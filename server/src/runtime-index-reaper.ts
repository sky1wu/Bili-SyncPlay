import { clampTimerIntervalMs } from "./timers.js";
import type { LogEvent } from "./types.js";
import type { RuntimeStore } from "./runtime-store.js";

/**
 * Exactly what the sweep touches, and no more.
 *
 * Narrow on purpose: a fake that has to satisfy the whole `RuntimeStore` gets
 * cast past the checker instead, and the cast then swallows every later change
 * to the contracts these tests exist to pin — `markSessionLeftRoom` becoming
 * awaitable, `removeMember` carrying `durable` (#235 review).
 */
export type RuntimeIndexReaperStore = Pick<
  RuntimeStore,
  | "listNodeStatuses"
  | "listClusterSessions"
  | "removeMember"
  | "markSessionLeftRoom"
  | "unregisterSession"
  | "purgeNodeStatus"
> &
  Partial<Pick<RuntimeStore, "flush" | "confirmWrites">>;

/**
 * Backlog size that gets logged, NOT a cap.
 *
 * There is deliberately no eviction. A record is the only trail back to its
 * room: the offline sessions are already out of the cluster index, so a dropped
 * record means that room's clients keep a dead `sharedByMemberId` until someone
 * reloads the page — the exact loss this set exists to prevent, now caused by
 * the thing meant to bound it (#242 review). Shedding load by discarding
 * unpublished one-shot notifications is not a trade this can make.
 *
 * Growth is bounded in practice by the number of distinct rooms that held a
 * dead node's members while the bus was rejecting publishes, and each entry is
 * a room code; the set drains as soon as the bus recovers. If that ever stops
 * being true the answer is to persist the records, not to evict them.
 */
const PENDING_RESYNC_BACKLOG_WARN_THRESHOLD = 512;

