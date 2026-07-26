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

// Re-checks each candidate inside the script so a code cannot be dropped from
// the index between the caller's read and the removal: createRoom may reuse a
// just-reaped code, and its SET+ZADD transaction would otherwise be undone by
// a ZREM decided against the previous occupant of that code.
const PRUNE_STALE_INDEX_ENTRIES_LUA = `
local indexKey = KEYS[1]
local roomKeyPrefix = ARGV[1]
local removed = 0

for index = 2, #ARGV do
  local code = ARGV[index]
  if redis.call("EXISTS", roomKeyPrefix .. code) == 0 then
    removed = removed + redis.call("ZREM", indexKey, code)
  end
end

return removed
`;

// Same check-then-act hazard as the prune, mirrored: the room may be deleted
// between the caller reading its body and this write, and an unconditional
// ZADD would resurrect an index entry for a room that no longer exists.
const BACKFILL_INDEX_ENTRY_LUA = `
local indexKey = KEYS[1]
local roomKey = KEYS[2]

if redis.call("EXISTS", roomKey) == 0 then
  return 0
end

return redis.call("ZADD", indexKey, ARGV[1], ARGV[2])
`;

// Chunk both the prune and the backfill: a first run against an index that
// leaked for months must not build one multi-megabyte command or hold Redis
// inside a single long-running script.
const INDEX_REPAIR_CHUNK_SIZE = 500;

// SCAN MATCH takes a glob, so a namespace carrying glob metacharacters — a
// plain string as far as the config layer is concerned, e.g. "tenant[1]" —
// would silently match nothing and leave that deployment's legacy rooms
// unindexed forever.
function escapeGlobPattern(value: string): string {
  return value.replaceAll(/[\\*?[\]]/g, (character) => `\\${character}`);
}

// Compare-and-set in one round trip, replacing WATCH + GET + MULTI/EXEC +
// UNWATCH. The caller merges the patch in JS and hands over both the exact
// bytes it read and the fully serialized next room, so the script never
// decodes or re-encodes room JSON — Redis's cjson formats numbers with
// %.14g, which turns a seq of 9007199254740991 into 9.007199254741e+15 and
// clips playback positions.
//
// The guard compares the whole previous body rather than just its version,
// because that is what WATCH actually guaranteed: a room can be deleted and
// a later room created under the same code, and the new room starts at
// version 0 again. Comparing versions alone would let an update prepared
// against the old room overwrite the new one — joinToken and owner included.
const UPDATE_ROOM_CAS_LUA = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return "not_found"
end

if raw ~= ARGV[1] then
  return "version_conflict"
end

redis.call("SET", KEYS[1], ARGV[2])
redis.call("ZADD", KEYS[2], ARGV[3], ARGV[4])

if ARGV[5] == "" then
  redis.call("ZREM", KEYS[3], ARGV[4])
else
  redis.call("ZADD", KEYS[3], ARGV[5], ARGV[4])
end

