import type { GlobalEventStore } from "./global-event-store.js";
import type { RoomDetail, RoomListQuery, RoomSummary } from "./types.js";
import type { PersistedRoom, Session } from "../types.js";
import type { RoomStore } from "../room-store.js";
import type { RuntimeStore } from "../runtime-store.js";

function toSummary(
  room: PersistedRoom,
  activeSessions: Session[],
): RoomSummary {
  return {
    roomCode: room.code,
    createdAt: room.createdAt,
    lastActiveAt: room.lastActiveAt,
    expiresAt: room.expiresAt,
    sharedVideo: room.sharedVideo,
    playback: room.playback,
    memberCount: activeSessions.length,
    isActive: activeSessions.length > 0,
  };
}

export function createAdminRoomQueryService(options: {
  instanceId: string;
  roomStore: RoomStore;
  runtimeStore: RuntimeStore;
  eventStore: GlobalEventStore;
}) {
  function filterByStatus(
    items: PersistedRoom[],
    status: RoomListQuery["status"],
  ): PersistedRoom[] {
    if (status === "all") {
      return items;
    }
    return items.filter((room) => {
      const isActive =
        options.runtimeStore.listSessionsByRoom(room.code).length > 0;
      return status === "active" ? isActive : !isActive;
    });
  }

  return {
    async listRooms(query: RoomListQuery) {
      const baseRooms =
        query.status === "all"
          ? await options.roomStore.listRooms(query)
          : filterByStatus(
              await options.roomStore.listRooms({
                ...query,
                page: 1,
                pageSize: Number.MAX_SAFE_INTEGER,
              }),
              query.status,
            );

      const total =
        query.status === "all"
          ? await options.roomStore.countRooms(query)
          : baseRooms.length;
      const start =
        query.status === "all" ? 0 : (query.page - 1) * query.pageSize;
      const selected =
        query.status === "all"
          ? baseRooms
          : baseRooms.slice(start, start + query.pageSize);

      return {
        items: selected.map((room) => ({
          ...toSummary(
            room,
            options.runtimeStore.listSessionsByRoom(room.code),
          ),
          instanceId: options.instanceId,
        })),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
        },
      };
    },
    async getRoomDetail(roomCode: string): Promise<RoomDetail | null> {
      const room = await options.roomStore.getRoom(roomCode);
      if (!room) {
        return null;
      }

      const sessions = options.runtimeStore.listSessionsByRoom(roomCode);
      return {
        instanceId: options.instanceId,
        room: {
          ...toSummary(room, sessions),
          instanceId: options.instanceId,
        },
        members: sessions.map((session) => ({
          sessionId: session.id,
          memberId: session.memberId ?? session.id,
          displayName: session.displayName,
          joinedAt: session.joinedAt,
          remoteAddress: session.remoteAddress,
          origin: session.origin,
        })),
        recentEvents: (
          await options.eventStore.query({
          roomCode,
          page: 1,
          pageSize: 20,
          })
        ).items,
      };
    },
  };
}
