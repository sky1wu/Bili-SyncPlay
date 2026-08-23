import { randomUUID } from "node:crypto";
import { ReplyError } from "ioredis";
import type { RoomListQuery } from "./admin/types.js";
import {
  connectWithin,
  createBoundedRedisClient,
  DEFAULT_REDIS_COMMAND_ADMISSION_LIMIT,
  REDIS_COMMAND_TIMEOUT_MS,
  RedisCommandAdmissionError,
} from "./redis-command-timeout.js";
import { quitWithin, type RedisQuitOutcome } from "./redis-graceful-close.js";
import { createConcurrencyLimiter } from "./concurrency-limiter.js";
import { createRetryPacer, settleWithin } from "./retry-pacer.js";
import { getRedisRoomStoreKeys } from "./redis-namespace.js";
import { RedisStoreUnavailableError } from "./redis-store-unavailable.js";
import {
  createPersistedRoom,
  type OrphanedIndexClaim,
  type RoomDeleteOutcome,
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

/**
 * Issues one Redis command under whatever bounds its caller.
 *
 * Both kinds of caller share this connection and reach the same helpers, so the
 * bound is a property of the CALL: `readRoomBody` runs inside an admin listing,
 * where nothing else stops waiting, and inside the index reconcile, where
 * `maintenance-pass` is already reading this command's silence (#277).
 */
type CommandBound = <T>(
  operationName: string,
  issue: () => Promise<T>,
) => Promise<T>;

export class RedisRoomStoreCommandTimeoutError extends RedisStoreUnavailableError {
  constructor(
    readonly operationName: string,
    readonly budgetMs: number,
  ) {
    super(
      "room",
      operationName,
      "timeout",
      `Redis room store command "${operationName}" went unanswered for ${budgetMs}ms.`,
    );
    this.name = "RedisRoomStoreCommandTimeoutError";
  }
}

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
const VALIDATE_ORPHAN_CLAIM_KEYS_LUA = `
-- Redis scripts are atomic with respect to other commands, but a runtime
-- error does not roll back writes this script already made. Validate both
-- handoff keys before any caller reaches an irreversible DEL/ZREM so one bad
-- key cannot hide rooms deleted earlier in the same sweep from its caller.
local orphanedRoomsKind = redis.call("TYPE", orphanedRoomsKey)["ok"]
if orphanedRoomsKind ~= "none" and orphanedRoomsKind ~= "hash" then
  return redis.error_reply("WRONGTYPE orphan cleanup claims must be a hash")
end
local orphanedRoomsQueueKind = redis.call(
  "TYPE", orphanedRoomsQueueKey
)["ok"]
if orphanedRoomsQueueKind ~= "none" and orphanedRoomsQueueKind ~= "zset" then
  return redis.error_reply("WRONGTYPE orphan cleanup queue must be a sorted set")
end
`;

const ORPHAN_CLAIM_PRIMITIVES_LUA = `
${VALIDATE_ORPHAN_CLAIM_KEYS_LUA}

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

${ORPHAN_CLAIM_PRIMITIVES_LUA}

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

${ORPHAN_CLAIM_PRIMITIVES_LUA}

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

// Membership goes first: a Lua error does not roll back, and a body left
// without membership is repaired by the next reconcile, whereas a membership
// left without a body would keep the room in every count until the orphan
// sweep runs. Doing both here also keeps the delete from throwing after the
// body is already gone, which would abort the caller's downstream cleanup and
// leave other nodes serving a room that no longer exists.
//
// Guarded by the bytes the caller read, like `UPDATE_ROOM_CAS_LUA` and for the
// same reason one layer further on: an unconditional `DEL` by code is a write
// nobody can bound, because a caller that stops waiting cannot stop the command
// and the room holding that code by then may be a different one entirely — with
// an owner who was already told their creation succeeded (#277). Comparing the
// whole body rather than a version is what the CAS taught: a recycled code
// starts back at version 0.
//
// Says which of the three happened rather than a DEL count: concurrent readers
// of one expired room all reach this script and only the winner may count a
// reclamation, while a body that no longer matches means the code still has a
// live room behind it and owes no runtime teardown. ZREM stays unconditional on
// the two paths where no body remains — the index entry must go even when the
// body was already collected by whoever got here first.
const DELETE_ROOM_CAS_LUA = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  redis.call("ZREM", KEYS[2], ARGV[1])
  return "already_deleted"
end
if raw ~= ARGV[2] then
  return "superseded"
end
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("DEL", KEYS[1])
return "deleted"
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

${ORPHAN_CLAIM_PRIMITIVES_LUA}

local function isFiniteNumber(value)
  return type(value) == "number"
    and value == value
    and value ~= math.huge
    and value ~= -math.huge
end

local function isOptionalNullableString(value)
  return value == nil or value == cjson.null or type(value) == "string"
end

local function isSharedVideo(value)
  if value == cjson.null then
    return true
  end
  return type(value) == "table"
    and type(value["videoId"]) == "string"
    and type(value["url"]) == "string"
    and type(value["title"]) == "string"
    and (value["sharedByMemberId"] == nil
      or type(value["sharedByMemberId"]) == "string")
    and (value["sharedByDisplayName"] == nil
      or type(value["sharedByDisplayName"]) == "string")
end

local function isPlayback(value)
  if value == cjson.null then
    return true
  end
  if type(value) ~= "table" then
    return false
  end
  local playState = value["playState"]
  local syncIntent = value["syncIntent"]
  return type(value["url"]) == "string"
    and isFiniteNumber(value["currentTime"])
    and (playState == "playing"
      or playState == "paused"
      or playState == "buffering")
    and (syncIntent == nil
      or syncIntent == "explicit-seek"
      or syncIntent == "explicit-ratechange")
    and (value["userInitiated"] == nil
      or type(value["userInitiated"]) == "boolean")
    and (value["naturalEnd"] == nil
      or type(value["naturalEnd"]) == "boolean")
    and isFiniteNumber(value["playbackRate"])
    and isFiniteNumber(value["updatedAt"])
    and isFiniteNumber(value["serverTime"])
    and type(value["actorId"]) == "string"
    and isFiniteNumber(value["seq"])
end

local function isUsableRoom(room, code)
  if type(room) ~= "table" then
    return false
  end
  local version = room["version"]
  local expiresAt = room["expiresAt"]
  return room["code"] == code
    and type(room["joinToken"]) == "string"
    and isFiniteNumber(room["createdAt"])
    and isOptionalNullableString(room["ownerMemberId"])
    and isOptionalNullableString(room["ownerDisplayName"])
    and isSharedVideo(room["sharedVideo"])
    and isPlayback(room["playback"])
    and isFiniteNumber(version)
    and version >= 0
    and version % 1 == 0
    and isFiniteNumber(room["lastActiveAt"])
    and (expiresAt == cjson.null or isFiniteNumber(expiresAt))
end

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
  if not ok or not isUsableRoom(room, code) then
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
    -- Use the same complete body predicate as the orphan-claim path. A body
    -- that merely has a plausible expiry is still corruption, not permission
    -- to delete it and report a room teardown as though its full state existed.
    if ok and isUsableRoom(room, code) then
      local expiresAt = room["expiresAt"]
      if expiresAt == cjson.null then
        redis.call("ZADD", roomsKey, "+inf", code)
      elseif expiresAt <= now then
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
local orphanedRoomsKey = KEYS[1]
local orphanedRoomsQueueKey = KEYS[2]

${VALIDATE_ORPHAN_CLAIM_KEYS_LUA}

local acknowledged = 0
for index = 1, #ARGV, 2 do
  local code = ARGV[index]
  local token = ARGV[index + 1]
  if redis.call("HGET", orphanedRoomsKey, code) == token then
    redis.call("HDEL", orphanedRoomsKey, code)
    redis.call("ZREM", orphanedRoomsQueueKey, code)
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

// One unusable value must not take down a whole batch. Batch reads quarantine
// it from the enumeration index only after staging a durable cleanup claim;
// point reads reject it as unknown. That lets healthy rooms keep reconciling
// without treating corruption as proof that a live room or cleanup debt is
// safe to consume.
//
// Valid JSON is not enough: every point-read consumer trusts the complete
// PersistedRoom contract, while the reaper uses this same answer as proof that
// a room code was recycled and an older cleanup claim may be consumed. Keep a
// single complete predicate for both point and batch reads; the Lua reaper
// mirrors it before making the same code-reuse decision atomically in Redis.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOptionalNullableString(
  value: unknown,
): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUsableSharedVideo(
  value: unknown,
): value is NonNullable<PersistedRoom["sharedVideo"]> {
  return (
    isRecord(value) &&
    typeof value.videoId === "string" &&
    typeof value.url === "string" &&
    typeof value.title === "string" &&
    (value.sharedByMemberId === undefined ||
      typeof value.sharedByMemberId === "string") &&
    (value.sharedByDisplayName === undefined ||
      typeof value.sharedByDisplayName === "string")
  );
}

function isUsablePlayback(
  value: unknown,
): value is NonNullable<PersistedRoom["playback"]> {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.url === "string" &&
    isFiniteNumber(value.currentTime) &&
    (value.playState === "playing" ||
      value.playState === "paused" ||
      value.playState === "buffering") &&
    (value.syncIntent === undefined ||
      value.syncIntent === "explicit-seek" ||
      value.syncIntent === "explicit-ratechange") &&
    (value.userInitiated === undefined ||
      typeof value.userInitiated === "boolean") &&
    (value.naturalEnd === undefined || typeof value.naturalEnd === "boolean") &&
    isFiniteNumber(value.playbackRate) &&
    isFiniteNumber(value.updatedAt) &&
    isFiniteNumber(value.serverTime) &&
    typeof value.actorId === "string" &&
    isFiniteNumber(value.seq)
  );
}

function isUsableRoom(
  value: unknown,
  expectedCode: string,
): value is PersistedRoom {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.code === expectedCode &&
    typeof value.joinToken === "string" &&
    isFiniteNumber(value.createdAt) &&
    isOptionalNullableString(value.ownerMemberId) &&
    isOptionalNullableString(value.ownerDisplayName) &&
    (value.sharedVideo === null || isUsableSharedVideo(value.sharedVideo)) &&
    (value.playback === null || isUsablePlayback(value.playback)) &&
    isFiniteNumber(value.version) &&
    Number.isInteger(value.version) &&
    value.version >= 0 &&
    isFiniteNumber(value.lastActiveAt) &&
    (value.expiresAt === null || isFiniteNumber(value.expiresAt))
  );
}

function parseRoom(
  value: string | null,
  expectedCode: string,
): PersistedRoom | null {
  if (value === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Room ${expectedCode} contains invalid JSON.`, {
      cause: error,
    });
  }
  if (!isUsableRoom(parsed, expectedCode)) {
    throw new Error(`Room ${expectedCode} contains an invalid room body.`);
  }
  return parsed;
}