return "ok"
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

  // The room index landed after Redis persistence shipped and never got a
  // backfill, so a database upgraded from those builds can hold room bodies
  // with no index member. Enumeration used to reach them through the KEYS
  // scan in the createdAt sort; now that the index is the only enumeration
  // source, they would disappear from every admin listing and count instead.
  // SCAN — not KEYS — so a large keyspace never blocks Redis for other
  // clients, and this runs once per process rather than once per listing.
  async function backfillRoomIndex(): Promise<void> {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${escapeGlobPattern(roomKeyPrefix)}*`,
        "COUNT",
        INDEX_REPAIR_CHUNK_SIZE,
      );
      cursor = nextCursor;
      if (keys.length === 0) {
        continue;
      }

      const codes = keys.map((key) => key.slice(roomKeyPrefix.length));
      const scores = await Promise.all(
        codes.map(async (code) => redis.zscore(roomIndexKey, code)),
      );
      const unindexed = codes.filter((_, index) => scores[index] === null);
      for (const code of unindexed) {
        const room = parseRoom(await redis.get(roomKey(code)));
        if (room) {
          await redis.eval(
            BACKFILL_INDEX_ENTRY_LUA,
            2,
            roomIndexKey,
            roomKey(code),
            String(room.lastActiveAt),
            room.code,
          );
        }
      }
    } while (cursor !== "0");
  }

  // The mirror image of the backfill: index members whose room body is gone.
  // fetchRooms prunes these as it encounters them, but countRooms no longer
  // loads bodies at all, so without a sweep here a leaked index would keep
  // inflating every count and metric for the life of the deployment. ZSCAN
  // rather than ZRANGE by rank, because ranks shift as members are removed.
  async function pruneOrphanedIndexEntries(): Promise<void> {
    let cursor = "0";
    do {
      const [nextCursor, entries] = await redis.zscan(
        roomIndexKey,
        cursor,
        "COUNT",
        INDEX_REPAIR_CHUNK_SIZE,
      );
      cursor = nextCursor;

      // ZSCAN returns a flat [member, score, member, score, ...] reply.
      const codes = entries.filter((_, index) => index % 2 === 0);
      if (codes.length === 0) {
        continue;
      }

      // The script re-checks each body inside Redis, so passing every member
      // is safe: live rooms are left alone.
      await redis.eval(
        PRUNE_STALE_INDEX_ENTRIES_LUA,
        1,
        roomIndexKey,
        roomKeyPrefix,
        ...codes,
      );
    } while (cursor !== "0");
  }

  async function reconcileRoomIndex(): Promise<void> {
    await backfillRoomIndex();
    await pruneOrphanedIndexEntries();
  }

  // Started here but deliberately not awaited: createSyncServer resolves
  // before httpServer.listen, so awaiting a full keyspace walk would delay
  // readiness and can trip deployment health-check timeouts on a Redis shared
  // with other services. Enumeration is the only thing that depends on the
  // repair, so enumeration awaits it instead — the cost lands on the first
  // listing or count rather than on startup, and only once per process.
  let indexRepair: Promise<void> | null = null;

  function repairRoomIndex(): Promise<void> {
    if (indexRepair) {
      return indexRepair;
    }

    // Clear the cached promise on failure so one transient Redis error does
    // not disable the repair for the life of the process, and rethrow so
    // enumeration fails loudly rather than quietly reporting a room list and
    // count built on an index that is known to be incomplete. The identity
    // check keeps a late failure from discarding a newer attempt that already
    // replaced this one.
    const pending = reconcileRoomIndex().catch((error: unknown) => {
      if (indexRepair === pending) {
        indexRepair = null;
      }
      throw error;
    });
    indexRepair = pending;
    return pending;
  }

  // Startup only kicks the repair off; the rejection is surfaced to whoever
  // enumerates, so swallow it here to avoid an unhandled rejection.
  void repairRoomIndex().catch(() => undefined);

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
    // Legacy rooms must be indexed before the index can be trusted as the
    // sole enumeration source; after the first call this is a settled promise.
    await repairRoomIndex();

    // Both sort orders enumerate through the room index. Its members are the
    // room codes themselves, so sorting by createdAt needs nothing more than
    // the room bodies this function already loads — the previous KEYS scan
    // walked the entire Redis keyspace while blocking every other client.
    // Order here is irrelevant: rooms are re-sorted below by query.sortBy.
    const codes = await redis.zrange(roomIndexKey, 0, -1);

    // Load in batches rather than one Promise.all over every code. The first
    // listing after this fix ships still faces an index that leaked for as
    // long as the deployment has existed, and queueing that many GETs at once
    // would spike heap and stall the connection before a single stale entry
    // got pruned. Batching bounds both the in-flight commands and the pruning.
    const rooms: PersistedRoom[] = [];
    for (
      let offset = 0;
      offset < codes.length;
      offset += INDEX_REPAIR_CHUNK_SIZE
    ) {
      const batch = codes.slice(offset, offset + INDEX_REPAIR_CHUNK_SIZE);
      const loaded = await Promise.all(
        batch.map(async (code) => ({
          code,
          room: parseRoom(await redis.get(roomKey(code))),
        })),
      );

      // A code with no room body is a leftover index entry. The reaper now
      // cleans up after itself, but indexes written by earlier builds still
      // carry one entry per room they ever expired, so drop them on sight.
      const staleCodes = loaded
        .filter(({ room }) => room === null)
        .map(({ code }) => code);
      if (staleCodes.length > 0) {
        try {
          await redis.eval(
            PRUNE_STALE_INDEX_ENTRIES_LUA,
            1,
            roomIndexKey,
            roomKeyPrefix,
            ...staleCodes,
          );
        } catch {
          // Best effort: a failed prune only means the next call retries it.
        }
      }

      for (const { room } of loaded) {
        if (room) {
          rooms.push(room);
        }
      }
    }

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
      const rawRoom = await redis.get(key);
      if (rawRoom === null) {
        return { ok: false, reason: "not_found" };
      }
      const currentRoom = parseRoom(rawRoom);
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

      const result = await redis.eval(
        UPDATE_ROOM_CAS_LUA,
        3,
        key,
        roomIndexKey,
        roomExpiryKey,
        rawRoom,
        serializeRoom(nextRoom),
        String(nextRoom.lastActiveAt),
        code,
        nextRoom.expiresAt === null ? "" : String(nextRoom.expiresAt),
      );

      if (result === "not_found") {
        return { ok: false, reason: "not_found" };
      }
      if (result !== "ok") {
        return { ok: false, reason: "version_conflict" };
      }
      return { ok: true, room: nextRoom };
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
    // Counting never needs a room body. The index members are the room codes,
    // and every room with a non-null expiresAt is in the expiry zset with that
    // timestamp as its score, so both filters this query supports are answered
    // from the two sorted sets alone. This matters because the metrics
    // collector calls countRooms on every scrape: the old implementation went
    // through fetchRooms and loaded every room in the deployment each time.
    async countRooms(query: Pick<RoomListQuery, "keyword" | "includeExpired">) {
      await repairRoomIndex();
      const currentTime = Date.now();

      if (!query.keyword) {
        if (query.includeExpired) {
          return await redis.zcard(roomIndexKey);
        }
        const [total, expired] = await Promise.all([
          redis.zcard(roomIndexKey),
          redis.zcount(roomExpiryKey, "-inf", currentTime),
        ]);
        return Math.max(total - expired, 0);
      }

      // Keyword search still has to look at every code, but codes come
      // straight out of the index — no room bodies are fetched.
      const keyword = query.keyword.toLowerCase();
      const matching = (await redis.zrange(roomIndexKey, 0, -1)).filter(
        (code) => code.toLowerCase().includes(keyword),
      );
      if (query.includeExpired) {
        return matching.length;
      }

      const expiredCodes = new Set(
        await redis.zrangebyscore(roomExpiryKey, "-inf", currentTime),
      );
      return matching.filter((code) => !expiredCodes.has(code)).length;
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