export function createRuntimeIndexReaper(options: {
  enabled: boolean;
  runtimeStore: RuntimeIndexReaperStore;
  intervalMs: number;
  now?: () => number;
  logEvent?: LogEvent;
  /**
   * Announce that a room this sweep touched needs rebuilding.
   *
   * A node that died took its members' seats with it and published nothing —
   * nobody left as far as the surviving clients are concerned. When one of those
   * seats held the share, every client still names it as `sharedByMemberId` and
   * the room stops advancing (#235 review). Once the indexes are cleaned, one
   * `room_state_updated` per affected room is enough: the state it triggers is
   * rebuilt from the live member list and resolves ownership on the way out.
   */
  publishRoomStateUpdate?: (roomCode: string) => Promise<void>;
}) {
  const now = options.now ?? Date.now;
  let timer: NodeJS.Timeout | null = null;
  let pendingSweep: Promise<number> | null = null;
  /**
   * Rooms still owed a resync announcement.
   *
   * The announcement is one-shot: a dead node's members left without anyone
   * publishing their departure, and once this sweep has cleaned the indexes
   * there is nothing left to rediscover them from — `listClusterSessions` no
   * longer returns those sessions, so a later sweep finds no work and the room
   * is stranded pointing at a member who will never come back (#242). The record
   * therefore outlives the sweep that created it and is dropped only once the
   * publish succeeds.
   */
  const roomsAwaitingResync = new Set<string>();

  function rememberResync(roomCode: string): void {
    const isNew = !roomsAwaitingResync.has(roomCode);
    roomsAwaitingResync.add(roomCode);
    if (
      isNew &&
      roomsAwaitingResync.size >= PENDING_RESYNC_BACKLOG_WARN_THRESHOLD
    ) {
      // Reported, never evicted — see the threshold's own comment.
      options.logEvent?.("runtime_index_resync_backlog", {
        pendingRooms: roomsAwaitingResync.size,
        threshold: PENDING_RESYNC_BACKLOG_WARN_THRESHOLD,
        result: "degraded",
        reason: "room_state_resync_publish_backlog",
      });
    }
  }

  /**
   * Publish every outstanding announcement, keeping the ones that fail.
   *
   * Runs at the START of a sweep too, before the "no offline nodes" early
   * return — otherwise a backlog accumulated during a bus outage would only
   * ever be retried on a sweep that happened to find another dead node.
   */
  async function flushPendingResyncs(): Promise<void> {
    for (const roomCode of Array.from(roomsAwaitingResync)) {
      try {
        await options.publishRoomStateUpdate?.(roomCode);
        roomsAwaitingResync.delete(roomCode);
      } catch (error) {
        // Kept for the next sweep. The sweep's own work is done and must not be
        // undone by a bus hiccup.
        options.logEvent?.("runtime_index_resync_publish_failed", {
          roomCode,
          pendingRooms: roomsAwaitingResync.size,
          result: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async function sweep(): Promise<number> {
    if (!options.enabled) {
      return 0;
    }

    await flushPendingResyncs();

    const currentTime = now();
    const nodeStatuses =
      await options.runtimeStore.listNodeStatuses(currentTime);
    const offlineInstanceIds = new Set(
      nodeStatuses
        .filter((status) => status.health === "offline")
        .map((status) => status.instanceId),
    );
    if (offlineInstanceIds.size === 0) {
      return 0;
    }

    const sessions = await options.runtimeStore.listClusterSessions();
    let cleanedSessions = 0;
    const roomsToResync = new Set<string>();
    for (const session of sessions) {
      if (!session.instanceId || !offlineInstanceIds.has(session.instanceId)) {
        continue;
      }

      if (session.roomCode && session.memberId) {
        await options.runtimeStore.removeMember(
          session.roomCode,
          session.memberId,
        );
      }
      if (session.roomCode) {
        // Swallowed, and NOT used to gate the announcement. One unwritable entry
        // must not abandon the rest of the sweep, and gating on it lost the
        // announcement for good: `unregisterSession` below deletes the session
        // hash and SREMs the same room-sessions key on its own, so the room ends
        // up clean either way — while the session disappears from
        // `listClusterSessions`, leaving the next pass nothing to retry (#235
        // review). In the rare case both writes fail, announcing is still no
        // worse than silence: the rebuilt state names the dead member, which is
        // exactly what every client already caches.
        await options.runtimeStore
          .markSessionLeftRoom(session.id, session.roomCode)
          .catch(() => undefined);
        roomsToResync.add(session.roomCode);
      }

      options.runtimeStore.unregisterSession(session.id);
      cleanedSessions += 1;
    }

    // Both cleanups are queued writes, so the announcement has to wait for them
    // to drain — otherwise the consumer rebuilds `room:state` from an index that
    // still lists the sessions this sweep just reaped.
    //
    // `confirmWrites` rather than `flush` where the store offers it: draining
    // says only that the queue emptied, and this sweep is about to announce a
    // state rebuilt from those very writes (#242). It does NOT gate the
    // announcement — see the `markSessionLeftRoom` comment above for why
    // announcing is still better than silence — but an unconfirmed sweep is
    // worth saying out loud.
    if (options.runtimeStore.confirmWrites) {
      await options.runtimeStore.confirmWrites().catch((error: unknown) => {
        options.logEvent?.("runtime_index_writes_unconfirmed", {
          result: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      await options.runtimeStore.flush?.();
    }

    // After the whole sweep, so a room that lost several members to the same
    // dead node is announced once rather than once per seat.
    for (const roomCode of roomsToResync) {
      rememberResync(roomCode);
    }
    await flushPendingResyncs();

    const remainingSessions = await options.runtimeStore.listClusterSessions();
    const activeInstanceIds = new Set(
      remainingSessions
        .map((session) => session.instanceId)
        .filter((instanceId): instanceId is string => Boolean(instanceId)),
    );
    const purgedInstanceIds: string[] = [];
    for (const instanceId of offlineInstanceIds) {
      if (activeInstanceIds.has(instanceId)) {
        continue;
      }
      await options.runtimeStore.purgeNodeStatus(instanceId);
      purgedInstanceIds.push(instanceId);
    }

    if (cleanedSessions > 0) {
      options.logEvent?.("runtime_index_sessions_reaped", {
        offlineInstanceIds: Array.from(offlineInstanceIds).sort(),
        purgedInstanceIds,
        cleanedSessions,
        result: "ok",
      });
    }

    return cleanedSessions;
  }

  /**
   * Skips the tick when the previous sweep is still running.
   *
   * Overlapping sweeps used to only waste work; now they share
   * `roomsAwaitingResync`, so two of them would walk the same records and
   * announce the same room twice. Worse, `stop()` awaits whichever sweep was
   * scheduled LAST — so if the newer one finished first, shutdown tore Redis
   * and the bus down while an older sweep was still writing.
   */
  function scheduleSweep(): void {
    if (pendingSweep) {
      return;
    }
    const running = sweep()
      .catch((error: unknown) => {
        options.logEvent?.("runtime_index_reaper_failed", {
          result: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        return 0;
      })
      .finally(() => {
        if (pendingSweep === running) {
          pendingSweep = null;
        }
      });
    pendingSweep = running;
  }

  return {
    start() {
      if (!options.enabled || timer) {
        return;
      }
      timer = setInterval(() => {
        scheduleSweep();
      }, clampTimerIntervalMs(options.intervalMs));
      timer.unref?.();
    },
    async sweep() {
      return sweep();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await pendingSweep;
      pendingSweep = null;
      // Last chance for anything the final sweep could not announce. Nothing
      // else will ever rediscover those rooms: their sessions are already out
      // of the cluster index, and this record set is memory-only, so shutting
      // down without trying loses the announcement for good (#242). One pass,
      // not the retry loop — the shutdown step is on a clock.
      await flushPendingResyncs();
    },
  };
}
