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
// just-reaped code, and its write would otherwise be undone by a ZREM decided
// against the previous occupant of that code. Both sorted sets are cleared
// together to keep the expiry set a subset of the index — see
// COUNT_NON_EXPIRED_ROOMS below.
const PRUNE_STALE_INDEX_ENTRIES_LUA = `
local indexKey = KEYS[1]
local expiryKey = KEYS[2]
local roomKeyPrefix = ARGV[1]
local removed = 0

for index = 2, #ARGV do
  local code = ARGV[index]
  if redis.call("EXISTS", roomKeyPrefix .. code) == 0 then
    removed = removed + redis.call("ZREM", indexKey, code)
    redis.call("ZREM", expiryKey, code)
  end
end

return removed
`;

// Re-points both sorted sets at what the room body currently says. Guarded by
// the exact bytes the caller read rather than mere key existence: a concurrent
// updateRoom on another node may already have written a newer body and correct
// entries, and replaying a stale snapshot over them would resurrect an index
// score that is too old or, worse, delete a freshly written expiry member and
// leave the room permanently unreapable.
const RECONCILE_INDEX_ENTRY_LUA = `
local indexKey = KEYS[1]
local expiryKey = KEYS[2]
local roomKey = KEYS[3]

if redis.call("GET", roomKey) ~= ARGV[1] then
  return 0
end

redis.call("ZADD", indexKey, ARGV[2], ARGV[3])

if ARGV[4] == "" then
  redis.call("ZREM", expiryKey, ARGV[3])
else
  redis.call("ZADD", expiryKey, ARGV[4], ARGV[3])
end

return 1
`;

// SET NX and the index writes must succeed or fail together: the previous
// MULTI wrote the index unconditionally, so a losing create still reset the
// winner's index score, and clearing a reused code's stale expiry entry could
// not be done there at all without also clearing the live room's.
const CREATE_ROOM_LUA = `
if not redis.call("SET", KEYS[1], ARGV[1], "NX") then
  return "exists"
end

redis.call("ZADD", KEYS[2], ARGV[2], ARGV[3])
redis.call("ZREM", KEYS[3], ARGV[3])

return "ok"
`;

// Counting non-expired rooms is ZCARD minus ZCOUNT, with no per-member work:
// every writer above moves the index and expiry sets together, so an expiry
// member is always an index member whose body carries exactly that expiresAt.
// An earlier revision verified each expired code against the index inside a
// Lua loop; that made a metrics scrape's cost grow with the expiry backlog
// while EVAL held Redis, which is precisely the stall this file exists to
// avoid.
// Chunk both the prune and the backfill: a first run against an index that
// leaked for months must not build one multi-megabyte command or hold Redis
// inside a single long-running script.
const INDEX_REPAIR_CHUNK_SIZE = 500;

// How long a completed reconcile is trusted before enumeration sweeps again.
const INDEX_RECONCILE_INTERVAL_MS = 300_000;

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

