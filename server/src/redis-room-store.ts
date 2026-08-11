import { randomUUID } from "node:crypto";
import { ReplyError } from "ioredis";
import type { RoomListQuery } from "./admin/types.js";
import {
  connectWithin,
  createBoundedRedisClient,
} from "./redis-command-timeout.js";
import { quitWithin, type RedisQuitOutcome } from "./redis-graceful-close.js";
import { getRedisRoomStoreKeys } from "./redis-namespace.js";
import {
  createPersistedRoom,
  type OrphanedIndexClaim,
  type RoomStore,
  type RoomUpdateResult,
} from "./room-store.js";
import type { PersistedRoom } from "./types.js";

/**
 * `close_room_store` has the default 5s shutdown budget and, after the room
 * index reconciler's separate stop step, this store has only `QUIT` left to
 * await. Four seconds gives the graceful path most of that budget while
 * retaining one second for shutdown bookkeeping and the degraded report.
 */
const CLOSE_QUIT_TIMEOUT_MS = 4_000;

/** Injectable so shutdown tests can model a `QUIT` reply that never arrives. */
export type RedisRoomStoreClient = {
  connect: () => Promise<unknown>;
  quit: () => Promise<unknown>;
  disconnect: () => void;
  get: (key: string) => Promise<string | null>;
  scan: (
    cursor: string,
    matchToken: "MATCH",
    pattern: string,
    countToken: "COUNT",
    count: number,
  ) => Promise<[string, string[]]>;
  zscan: (
    key: string,
    cursor: string,
    countToken: "COUNT",
    count: number,
  ) => Promise<[string, string[]]>;
  zscore: (key: string, member: string) => Promise<string | null>;
  eval: (
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ) => Promise<unknown>;
  zrange: (key: string, start: number, stop: number) => Promise<string[]>;
  zrangebyscore: (key: string, min: string, max: string) => Promise<string[]>;
  zcard: (key: string) => Promise<number>;
  zcount: (key: string, min: string, max: string) => Promise<number>;
  ping: () => Promise<string>;
};

// Every room is a member of one sorted set scored by its expiry, with "+inf"
// standing in for a room that does not expire. That single invariant — one
// member per room body, score equal to its expiresAt — is what lets counting,
// enumeration and reaping each read one key and nothing else. An earlier
// design derived the same answers by subtracting one index from another, and
// every scenario in which those two indexes could disagree turned into a
// separate correctness hole. `room-index-orphans` below is a cleanup-debt hash,
// not a second room index: no room is enumerated or counted from it. Its field
// is a room code and its value is a unique token for one orphan discovery.

// The one atomic primitive for removing a room-index member that did not die
// through the normal room deletion path. Every caller stages a tokened claim
// before ZREM; a loser restores the claim it observed before trying. Keeping
// this in one source block is the invariant — prune, quarantine, and reaper
// candidate handling must not grow their own hand-written variants.
const REMOVE_INDEX_WITH_ORPHAN_CLAIM_LUA = `
local sequenceMember = "!sequence"

local function rotateOrphanClaim(code)
  local nextScore = redis.call(
    "ZINCRBY", orphanedRoomsQueueKey, 1, sequenceMember
  )
  redis.call("ZADD", orphanedRoomsQueueKey, nextScore, code)
end

local function stageOrphanClaim(code, token)
  redis.call("HSET", orphanedRoomsKey, code, token)
  rotateOrphanClaim(code)
end

local function removeIndexWithOrphanClaim(code, token)
  local previousToken = redis.call("HGET", orphanedRoomsKey, code)
  local previousScore = redis.call("ZSCORE", orphanedRoomsQueueKey, code)
  stageOrphanClaim(code, token)
  if redis.call("ZREM", roomsKey, code) > 0 then
    return 1
  end

  -- A concurrent remover already won. Preserve the token it may have handed
  -- to a caller instead of replacing it with a token nobody owns.
  if previousToken then
    redis.call("HSET", orphanedRoomsKey, code, previousToken)
  else
    redis.call("HDEL", orphanedRoomsKey, code)
  end
  if previousScore then
    redis.call("ZADD", orphanedRoomsQueueKey, previousScore, code)
  else
    redis.call("ZREM", orphanedRoomsQueueKey, code)
  end
  return 0
end
`;

