import { hasAttachedSocket, type SendMessage, type Session } from "./types.js";
import type { RoomEventBus } from "./room-event-bus.js";

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

      for (const session of localSessions) {
        if (!hasAttachedSocket(session)) {
          continue;
        }
        options.send(session.socket, {
          type: "room:state",
          payload: state,
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
