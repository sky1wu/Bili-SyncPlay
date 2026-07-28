import { Redis } from "ioredis";
import type { RoomListQuery } from "./admin/types.js";
import { getRedisRoomStoreKeys } from "./redis-namespace.js";
import {
  createPersistedRoom,
  type RoomStore,
  type RoomUpdateResult,
} from "./room-store.js";
import type { PersistedRoom } from "./types.js";

// Every room is a member of one sorted set scored by its expiry, with "+inf"
// standing in for a room that does not expire. That single invariant — one
// member per room body, score equal to its expiresAt — is what lets counting,
// enumeration and reaping each read one key and nothing else. An earlier
// design derived the same answers by subtracting one index from another, and
// every scenario in which those two indexes could disagree turned into a
// separate correctness hole.

// Members whose room body is gone. Existence is re-checked inside the script
// so a code that createRoom is reusing at this very moment cannot lose the
// membership that create just wrote.
const PRUNE_ORPHANED_MEMBERS_LUA = `
local roomsKey = KEYS[1]
local roomKeyPrefix = ARGV[1]
local removed = 0

for index = 2, #ARGV do
  local code = ARGV[index]
  if redis.call("EXISTS", roomKeyPrefix .. code) == 0 then
    removed = removed + redis.call("ZREM", roomsKey, code)
  end
end

return removed
`;

// Re-points a member at what the room body currently says. Guarded by the
// exact bytes the caller read: a concurrent writer on another node may have
// replaced the body already, and replaying a stale snapshot over it would
// restore an expiry the room no longer has.
const RECONCILE_MEMBER_LUA = `
local roomsKey = KEYS[1]
local roomKey = KEYS[2]

if redis.call("GET", roomKey) ~= ARGV[1] then
  return 0
end

redis.call("ZADD", roomsKey, ARGV[2], ARGV[3])
return 1
`;

// Drops the member of a body that exists but cannot be read. Enumeration
// already skips such a room, so leaving it in the set made ZCARD count a row
// listRooms would never return — the admin table reports a total larger than
// the page it can render, and rooms_non_expired stays inflated. Guarded by the
// bytes the caller read, so a body repaired in the meantime keeps its member.
//
// The body itself is deliberately left in place: it cannot be interpreted, so
// deleting it would destroy data on a guess.
const QUARANTINE_MEMBER_LUA = `
local roomsKey = KEYS[1]
local roomKey = KEYS[2]
local kind = redis.call("TYPE", roomKey)["ok"]

if kind == "none" then
  -- No body at all; the orphan prune owns that case.
  return 0
end

if kind ~= "string" then
  -- GET would raise WRONGTYPE, so the caller could not have read bytes to
  -- compare. Such a key can never be enumerated, so its member has to go.
  return redis.call("ZREM", roomsKey, ARGV[2])
end

if redis.call("GET", roomKey) ~= ARGV[1] then
  return 0
end

return redis.call("ZREM", roomsKey, ARGV[2])
`;

// SET NX and the membership write must succeed or fail together, or a losing
// create would still stamp its score over the winner's membership.
//
// A Lua runtime error does not roll back what the script already wrote, so the
// membership write is guarded and the body deleted if it fails — otherwise a
// Redis ACL that does not yet grant the new key would leave an unreachable
// room behind, five of them per request once room-service retries what it
// reads as a code collision. With one key to write there is nothing else to
// undo on that path.
const CREATE_ROOM_LUA = `
if not redis.call("SET", KEYS[1], ARGV[1], "NX") then
  return "exists"
end

local indexed = pcall(function()
  redis.call("ZADD", KEYS[2], ARGV[2], ARGV[3])
end)

if not indexed then
  redis.call("DEL", KEYS[1])
  return "index_failed"
end

return "ok"
`;

// Compare-and-set in one round trip, replacing WATCH + GET + MULTI/EXEC +
// UNWATCH. The caller merges the patch in JS and hands over both the exact
// bytes it read and the fully serialized next room, so the script never
// decodes or re-encodes room JSON — Redis's cjson formats numbers with
// %.14g, which turns a seq of 9007199254740991 into 9.007199254741e+15 and
// clips playback positions.
//
// The guard compares the whole previous body rather than just its version,
// because that is what WATCH actually guaranteed: a room can be deleted and a
// later room created under the same code, and the new room starts at version
// 0 again. Comparing versions alone would let an update prepared against the
// old room overwrite the new one — joinToken and owner included.
const UPDATE_ROOM_CAS_LUA = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  return "not_found"
end