// Members whose room body is gone. Existence is re-checked inside the script
// so a code that createRoom is reusing at this very moment cannot lose the
// membership that create just wrote. Every removed code is added atomically to
// a shared handoff hash so the next reaper sweep can still request its runtime
// teardown. Shared matters because the standalone global-admin reconciles this
// index but runs no room reaper of its own (#258).
const PRUNE_ORPHANED_MEMBERS_LUA = `
local roomsKey = KEYS[1]
local orphanedRoomsKey = KEYS[2]
local orphanedRoomsQueueKey = KEYS[3]
local roomKeyPrefix = ARGV[1]
local claimToken = ARGV[2]
local removed = 0

${REMOVE_INDEX_WITH_ORPHAN_CLAIM_LUA}

for index = 3, #ARGV do
  local code = ARGV[index]
  if redis.call("EXISTS", roomKeyPrefix .. code) == 0 then
    -- Handoff first: a Lua runtime error does not roll earlier writes back. If
    -- either handoff key is unavailable or has the wrong type, retaining the
    -- index member lets a later pass retry instead of losing the only cleanup
    -- trail. Restore the previous claim when another process already pruned
    -- the member; it may still be working under that token.
    removed = removed + removeIndexWithOrphanClaim(code, claimToken)
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
// the page it can render, and rooms_non_expired stays inflated. Before removal
// it leaves a deferred cleanup claim: if an operator later deletes the bad
// body, no index member would otherwise remain to name its runtime residue.
// Guarded by the bytes the caller read, so a body repaired in the meantime
// keeps its member.
//
// The body itself is deliberately left in place: it cannot be interpreted, so
// deleting it would destroy data on a guess.
const QUARANTINE_MEMBER_LUA = `
local roomsKey = KEYS[1]
local roomKey = KEYS[2]
local orphanedRoomsKey = KEYS[3]
local orphanedRoomsQueueKey = KEYS[4]
local kind = redis.call("TYPE", roomKey)["ok"]
local code = ARGV[2]
local claimToken = ARGV[3]

${REMOVE_INDEX_WITH_ORPHAN_CLAIM_LUA}

if kind == "none" then
  -- No body at all; the orphan prune owns that case.
  return 0
end

if kind ~= "string" then
  -- GET would raise WRONGTYPE, so the caller could not have read bytes to
  -- compare. Such a key can never be enumerated, so its member has to go.
  return removeIndexWithOrphanClaim(code, claimToken)
end

if redis.call("GET", roomKey) ~= ARGV[1] then
  return 0
end

return removeIndexWithOrphanClaim(code, claimToken)
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
// Returns the DEL count, not "ok": concurrent readers of the same expired room
// all reach this script, and the caller has to be able to tell which one of them
// actually removed the body. ZREM stays unconditional — the index entry must go
// even when the body was already collected by whoever got here first.
const DELETE_ROOM_LUA = `
redis.call("ZREM", KEYS[2], ARGV[1])
return redis.call("DEL", KEYS[1])
`;