export async function createRedisRoomStore(
  redisUrl: string,
  options: {
    namespace?: string;
    // Injectable only so the reconcile cooldown below is testable without
    // waiting it out; every other timestamp in this module stays on Date.now.
    now?: () => number;
  } = {},
): Promise<RoomStore & { close: () => Promise<void> }> {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const { roomKeyPrefix, roomExpiryKey, roomIndexKey } = getRedisRoomStoreKeys(
    options.namespace,
  );
  const now = options.now ?? Date.now;

  function roomKey(code: string): string {
    return `${roomKeyPrefix}${code}`;
  }

  await redis.connect();

  // The room index landed after Redis persistence shipped and never got a
  // backfill, so a database upgraded from those builds can hold room bodies
  // with no index member. Enumeration used to reach them through the KEYS
  // scan in the createdAt sort; now that the index is the only enumeration
  // source, they would disappear from every admin listing and count instead.
  //
  // It reconciles the expiry set too, and for every room body rather than
  // only unindexed ones: the pre-fix saveRoom wrote the body and the index in
  // one MULTI but updated expiry in a separate call, so a crash between them
  // left indexed rooms carrying an expiresAt that no expiry member records —
  // counted as alive forever, and never found by the reaper.
  //
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
      const loaded = await Promise.all(
        codes.map(async (code) => {
          const raw = await redis.get(roomKey(code));
          return { code, raw, room: parseRoom(raw) };
        }),
      );

      for (const { code, raw, room } of loaded) {
        if (!room || raw === null) {
          continue;
        }
        await redis.eval(
          RECONCILE_INDEX_ENTRY_LUA,
          3,
          roomIndexKey,
          roomExpiryKey,
          roomKey(code),
          raw,
          String(room.lastActiveAt),
          room.code,
          room.expiresAt === null ? "" : String(room.expiresAt),
        );
      }
    } while (cursor !== "0");
  }

  // The mirror image of the backfill: index members whose room body is gone.
  // fetchRooms prunes these as it encounters them, but countRooms no longer
  // loads bodies at all, so without a sweep here a leaked index would keep
  // inflating every count and metric for the life of the deployment. ZSCAN
  // rather than ZRANGE by rank, because ranks shift as members are removed.
  async function pruneOrphansIn(sortedSetKey: string): Promise<void> {
    let cursor = "0";
    do {
      const [nextCursor, entries] = await redis.zscan(
        sortedSetKey,
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
        2,
        roomIndexKey,
        roomExpiryKey,
        roomKeyPrefix,
        ...codes,
      );
    } while (cursor !== "0");
  }

  // Both sets need sweeping, and neither can stand in for the other: an
  // expiry member whose code was already dropped from the index would never
  // be visited by a sweep driven from the index, yet ZCOUNT would keep
  // subtracting it from unrelated live rooms.
  async function pruneOrphanedIndexEntries(): Promise<void> {
    await pruneOrphansIn(roomIndexKey);
    await pruneOrphansIn(roomExpiryKey);
  }

  let backfillCompleted = false;
  let lastReconciledAt = 0;

  async function reconcileRoomIndex(): Promise<void> {
    // The keyspace walk only matters for a database written before the index
    // existed, so it runs once; orphan sweeping repeats.
    if (!backfillCompleted) {
      await backfillRoomIndex();
      backfillCompleted = true;
    }
    await pruneOrphanedIndexEntries();
    lastReconciledAt = now();
  }

  // Started here but deliberately not awaited: createSyncServer resolves
  // before httpServer.listen, so awaiting a full keyspace walk would delay
  // readiness and can trip deployment health-check timeouts on a Redis shared
  // with other services. Enumeration is the only thing that depends on the
  // repair, so enumeration awaits it instead — the cost lands on the first
  // listing or count rather than on startup.
  let indexRepair: Promise<void> | null = null;

  function repairRoomIndex(): Promise<void> {
    // An in-flight reconcile is shared rather than duplicated.
    if (indexRepair) {
      return indexRepair;
    }
    // Sweeping repeats on a cooldown rather than running once per process:
    // during a rolling upgrade on a shared Redis, nodes still on the old
    // build keep reaping rooms without removing their index members, and
    // those orphans appear after this process already swept. countRooms no
    // longer loads room bodies, so nothing else would ever notice them and
    // both the overview and rooms_non_expired would stay inflated until a
    // room listing happened to run or the process restarted.
    if (
      lastReconciledAt !== 0 &&
      now() - lastReconciledAt < INDEX_RECONCILE_INTERVAL_MS
    ) {
      return Promise.resolve();
    }

    // Clear the cached promise once settled so the cooldown governs the next
    // run, and rethrow on failure so enumeration fails loudly rather than
    // quietly reporting a list and count built on an index known to be
    // incomplete. The identity checks keep a late settlement from discarding
    // a newer attempt that already replaced this one.
    const pending = reconcileRoomIndex().then(
      () => {
        if (indexRepair === pending) {
          indexRepair = null;
        }
      },
      (error: unknown) => {
        if (indexRepair === pending) {
          indexRepair = null;
        }
        throw error;
      },
    );
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
            2,
            roomIndexKey,
            roomExpiryKey,
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
      const created = await redis.eval(
        CREATE_ROOM_LUA,
        3,
        roomKey(room.code),
        roomIndexKey,
        roomExpiryKey,
        serializeRoom(room),
        String(room.lastActiveAt),
        room.code,
      );
      if (created !== "ok") {
        throw new Error(`Room ${room.code} already exists.`);
      }
      return room;
    },
    async getRoom(code) {
      return parseRoom(await redis.get(roomKey(code)));
    },
    async saveRoom(room) {
      // The expiry write belongs in the same transaction: as a follow-up call
      // it could be lost to a crash or a connection drop, leaving the two
      // sorted sets disagreeing about whether the room expires.
      const transaction = redis.multi();
      transaction.set(roomKey(room.code), serializeRoom(room));
      transaction.zadd(roomIndexKey, String(room.lastActiveAt), room.code);
      if (room.expiresAt === null) {
        transaction.zrem(roomExpiryKey, room.code);
      } else {
        transaction.zadd(roomExpiryKey, String(room.expiresAt), room.code);
      }
      await transaction.exec();
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
        // MULTI, not Promise.all: the two commands must observe one snapshot,
        // or a reaper deleting a room between them yields a count that never
        // existed. Both are O(log N) with no per-member work, so holding the
        // server for the transaction costs nothing measurable.
        const snapshot = await redis
          .multi()
          .zcard(roomIndexKey)
          .zcount(roomExpiryKey, "-inf", currentTime)
          .exec();
        const total = Number(snapshot?.[0]?.[1] ?? 0);
        const expired = Number(snapshot?.[1]?.[1] ?? 0);
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