if raw ~= ARGV[1] then
  return "version_conflict"
end

redis.call("SET", KEYS[1], ARGV[2])

local indexed = pcall(function()
  redis.call("ZADD", KEYS[2], ARGV[3], ARGV[4])
end)

if not indexed then
  redis.call("SET", KEYS[1], ARGV[1])
  return "index_failed"
end

return "ok"
`;

// Unconditional write, so the previous body is read inside the script rather
// than by the caller: there is nothing to compare against, and taking it here
// means no extra round trip and no window between the read and the write.
//
// The membership write is guarded and the body restored if it fails. Without
// that the caller is told the save failed while the body has in fact already
// changed, leaving the index carrying a score for a room state that no longer
// exists — the same partial commit create and update already guard against.
const SAVE_ROOM_LUA = `
local previous = redis.call("GET", KEYS[1])
redis.call("SET", KEYS[1], ARGV[1])

local indexed = pcall(function()
  redis.call("ZADD", KEYS[2], ARGV[2], ARGV[3])
end)

if not indexed then
  if previous then
    redis.call("SET", KEYS[1], previous)
  else
    redis.call("DEL", KEYS[1])
  end
  return "index_failed"
end

return "ok"
`;

// Membership goes first: a Lua error does not roll back, and a body left
// without membership is repaired by the next reconcile, whereas a membership
// left without a body would keep the room in every count until the orphan
// sweep runs. Doing both here also keeps deleteRoom from throwing after the
// body is already gone, which would abort the caller's downstream cleanup and
// leave other nodes serving a room that no longer exists.
const DELETE_ROOM_LUA = `
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("DEL", KEYS[1])
return "ok"
`;

// Candidates come from the score range itself, so rooms that never expire are
// never even looked at. A candidate whose body disagrees with its score is
// repaired rather than deleted: only a body that really is past its expiry is
// removed. A body dated in the future is left for the reconcile pass instead
// of being rescored here, because writing the score back would mean formatting
// a number in Lua and that is exactly how playback values got mangled before.
const DELETE_EXPIRED_ROOMS_LUA = `
local roomsKey = KEYS[1]
local roomKeyPrefix = ARGV[1]
local now = tonumber(ARGV[2])
local candidates = redis.call("ZRANGEBYSCORE", roomsKey, "-inf", now)
local deletedCount = 0

for _, code in ipairs(candidates) do
  local key = roomKeyPrefix .. code
  -- A body of the wrong type makes GET raise, which would abort the whole
  -- run: the member stays a candidate and every expired room ordered after
  -- it stops being collected too.
  local readable, rawRoom = pcall(function()
    return redis.call("GET", key)
  end)

  if not readable then
    redis.call("ZREM", roomsKey, code)
  elseif not rawRoom then
    redis.call("ZREM", roomsKey, code)
  else
    local ok, room = pcall(cjson.decode, rawRoom)
    -- cjson.decode("1") yields a truthy scalar; indexing it raises a Lua
    -- error that aborts the whole reaper run, so the member stays a candidate
    -- and every expired room ordered after it stops being collected too.
    if ok and type(room) == "table" then
      local expiresAt = room["expiresAt"]
      if expiresAt == cjson.null or expiresAt == nil then
        redis.call("ZADD", roomsKey, "+inf", code)
      elseif tonumber(expiresAt) ~= nil and tonumber(expiresAt) <= now then
        redis.call("DEL", key)
        redis.call("ZREM", roomsKey, code)
        deletedCount = deletedCount + 1
      end
    end
  end
end