// Candidates come from the score range itself, so rooms that never expire are
// never even looked at. A candidate whose body disagrees with its score is
// repaired rather than deleted: only a body that really is past its expiry is
// removed. A body dated in the future is left for the reconcile pass instead
// of being rescored here, because writing the score back would mean formatting
// a number in Lua and that is exactly how playback values got mangled before.
const DELETE_EXPIRED_ROOMS_LUA = `
local roomsKey = KEYS[1]
local orphanedRoomsKey = KEYS[2]
local orphanedRoomsQueueKey = KEYS[3]
local roomKeyPrefix = ARGV[1]
local now = tonumber(ARGV[2])
local orphanLimit = tonumber(ARGV[3])
local sweepClaimToken = ARGV[4]
local candidates = redis.call("ZRANGEBYSCORE", roomsKey, "-inf", now)
local deletedCodes = {}
local orphanClaims = {}
local orphanPositions = {}

${REMOVE_INDEX_WITH_ORPHAN_CLAIM_LUA}

local function roomBodyState(code)
  local readable, rawRoom = pcall(function()
    return redis.call("GET", roomKeyPrefix .. code)
  end)
  if not readable then
    return "unusable"
  end
  if not rawRoom then
    return "missing"
  end

  local ok, room = pcall(cjson.decode, rawRoom)
  if not ok or type(room) ~= "table" then
    return "unusable"
  end
  local expiresAt = room["expiresAt"]
  if room["code"] ~= code
    or type(room["version"]) ~= "number"
    or type(room["createdAt"]) ~= "number"
    or type(room["lastActiveAt"]) ~= "number"
    or not (
      expiresAt == cjson.null
      or type(expiresAt) == "number"
    ) then
    return "unusable"
  end
  return "usable"
end

local function reportOrphan(code, token)
  local position = orphanPositions[code]
  if position then
    orphanClaims[position + 1] = token
  else
    position = #orphanClaims + 1
    orphanPositions[code] = position
    orphanClaims[position] = code
    orphanClaims[position + 1] = token
  end
end

-- Reconcile/listing already removed these codes from the main index to keep
-- counts accurate. Read, but do not consume, a bounded batch: only the caller
-- can acknowledge a claim after runtime teardown has really settled. Rotating
-- every delivered claim to the tail prevents one failing batch from starving
-- newer debt, using commands available in the supported Redis 6.0 baseline.
local stagedOrphanCodes = redis.call(
  "ZRANGE", orphanedRoomsQueueKey, 0, orphanLimit - 1
)
for _, code in ipairs(stagedOrphanCodes) do
  if code ~= sequenceMember then
    local token = redis.call("HGET", orphanedRoomsKey, code)
    if not token then
      redis.call("ZREM", orphanedRoomsQueueKey, code)
    else
      local bodyState = roomBodyState(code)
      if bodyState == "missing" then
        reportOrphan(code, token)
        rotateOrphanClaim(code)
      elseif bodyState == "usable" then
        redis.call("HDEL", orphanedRoomsKey, code)
        redis.call("ZREM", orphanedRoomsQueueKey, code)
      else
        -- A wrong-type or malformed body is not proof that the room code was
        -- reused. Keep the debt: if an operator later deletes that corrupt key,
        -- this claim is the only remaining path to its runtime residue.
        rotateOrphanClaim(code)
      end
    end
  end
end

for _, code in ipairs(candidates) do
  local key = roomKeyPrefix .. code
  -- A body of the wrong type makes GET raise, which would abort the whole
  -- run: the member stays a candidate and every expired room ordered after
  -- it stops being collected too.
  local readable, rawRoom = pcall(function()
    return redis.call("GET", key)
  end)

  if not readable then
    -- The corrupt body is deliberately retained, but removing its index entry
    -- still needs a durable trail in case an operator later deletes that body.
    -- The staged path keeps this claim blocked while the bad key exists.
    removeIndexWithOrphanClaim(code, sweepClaimToken)
  elseif not rawRoom then
    -- Index entry without a body: the room is already gone, so it still has to
    -- be reported — staying silent left its runtime state uncollected, and
    -- since a code is only handed out once nothing remains under it, that code
    -- stopped being allocatable (#237 review). Reported apart from the real
    -- deletions though: no room died on this pass, and metering it as one would
    -- inflate reclamations with manual cleanups, older builds and corruption
    -- (#254 review).
    -- Queue before removing the index member. The token replaces any older
    -- claim for a previous incarnation, so a late acknowledgement of that
    -- older claim cannot consume this new cleanup debt.
    if removeIndexWithOrphanClaim(code, sweepClaimToken) > 0 then
      reportOrphan(code, sweepClaimToken)
    end
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
        deletedCodes[#deletedCodes + 1] = code
      end
    end
  end
end

return { deletedCodes, orphanClaims }
`;

