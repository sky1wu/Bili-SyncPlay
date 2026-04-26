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
import { RoomServiceError } from "./room-service.js";
import type { RoomEventBusMessage } from "./room-event-bus.js";
import { hasAttachedSocket } from "./types.js";
import type { LogEvent, SendError, SendMessage, Session } from "./types.js";

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
    ) => Promise<{ room: { code: string } | null; notifyRoom?: boolean }>;
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
  metricsCollector?: Pick<MetricsCollector, "observeMessageHandlerDuration">;
  maxPendingPublishes?: number;
  backpressureWaitMs?: number;
  onRoomJoined?: (
    session: Session,
    roomCode: string,
    previousRoomCode: string | null,
  ) => void;
  onRoomLeft?: (session: Session, roomCode: string) => void;
  now?: () => number;
}): {
  handleClientMessage: (
    session: Session,
    message: ClientMessage,
  ) => Promise<void>;
  leaveRoom: (session: Session) => Promise<void>;
  flushPendingPublishes: () => Promise<void>;
} {
  const { config, roomService, logEvent, send, sendError } = options;
  const now = options.now ?? Date.now;
  const metricsCollector = options.metricsCollector;
  const pendingPublishes = new Set<Promise<void>>();
  const maxPendingPublishes = options.maxPendingPublishes ?? 256;
  const backpressureWaitMs = options.backpressureWaitMs ?? 5_000;

  async function firePublishRoomEvent(
    type: RoomEventBusMessage["type"],
    roomCode: string,
    context: {
      reason: string;
      sessionId?: string;
      remoteAddress?: string | null;
      origin?: string | null;
    },
  ): Promise<void> {
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
          return;
        }
      }
    }
    const promise = options
      .publishRoomEvent({
        type,
        roomCode,
        sourceInstanceId: options.instanceId,
        emittedAt: now(),
      })
      .catch((error: unknown) => {
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
      });
    pendingPublishes.add(promise);
    void promise.finally(() => {
      pendingPublishes.delete(promise);
    });
  }

  async function flushPendingPublishes(): Promise<void> {
    while (pendingPublishes.size > 0) {
      await Promise.allSettled(Array.from(pendingPublishes));
    }
  }

  async function leaveRoom(session: Session): Promise<void> {
    const roomCode = session.roomCode;
    const { room, notifyRoom } = await roomService.leaveRoomForSession(session);
    if (!roomCode || (!room && !notifyRoom)) {
      return;
    }
    options.onRoomLeft?.(session, roomCode);

    await firePublishRoomEvent("room_member_changed", roomCode, {
      reason: "leave_room_broadcast_failed",
      sessionId: session.id,
      remoteAddress: session.remoteAddress,
      origin: session.origin,
    });
  }

  function handleRateLimitedMessage(
    session: Session,
    messageType: string,
  ): void {
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

          const { room, memberToken } = await roomService.createRoomForSession(
            session,
            message.payload?.displayName,
          );
          if (previousRoomCode && previousRoomCode !== room.code) {
            options.onRoomLeft?.(session, previousRoomCode);
          }
          options.onRoomJoined?.(session, room.code, previousRoomCode);
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
          await firePublishRoomEvent("room_member_changed", room.code, {
            reason: "create_room_broadcast_failed",
            sessionId: session.id,
            remoteAddress: session.remoteAddress,
            origin: session.origin,
          });
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
            const { room, memberToken } = await roomService.joinRoomForSession(
              session,
              message.payload.roomCode,
              message.payload.joinToken,
              message.payload.displayName,
              message.payload.memberToken,
            );
            if (previousRoomCode && previousRoomCode !== room.code) {
              options.onRoomLeft?.(session, previousRoomCode);
            }
            options.onRoomJoined?.(session, room.code, previousRoomCode);
            send(socket, {
              type: "room:joined",
              payload: {
                roomCode: room.code,
                memberId: session.memberId ?? session.id,
                memberToken,
                serverProtocolVersion: CURRENT_PROTOCOL_VERSION,
              },
            });
            await firePublishRoomEvent("room_member_changed", room.code, {
              reason: "join_room_broadcast_failed",
              sessionId: session.id,
              remoteAddress: session.remoteAddress,
              origin: session.origin,
            });
            logEvent("room_joined", {
              sessionId: session.id,
              roomCode: room.code,
              memberId: session.memberId ?? session.id,
              displayName: session.displayName,
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
          await firePublishRoomEvent("room_state_updated", room.code, {
            reason: "profile_update_broadcast_failed",
            sessionId: session.id,
            remoteAddress: session.remoteAddress,
            origin: session.origin,
          });
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
            await firePublishRoomEvent("room_state_updated", room.code, {
              reason: "video_share_broadcast_failed",
              sessionId: session.id,
              remoteAddress: session.remoteAddress,
              origin: session.origin,
            });
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
                "room_state_updated",
                result.room.code,
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

          const state = await roomService.getRoomStateForSession(
            session,
            message.payload.memberToken,
            message.type,
          );
          send(socket, {
            type: "room:state",
            payload: state,
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
