import type { ClientMessage, ErrorCode } from "@bili-syncplay/protocol";
import type { WebSocket } from "ws";
import { performance } from "node:perf_hooks";
import type {
  MetricsCollector,
  MonitoredMessageType,
} from "./admin/metrics.js";
import {
  consumeFixedWindow,
  consumeTokenBucket,
  WINDOW_10_SECONDS_MS,
  WINDOW_MINUTE_MS,
} from "./rate-limit.js";
import {
  INTERNAL_SERVER_ERROR_MESSAGE,
  MEMBER_TOKEN_INVALID_MESSAGE,
  RATE_LIMITED_MESSAGE,
  UNSUPPORTED_PROTOCOL_VERSION_MESSAGE,
  MIN_PROTOCOL_VERSION,
  CURRENT_PROTOCOL_VERSION,
  ROOM_NOT_FOUND_MESSAGE,
} from "./messages.js";
import { createPendingResyncQueue } from "./pending-resync-queue.js";
import { RoomServiceError, type LeaveRoomReason } from "./room-service.js";
import { withPlaybackAge } from "./room-state-age.js";
import type { RoomEventBusMessage } from "./room-event-bus.js";
import { hasAttachedSocket } from "./types.js";
import type { LogEvent, SendError, SendMessage, Session } from "./types.js";

type RoomEventBusPublishInput<T> = T extends unknown
  ? Omit<T, "sourceInstanceId" | "emittedAt">
  : never;

/** RFC 6455 "internal error": the server could not put the session back. */
const CLOSE_CODE_JOIN_ROLLBACK_FAILED = 1011;
/**
 * How long a refused join waits for its own rollback before answering the
 * client anyway. The rollback keeps running, ordered on the session's key.
 */
const JOIN_ROLLBACK_TIMEOUT_MS = 5_000;
const ROOM_RESOLUTION_RETRY_PROTOCOL_VERSION = 5;

