import type { ClientMessage } from "@bili-syncplay/protocol";
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
  MEMBER_TOKEN_INVALID_MESSAGE,
  RATE_LIMITED_MESSAGE,
  UNSUPPORTED_PROTOCOL_VERSION_MESSAGE,
  MIN_PROTOCOL_VERSION,
  CURRENT_PROTOCOL_VERSION,
} from "./messages.js";
import { RoomServiceError, type LeaveRoomReason } from "./room-service.js";
import { withPlaybackAge } from "./room-state-age.js";
import type { RoomEventBusMessage } from "./room-event-bus.js";
import { hasAttachedSocket } from "./types.js";
import type { LogEvent, SendError, SendMessage, Session } from "./types.js";

type RoomEventBusPublishInput<T> = T extends unknown
  ? Omit<T, "sourceInstanceId" | "emittedAt">
  : never;

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
  leaveRoom: (session: Session, reason?: LeaveRoomReason) => Promise<void>;
  flushPendingPublishes: () => Promise<void>;
} {
  const { config, roomService, logEvent, send, sendError } = options;
  const now = options.now ?? Date.now;
  const metricsCollector = options.metricsCollector;
  const pendingPublishes = new Set<Promise<void>>();
  const maxPendingPublishes = options.maxPendingPublishes ?? 256;
  const backpressureWaitMs = options.backpressureWaitMs ?? 5_000;
  const publishTimeoutMs = options.publishTimeoutMs ?? 5_000;

  async function runRoomJoinedHook(
    session: Session,
    roomCode: string,
    previousRoomCode: string | null,
  ): Promise<void> {
    try {
      await options.onRoomJoined?.(session, roomCode, previousRoomCode);
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

  async function flushPendingPublishes(): Promise<void> {
    while (pendingPublishes.size > 0) {
      await Promise.allSettled(Array.from(pendingPublishes));
    }
  }

  async function leaveRoom(
    session: Session,
    reason: LeaveRoomReason = "client-request",
  ): Promise<void> {
    const roomCode = session.roomCode;
    const memberId = session.memberId ?? session.id;
    const displayName = session.displayName;
    const { room, notifyRoom, memberRemoved, needsRoomStateResync } =
      await roomService.leaveRoomForSession(session, reason);
    if (!roomCode || (!room && !notifyRoom)) {
      return;
    }
    const roomIndexCleaned = await runRoomLeftHook(session, roomCode);
    if (!memberRemoved && !notifyRoom) {
      return;
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
    if (needsRoomStateResync && roomIndexCleaned) {
      await publishSharedOwnerResync(session, roomCode);
    }
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
   */
  async function publishSharedOwnerResync(
    session: Session,
    roomCode: string,
    reason = "shared_owner_resync_broadcast_failed",
  ): Promise<void> {
    await firePublishRoomEvent(
      {
        type: "room_state_updated",
        roomCode,
      },
      {
        reason,
        sessionId: session.id,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
      },
    );
  }

  /**
   * A member switching rooms leaves the old one through `createRoomForSession` /
   * `joinRoomForSession`, which call `leaveCurrentRoom` internally and publish
   * nothing — so the old room is told neither that the member is gone nor that
   * the share may have moved with them (#235 review).
   *
   * One full `room:state` covers both: it carries the corrected roster and the
   * resolved owner. Unconditional, because the internal leave's verdict never
   * reaches here, and a switch is rare enough that one broadcast is cheaper
   * than plumbing it out.
   */
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
    previousRoomCode: string | null,
    enter: () => Promise<T>,
  ): Promise<T> {
    try {
      return await enter();
    } catch (error) {
      if (previousRoomCode && session.roomCode !== previousRoomCode) {
        await releasePreviousRoom(session, previousRoomCode);
      }
      throw error;
    }
  }

  async function releasePreviousRoom(
    session: Session,
    previousRoomCode: string,
  ): Promise<void> {
    const roomIndexCleaned = await runRoomLeftHook(session, previousRoomCode);
    if (!roomIndexCleaned) {
      return;
    }
    await publishSharedOwnerResync(
      session,
      previousRoomCode,
      "room_switch_resync_broadcast_failed",
    );
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
            previousRoomCode,
            () =>
              roomService.createRoomForSession(
                session,
                message.payload?.displayName,
              ),
          );
          if (previousRoomCode && previousRoomCode !== room.code) {
            await releasePreviousRoom(session, previousRoomCode);
          }
          await runRoomJoinedHook(session, room.code, previousRoomCode);
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
              previousRoomCode,
              () =>
                roomService.joinRoomForSession(
                  session,
                  message.payload.roomCode,
                  message.payload.joinToken,
                  message.payload.displayName,
                  message.payload.memberToken,
                ),
            );
            if (previousRoomCode && previousRoomCode !== room.code) {
              await releasePreviousRoom(session, previousRoomCode);
            }
            await runRoomJoinedHook(session, room.code, previousRoomCode);
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
            if (
              !bootstrapState.known ||
              bootstrapState.sharedOwnerId === joinedMemberId
            ) {
              await publishSharedOwnerResync(session, joinedRoomCode);
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
          await measureMessageHandling("room:leave", () => leaveRoom(session));
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
        sendError(socket, error.code, error.message);
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
