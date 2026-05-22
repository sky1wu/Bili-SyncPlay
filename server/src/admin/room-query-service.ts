import type { GlobalEventStore } from "./global-event-store.js";
import type { RoomDetail, RoomListQuery, RoomSummary } from "./types.js";
import type { PersistedRoom, Session } from "../types.js";
import type { RoomStore } from "../room-store.js";
import type { RuntimeStore } from "../runtime-store.js";

function toSummary(
  room: PersistedRoom,
  activeSessions: Session[],
): RoomSummary {
  const ownerSession =
    room.ownerMemberId !== undefined && room.ownerMemberId !== null
      ? activeSessions.find((session) => {
          const memberId = session.memberId ?? session.id;
          return memberId === room.ownerMemberId;
        })
      : null;
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
    ownerMemberId: room.ownerMemberId ?? null,
    ownerDisplayName:
      ownerSession?.displayName ?? room.ownerDisplayName ?? null,
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

function tokenizeKeyword(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function collectHaystacks(room: PersistedRoom, sessions: Session[]): string[] {
  const values: Array<string | null | undefined> = [
    room.code,
    room.ownerDisplayName,
    room.sharedVideo?.title,
    room.sharedVideo?.url,
    room.sharedVideo?.sharedByDisplayName,
    ...sessions.map((session) => session.displayName),
  ];
  return values
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .map((value) => value.toLowerCase());
}

function matchesAllTokens(
  room: PersistedRoom,
  sessions: Session[],
  tokens: string[],
): boolean {
  if (tokens.length === 0) {
    return true;
  }
  const haystacks = collectHaystacks(room, sessions);
  return tokens.every((token) =>
    haystacks.some((haystack) => haystack.includes(token)),
  );
}

export function createAdminRoomQueryService(options: {
  instanceId: string;
  roomStore: RoomStore;
  runtimeStore: RuntimeStore;
  eventStore: GlobalEventStore;
}) {
  async function enrichWithSessions(rooms: PersistedRoom[]) {
    return Promise.all(
      rooms.map(async (room) => ({
        room,
        sessions: await options.runtimeStore.listClusterSessionsByRoom(
          room.code,
        ),
      })),
    );
  }

  return {
    async listRooms(query: RoomListQuery) {
      const tokens = tokenizeKeyword(query.keyword);
      const needsRuntime = query.status !== "all" || tokens.length > 0;
      const normalizedQuery: RoomListQuery = {
        ...query,
        keyword: tokens.length > 0 ? query.keyword : undefined,
      };

      if (!needsRuntime) {
        const baseRooms = await options.roomStore.listRooms(normalizedQuery);
        const total = await options.roomStore.countRooms(normalizedQuery);
        const roomItems = await Promise.all(
          baseRooms.map(async (room) => {
            const activeSessions =
              await options.runtimeStore.listClusterSessionsByRoom(room.code);
            const summary = toSummary(room, activeSessions);
            return {
              ...summary,
              instanceId: summary.instanceId ?? options.instanceId,
            };
          }),
        );
        return {
          items: roomItems,
          pagination: {
            page: normalizedQuery.page,
            pageSize: normalizedQuery.pageSize,
            total,
          },
        };
      }

      const allRooms = await options.roomStore.listRooms({
        ...normalizedQuery,
        keyword: undefined,
        page: 1,
        pageSize: Number.MAX_SAFE_INTEGER,
      });

      const enriched = await enrichWithSessions(allRooms);

      const filtered = enriched.filter(({ room, sessions }) => {
        if (!matchesAllTokens(room, sessions, tokens)) {
          return false;
        }
        if (normalizedQuery.status === "active") {
          return sessions.length > 0;
        }
        if (normalizedQuery.status === "idle") {
          return sessions.length === 0;
        }
        return true;
      });

      const total = filtered.length;
      const start = (normalizedQuery.page - 1) * normalizedQuery.pageSize;
      const selected = filtered.slice(start, start + normalizedQuery.pageSize);

      const roomItems = selected.map(({ room, sessions }) => {
        const summary = toSummary(room, sessions);
        return {
          ...summary,
          instanceId: summary.instanceId ?? options.instanceId,
        };
      });

      return {
        items: roomItems,
        pagination: {
          page: normalizedQuery.page,
          pageSize: normalizedQuery.pageSize,
          total,
        },
      };
    },
    async getRoomDetail(roomCode: string): Promise<RoomDetail | null> {
      const room = await options.roomStore.getRoom(roomCode);
      if (!room) {
        return null;
      }

      const sessions =
        await options.runtimeStore.listClusterSessionsByRoom(roomCode);
      return {
        instanceId:
          sessions.length === 1
            ? (sessions[0]?.instanceId ?? options.instanceId)
            : undefined,
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
