import { Redis } from "ioredis";
import type { RoomListQuery } from "./admin/types.js";
import { getRedisRoomStoreKeys } from "./redis-namespace.js";
import {
  createPersistedRoom,
  type RoomStore,
  type RoomUpdateResult,
} from "./room-store.js";
import type { PersistedRoom } from "./types.js";

const DELETE_EXPIRED_ROOMS_LUA = `
local expiryKey = KEYS[1]
local roomKeyPrefix = ARGV[1]
local now = tonumber(ARGV[2])
local expiredCodes = redis.call("ZRANGEBYSCORE", expiryKey, 0, now)
local deletedCount = 0

for _, code in ipairs(expiredCodes) do
  local key = roomKeyPrefix .. code
  local rawRoom = redis.call("GET", key)

  if rawRoom then
    local ok, room = pcall(cjson.decode, rawRoom)
    if ok and room and room["expiresAt"] ~= cjson.null and room["expiresAt"] ~= nil and tonumber(room["expiresAt"]) ~= nil and tonumber(room["expiresAt"]) <= now then
      redis.call("DEL", key)
      redis.call("ZREM", expiryKey, code)
      deletedCount = deletedCount + 1
    elseif ok and room and (room["expiresAt"] == cjson.null or room["expiresAt"] == nil) then
      redis.call("ZREM", expiryKey, code)
    end
  else
    redis.call("ZREM", expiryKey, code)
  end
end

return deletedCount
`;

function serializeRoom(room: PersistedRoom): string {
  return JSON.stringify(room);
}

function parseRoom(value: string | null): PersistedRoom | null {
  if (!value) {
    return null;
  }
  return JSON.parse(value) as PersistedRoom;
}

function matchesQuery(
  room: PersistedRoom,
  query: Pick<RoomListQuery, "keyword" | "includeExpired">,
): boolean {
  if (
    !query.includeExpired &&
    room.expiresAt !== null &&
    room.expiresAt <= Date.now()
  ) {
    return false;
  }
  if (
    query.keyword &&
    !room.code.toLowerCase().includes(query.keyword.toLowerCase())
  ) {
    return false;
  }
  return true;
}

async function updateExpiryIndex(
  redis: Redis,
  roomExpiryKey: string,
  room: PersistedRoom,
): Promise<void> {
  if (room.expiresAt === null) {
    await redis.zrem(roomExpiryKey, room.code);
    return;
  }
  await redis.zadd(roomExpiryKey, String(room.expiresAt), room.code);
}

export async function createRedisRoomStore(
  redisUrl: string,
  options: {
    namespace?: string;
  } = {},
): Promise<RoomStore & { close: () => Promise<void> }> {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const { roomKeyPrefix, roomExpiryKey, roomIndexKey } = getRedisRoomStoreKeys(
    options.namespace,
  );

  function roomKey(code: string): string {
    return `${roomKeyPrefix}${code}`;
  }

  await redis.connect();

  async function fetchRooms(
    query: Pick<
      RoomListQuery,
      | "keyword"
      | "includeExpired"
      | "page"
      | "pageSize"
      | "sortBy"
      | "sortOrder"
    >,
  ) {
    const ascending = query.sortOrder === "asc";
    const codes =
      query.sortBy === "lastActiveAt"
        ? ascending
          ? await redis.zrange(roomIndexKey, 0, -1)
          : await redis.zrevrange(roomIndexKey, 0, -1)
        : await redis.keys(`${roomKeyPrefix}*`);

    const normalizedCodes =
      query.sortBy === "createdAt"
        ? codes.map((key) => key.replace(roomKeyPrefix, ""))
        : codes;
    const rooms = (
      await Promise.all(
        normalizedCodes.map(async (code) =>
          parseRoom(await redis.get(roomKey(code))),
        ),
      )
    ).filter((room): room is PersistedRoom => room !== null);

    rooms.sort((left, right) => {
      const factor = query.sortOrder === "asc" ? 1 : -1;
      return (left[query.sortBy] - right[query.sortBy]) * factor;
    });

    const filtered = rooms.filter((room) => matchesQuery(room, query));
    const start = (query.page - 1) * query.pageSize;
    return filtered.slice(start, start + query.pageSize);
  }

  return {
    async createRoom(input) {
      const room = createPersistedRoom(input);
      const transaction = redis.multi();
      transaction.set(roomKey(room.code), serializeRoom(room), "NX");
      transaction.zadd(roomIndexKey, String(room.lastActiveAt), room.code);
      const [created] = (await transaction.exec()) ?? [];
      if (!created || created[1] !== "OK") {
        throw new Error(`Room ${room.code} already exists.`);
      }
      return room;
    },
    async getRoom(code) {
      return parseRoom(await redis.get(roomKey(code)));
    },
    async saveRoom(room) {
      const transaction = redis.multi();
      transaction.set(roomKey(room.code), serializeRoom(room));
      transaction.zadd(roomIndexKey, String(room.lastActiveAt), room.code);
      await transaction.exec();
      await updateExpiryIndex(redis, roomExpiryKey, room);
      return room;
    },
    async updateRoom(code, expectedVersion, patch): Promise<RoomUpdateResult> {
      const key = roomKey(code);
      await redis.watch(key);
      try {
        const currentRoom = parseRoom(await redis.get(key));
        if (!currentRoom) {
          return { ok: false, reason: "not_found" };
        }
        if (currentRoom.version !== expectedVersion) {
          return { ok: false, reason: "version_conflict" };
        }

        const nextRoom: PersistedRoom = {
          ...currentRoom,
          ...patch,
          version: currentRoom.version + 1,
        };

        const transaction = redis.multi();
        transaction.set(key, serializeRoom(nextRoom));
        transaction.zadd(roomIndexKey, String(nextRoom.lastActiveAt), code);
        if (nextRoom.expiresAt === null) {
          transaction.zrem(roomExpiryKey, code);
        } else {
          transaction.zadd(roomExpiryKey, String(nextRoom.expiresAt), code);
        }
        const result = await transaction.exec();
        if (result === null) {
          return { ok: false, reason: "version_conflict" };
        }
        return { ok: true, room: nextRoom };
      } finally {
        await redis.unwatch();
      }
    },
    async deleteRoom(code) {
      const transaction = redis.multi();
      transaction.del(roomKey(code));
      transaction.zrem(roomExpiryKey, code);
      transaction.zrem(roomIndexKey, code);
      await transaction.exec();
    },
    async deleteExpiredRooms(now) {
      const deletedCount = await redis.eval(
        DELETE_EXPIRED_ROOMS_LUA,
        1,
        roomExpiryKey,
        roomKeyPrefix,
        String(now),
      );
      return Number(deletedCount);
    },
    async listRooms(
      query: Pick<
        RoomListQuery,
        | "keyword"
        | "includeExpired"
        | "page"
        | "pageSize"
        | "sortBy"
        | "sortOrder"
      >,
    ) {
      return await fetchRooms(query);
    },
    async countRooms(query: Pick<RoomListQuery, "keyword" | "includeExpired">) {
      const rooms = await fetchRooms({
        ...query,
        page: 1,
        pageSize: Number.MAX_SAFE_INTEGER,
        sortBy: "lastActiveAt",
        sortOrder: "desc",
      });
      return rooms.length;
    },
    async isReady() {
      try {
        const pong = await redis.ping();
        return pong === "PONG";
      } catch {
        return false;
      }
    },
    async close() {
      await redis.quit();
    },
  };
}