function parseRoomOrNull(
  value: string | null,
  expectedCode: string,
): PersistedRoom | null {
  try {
    return parseRoom(value, expectedCode);
  } catch {
    return null;
  }
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
    /**
     * How long a request-path command may go unanswered. A liveness bound, not
     * a deadline: it asks the same question as `REDIS_COMMAND_TIMEOUT_MS` and
     * carries the same magnitude, because a shorter one would fail a merely
     * slow Redis.
     */
    commandTimeoutMs?: number;
    /** Commands admitted here hold their slot until the real Redis reply. */
    maxPendingCommands?: number;
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
    // The request path is bounded HERE instead, by `boundCommand`: a cap that
    // answers the caller and leaves the command tracked, so both passes keep
    // reading the silence they derive their bounds from (#277). That is why the
    // choice is per CALL — the two passes reach the very same helpers.
    //
    // What this does NOT resolve: the three durable writes (`createRoom`,
    // `updateRoom`, `deleteRoom`). Capping a write whose effect
    // does not expire on its own tells a caller it failed while the write may
    // still land, which is #237's trade and needs its own derivation.
    (createBoundedRedisClient(redisUrl, {
      bound: "caller",
      boundedBy:
        "boundCommand's cap on the request path, plus room-reaper's sweep cap and room-index-reconciler's, both via maintenance-pass; NOT the three durable writes",
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
  const commandTimeoutMs = options.commandTimeoutMs ?? REDIS_COMMAND_TIMEOUT_MS;
  const maxPendingCommands =
    options.maxPendingCommands ?? DEFAULT_REDIS_COMMAND_ADMISSION_LIMIT;
  /**
   * Only the cap and the tracking are used; this store does not retry. Sharing
   * the primitive is what keeps "a timeout is not a cancel" from acquiring
   * another private implementation (#242), and `trackedCount()` is the
   * admission counter below — one number for both halves of #277, counting
   * commands that outlived their cap because those are exactly the ones still
   * sitting in ioredis's queue.
   */
  const commandPacer = createRetryPacer({
    initialDelayMs: commandTimeoutMs,
    maxDelayMs: commandTimeoutMs,
  });
  /**
   * Keeps a listing's own fan-out clear of the admission limit.
   *
   * Admission is a refusal-style safety boundary; this is a waiting budget for
   * work already accepted, and mixing the two roles is what turns a boundary
   * into a partial business operation (`concurrency-limiter`, #275). Without it
   * `listRooms` reads a whole `REPAIR_CHUNK_SIZE` batch at once, so a
   * deployment with more rooms than `maxPendingCommands` fails every listing on
   * a perfectly healthy Redis — 257 rooms was enough (#277 review).
   *
   * Half the limit, so a listing in flight can never refuse a join's `getRoom`
   * either, and vice versa.
   */
  const listingFanOut = createConcurrencyLimiter(
    Math.max(1, Math.floor(maxPendingCommands / 2)),
  );

  /**
   * The caller-side bound for a command nobody else is waiting behind.
   *
   * Refuse-then-cap, in that order, because the refusal is the one answer with
   * no ambiguity in it: past `maxPendingCommands` unanswered commands the next
   * one is never issued, so nothing can land later. The cap that follows only
   * answers the caller — `capAttempt` leaves the command tracked, which is what
   * lets the two maintenance passes on this connection keep deriving their own
   * bounds from its silence, and what a connection-wide `commandTimeout` could
   * not do (#271, #277).
   *
   * `async` so that no failure — the refusal, or anything `issue()` throws
   * before it returns a promise — can leave this function synchronously. A
   * caller assembling several of these into one `Promise.all` literal would
   * otherwise abandon the list with earlier commands already issued and
   * unhandled (#277 review).
   */
  async function boundCommand<T>(
    operationName: string,
    issue: () => Promise<T>,
  ): Promise<T> {
    if (commandPacer.trackedCount() >= maxPendingCommands) {
      const cause = new RedisCommandAdmissionError(maxPendingCommands);
      throw new RedisStoreUnavailableError(
        "room",
        operationName,
        "admission",
        cause.message,
        { cause },
      );
    }
    return await commandPacer.capAttempt(
      issue(),
      commandTimeoutMs,
      () =>
        new RedisRoomStoreCommandTimeoutError(operationName, commandTimeoutMs),
    );
  }

  /**
   * Commands answered by a pass-bounded caller. Any answer counts, including an
   * error: the question is whether the connection is still moving, and
   * `awaitBootstrapReconcile` is the only reader.
   */
  let reconcileProgress = 0;

  /**
   * For a command whose caller already derives a bound from its silence — the
   * room reaper's sweep and the index reconcile, both through
   * `maintenance-pass`, whose `stalled` outcome exists to stop a pass running
   * on top of one that never came back (#261, #263).
   */
  const boundedByOuterCaller: CommandBound = (_operationName, issue) =>
    issue().finally(() => {
      reconcileProgress += 1;
    });

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
  async function readRoomBody(
    code: string,
    bound: CommandBound,
  ): Promise<string | null> {
    try {
      return await bound("read_room_body", () => redis.get(roomKey(code)));
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
      const [nextCursor, keys] = await boundedByOuterCaller(
        "reconcile_scan",
        () =>
          redis.scan(
            cursor,
            "MATCH",
            `${escapeGlobPattern(roomKeyPrefix)}*`,
            "COUNT",
            REPAIR_CHUNK_SIZE,
          ),
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
            readRoomBody(code, boundedByOuterCaller),
            boundedByOuterCaller("reconcile_score", () =>
              redis.zscore(roomsByExpiryKey, code),
            ),
          ]);
          return { code, raw, score, room: parseRoomOrNull(raw, code) };
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
          boundedByOuterCaller("reconcile_member", () =>
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
        ),
      );

      // A body that exists but cannot be read must leave the set, or counting
      // and enumeration disagree about it for as long as it sits there.
      const unreadable = loaded.filter(
        ({ room, score }) => room === null && score !== null,
      );
      await Promise.all(
        unreadable.map(async ({ code, raw }) =>
          boundedByOuterCaller("reconcile_quarantine", () =>
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
        ),
      );
    } while (cursor !== "0");
  }

  // The other direction: members whose room body is gone.
  async function pruneOrphanedMembers(): Promise<void> {
    let cursor = "0";
    do {
      const [nextCursor, entries] = await boundedByOuterCaller(
        "prune_orphaned_scan",
        () => redis.zscan(roomsByExpiryKey, cursor, "COUNT", REPAIR_CHUNK_SIZE),
      );
      cursor = nextCursor;

      // ZSCAN returns a flat [member, score, member, score, ...] reply.
      const codes = entries.filter((_, index) => index % 2 === 0);
      if (codes.length === 0) {
        continue;
      }

      await boundedByOuterCaller("prune_orphaned_members", () =>
        redis.eval(
          PRUNE_ORPHANED_MEMBERS_LUA,
          3,
          roomsByExpiryKey,
          orphanedRoomCodesKey,
          orphanedRoomQueueKey,
          roomKeyPrefix,
          randomUUID(),
          ...codes,
        ),
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

  /**
   * The migration wait, for a caller that has to be answered.
   *
   * `boundCommand` bounds the commands a read issues itself, and would leave
   * the read hanging on a pass it merely joined: the reconcile's own commands
   * are deliberately uncapped, because the reconciler's `maintenance-pass` is
   * reading their silence. So the request side bounds the WAIT rather than the
   * pass — the pass keeps running, and its next caller can still join it.
   *
   * On SILENCE, not on duration. The bootstrap pass walks the whole keyspace, so
   * on a large database it legitimately takes far longer than any one command
   * may; a total budget here would fail every admin listing for the length of a
   * healthy migration. Healthy work grows with the database, one unanswered
   * command does not — the same rule that keeps a startup migration on a
   * per-command deadline (#271 review). So this gives up only when a whole
   * window passes with no reconcile command answering at all.
   */
  async function awaitBootstrapReconcile(operationName: string): Promise<void> {
    if (bootstrapReconciled) {
      return;
    }
    const pass = ensureBootstrapReconciled();
    let observedProgress = reconcileProgress;
    // `settleWithin` absorbs the pass's rejection, which is what makes the
    // timed-out branch safe: the pass outlives this wait, and a rejection with
    // nobody left listening is an unhandled rejection — a process exit on
    // Node 22, not a logged warning (#275).
    while (!(await settleWithin(pass, commandTimeoutMs))) {
      if (reconcileProgress === observedProgress) {
        throw new RedisRoomStoreCommandTimeoutError(
          `${operationName}:bootstrap_reconcile`,
          commandTimeoutMs,
        );
      }
      observedProgress = reconcileProgress;
    }
    // Settled, so this only re-raises a real failure. A listing built on an
    // index known to be incomplete is what the wait exists to prevent.
    await pass;
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
    await awaitBootstrapReconcile("list_rooms");

    // Members are the room codes; ordering here is irrelevant because rooms
    // are re-sorted below by query.sortBy once their bodies are loaded.
    const codes = await boundCommand("list_rooms", () =>
      redis.zrange(roomsByExpiryKey, 0, -1),
    );

    // Batched rather than one Promise.all over every code: a database that
    // has just been migrated can hand back every room at once, and queueing
    // that many GETs would spike heap and stall the connection.
    const rooms: PersistedRoom[] = [];
    for (let offset = 0; offset < codes.length; offset += REPAIR_CHUNK_SIZE) {
      const batch = codes.slice(offset, offset + REPAIR_CHUNK_SIZE);
      const loaded = await Promise.all(
        batch.map(async (code) =>
          listingFanOut.run(async () => {
            const raw = await readRoomBody(code, boundCommand);
            return { code, raw, room: parseRoomOrNull(raw, code) };
          }),
        ),
      );

      // Codes with no body at all: the script re-checks EXISTS, so a body
      // written between the read and the prune keeps its membership.
      const orphanedCodes = loaded
        .filter(({ raw }) => raw === null)
        .map(({ code }) => code);
      if (orphanedCodes.length > 0) {
        try {
          await boundCommand("list_rooms", () =>
            redis.eval(
              PRUNE_ORPHANED_MEMBERS_LUA,
              3,
              roomsByExpiryKey,
              orphanedRoomCodesKey,
              orphanedRoomQueueKey,
              roomKeyPrefix,
              randomUUID(),
              ...orphanedCodes,
            ),
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
              listingFanOut.run(() =>
                boundCommand("list_rooms", () =>
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

  /**
   * The one guarded delete both public deletes are made of.
   *
   * Read, judge, then write under the bytes that were judged. The predicate
   * runs in JS on purpose: this file never decodes room JSON inside a script,
   * because Redis's cjson formats numbers with `%.14g` and that is how playback
   * positions got mangled. The script's own comparison is on raw bytes, so the
   * decision and the delete cannot be split by a concurrent write — which is
   * what a check-then-act delete by code could never promise (#277).
   */
  async function deleteRoomWhen(
    code: string,
    accept: (current: PersistedRoom) => boolean,
  ): Promise<RoomDeleteOutcome> {
    const key = roomKey(code);
    const rawRoom = await boundCommand("delete_room", () => redis.get(key));
    if (rawRoom !== null) {
      const currentRoom = parseRoom(rawRoom, code);
      // An unreadable body is never deleted here: it cannot be judged, and the
      // sweep's quarantine owns that case rather than a guess made on a
      // request path.
      if (!currentRoom || !accept(currentRoom)) {
        return "superseded";
      }
    }
    // `""` for a body we did not find. A body present at write time is then by
    // definition not the one that was judged, so the script declines instead of
    // deleting whatever arrived in between.
    const outcome = await boundCommand("delete_room", () =>
      redis.eval(
        DELETE_ROOM_CAS_LUA,
        2,
        key,
        roomsByExpiryKey,
        code,
        rawRoom ?? "",
      ),
    );
    if (outcome === "deleted" || outcome === "already_deleted") {
      return outcome;
    }
    return "superseded";
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
    async getRoom(code, caller = "request") {
      // Requests own this deadline; the runtime-teardown precondition read is
      // also reached from the room reaper, whose maintenance pass must keep
      // deriving `stalled` from the command's silence (#277).
      const bound = caller === "request" ? boundCommand : boundedByOuterCaller;
      return parseRoom(
        await bound("get_room", () => redis.get(roomKey(code))),
        code,
      );
    },
    async updateRoom(code, expectedVersion, patch): Promise<RoomUpdateResult> {
      const key = roomKey(code);
      // The read half is capped like any other read; the CAS below is one of
      // the three durable writes this change leaves for its own derivation.
      const rawRoom = await boundCommand("update_room", () => redis.get(key));
      if (rawRoom === null) {
        return { ok: false, reason: "not_found" };
      }
      const currentRoom = parseRoom(rawRoom, code);
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
    deleteRoom(expected) {
      // Pinned by `joinToken`, not by the whole record: the members of a room an
      // admin is closing are disconnected first, and their leaves rewrite the
      // body, so a version-exact guard would decline the action that caused the
      // change. A recycled code always brings a new token with it.
      return deleteRoomWhen(
        expected.code,
        (current) => current.joinToken === expected.joinToken,
      );
    },
    deleteExpiredRoom(code, currentTime) {
      return deleteRoomWhen(
        code,
        (current) =>
          current.expiresAt !== null && current.expiresAt <= currentTime,
      );
    },
    async deleteExpiredRooms(currentTime) {
      // Candidates come from the index, so on a database that predates it the
      // reaper would see nothing until the migration pass lands. It waits for
      // that one pass only — keeping it waiting on every later pass put a
      // keyspace walk inside one reaper tick per interval, which is what made
      // this operation's histogram bimodal.
      //
      // Uncapped, unlike the listing's wait on the same pass: this caller is
      // the reaper, and `maintenance-pass` is already deriving `stalled` from
      // this call not coming back.
      await ensureBootstrapReconciled();
      // Two nested arrays, in this order — a Lua table with string keys does
      // not survive the RESP conversion, only its array part does.
      const swept = await boundedByOuterCaller("delete_expired_rooms", () =>
        redis.eval(
          DELETE_EXPIRED_ROOMS_LUA,
          3,
          roomsByExpiryKey,
          orphanedRoomCodesKey,
          orphanedRoomQueueKey,
          roomKeyPrefix,
          String(currentTime),
          REPAIR_CHUNK_SIZE,
          randomUUID(),
        ),
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
      await boundedByOuterCaller("acknowledge_orphaned_index_claims", () =>
        redis.eval(
          ACKNOWLEDGE_ORPHANED_INDEX_CLAIMS_LUA,
          2,
          orphanedRoomCodesKey,
          orphanedRoomQueueKey,
          ...claims.flatMap(({ code, token }) => [code, token]),
        ),
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
      await awaitBootstrapReconcile("count_rooms");

      if (!query.keyword) {
        return query.includeExpired
          ? await boundCommand("count_rooms", () =>
              redis.zcard(roomsByExpiryKey),
            )
          : await boundCommand("count_rooms", () =>
              redis.zcount(roomsByExpiryKey, `(${now()}`, "+inf"),
            );
      }

      // Keyword search has to look at every candidate code, but codes come
      // straight out of the set — no room bodies are fetched.
      const keyword = query.keyword.toLowerCase();
      const codes = query.includeExpired
        ? await boundCommand("count_rooms", () =>
            redis.zrange(roomsByExpiryKey, 0, -1),
          )
        : await boundCommand("count_rooms", () =>
            redis.zrangebyscore(roomsByExpiryKey, `(${now()}`, "+inf"),
          );
      return codes.filter((code) => code.toLowerCase().includes(keyword))
        .length;
    },
    async isReady() {
      try {
        // The readiness probe is the one caller that must never wait: an
        // unanswered PING is the exact condition it is asked to report, and
        // uncapped it answered neither ready nor not-ready.
        const pong = await boundCommand("is_ready", () => redis.ping());
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