return deletedCount
`;

// Chunk the repair passes: a first run against a database that has never been
// migrated must not build one multi-megabyte command or hold Redis inside a
// single long-running script.
const REPAIR_CHUNK_SIZE = 500;

// How often the index is reconciled against the room bodies. It repeats
// rather than running once per process because a node still on an older build
// — mid rolling upgrade, sharing this Redis — writes rooms this set never
// hears about, and reaps rooms whose membership nobody removes.
export const ROOM_INDEX_RECONCILE_INTERVAL_MS = 900_000;

// SCAN MATCH takes a glob, so a namespace carrying glob metacharacters — a
// plain string as far as the config layer is concerned, e.g. "tenant[1]" —
// would silently match nothing and leave that deployment's rooms unmigrated.
function escapeGlobPattern(value: string): string {
  return value.replaceAll(/[\\*?[\]]/g, (character) => `\\${character}`);
}

function serializeRoom(room: PersistedRoom): string {
  return JSON.stringify(room);
}

function parseRoom(value: string | null): PersistedRoom | null {
  if (!value) {
    return null;
  }
  return JSON.parse(value) as PersistedRoom;
}

// One unusable value must not take down a whole batch. The reaper's script
// already skips such a body via pcall, and the orphan prune keys off EXISTS,
// so a bad room keeps its membership and is simply not enumerated — rather
// than rejecting the reconcile that the reaper now waits on, which would stop
// every other room from ever being collected.
//
// Valid JSON is not enough: a body carrying `expiresAt: "bad"` parses fine,
// and expiryScore() would then hand Redis "bad" as a score, failing the ZADD
// and blocking the reaper just the same. Every field this store actually
// reads is checked before the body is trusted.
function isUsableRoom(value: unknown): value is PersistedRoom {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const room = value as Partial<PersistedRoom>;
  return (
    typeof room.code === "string" &&
    typeof room.version === "number" &&
    typeof room.createdAt === "number" &&
    typeof room.lastActiveAt === "number" &&
    (room.expiresAt === null || typeof room.expiresAt === "number")
  );
}

function parseRoomOrNull(value: string | null): PersistedRoom | null {
  let parsed: unknown;
  try {
    parsed = value === null || value === "" ? null : JSON.parse(value);
  } catch {
    return null;
  }
  return isUsableRoom(parsed) ? parsed : null;
}

// JS formats the score, never Lua: String() renders a millisecond timestamp
// exactly, while Lua's default number formatting can reach for exponent
// notation.
//
// "inf" rather than "+inf" because that is what ZSCORE reads back, and the
// reconcile compares the two as strings. Emitting "+inf" here made every
// non-expiring room — the common case — compare as drifted forever, so the
// pass rewrote every room on every run instead of writing nothing.
export function expiryScore(room: PersistedRoom): string {
  return room.expiresAt === null ? "inf" : String(room.expiresAt);
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
    // Injectable only so a test can place rooms either side of the expiry
    // cutoff without waiting; every other timestamp in this module stays on
    // Date.now.
    now?: () => number;
  } = {},
): Promise<
  RoomStore & {
    close: () => Promise<void>;
    reconcileRoomIndex: () => Promise<void>;
  }
> {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const { roomKeyPrefix, roomsByExpiryKey } = getRedisRoomStoreKeys(
    options.namespace,
  );
  const now = options.now ?? Date.now;

  function roomKey(code: string): string {
    return `${roomKeyPrefix}${code}`;
  }

  // A room key of the wrong type — corruption, or a namespace collision with
  // another user of this Redis — makes GET raise WRONGTYPE. Batches read many
  // keys at once, so letting that escape would reject the whole batch and,
  // through it, the reconcile the reaper waits on: one bad key would stop
  // every other expired room from ever being collected. Null here means the
  // body could not be read, which callers already treat as unusable.
  async function readRoomBody(code: string): Promise<string | null> {
    try {
      return await redis.get(roomKey(code));
    } catch {
      return null;
    }
  }

  await redis.connect();

  // Walks room bodies and points the set at each one. On a database written
  // before this set existed it is the migration; afterwards it is what brings
  // in rooms created by a node still running an older build.
  async function reconcileFromRoomBodies(): Promise<void> {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${escapeGlobPattern(roomKeyPrefix)}*`,
        "COUNT",
        REPAIR_CHUNK_SIZE,
      );
      cursor = nextCursor;
      if (keys.length === 0) {
        continue;
      }

      const codes = keys.map((key) => key.slice(roomKeyPrefix.length));
      // Reads for the whole chunk go out together; ioredis writes them in one
      // batch rather than paying a round trip each.
      const loaded = await Promise.all(
        codes.map(async (code) => {
          // One key of the wrong type must not reject the whole batch and,
          // with it, the reconcile the reaper waits on.
          const [raw, score] = await Promise.all([
            readRoomBody(code),
            redis.zscore(roomsByExpiryKey, code),
          ]);
          return { code, raw, score, room: parseRoomOrNull(raw) };
        }),
      );

      // Only members that actually disagree get written. In steady state this
      // pass issues no writes at all, so the periodic reconcile does not
      // rewrite every room into the AOF and replication stream, and a listing
      // or scrape that triggers it does not wait on one round trip per room.
      const drifted = loaded.filter(
        ({ raw, score, room }) =>
          room !== null && raw !== null && score !== expiryScore(room),
      );
      await Promise.all(
        drifted.map(async ({ code, raw, room }) =>
          redis.eval(
            RECONCILE_MEMBER_LUA,
            2,
            roomsByExpiryKey,
            roomKey(code),
            raw as string,
            expiryScore(room as PersistedRoom),
            code,
          ),
        ),
      );

      // A body that exists but cannot be read must leave the set, or counting
      // and enumeration disagree about it for as long as it sits there.
      const unreadable = loaded.filter(
        ({ room, score }) => room === null && score !== null,
      );
      await Promise.all(
        unreadable.map(async ({ code, raw }) =>
          redis.eval(
            QUARANTINE_MEMBER_LUA,
            2,
            roomsByExpiryKey,
            roomKey(code),
            // Empty when the read itself failed; the script's type check
            // decides that case without consulting these bytes.
            raw ?? "",
            code,
          ),
        ),
      );
    } while (cursor !== "0");
  }

  // The other direction: members whose room body is gone.
  async function pruneOrphanedMembers(): Promise<void> {
    let cursor = "0";
    do {
      const [nextCursor, entries] = await redis.zscan(
        roomsByExpiryKey,
        cursor,
        "COUNT",
        REPAIR_CHUNK_SIZE,
      );
      cursor = nextCursor;

      // ZSCAN returns a flat [member, score, member, score, ...] reply.
      const codes = entries.filter((_, index) => index % 2 === 0);
      if (codes.length === 0) {
        continue;
      }

      await redis.eval(
        PRUNE_ORPHANED_MEMBERS_LUA,
        1,
        roomsByExpiryKey,
        roomKeyPrefix,
        ...codes,
      );
    } while (cursor !== "0");
  }

  let reconcile: Promise<void> | null = null;
  let bootstrapReconciled = false;

  async function runReconcile(): Promise<void> {
    await reconcileFromRoomBodies();
    await pruneOrphanedMembers();
  }

  // De-duplicates concurrent passes: the periodic timer and a read still
  // waiting on the first pass must not walk the keyspace twice at once.
  // Cleared once settled, and rethrown on failure so a read that depends on
  // this fails loudly rather than reporting a count built on a set known to be
  // incomplete. The identity checks keep a late settlement from discarding a
  // newer attempt that already replaced this one.
  function reconcileRoomIndex(): Promise<void> {
    if (reconcile) {
      return reconcile;
    }

    const pending = runReconcile().then(
      () => {
        bootstrapReconciled = true;
        if (reconcile === pending) {
          reconcile = null;
        }
      },
      (error: unknown) => {
        if (reconcile === pending) {
          reconcile = null;
        }
        throw error;
      },
    );
    reconcile = pending;
    return pending;
  }

  // Reads wait for the *first* pass only. That one is the migration: until it
  // lands, a database written before this set existed answers every count and
  // listing with rooms missing, so a read that skipped it would be wrong.
  // Every later pass exists to pick up rooms a node on an older build wrote
  // mid rolling upgrade — nothing a caller is holding depends on it, so making
  // callers wait only charged one unlucky read per interval for a keyspace
  // walk. `createRoomIndexReconciler` drives those on its own timer instead,
  // where the cost is attributable and nobody is blocked by it.
  function ensureBootstrapReconciled(): Promise<void> {
    if (bootstrapReconciled) {
      return Promise.resolve();
    }
    return reconcileRoomIndex();
  }

  // Started here but deliberately not awaited: createSyncServer resolves
  // before httpServer.listen, so awaiting a keyspace walk would delay
  // readiness and can trip deployment health checks on a Redis shared with
  // other services. Only reads depend on the result, so they await it instead.
  void reconcileRoomIndex().catch(() => undefined);

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
    await ensureBootstrapReconciled();

    // Members are the room codes; ordering here is irrelevant because rooms
    // are re-sorted below by query.sortBy once their bodies are loaded.
    const codes = await redis.zrange(roomsByExpiryKey, 0, -1);

    // Batched rather than one Promise.all over every code: a database that
    // has just been migrated can hand back every room at once, and queueing
    // that many GETs would spike heap and stall the connection.
    const rooms: PersistedRoom[] = [];
    for (let offset = 0; offset < codes.length; offset += REPAIR_CHUNK_SIZE) {
      const batch = codes.slice(offset, offset + REPAIR_CHUNK_SIZE);
      const loaded = await Promise.all(
        batch.map(async (code) => {
          const raw = await readRoomBody(code);
          return { code, raw, room: parseRoomOrNull(raw) };
        }),
      );

      // Codes with no body at all: the script re-checks EXISTS, so a body
      // written between the read and the prune keeps its membership.
      const orphanedCodes = loaded
        .filter(({ raw }) => raw === null)
        .map(({ code }) => code);
      if (orphanedCodes.length > 0) {
        try {
          await redis.eval(
            PRUNE_ORPHANED_MEMBERS_LUA,
            1,
            roomsByExpiryKey,
            roomKeyPrefix,
            ...orphanedCodes,
          );
        } catch {
          // Best effort: a failed prune only means the next call retries it.
        }
      }

      // Bodies that exist but cannot be read leave the set here too, not just
      // on the next reconcile, so a listing and the count it is paired with
      // never disagree about how many rooms there are.
      const unreadable = loaded.filter(({ room }) => room === null);
      if (unreadable.length > 0) {
        try {
          await Promise.all(
            unreadable.map(async ({ code, raw }) =>
              redis.eval(
                QUARANTINE_MEMBER_LUA,
                2,
                roomsByExpiryKey,
                roomKey(code),
                raw as string,
                code,
              ),
            ),
          );
        } catch {
          // Best effort, same as the prune above.
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
        2,
        roomKey(room.code),
        roomsByExpiryKey,
        serializeRoom(room),
        expiryScore(room),
        room.code,
      );
      if (created === "index_failed") {
        throw new Error(
          `Room ${room.code} could not be indexed; the room was not created.`,
        );
      }
      if (created !== "ok") {
        throw new Error(`Room ${room.code} already exists.`);
      }
      return room;
    },
    async getRoom(code) {
      return parseRoom(await redis.get(roomKey(code)));
    },
    async saveRoom(room) {
      const saved = await redis.eval(
        SAVE_ROOM_LUA,
        2,
        roomKey(room.code),
        roomsByExpiryKey,
        serializeRoom(room),
        expiryScore(room),
        room.code,
      );
      if (saved !== "ok") {
        throw new Error(
          `Room ${room.code} could not be indexed; the save was rolled back.`,
        );
      }
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
        2,
        key,
        roomsByExpiryKey,
        rawRoom,
        serializeRoom(nextRoom),
        expiryScore(nextRoom),
        code,
      );

      if (result === "not_found") {
        return { ok: false, reason: "not_found" };
      }
      if (result === "index_failed") {
        throw new Error(
          `Room ${code} could not be indexed; the update was rolled back.`,
        );
      }
      if (result !== "ok") {
        return { ok: false, reason: "version_conflict" };
      }
      return { ok: true, room: nextRoom };
    },
    async deleteRoom(code) {
      await redis.eval(
        DELETE_ROOM_LUA,
        2,
        roomKey(code),
        roomsByExpiryKey,
        code,
      );
    },
    async deleteExpiredRooms(currentTime) {
      // Candidates come from the index, so on a database that predates it the
      // reaper would see nothing until the migration pass lands. It waits for
      // that one pass only — keeping it waiting on every later pass put a
      // keyspace walk inside one reaper tick per interval, which is what made
      // this operation's histogram bimodal.
      await ensureBootstrapReconciled();
      const deletedCount = await redis.eval(
        DELETE_EXPIRED_ROOMS_LUA,
        1,
        roomsByExpiryKey,
        roomKeyPrefix,
        String(currentTime),
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
    // Every branch is a single command against a single key, so each answer is
    // taken from one Redis snapshot without a transaction to hold it still,
    // and none of them loads a room body — which matters because the metrics
    // collector calls this on every scrape.
    async countRooms(query: Pick<RoomListQuery, "keyword" | "includeExpired">) {
      await ensureBootstrapReconciled();

      if (!query.keyword) {
        return query.includeExpired
          ? await redis.zcard(roomsByExpiryKey)
          : await redis.zcount(roomsByExpiryKey, `(${now()}`, "+inf");
      }

      // Keyword search has to look at every candidate code, but codes come
      // straight out of the set — no room bodies are fetched.
      const keyword = query.keyword.toLowerCase();
      const codes = query.includeExpired
        ? await redis.zrange(roomsByExpiryKey, 0, -1)
        : await redis.zrangebyscore(roomsByExpiryKey, `(${now()}`, "+inf");
      return codes.filter((code) => code.toLowerCase().includes(keyword))
        .length;
    },
    async isReady() {
      try {
        const pong = await redis.ping();
        return pong === "PONG";
      } catch {
        return false;
      }
    },
    // Outside the RoomStore contract: only this implementation keeps an index
    // that can drift from the room bodies. `createRoomIndexReconciler` owns
    // the schedule; exposing it here is what lets that timer's cost land on
    // its own histogram label instead of on whichever read triggered it.
    reconcileRoomIndex,
    async close() {
      await redis.quit();
    },
  };
}
