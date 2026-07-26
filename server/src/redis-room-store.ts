import { Redis } from "ioredis";
import type { RoomListQuery } from "./admin/types.js";
import { getRedisRoomStoreKeys } from "./redis-namespace.js";
import {
  createPersistedRoom,
  type RoomStore,
  type RoomUpdateResult,
} from "./room-store.js";
import type { PersistedRoom } from "./types.js";

// Every branch that stops a code from having a room body must also drop it
// from the room index, or the index grows without bound: it is the only
// enumeration source for listRooms/countRooms, so leftovers turn every room
// listing into a scan over every room the deployment has ever created.
const DELETE_EXPIRED_ROOMS_LUA = `
local expiryKey = KEYS[1]
local indexKey = KEYS[2]
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
      redis.call("ZREM", indexKey, code)
      deletedCount = deletedCount + 1
    elseif ok and room and (room["expiresAt"] == cjson.null or room["expiresAt"] == nil) then
      -- The room outlived its expiry candidacy; it keeps its index entry.
      redis.call("ZREM", expiryKey, code)
    end
  else
    redis.call("ZREM", expiryKey, code)
    redis.call("ZREM", indexKey, code)
  end
end

return deletedCount
`;

// ZREM takes variadic members; chunk so a first-run cleanup of a long-leaking
// index cannot build one multi-megabyte command.
const STALE_INDEX_PRUNE_CHUNK_SIZE = 500;

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
    // Both sort orders enumerate through the room index. Its members are the
    // room codes themselves, so sorting by createdAt needs nothing more than
    // the room bodies this function already loads — the previous KEYS scan
    // walked the entire Redis keyspace while blocking every other client.
    // Order here is irrelevant: rooms are re-sorted below by query.sortBy.
    const codes = await redis.zrange(roomIndexKey, 0, -1);

    const loaded = await Promise.all(
      codes.map(async (code) => ({
        code,
        room: parseRoom(await redis.get(roomKey(code))),
      })),
    );

    // A code with no room body is a leftover index entry. The reaper above
    // now cleans up after itself, but indexes written by earlier builds still
    // carry one entry per room they ever expired, so drop them on sight.
    const staleCodes = loaded
      .filter(({ room }) => room === null)
      .map(({ code }) => code);
    if (staleCodes.length > 0) {
      try {
        for (
          let offset = 0;
          offset < staleCodes.length;
          offset += STALE_INDEX_PRUNE_CHUNK_SIZE
        ) {
          await redis.zrem(
            roomIndexKey,
            ...staleCodes.slice(offset, offset + STALE_INDEX_PRUNE_CHUNK_SIZE),
          );
        }
      } catch {
        // Best effort: a failed prune only means the next call retries it.
      }
    }

    const rooms = loaded
      .map(({ room }) => room)
      .filter((room): room is PersistedRoom => room !== null);

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
        2,
        roomExpiryKey,
        roomIndexKey,
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