export function createMessageHandler(options: {
  config: {
    maxMembersPerRoom: number;
    rateLimits: {
      roomCreatePerMinute: number;
      roomJoinPerMinute: number;
      videoSharePer10Seconds: number;
      playbackUpdatePerSecond: number;
      playbackUpdateBurst: number;
      syncRequestPer10Seconds: number;
      syncPingPerSecond: number;
      syncPingBurst: number;
    };
  };
  roomService: {
    createRoomForSession: (
      session: Session,
      displayName?: string,
    ) => Promise<{
      room: { code: string; joinToken: string };
      memberToken: string;
    }>;
    joinRoomForSession: (
      session: Session,
      roomCode: string,
      joinToken: string,
      displayName?: string,
      previousMemberToken?: string,
    ) => Promise<{ room: { code: string }; memberToken: string }>;
    leaveRoomForSession: (
      session: Session,
      reason?: LeaveRoomReason,
    ) => Promise<{
      room: { code: string } | null;
      notifyRoom?: boolean;
      memberRemoved?: boolean;
      needsRoomStateResync?: boolean;
    }>;
    shareVideoForSession: (
      session: Session,
      memberToken: string,
      video: ClientMessage extends never
        ? never
        : Extract<ClientMessage, { type: "video:share" }>["payload"]["video"],
      playback?: ClientMessage extends never
        ? never
        : Extract<
            ClientMessage,
            { type: "video:share" }
          >["payload"]["playback"],
    ) => Promise<{ room: { code: string } }>;
    updatePlaybackForSession: (
      session: Session,
      memberToken: string,
      playback: Extract<
        ClientMessage,
        { type: "playback:update" }
      >["payload"]["playback"],
    ) => Promise<{ room: { code: string } | null; ignored: boolean }>;
    updateProfileForSession: (
      session: Session,
      memberToken: string,
      displayName: string,
    ) => Promise<{ room: { code: string } }>;
    getRoomStateForSession: (
      session: Session,
      memberToken: string,
      messageType: ClientMessage["type"],
    ) => Promise<import("./types.js").RoomStoreRoomState>;
  };
  logEvent: LogEvent;
  send: SendMessage;
  sendError: SendError;
  publishRoomEvent: (message: RoomEventBusMessage) => Promise<void>;
  instanceId: string;
  metricsCollector?: Pick<
    MetricsCollector,
    | "observeMessageHandlerDuration"
    | "recordRoomEventPublishDropped"
    | "recordRateLimited"
    | "recordSessionProtocolVersion"
  >;
  maxPendingPublishes?: number;
  backpressureWaitMs?: number;
  publishTimeoutMs?: number;
  /**
   * Retry policy for the share-ownership resync, the one broadcast in this file
   * that nothing else repeats. See `pending-resync-queue`.
   */
  sharedOwnerResyncRetry?: {
    initialRetryDelayMs?: number;
    maxRetryDelayMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
  };
  /**
   * Rejecting ABORTS the join. Its implementation puts the session into the room
   * index, and everything the join sends next is read back off that index: the
   * bootstrap `room:state` would be missing the member who just joined, and the
   * ownership decision taken from it is then wrong in the one case it exists
   * for — the stored sharer reconnecting (#235). Seating a member the room
   * cannot see is worse than refusing the join, which the client simply retries
   * (#242).
   */
  /**
   * How long a refused join waits for its own rollback before answering the
   * client anyway. Injectable so tests do not pay it in wall-clock time.
   */
  joinRollbackTimeoutMs?: number;
  onRoomJoined?: (
    session: Session,
    roomCode: string,
    previousRoomCode: string | null,
  ) => void | Promise<void>;
  /**
   * Awaited, unlike the fire-and-forget hook it used to be. Its implementation
   * clears the session out of the room index, and a `room:state` published
   * before that write lands is rebuilt from an index that still lists the
   * leaver — who then reappears in the snapshot and can win the share back
   * (#235 review). Anything published after a leave must wait for this.
   */
  onRoomLeft?: (session: Session, roomCode: string) => void | Promise<void>;
  now?: () => number;
}): {
  handleClientMessage: (
    session: Session,
    message: ClientMessage,
  ) => Promise<void>;
  /**
   * `reason` decides whether the member keeps their identity. A socket close
   * must pass `"disconnect"`: the client still holds its `memberToken` and
   * will present it on the next join to reclaim the same `memberId` (#234).
   */
  leaveRoom: (session: Session, reason?: LeaveRoomReason) => Promise<boolean>;
  flushPendingPublishes: (options?: { final?: boolean }) => Promise<void>;
} {
  const { config, roomService, logEvent, send, sendError } = options;
  const now = options.now ?? Date.now;
  const metricsCollector = options.metricsCollector;
  const pendingPublishes = new Set<Promise<void>>();
  const maxPendingPublishes = options.maxPendingPublishes ?? 256;
  const backpressureWaitMs = options.backpressureWaitMs ?? 5_000;
  const publishTimeoutMs = options.publishTimeoutMs ?? 5_000;

  /**
   * Returns whether the session was actually seated. A `false` here used to be
   * swallowed and the join carried on regardless: the member was absent from
   * the room index, so the bootstrap state they were handed did not contain
   * them, and the stored sharer reconnecting into that room was handed a
   * stand-in owner with no full state to follow (#242).
   */
  async function runRoomJoinedHook(
    session: Session,
    roomCode: string,
    previousRoomCode: string | null,
  ): Promise<boolean> {
    try {
      await options.onRoomJoined?.(session, roomCode, previousRoomCode);
      return true;
    } catch (error) {
      logEvent("room_join_hook_failed", {
        sessionId: session.id,
        roomCode,
        previousRoomCode,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Undo a join whose index write never landed.
   *
   * `applyJoinedSessionState` and `addMember` have both already taken effect by
   * the time the hook runs, so refusing the join means unwinding them — and
   * `leaveRoom` is the one path that does that completely: it drops the member,
   * clears the session's room state, releases the room's own bookkeeping and
   * publishes whatever the departure owes.
   *
   * `"disconnect"`, not `"client-request"`: the member's identity has to
   * survive so the client's retry reclaims the same `memberId` with the token it
   * was never given. It has none yet — the join is refused before `room:joined`
   * is sent — so on a first join it simply comes back as a new member, while a
   * RECONNECTING member keeps the seat the whole ownership rule depends on.
   */
  async function abortJoin(
    session: Session,
    roomCode: string,
    socket: WebSocket,
  ): Promise<void> {
    let rolledBack = false;
    try {
      // The RETURNED verdict, not merely "it did not throw": the cleanup is
      // skipped on two paths that resolve normally (#242 review).
      //
      // Bounded, because the rollback's own index write queues behind the join
      // write's command — and a command that never answers neither resolves nor
      // rejects. Waiting on it left the client parked on a join that had
      // already failed, with the error and the socket close unreachable (#242
      // review). Timing out means the same thing a failed rollback means: the
      // seat did not provably come back, so the socket goes. The rollback is
      // NOT cancelled; it stays ordered on the session's key and completes
      // behind the scenes.
      const rollback = leaveRoom(session, "disconnect");
      rollback.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const verdict = await Promise.race([
        rollback,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(
            () => resolve("timeout"),
            options.joinRollbackTimeoutMs ?? JOIN_ROLLBACK_TIMEOUT_MS,
          );
        }),
      ]);
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (verdict === "timeout") {
        logEvent("room_join_rollback_timeout", {
          sessionId: session.id,
          roomCode,
          remoteAddress: session.remoteAddress,
          origin: session.origin,
          result: "timeout",
          timeoutMs: options.joinRollbackTimeoutMs ?? JOIN_ROLLBACK_TIMEOUT_MS,
        });
      } else {
        rolledBack = verdict;
      }
    } catch (error) {
      logEvent("room_join_rollback_failed", {
        sessionId: session.id,
        roomCode,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    logEvent("room_join_aborted", {
      sessionId: session.id,
      roomCode,
      remoteAddress: session.remoteAddress,
      origin: session.origin,
      result: "rejected",
      reason: "room_index_write_failed",
      rolledBack,
    });
    sendError(socket, "internal_error", INTERNAL_SERVER_ERROR_MESSAGE);
    if (rolledBack) {
      return;
    }
    // The seat did not come back. `leaveCurrentRoom` RESTORES the member when
    // its own persistence fails and the socket is still open, so telling the
    // client the join failed while the server still holds it as a member leaves
    // the two disagreeing — and that connection can go on sharing and driving
    // playback from a seat the shared index never received (#242 review).
    //
    // Dropping the socket is the only honest end: `cleanupSessionAfterClose`
    // runs the leave again with no socket to restore into, and unregisters the
    // session either way.
    if (
      hasAttachedSocket(session) &&
      session.socket.readyState === session.socket.OPEN
    ) {
      session.socket.close(
        CLOSE_CODE_JOIN_ROLLBACK_FAILED,
        "join_rollback_failed",
      );
    }
  }

  /**
   * Returns whether the hook actually completed. Callers need it because the
   * failure it swallows is the room-index write not landing, and a `room:state`
   * rebuilt from an uncleaned index contains the member who just left — who then
   * wins the share straight back (#235 review). Publishing that state is worse
   * than publishing nothing: it corrupts the roster too, and nothing is
   * scheduled to correct it afterwards.
   */
  async function runRoomLeftHook(
    session: Session,
    roomCode: string,
  ): Promise<boolean> {
    try {
      await options.onRoomLeft?.(session, roomCode);
      return true;
    } catch (error) {
      logEvent("room_left_hook_failed", {
        sessionId: session.id,
        roomCode,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Reports who the sent state named as share owner. The join path needs it to
   * decide whether the room owes everybody else a resync (#235): adding a member
   * can only move the share if the new member wins it, so "did this joiner end
   * up owning the share?" is the whole question — and this state has already
   * been resolved against the live member list, so it answers it without a
   * second read or a second copy of the rule.
   *
   * `"unknown"` is a separate outcome from an owner of `undefined`, which would
   * otherwise read as "this room has no shared video" and skip the resync on a
   * transient store error — exactly when the returning sharer's room needs it
   * (#235 review).
   */
  type RoomStateSendOutcome =
    { known: true; sharedOwnerId: string | undefined } | { known: false };

  async function sendRoomStateToSession(
    session: Session,
    memberToken: string,
    messageType: ClientMessage["type"],
  ): Promise<RoomStateSendOutcome> {
    if (!hasAttachedSocket(session)) {
      return { known: false };
    }
    try {
      const state = await roomService.getRoomStateForSession(
        session,
        memberToken,
        messageType,
      );
      if (!hasAttachedSocket(session)) {
        return { known: false };
      }
      // Aged at the send, not at the read: `getRoomStateForSession` awaits the
      // store, and the room kept playing through it.
      send(session.socket, {
        type: "room:state",
        payload: withPlaybackAge(state, now()),
      });
      return {
        known: true,
        sharedOwnerId: state.sharedVideo?.sharedByMemberId,
      };
    } catch (error) {
      logEvent("room_state_bootstrap_failed", {
        sessionId: session.id,
        roomCode: session.roomCode,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        result: "error",
        reason:
          error instanceof RoomServiceError
            ? error.reason
            : "room_state_bootstrap_failed",
      });
      return { known: false };
    }
  }

  async function firePublishRoomEvent(
    message: RoomEventBusPublishInput<RoomEventBusMessage>,
    context: {
      reason: string;
      sessionId?: string;
      remoteAddress?: string | null;
      origin?: string | null;
    },
  ): Promise<void> {
    const { type, roomCode } = message;
    if (pendingPublishes.size >= maxPendingPublishes) {
      logEvent("room_event_publish_backpressure", {
        sessionId: context.sessionId,
        roomCode,
        remoteAddress: context.remoteAddress,
        origin: context.origin,
        result: "throttled",
        reason: context.reason,
        eventType: type,
        pendingCount: pendingPublishes.size,
        maxPending: maxPendingPublishes,
      });
      // Loop and re-check size synchronously after each wake-up. A slot
      // freeing wakes every concurrent waiter at once; the first one
      // through grabs the slot synchronously (no await between size
      // check and pendingPublishes.add), the rest see the cap is full
      // again and wait another round. Total wait is bounded by an
      // absolute deadline so callers can't be starved past
      // backpressureWaitMs.
      const deadline = now() + backpressureWaitMs;
      while (pendingPublishes.size >= maxPendingPublishes) {
        const remainingMs = deadline - now();
        if (remainingMs <= 0) {
          logEvent("room_event_publish_dropped", {
            sessionId: context.sessionId,
            roomCode,
            remoteAddress: context.remoteAddress,
            origin: context.origin,
            result: "dropped",
            reason: context.reason,
            eventType: type,
            pendingCount: pendingPublishes.size,
            maxPending: maxPendingPublishes,
            waitMs: backpressureWaitMs,
          });
          metricsCollector?.recordRoomEventPublishDropped(type);
          return;
        }
        let waitTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const slotFreed = Promise.race(Array.from(pendingPublishes)).then(
          () => "ok" as const,
        );
        const waitTimedOut = new Promise<"timeout">((resolve) => {
          waitTimeoutHandle = setTimeout(() => resolve("timeout"), remainingMs);
        });
        const result = await Promise.race([slotFreed, waitTimedOut]);
        if (waitTimeoutHandle !== null) {
          clearTimeout(waitTimeoutHandle);
        }
        if (result === "timeout") {
          logEvent("room_event_publish_dropped", {
            sessionId: context.sessionId,
            roomCode,
            remoteAddress: context.remoteAddress,
            origin: context.origin,
            result: "dropped",
            reason: context.reason,
            eventType: type,
            pendingCount: pendingPublishes.size,
            maxPending: maxPendingPublishes,
            waitMs: backpressureWaitMs,
          });
          metricsCollector?.recordRoomEventPublishDropped(type);
          return;
        }
      }
    }
    // Bound each publish so a hung bus call (Redis disconnect, slow network)
    // can't pin a slot indefinitely. Track the wrapper rather than the raw
    // publish so:
    //   - The cap reflects what message-handler is willing to wait for, not
    //     the bus's true in-flight count (which the bus driver is responsible
    //     for managing).
    //   - flushPendingPublishes() always drains within publishTimeoutMs
    //     regardless of whether the underlying call ever resolves.
    // The underlying publish keeps running after timeout so the bus can still
    // deliver if it eventually unblocks; we just stop accounting for it here.
    const realPublish = options.publishRoomEvent({
      ...message,
      sourceInstanceId: options.instanceId,
      emittedAt: now(),
    } as RoomEventBusMessage);
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const wrapper = Promise.race<"ok" | "timeout">([
      realPublish.then(
        () => "ok" as const,
        (error: unknown) => {
          // If the publish rejects after the timeout has already won, the
          // timeout log captured the incident — suppress the duplicate.
          if (!timedOut) {
            logEvent("room_event_publish_failed", {
              sessionId: context.sessionId,
              roomCode,
              remoteAddress: context.remoteAddress,
              origin: context.origin,
              result: "error",
              reason: context.reason,
              eventType: type,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return "ok" as const;
        },
      ),
      new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          resolve("timeout");
        }, publishTimeoutMs);
      }),
    ]).then((outcome) => {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (outcome === "timeout") {
        logEvent("room_event_publish_timeout", {
          sessionId: context.sessionId,
          roomCode,
          remoteAddress: context.remoteAddress,
          origin: context.origin,
          result: "timeout",
          reason: context.reason,
          eventType: type,
          timeoutMs: publishTimeoutMs,
        });
      }
    });
    pendingPublishes.add(wrapper);
    void wrapper.finally(() => {
      pendingPublishes.delete(wrapper);
    });
  }

  /**
   * Drains the retrying resync records too, not just the one-shot wrappers.
   * Shutdown calls this before the bus is torn down, and a record left behind
   * is the one broadcast nothing else will ever re-send (#242).
   *
   * `final` marks the shutdown call. Without it the drain is unbounded in the
   * time it takes: records retry until the bus takes them, which is the point
   * of the queue and no bound at all for a shutdown step (#242 review).
   */
  async function flushPendingPublishes(options?: {
    final?: boolean;
  }): Promise<void> {
    if (options?.final) {
      sharedOwnerResyncQueue.stopRetrying();
    }
    while (pendingPublishes.size > 0 || sharedOwnerResyncQueue.size() > 0) {
      await Promise.allSettled([
        ...Array.from(pendingPublishes),
        sharedOwnerResyncQueue.drain(),
      ]);
    }
  }

  /**
   * Returns whether the session is provably out of the room's index.
   *
   * `abortJoin` acts on it, so the three ways the cleanup can be skipped all
   * have to answer `false` — not just the one that throws (#242 review):
   * the service call rejecting, the early return that never reaches the hook,
   * and the hook itself reporting failure.
   */
  async function leaveRoom(
    session: Session,
    reason: LeaveRoomReason = "client-request",
  ): Promise<boolean> {
    const roomCode = session.roomCode;
    const memberId = session.memberId ?? session.id;
    const displayName = session.displayName;
    const { room, notifyRoom, memberRemoved, needsRoomStateResync } =
      await roomService.leaveRoomForSession(session, reason);
    if (!roomCode) {
      // In no room to begin with; there is nothing to have failed.
      return true;
    }
    if (!room && !notifyRoom) {
      // The service released the room but this path never runs the hook, so
      // `markSessionLeftRoom` never went out and the index still lists us.
      return false;
    }
    const roomIndexCleaned = await runRoomLeftHook(session, roomCode);
    // Two independent questions, so two independent gates. `memberRemoved` is
    // THIS node's local removal result, while `needsRoomStateResync` came out of
    // the shared view — a session replaced on another node clears no local seat
    // yet still changes who the election picks, and folding the resync into the
    // delta's early return dropped exactly that case (#235 review).
    const publishResync = needsRoomStateResync === true && roomIndexCleaned;
    if (!memberRemoved && !notifyRoom) {
      if (publishResync) {
        publishSharedOwnerResync(roomCode);
      }
      return roomIndexCleaned;
    }

    await firePublishRoomEvent(
      {
        type: "room_member_left",
        roomCode,
        memberId,
        displayName,
      },
      {
        reason: "leave_room_broadcast_failed",
        sessionId: session.id,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
      },
    );

    // `room_member_left` goes out either way: it carries no state read, so an
    // uncleaned index cannot corrupt it, and it still drops the member from
    // every roster. The full state is the one that must not be built on an
    // index we failed to clean (#235 review).
    if (publishResync) {
      publishSharedOwnerResync(roomCode);
    }
    return roomIndexCleaned;
  }

  /**
   * Follow a membership delta with a full `room:state` because the share
   * changed hands (#235).
   *
   * `room_state_updated` rather than a bespoke event: the consumer already
   * answers it by rebuilding and broadcasting the room state, and that rebuild
   * is where ownership is resolved (`roomStateFromSessions`). Sent AFTER the
   * delta so the authoritative state is the last word — the two ride the same
   * channel, so their order survives.
   *
   * Retried, unlike every other publish in this file, because it is the only
   * ONE-SHOT one. The rest are re-sent by the next `video:share` /
   * `playback:update` / `profile:update`, so dropping one costs a moment. This
   * one goes out precisely because the room has stopped advancing, so nothing
   * follows it to correct it, and an idle room never sends `sync:request`
   * either — the user has to reload the page (#242).
   */
  const sharedOwnerResyncQueue = createPendingResyncQueue({
    ...options.sharedOwnerResyncRetry,
    attemptTimeoutMs: publishTimeoutMs,
    publish: (roomCode) =>
      options.publishRoomEvent({
        type: "room_state_updated",
        roomCode,
        sourceInstanceId: options.instanceId,
        emittedAt: now(),
      }),
    onAttemptFailed: ({ roomCode, attempt, delayMs, error }) => {
      logEvent("shared_owner_resync_retry_scheduled", {
        roomCode,
        attempt,
        delayMs,
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    },
    onBacklog: ({ roomCode, pendingRooms }) => {
      logEvent("shared_owner_resync_backlog", {
        roomCode,
        pendingRooms,
        result: "degraded",
        reason: "shared_owner_resync_publish_backlog",
      });
    },
  });

  /**
   * Returns immediately, exactly like `firePublishRoomEvent`: the leave and join
   * handlers would otherwise block on the bus for up to `publishTimeoutMs`, and
   * `firePublishRoomEvent` was written not to await its wrapper for that very
   * reason. The retry lives inside the queue instead.
   */
  function publishSharedOwnerResync(roomCode: string): void {
    sharedOwnerResyncQueue.request(roomCode);
  }

  /**
   * Runs a create/join and makes sure the room being left is released even when
   * it fails.
   *
   * Both service calls leave the current room FIRST and can throw afterwards —
   * room full, bad join token, admission lock timeout, code collision. The
   * caller's release then never ran, so the old room kept a ghost session in its
   * index: it still listed the member, and that ghost could win the share
   * election (#235 review). The session's own `roomCode` is the evidence that
   * the leave happened, since the service clears it as part of leaving.
   */
  async function enterRoom<T>(
    session: Session,
    previous: {
      roomCode: string;
      memberId: string;
      displayName: string;
    } | null,
    enter: () => Promise<T>,
  ): Promise<T> {
    try {
      return await enter();
    } catch (error) {
      if (previous && session.roomCode !== previous.roomCode) {
        // Gated: the create/join FAILED, so no later write will re-stamp this
        // session's room code. If the hook could not clear the index, a state
        // built from it still lists the switcher and hands them the share back
        // (#242 review).
        const indexCleaned = await releasePreviousRoom(session, previous);
        publishPreviousRoomResync(previous, "", {
          seated: false,
          indexCleaned,
        });
      }
      throw error;
    }
  }

  /**
   * A member switching rooms leaves the old one through `createRoomForSession` /
   * `joinRoomForSession`, which call `leaveCurrentRoom` internally and publish
   * nothing — so the old room is told neither that the member is gone nor that
   * the share may have moved with them (#235 review).
   *
   * The identity is passed in because the caller captured it BEFORE the switch —
   * by now `session.memberId` names the new room's seat.
   *
   * `room_member_left` goes out even when the index write failed — it carries no
   * state read, so a dirty index cannot corrupt it, and withholding it lost the
   * announcement permanently since nothing afterwards carries the old room code
   * (#235 review).
   *
   * The full `room:state` does NOT, and that is what changed in #242. The old
   * reasoning was that "a switcher's session hash already names the NEW room, so
   * `roomStateFromSessions` drops it from the old room's roster on its own" —
   * but that hash is written by `onRoomLeft`'s own `registerSession`, so when the
   * hook fails the hash can still name the OLD room and the state hands the
   * switcher straight back into it, share and all. Returning the verdict lets
   * each caller publish it where it is provably safe; see the call sites.
   */
  async function releasePreviousRoom(
    session: Session,
    previous: { roomCode: string; memberId: string; displayName: string },
  ): Promise<boolean> {
    const indexCleaned = await runRoomLeftHook(session, previous.roomCode);
    await firePublishRoomEvent(
      {
        type: "room_member_left",
        roomCode: previous.roomCode,
        memberId: previous.memberId,
        displayName: previous.displayName,
      },
      {
        reason: "room_switch_member_left_broadcast_failed",
        sessionId: session.id,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
      },
    );
    return indexCleaned;
  }

  /**
   * Publish the old room's full `room:state` — but only where the switcher
   * provably cannot come back into it.
   *
   * Two ways to know that. `seated` means `runRoomJoinedHook` succeeded, and
   * its write re-stamps the whole session record under the NEW room code, so
   * the old room's rebuild drops this session as index residue whatever
   * `onRoomLeft` managed to write. `indexCleaned` means `onRoomLeft` itself
   * landed. Either is enough; neither is optional, because a state built on an
   * index nobody cleared hands the leaver their share straight back (#242
   * review).
   */
  function publishPreviousRoomResync(
    previousRoom: { roomCode: string } | null,
    joinedRoomCode: string,
    outcome: { seated: boolean; indexCleaned: boolean },
  ): void {
    if (!previousRoom || previousRoom.roomCode === joinedRoomCode) {
      return;
    }
    if (outcome.seated || outcome.indexCleaned) {
      publishSharedOwnerResync(previousRoom.roomCode);
    }
  }

  function handleRateLimitedMessage(
    session: Session,
    messageType: string,
  ): void {
    metricsCollector?.recordRateLimited(messageType);
    logEvent("rate_limited", {
      sessionId: session.id,
      roomCode: session.roomCode,
      remoteAddress: session.remoteAddress,
      origin: session.origin,
      messageType,
      result: "rejected",
    });
  }

  async function measureMessageHandling(
    messageType: MonitoredMessageType,
    handler: () => Promise<void>,
  ): Promise<void> {
    const startedAt = performance.now();
    try {
      await handler();
    } finally {
      metricsCollector?.observeMessageHandlerDuration(
        messageType,
        performance.now() - startedAt,
      );
    }
  }

  function checkProtocolVersion(
    session: Session,
    socket: WebSocket,
    clientVersion: number | undefined,
  ): boolean {
    if (clientVersion === undefined) {
      // Old extension without protocolVersion — compatible baseline, log deprecation
      if (session.protocolVersion === undefined) {
        metricsCollector?.recordSessionProtocolVersion("legacy");
      }
      session.protocolVersion = MIN_PROTOCOL_VERSION;
      logEvent("protocol_version_missing", {
        sessionId: session.id,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        result: "accepted",
        reason: "legacy_client",
      });
      return true;
    }
    if (clientVersion < MIN_PROTOCOL_VERSION) {
      sendError(
        socket,
        "unsupported_protocol_version",
        UNSUPPORTED_PROTOCOL_VERSION_MESSAGE,
      );
      logEvent("protocol_version_rejected", {
        sessionId: session.id,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        result: "rejected",
        clientVersion,
        minVersion: MIN_PROTOCOL_VERSION,
      });
      return false;
    }
    // Count each session once, at its first accepted handshake, so the
    // per-version series tracks connected-client population rather than
    // room:create/room:join message volume. The label set must stay bounded
    // even though clients control the value: anything above the server's
    // current version collapses into a single "future" bucket so a hostile
    // client cannot mint unbounded Prometheus series.
    if (session.protocolVersion === undefined) {
      metricsCollector?.recordSessionProtocolVersion(
        clientVersion <= CURRENT_PROTOCOL_VERSION
          ? String(clientVersion)
          : "future",
      );
    }
    session.protocolVersion = clientVersion;
    return true;
  }

  async function handleClientMessage(
    session: Session,
    message: ClientMessage,
  ): Promise<void> {
    const currentTime = now();
    if (!hasAttachedSocket(session)) {
      throw new Error(
        `Detached session cannot process client message: ${session.id}.`,
      );
    }
    const socket = session.socket;

    try {
      switch (message.type) {
        case "room:create": {
          const previousRoomCode = session.roomCode;
          // Captured before the service call: entering the new room overwrites
          // `memberId`, and the old room's delta needs the seat that is leaving.
          const previousRoom = previousRoomCode
            ? {
                roomCode: previousRoomCode,
                memberId: session.memberId ?? session.id,
                displayName: session.displayName,
              }
            : null;
          if (
            !consumeFixedWindow(
              session.rateLimitState.roomCreate,
              config.rateLimits.roomCreatePerMinute,
              WINDOW_MINUTE_MS,
              currentTime,
            )
          ) {
            handleRateLimitedMessage(session, message.type);
            sendError(socket, "rate_limited", RATE_LIMITED_MESSAGE);
            return;
          }
          if (
            !checkProtocolVersion(
              session,
              socket,
              message.payload?.protocolVersion,
            )
          ) {
            return;
          }

          const { room, memberToken } = await enterRoom(
            session,
            previousRoom,
            () =>
              roomService.createRoomForSession(
                session,
                message.payload?.displayName,
              ),
          );
          let previousRoomIndexCleaned = false;
          if (previousRoom && previousRoom.roomCode !== room.code) {
            previousRoomIndexCleaned = await releasePreviousRoom(
              session,
              previousRoom,
            );
          }
          const seated = await runRoomJoinedHook(
            session,
            room.code,
            previousRoomCode,
          );
          if (!seated) {
            await abortJoin(session, room.code, socket);
            // The refused join is the NEW room's problem; the old room is still
            // owed its state, and a clean index is the licence to send it.
            publishPreviousRoomResync(previousRoom, room.code, {
              seated,
              indexCleaned: previousRoomIndexCleaned,
            });
            return;
          }
          publishPreviousRoomResync(previousRoom, room.code, {
            seated,
            indexCleaned: previousRoomIndexCleaned,
          });
          send(socket, {
            type: "room:created",
            payload: {
              roomCode: room.code,
              memberId: session.memberId ?? session.id,
              joinToken: room.joinToken,
              memberToken,
              serverProtocolVersion: CURRENT_PROTOCOL_VERSION,
            },
          });
          await sendRoomStateToSession(session, memberToken, message.type);
          logEvent("room_created", {
            sessionId: session.id,
            roomCode: room.code,
            memberId: session.memberId ?? session.id,
            displayName: session.displayName,
            remoteAddress: session.remoteAddress,
            origin: session.origin,
            result: "ok",
          });
          return;
        }
        case "room:join": {
          const previousRoomCode = session.roomCode;
          // Captured before the service call: entering the new room overwrites
          // `memberId`, and the old room's delta needs the seat that is leaving.
          const previousRoom = previousRoomCode
            ? {
                roomCode: previousRoomCode,
                memberId: session.memberId ?? session.id,
                displayName: session.displayName,
              }
            : null;
          if (
            !consumeFixedWindow(
              session.rateLimitState.roomJoin,
              config.rateLimits.roomJoinPerMinute,
              WINDOW_MINUTE_MS,
              currentTime,
            )
          ) {
            handleRateLimitedMessage(session, message.type);
            sendError(socket, "rate_limited", RATE_LIMITED_MESSAGE);
            return;
          }
          if (
            !checkProtocolVersion(
              session,
              socket,
              message.payload.protocolVersion,
            )
          ) {
            return;
          }

          await measureMessageHandling("room:join", async () => {
            const { room, memberToken } = await enterRoom(
              session,
              previousRoom,
              () =>
                roomService.joinRoomForSession(
                  session,
                  message.payload.roomCode,
                  message.payload.joinToken,
                  message.payload.displayName,
                  message.payload.memberToken,
                ),
            );
            let previousRoomIndexCleaned = false;
            if (previousRoom && previousRoom.roomCode !== room.code) {
              previousRoomIndexCleaned = await releasePreviousRoom(
                session,
                previousRoom,
              );
            }
            const seated = await runRoomJoinedHook(
              session,
              room.code,
              previousRoomCode,
            );
            if (!seated) {
              await abortJoin(session, room.code, socket);
              publishPreviousRoomResync(previousRoom, room.code, {
                seated,
                indexCleaned: previousRoomIndexCleaned,
              });
              return;
            }
            publishPreviousRoomResync(previousRoom, room.code, {
              seated,
              indexCleaned: previousRoomIndexCleaned,
            });
            const joinedRoomCode = room.code;
            const joinedMemberId = session.memberId ?? session.id;
            const joinedDisplayName = session.displayName;
            send(socket, {
              type: "room:joined",
              payload: {
                roomCode: joinedRoomCode,
                memberId: joinedMemberId,
                memberToken,
                serverProtocolVersion: CURRENT_PROTOCOL_VERSION,
              },
            });
            const bootstrapState = await sendRoomStateToSession(
              session,
              memberToken,
              message.type,
            );
            if (
              session.roomCode !== joinedRoomCode ||
              session.memberId !== joinedMemberId
            ) {
              logEvent("room_join_delta_skipped", {
                sessionId: session.id,
                roomCode: joinedRoomCode,
                memberId: joinedMemberId,
                remoteAddress: session.remoteAddress,
                origin: session.origin,
                result: "skipped",
                reason: "session_no_longer_joined",
              });
              return;
            }
            await firePublishRoomEvent(
              {
                type: "room_member_joined",
                roomCode: joinedRoomCode,
                memberId: joinedMemberId,
                displayName: joinedDisplayName,
              },
              {
                reason: "join_room_broadcast_failed",
                sessionId: session.id,
                remoteAddress: session.remoteAddress,
                origin: session.origin,
              },
            );
            // This joiner owns the share, so everyone else is still pointing at
            // whoever owned it a moment ago (#235). Usually it means the stored
            // sharer came back, but the test is deliberately "did the joiner end
            // up owning it" rather than "is the joiner the stored sharer": a
            // join can only move the share by winning it, and asking the state
            // we just sent keeps that answer free of any assumption about how
            // the election ranks members.
            //
            // An unknown answer resyncs too. The same reasoning as the leave
            // path: we could not work out whether the share moved, and silence
            // leaves the room pointing at a stand-in with nothing scheduled to
            // correct it.
            //
            // So does re-entering the room the session was already in. That path
            // skips `releasePreviousRoom` — rightly, since nobody left — but the
            // service still leaves and rejoins internally, which re-stamps
            // `joinedAt` and can issue a fresh `memberId`. Either is enough to
            // hand the share to another member who was already seated, and the
            // check above stays silent because this joiner did not end up owning
            // it (#235 review). We cannot compare against the pre-rejoin owner
            // from here, so this path resyncs unconditionally; it costs one
            // broadcast on a redundant join from an already-joined session.
            if (
              !bootstrapState.known ||
              bootstrapState.sharedOwnerId === joinedMemberId ||
              previousRoom?.roomCode === joinedRoomCode
            ) {
              publishSharedOwnerResync(joinedRoomCode);
            }
            logEvent("room_joined", {
              sessionId: session.id,
              roomCode: joinedRoomCode,
              memberId: joinedMemberId,
              displayName: joinedDisplayName,
              remoteAddress: session.remoteAddress,
              origin: session.origin,
              result: "ok",
            });
          });
          return;
        }
        case "room:leave": {
          if (
            message.payload?.memberToken &&
            session.memberToken &&
            message.payload.memberToken !== session.memberToken
          ) {
            sendError(
              socket,
              "member_token_invalid",
              MEMBER_TOKEN_INVALID_MESSAGE,
            );
            return;
          }
          await measureMessageHandling("room:leave", async () => {
            // The verdict is for `abortJoin`; an explicit leave already gates
            // its own publishing on it inside `leaveRoom`.
            await leaveRoom(session);
          });
          return;
        }
        case "profile:update": {
          const { room } = await roomService.updateProfileForSession(
            session,
            message.payload.memberToken,
            message.payload.displayName,
          );
          await firePublishRoomEvent(
            {
              type: "room_state_updated",
              roomCode: room.code,
            },
            {
              reason: "profile_update_broadcast_failed",
              sessionId: session.id,
              remoteAddress: session.remoteAddress,
              origin: session.origin,
            },
          );
          return;
        }
        case "video:share": {
          if (
            !consumeFixedWindow(
              session.rateLimitState.videoShare,
              config.rateLimits.videoSharePer10Seconds,
              WINDOW_10_SECONDS_MS,
              currentTime,
            )
          ) {
            handleRateLimitedMessage(session, message.type);
            sendError(socket, "rate_limited", RATE_LIMITED_MESSAGE);
            return;
          }

          await measureMessageHandling("video:share", async () => {
            const { room } = await roomService.shareVideoForSession(
              session,
              message.payload.memberToken,
              message.payload.video,
              message.payload.playback,
            );
            await firePublishRoomEvent(
              {
                type: "room_state_updated",
                roomCode: room.code,
              },
              {
                reason: "video_share_broadcast_failed",
                sessionId: session.id,
                remoteAddress: session.remoteAddress,
                origin: session.origin,
              },
            );
          });
          return;
        }
        case "playback:update": {
          if (
            !consumeTokenBucket(
              session.rateLimitState.playbackUpdate,
              config.rateLimits.playbackUpdatePerSecond,
              config.rateLimits.playbackUpdateBurst,
              currentTime,
            )
          ) {
            handleRateLimitedMessage(session, message.type);
            return;
          }

          await measureMessageHandling("playback:update", async () => {
            const result = await roomService.updatePlaybackForSession(
              session,
              message.payload.memberToken,
              message.payload.playback,
            );
            if (!result.ignored && result.room) {
              await firePublishRoomEvent(
                {
                  type: "room_state_updated",
                  roomCode: result.room.code,
                },
                {
                  reason: "playback_update_broadcast_failed",
                  sessionId: session.id,
                  remoteAddress: session.remoteAddress,
                  origin: session.origin,
                },
              );
            }
          });
          return;
        }
        case "sync:request": {
          if (
            !consumeFixedWindow(
              session.rateLimitState.syncRequest,
              config.rateLimits.syncRequestPer10Seconds,
              WINDOW_10_SECONDS_MS,
              currentTime,
            )
          ) {
            handleRateLimitedMessage(session, message.type);
            sendError(socket, "rate_limited", RATE_LIMITED_MESSAGE);
            return;
          }

          await measureMessageHandling("sync:request", async () => {
            const state = await roomService.getRoomStateForSession(
              session,
              message.payload.memberToken,
              message.type,
            );
            send(socket, {
              type: "room:state",
              payload: withPlaybackAge(state, now()),
            });
          });
          return;
        }
        case "sync:ping": {
          if (
            !consumeTokenBucket(
              session.rateLimitState.syncPing,
              config.rateLimits.syncPingPerSecond,
              config.rateLimits.syncPingBurst,
              currentTime,
            )
          ) {
            handleRateLimitedMessage(session, message.type);
            return;
          }

          send(socket, {
            type: "sync:pong",
            payload: {
              clientSendTime: message.payload.clientSendTime,
              serverReceiveTime: currentTime,
              serverSendTime: now(),
            },
          });
          return;
        }
        default: {
          const exhaustiveCheck: never = message;
          return exhaustiveCheck;
        }
      }
    } catch (error) {
      if (error instanceof RoomServiceError) {
        let code: ErrorCode = error.code;
        let errorMessage = error.message;
        if (
          code === "room_resolution_unconfirmed" &&
          message.type === "room:join" &&
          (session.protocolVersion ?? MIN_PROTOCOL_VERSION) <
            ROOM_RESOLUTION_RETRY_PROTOCOL_VERSION
        ) {
          // Older clients cannot retry this additive third outcome: their join
          // state machine only knows success or terminal failure and would stay
          // pending forever on an unknown/transient code. Preserve the pre-v5
          // behaviour for them; v5+ clients keep the join intent and retry the
          // same server-side collection effect.
          code = "room_not_found";
          errorMessage = ROOM_NOT_FOUND_MESSAGE;
        }
        sendError(socket, code, errorMessage);
        if (error.reason === "internal_error") {
          logEvent("room_persist_failed", {
            sessionId: session.id,
            roomCode: session.roomCode,
            remoteAddress: session.remoteAddress,
            origin: session.origin,
            result: "error",
            reason: error.reason,
          });
        }
        return;
      }

      throw error;
    }
  }

  return {
    handleClientMessage,
    leaveRoom,
    flushPendingPublishes,
  };
}
