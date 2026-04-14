import type { ClientMessage } from "@bili-syncplay/protocol";
import {
  consumeFixedWindow,
  consumeTokenBucket,
  WINDOW_10_SECONDS_MS,
  WINDOW_MINUTE_MS,
} from "./rate-limit.js";
import {
  MEMBER_TOKEN_INVALID_MESSAGE,
  RATE_LIMITED_MESSAGE,
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
    ) => Promise<{ room: { code: string } | null }>;
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
} {
  const { config, roomService, logEvent, send, sendError } = options;
  const now = options.now ?? Date.now;

  async function publishRoomEvent(
    type: RoomEventBusMessage["type"],
    roomCode: string,
  ): Promise<void> {
    await options.publishRoomEvent({
      type,
      roomCode,
      sourceInstanceId: options.instanceId,
      emittedAt: now(),
    });
  }

  async function leaveRoom(session: Session): Promise<void> {
    const roomCode = session.roomCode;
    const { room } = await roomService.leaveRoomForSession(session);
    if (!roomCode || !room) {
      return;
    }
    options.onRoomLeft?.(session, roomCode);

    try {
      await publishRoomEvent("room_member_changed", roomCode);
    } catch (error) {
      logEvent("room_event_publish_failed", {
        sessionId: session.id,
        roomCode,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        result: "error",
        reason: "leave_room_broadcast_failed",
        eventType: "room_member_changed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
            },
          });
          await publishRoomEvent("room_member_changed", room.code);
          logEvent("room_created", {
            sessionId: session.id,
            roomCode: room.code,
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
            },
          });
          await publishRoomEvent("room_member_changed", room.code);
          logEvent("room_joined", {
            sessionId: session.id,
            roomCode: room.code,
            remoteAddress: session.remoteAddress,
            origin: session.origin,
            result: "ok",
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
          await leaveRoom(session);
          return;
        }
        case "profile:update": {
          const { room } = await roomService.updateProfileForSession(
            session,
            message.payload.memberToken,
            message.payload.displayName,
          );
          await publishRoomEvent("room_state_updated", room.code);
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

          const { room } = await roomService.shareVideoForSession(
            session,
            message.payload.memberToken,
            message.payload.video,
            message.payload.playback,
          );
          await publishRoomEvent("room_state_updated", room.code);
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

          const result = await roomService.updatePlaybackForSession(
            session,
            message.payload.memberToken,
            message.payload.playback,
          );
          if (!result.ignored && result.room) {
            await publishRoomEvent("room_state_updated", result.room.code);
          }
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
  };
}
