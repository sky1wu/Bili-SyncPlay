import type { GlobalEventStore } from "./global-event-store.js";
import type { RoomDetail, RoomListQuery, RoomSummary } from "./types.js";
import type { PersistedRoom, Session } from "../types.js";
import type { RoomStore } from "../room-store.js";
import type { RuntimeStore } from "../runtime-store.js";

function toSummary(
  room: PersistedRoom,
  activeSessions: Session[],
): RoomSummary {
  const instanceIds = Array.from(
    new Set(
      activeSessions
        .map((session) => session.instanceId ?? null)
        .filter((instanceId): instanceId is string => Boolean(instanceId)),
    ),
  ).sort();

  return {
    instanceId: instanceIds.length === 1 ? instanceIds[0] : undefined,
    roomCode: room.code,
    createdAt: room.createdAt,
    lastActiveAt: room.lastActiveAt,
    expiresAt: room.expiresAt,
    sharedVideo: room.sharedVideo,
    playback: room.playback,
    memberCount: activeSessions.length,
    isActive: activeSessions.length > 0,
    instanceIds: instanceIds.filter(
      (instanceId): instanceId is string => typeof instanceId === "string",
    ),
  };
}

export function createAdminRoomQueryService(options: {
  instanceId: string;
  roomStore: RoomStore;
  runtimeStore: RuntimeStore;
  eventStore: GlobalEventStore;
}) {
  async function filterByStatus(
    items: PersistedRoom[],
    status: RoomListQuery["status"],
  ): Promise<PersistedRoom[]> {
    if (status === "all") {
      return items;
    }

    const roomsWithState = await Promise.all(
      items.map(async (room) => ({
        room,
        isActive:
          (await options.runtimeStore.listClusterSessionsByRoom(room.code))
            .length > 0,
      })),
    );

    return roomsWithState
      .filter(({ isActive }) => (status === "active" ? isActive : !isActive))
      .map(({ room }) => room);
  }

  return {
    async listRooms(query: RoomListQuery) {
      const baseRooms =
        query.status === "all"
          ? await options.roomStore.listRooms(query)
          : await filterByStatus(
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

      const roomItems = await Promise.all(
        selected.map(async (room) => {
          const activeSessions = await options.runtimeStore.listClusterSessionsByRoom(
            room.code,
          );
          return {
            ...toSummary(room, activeSessions),
            instanceId:
              activeSessions.length === 0 ? options.instanceId : undefined,
          };
        }),
      );

      return {
        items: roomItems,
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

      const sessions = await options.runtimeStore.listClusterSessionsByRoom(
        roomCode,
      );
      return {
        instanceId:
          sessions.length === 1 ? (sessions[0]?.instanceId ?? options.instanceId) : undefined,
        room: {
          ...toSummary(room, sessions),
        },
        members: sessions.map((session) => ({
          sessionId: session.id,
          memberId: session.memberId ?? session.id,
          instanceId: session.instanceId ?? undefined,
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