const ACKNOWLEDGE_ORPHANED_INDEX_CLAIMS_LUA = `
local acknowledged = 0
for index = 1, #ARGV, 2 do
  local code = ARGV[index]
  local token = ARGV[index + 1]
  if redis.call("HGET", KEYS[1], code) == token then
    redis.call("HDEL", KEYS[1], code)
    redis.call("ZREM", KEYS[2], code)
    acknowledged = acknowledged + 1
  end
end
return acknowledged
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
    closeQuitTimeoutMs?: number;
    /** Report the graceful close that was replaced by a forced disconnect. */
    onCloseUnfinished?: (info: {
      quitOutcome: RedisQuitOutcome;
      budgetMs: number;
    }) => void;
    redisClient?: RedisRoomStoreClient;
  } = {},
): Promise<
  RoomStore & {
    close: () => Promise<void>;
    reconcileRoomIndex: () => Promise<void>;
  }
> {
  const redis =
    options.redisClient ??
    // Exempt, and this is the connection where the criterion is easiest to get
    // wrong: its REQUEST path (twenty-odd command sites on join / leave) has no
    // caller-side bound at all, which makes a backstop look like the obvious
    // fix. It is not, because two background passes share this connection and
    // both derive their bounds from a command's silence — the room reaper's
    // 30s sweep cap and the room index reconciler's, via `maintenance-pass`,
    // whose `stalled` outcome exists precisely to stop a pass running on top of
    // one that never came back (#261, #263). A 5s backstop would win every one
    // of those races: `stalled` becomes unreachable, and every interval issues
    // a fresh sweep onto a connection still holding the last one.
    //
    // So the request path's gap stays open here and is named rather than
    // papered over: closing it needs a bound that keeps the call tracked, or a
    // separate connection for the paths that want a backstop (#271 review).
    (createBoundedRedisClient(redisUrl, {
      bound: "caller",
      boundedBy:
        "room-reaper's sweep cap and room-index-reconciler's, both via maintenance-pass; NOT the request path",
    }) as RedisRoomStoreClient);
  const {
    orphanedRoomCodesKey,
    orphanedRoomQueueKey,
    roomKeyPrefix,
    roomsByExpiryKey,
  } = getRedisRoomStoreKeys(options.namespace);
  const now = options.now ?? Date.now;
  const closeQuitTimeoutMs =
    options.closeQuitTimeoutMs ?? CLOSE_QUIT_TIMEOUT_MS;

  function roomKey(code: string): string {
    return `${roomKeyPrefix}${code}`;
  }

  // A room key of the wrong type — corruption, or a namespace collision with
  // another user of this Redis — makes GET raise WRONGTYPE. Batches read many
  // keys at once, so letting that escape would reject the whole batch and,
  // through it, the reconcile the reaper waits on: one bad key would stop
  // every other expired room from ever being collected. Null here means the
  // body could not be read, which callers already treat as unusable.
  //
  // Which is a statement about ONE KEY, and only a reply can make it. Anything
  // else is a statement about the CONNECTION, and answering it with "no body"
  // is the unknown-as-absent mistake this codebase refuses everywhere else: a
  // Redis that stopped answering would empty every listing of live rooms and
  // send the orphan prune after their index members. A stall hangs this batch
  // rather than rejecting it, but a dropped socket or an exhausted
  // `maxRetriesPerRequest` rejects it — and either way "no reply" is not "no
  // room" (#271 review).
  async function readRoomBody(code: string): Promise<string | null> {
    try {
      return await redis.get(roomKey(code));
    } catch (error) {
      if (
        error instanceof Error &&
        error instanceof ReplyError &&
        error.message.startsWith("WRONGTYPE ")
      ) {
        return null;
      }
      throw error;
    }
  }

  // The exemption is about commands; the handshake is not one of them and has
  // no bound of its own without a `commandTimeout` (#271 review).
  await connectWithin(redis);

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
            4,
            roomsByExpiryKey,
            roomKey(code),
            orphanedRoomCodesKey,
            orphanedRoomQueueKey,
            // Empty when the read itself failed; the script's type check
            // decides that case without consulting these bytes.
            raw ?? "",
            code,
            randomUUID(),
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
        3,
        roomsByExpiryKey,
        orphanedRoomCodesKey,
        orphanedRoomQueueKey,
        roomKeyPrefix,
        randomUUID(),
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
            3,
            roomsByExpiryKey,
            orphanedRoomCodesKey,
            orphanedRoomQueueKey,
            roomKeyPrefix,
            randomUUID(),
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
                4,
                roomsByExpiryKey,
                roomKey(code),
                orphanedRoomCodesKey,
                orphanedRoomQueueKey,
                raw as string,
                code,
                randomUUID(),
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
      const deleted = await redis.eval(
        DELETE_ROOM_LUA,
        2,
        roomKey(code),
        roomsByExpiryKey,
        code,
      );
      return Number(deleted) > 0;
    },
    async deleteExpiredRooms(currentTime) {
      // Candidates come from the index, so on a database that predates it the
      // reaper would see nothing until the migration pass lands. It waits for
      // that one pass only — keeping it waiting on every later pass put a
      // keyspace walk inside one reaper tick per interval, which is what made
      // this operation's histogram bimodal.
      await ensureBootstrapReconciled();
      // Two nested arrays, in this order — a Lua table with string keys does
      // not survive the RESP conversion, only its array part does.
      const swept = await redis.eval(
        DELETE_EXPIRED_ROOMS_LUA,
        3,
        roomsByExpiryKey,
        orphanedRoomCodesKey,
        orphanedRoomQueueKey,
        roomKeyPrefix,
        String(currentTime),
        REPAIR_CHUNK_SIZE,
        randomUUID(),
      );
      const codesAt = (index: number): string[] => {
        const group = Array.isArray(swept) ? swept[index] : null;
        return Array.isArray(group) ? (group as string[]) : [];
      };
      const orphanedClaimValues = codesAt(1);
      const orphanedIndexClaims: OrphanedIndexClaim[] = [];
      for (let index = 0; index + 1 < orphanedClaimValues.length; index += 2) {
        orphanedIndexClaims.push({
          code: orphanedClaimValues[index],
          token: orphanedClaimValues[index + 1],
        });
      }
      return {
        deletedRoomCodes: codesAt(0),
        orphanedIndexCodes: orphanedIndexClaims.map(({ code }) => code),
        orphanedIndexClaims,
      };
    },
    async acknowledgeOrphanedIndexClaims(claims) {
      if (claims.length === 0) {
        return;
      }
      await redis.eval(
        ACKNOWLEDGE_ORPHANED_INDEX_CLAIMS_LUA,
        2,
        orphanedRoomCodesKey,
        orphanedRoomQueueKey,
        ...claims.flatMap(({ code, token }) => [code, token]),
      );
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
      const quitOutcome = await quitWithin(redis, closeQuitTimeoutMs);
      if (quitOutcome !== "ok") {
        options.onCloseUnfinished?.({
          quitOutcome,
          budgetMs: closeQuitTimeoutMs,
        });
      }
    },
  };
}
