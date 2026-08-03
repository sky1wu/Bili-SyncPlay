import { createRetryPacer } from "./retry-pacer.js";
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

/**
 * The shutdown pass's own budget, and how many publishes it runs at once.
 *
 * Comfortably inside `stop_runtime_index_reaper`'s step timeout (see
 * `createSharedServerShutdownSteps`), which is what keeps an overrun from being
 * recorded as a failed shutdown step.
 */
const SHUTDOWN_RESYNC_BUDGET_MS = 3_000;
const SHUTDOWN_RESYNC_CONCURRENCY = 8;
/**
 * Caps ONE publish. A deadline that only decides whether to START the next
 * record is no bound at all when the bus hangs rather than rejecting: the call
 * already in flight pins the sweep drain and the shutdown pass alike, and the
 * step times out with the publish still running (#242 review).
 */
const RESYNC_PUBLISH_TIMEOUT_MS = 2_000;
/**
 * Caps the sweep's own wait on ONE of a session's cleanup writes.
 *
 * The write keeps going — the store retries it on its own budget — but the
 * sweep must not inherit that budget, or one unreachable session holds `stop()`
 * past the whole shutdown step and starves the dead node's other sessions.
 */
const SESSION_INDEX_WRITE_TIMEOUT_MS = 2_000;

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
  // The sweep timer drives the retries here, so the pacer's backoff is unused;
  // what this file needs from it is the per-attempt cap that does NOT cancel
  // the call, the record of calls that outlived one, and the stop switch.
  const pacer = createRetryPacer({
    initialDelayMs: RESYNC_PUBLISH_TIMEOUT_MS,
    maxDelayMs: RESYNC_PUBLISH_TIMEOUT_MS,
  });
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
  /**
   * The publish a room already has out that has not answered yet.
   *
   * The per-publish cap races the bus call, it cannot abort it — so without
   * this the next sweep starts ANOTHER publish for the same room every
   * interval, and one hung bus accumulates Redis commands for as long as it
   * stays hung (#242 review). Same reasoning as `pending-resync-queue`; the
   * difference is only that here the retries are driven by the sweep timer.
   */
  const inFlightResyncByRoom = new Map<string, Promise<void>>();
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

  async function publishPendingResync(
    roomCode: string,
    timeoutMs = RESYNC_PUBLISH_TIMEOUT_MS,
  ): Promise<void> {
    if (inFlightResyncByRoom.has(roomCode)) {
      // Still waiting on the previous call. Piling another on top is what the
      // per-publish cap would otherwise turn every retry into.
      return;
    }
    try {
      const publish = options.publishRoomStateUpdate?.(roomCode);
      if (publish) {
        const tracked = publish.then(
          () => undefined,
          () => undefined,
        );
        inFlightResyncByRoom.set(roomCode, tracked);
        void tracked.finally(() => {
          if (inFlightResyncByRoom.get(roomCode) === tracked) {
            inFlightResyncByRoom.delete(roomCode);
          }
        });
        await pacer.capAttempt(
          publish,
          timeoutMs,
          () =>
            new Error(`Room state resync publish timed out for ${roomCode}.`),
        );
      }
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

  /**
   * Publish every outstanding announcement, keeping the ones that fail.
   *
   * Runs at the START of a sweep too, before the "no offline nodes" early
   * return — otherwise a backlog accumulated during a bus outage would only
   * ever be retried on a sweep that happened to find another dead node.
   *
   * Serial, because a sweep runs on its own timer and has all the time it
   * needs. `stop` does NOT — see {@link flushPendingResyncsWithinBudget}.
   */
  async function flushPendingResyncs(): Promise<void> {
    for (const roomCode of Array.from(roomsAwaitingResync)) {
      if (pacer.stopped()) {
        // `stop` is waiting on this sweep and has its own bounded pass to run.
        return;
      }
      await publishPendingResync(roomCode);
    }
  }

  /**
   * The shutdown pass: bounded in both directions.
   *
   * The backlog has no cap — evicting an unpublished record is the loss this
   * set exists to prevent — so a serial drain of it is unbounded too, and
   * `stop_runtime_index_reaper` gets a few seconds. Overrunning it is not a
   * harmless delay: the step is recorded as FAILED, shutdown carries on and
   * closes the event bus, and publishes still in flight then return early
   * against a closing bus, so their records get deleted as if they had
   * succeeded (#242 review). Bounded concurrency plus a deadline keeps the pass
   * inside the budget; whatever it does not reach stays in the set, which is
   * honest — the set is memory-only and about to go with the process.
   */
  async function flushPendingResyncsWithinBudget(): Promise<void> {
    const deadline = now() + SHUTDOWN_RESYNC_BUDGET_MS;
    const queued = Array.from(roomsAwaitingResync);
    let next = 0;
    const workers = Array.from(
      { length: Math.min(SHUTDOWN_RESYNC_CONCURRENCY, queued.length) },
      async () => {
        while (next < queued.length && now() < deadline) {
          const roomCode = queued[next];
          next += 1;
          if (roomCode !== undefined) {
            // Capped by what is LEFT of the budget, not by the per-publish
            // default: the last record must not be able to overrun it either.
            await publishPendingResync(
              roomCode,
              Math.min(RESYNC_PUBLISH_TIMEOUT_MS, deadline - now()),
            );
          }
        }
      },
    );
    await Promise.all(workers);
    // A publish that timed out is still on its way to the bus, and the very
    // next shutdown step closes that bus. Give the leftovers what remains of
    // the budget rather than closing under them (#242 review).
    await pacer.settleTracked(deadline - now());
    if (roomsAwaitingResync.size > 0) {
      options.logEvent?.("runtime_index_resync_abandoned_at_shutdown", {
        pendingRooms: roomsAwaitingResync.size,
        budgetMs: SHUTDOWN_RESYNC_BUDGET_MS,
        result: "dropped",
      });
    }
  }

  /**
   * Await one cleanup write and say whether it really landed.
   *
   * The sweep's steps are ordered by what they destroy: the member removal
   * needs the session's `roomCode` and `memberId`, the index removal needs its
   * `roomCode`, and `unregisterSession` throws the whole record away. That
   * record is the ONLY trail back to this work — once it is gone
   * `listClusterSessions` stops returning the session and no later sweep can
   * rediscover the room. So each step runs only after the previous one is
   * confirmed, and a step that did not land leaves the record untouched for the
   * next sweep to redo from the top. Every one of them is idempotent.
   *
   * Capped, because a write that never answers must not hold the OTHER
   * sessions of a dead node hostage; the write itself keeps going on the
   * store's own retry budget. A cap that expires is simply "not confirmed" —
   * which is now a safe answer rather than a reason to compensate.
   */
  async function confirmCleanupWrite(
    write: Promise<void>,
    session: { id: string },
    step: string,
  ): Promise<boolean> {
    const settled = pacer
      .capAttempt(
        write,
        SESSION_INDEX_WRITE_TIMEOUT_MS,
        () =>
          new Error(
            `Runtime index reaper gave up waiting for the ${step} of ${session.id}.`,
          ),
      )
      .then(
        () => true,
        (error: unknown) => {
          // Retries are exhausted or the cap expired. Either way this session
          // keeps its record and its place in the cluster index, so saying so
          // is all that is left to do here.
          options.logEvent?.("runtime_index_cleanup_unconfirmed", {
            sessionId: session.id,
            step,
            result: "error",
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        },
      );
    await Promise.race([settled, pacer.whenStopped()]);
    // Stopping is not a verdict on the write. Treating it as "unconfirmed"
    // hands the session to the next instance intact, which is exactly what a
    // half-finished cleanup needs — the alternative was announcing a room
    // rebuilt from an index this sweep had not finished cleaning, and that
    // announcement is one-shot (#242 review).
    return pacer.stopped() ? false : await settled;
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
      if (pacer.stopped()) {
        // The same rule as the confirmation wait below: stopping is the only
        // thing that cuts this sweep short. Without it each remaining session
        // still spent its own bounded wait on the index write, and five of them
        // were enough to outlast the whole shutdown step (#242 review). What is
        // left is picked up by the next instance — these sessions are still in
        // the cluster index precisely because this sweep did not get to them.
        break;
      }
      if (!session.instanceId || !offlineInstanceIds.has(session.instanceId)) {
        continue;
      }

      if (session.roomCode && session.memberId) {
        // `session` is passed, so `REMOVE_MEMBER_LUA`'s binding guard is armed.
        // Without it the script HDELs the memberId unconditionally — and this
        // write can land late, after the member reconnected elsewhere with the
        // token they were allowed to keep, deleting the NEW session's binding
        // (#242 review).
        const removal = options.runtimeStore.removeMember(
          session.roomCode,
          session.memberId,
          session,
        );
        // Confirmed BEFORE anything else touches this session, because
        // `markSessionLeftRoom` blanks the record's `roomCode` and
        // `unregisterSession` deletes the record outright — and a retry of this
        // removal needs both `roomCode` and `memberId` to exist. Running ahead
        // of it left the stale member binding in Redis with its token retention
        // never armed, nothing to rediscover it from, and `hasRoomResidue`
        // keeping the code reserved for good (#242 review).
        if (
          removal.durable &&
          !(await confirmCleanupWrite(
            removal.durable,
            session,
            "member removal",
          ))
        ) {
          continue;
        }
      }
      if (session.roomCode) {
        // Gates the announcement, because the announcement is one-shot: it is
        // dropped as soon as the publish succeeds, so spending it on a state
        // rebuilt from an index this write has not cleaned strands the room
        // pointing at the dead member for good. The #235-era reasoning for
        // announcing anyway — "`unregisterSession` cleans the same key, and
        // gating leaves the next pass nothing to retry" — only held because
        // this sweep unregistered regardless; it no longer does.
        if (
          !(await confirmCleanupWrite(
            options.runtimeStore.markSessionLeftRoom(
              session.id,
              session.roomCode,
            ),
            session,
            "index write",
          ))
        ) {
          continue;
        }
        roomsToResync.add(session.roomCode);
      }

      // Last, and only now: this is what makes the session unrediscoverable.
      options.runtimeStore.unregisterSession(session.id);
      cleanedSessions += 1;
    }

    // Everything the announcement depends on was confirmed per session above.
    // What is left over is `unregisterSession`, and it alone: the contract
    // returns `void`, so a store-wide confirmation is the only place its
    // outcome is visible at all.
    //
    // It gates nothing, and may not — `markSessionLeftRoom` already SREM'd this
    // session out of the room index, so a failed unregister leaves the room
    // clean and only the session hash behind. The next sweep still finds that
    // hash in the cluster index, sees an empty `roomCode`, and unregisters it
    // again. That is the whole difference from the writes above, which are
    // gated precisely BECAUSE failing to redo them costs the room its one-shot
    // announcement (#242 review).
    //
    // `confirmWrites` rather than `flush` where the store offers it: draining
    // says only that the queue emptied, so a failed write drains exactly like a
    // successful one. Waited for, not merely sampled — the 2s cap this used to
    // carry was itself the first patch, put there for the shutdown budget, and
    // the latch map and re-confirmation pass above it existed to compensate for
    // giving up early. A sweep is a background timer task with no deadline of
    // its own; shutdown is the only thing that cuts it short (#242).
    const confirmation = options.runtimeStore.confirmWrites
      ? options.runtimeStore.confirmWrites()
      : (options.runtimeStore.flush?.() ?? Promise.resolve());
    void confirmation.catch(() => undefined);
    await Promise.race([
      confirmation.catch((error: unknown) => {
        options.logEvent?.("runtime_index_writes_unconfirmed", {
          result: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }),
      pacer.whenStopped(),
    ]);

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
      pacer.stop();
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await pendingSweep;
      pendingSweep = null;
      // Last chance for anything the final sweep could not announce. Nothing
      // else will ever rediscover those rooms: their sessions are already out
      // of the cluster index, and this record set is memory-only, so shutting
      // down without trying loses the announcement for good (#242). Bounded,
      // because the shutdown step is on a clock and the backlog is not.
      await flushPendingResyncsWithinBudget();
    },
  };
}
