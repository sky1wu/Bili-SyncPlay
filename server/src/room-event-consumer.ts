import {
  hasAttachedSocket,
  type AttachedSession,
  type SendMessage,
  type Session,
} from "./types.js";
import type { RoomEventBus, RoomEventBusMessage } from "./room-event-bus.js";
import type { ServerMessage } from "@bili-syncplay/protocol";

const MEMBER_DELTA_PROTOCOL_VERSION = 2;
type MemberDeltaMessage = Extract<
  RoomEventBusMessage,
  { type: "room_member_joined" | "room_member_left" }
>;

function supportsIncrementalMemberEvents(session: Session): boolean {
  return (session.protocolVersion ?? 1) >= MEMBER_DELTA_PROTOCOL_VERSION;
}

function createMemberMessage(
  message: RoomEventBusMessage,
): ServerMessage | null {
  if (message.type === "room_member_joined") {
    return {
      type: "room:member-joined",
      payload: {
        roomCode: message.roomCode,
        member: {
          id: message.memberId,
          name: message.displayName,
        },
      },
    };
  }
  if (message.type === "room_member_left") {
    return {
      type: "room:member-left",
      payload: {
        roomCode: message.roomCode,
        member: {
          id: message.memberId,
          name: message.displayName,
        },
      },
    };
  }
  return null;
}

function isRoomEventRecipient(
  session: Session,
  roomCode: string,
): session is AttachedSession {
  return hasAttachedSocket(session) && session.roomCode === roomCode;
}

function isMemberDeltaRecipient(
  session: Session,
  message: MemberDeltaMessage,
): session is AttachedSession {
  return (
    isRoomEventRecipient(session, message.roomCode) &&
    session.memberId !== message.memberId
  );
}

export async function createRoomEventConsumer(options: {
  roomEventBus: RoomEventBus;
  getRoomStateByCode: (
    roomCode: string,
  ) => Promise<import("./types.js").RoomStoreRoomState | null>;
  listLocalSessionsByRoom: (roomCode: string) => Session[];
  send: SendMessage;
  instanceId?: string;
  logEvent?: import("./types.js").LogEvent;
}): Promise<{ close: () => Promise<void> }> {
  const unsubscribe = await options.roomEventBus.subscribe(async (message) => {
    try {
      const localSessions = options.listLocalSessionsByRoom(message.roomCode);
      if (
        message.type === "room_member_joined" ||
        message.type === "room_member_left"
      ) {
        const memberMessage = createMemberMessage(message);
        if (!memberMessage) {
          return;
        }
        let legacyRoomState:
          Awaited<ReturnType<typeof options.getRoomStateByCode>> | undefined;
        let legacyRoomStateLoaded = false;
        async function getLegacyRoomState() {
          if (!legacyRoomStateLoaded) {
            legacyRoomState = await options.getRoomStateByCode(
              message.roomCode,
            );
            legacyRoomStateLoaded = true;
          }
          return legacyRoomState;
        }

        for (const session of localSessions) {
          if (!isMemberDeltaRecipient(session, message)) {
            continue;
          }
          if (supportsIncrementalMemberEvents(session)) {
            options.send(session.socket, memberMessage);
            continue;
          }

          const roomState = await getLegacyRoomState();
          if (!roomState || !isMemberDeltaRecipient(session, message)) {
            continue;
          }
          options.send(session.socket, {
            type: "room:state",
            payload: roomState,
          });
        }

        options.logEvent?.("room_event_consumed", {
          roomCode: message.roomCode,
          eventType: message.type,
          sourceInstanceId: message.sourceInstanceId,
          instanceId: options.instanceId ?? null,
          localSessionCount: localSessions.length,
          result: "ok",
        });
        return;
      }

      // The room event bus uses a single global channel, so every node
      // receives every room's events. Resolving room state before checking
      // whether any local session actually wants it turned one broadcast into
      // one room-store read per node — O(nodes x message rate) of pure waste,
      // and a full network round trip each once a node is not co-located with
      // Redis. The member-delta branch above already defers its read lazily.
      const recipients = localSessions.filter((session) =>
        isRoomEventRecipient(session, message.roomCode),
      );

      if (recipients.length > 0) {
        const state =
          message.type === "room_deleted"
            ? {
                roomCode: message.roomCode,
                sharedVideo: null,
                playback: null,
                members: [],
              }
            : await options.getRoomStateByCode(message.roomCode);
        if (!state) {
          return;
        }

        for (const session of recipients) {
          // Re-check after the await: a session can leave the room while the
          // state loads, and it must not receive another room's state.
          if (!isRoomEventRecipient(session, message.roomCode)) {
            continue;
          }
          options.send(session.socket, {
            type: "room:state",
            payload: state,
          });
        }
      }

      options.logEvent?.("room_event_consumed", {
        roomCode: message.roomCode,
        eventType: message.type,
        sourceInstanceId: message.sourceInstanceId,
        instanceId: options.instanceId ?? null,
        localSessionCount: localSessions.length,
        result: "ok",
      });
    } catch (error) {
      options.logEvent?.("room_event_consume_failed", {
        roomCode: message.roomCode,
        eventType: message.type,
        sourceInstanceId: message.sourceInstanceId,
        instanceId: options.instanceId ?? null,
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return {
    async close() {
      await unsubscribe();
    },
  };
}
