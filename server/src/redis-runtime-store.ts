import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Redis } from "ioredis";
import type { MetricsCollector } from "./admin/metrics.js";
import type { ActiveRoom, ClusterNodeStatus, Session } from "./types.js";
import {
  createInMemoryRuntimeStore,
  DEFAULT_MEMBER_TOKEN_RETENTION_MS,
  type RuntimeStore,
} from "./runtime-store.js";
import {
  findMemberIdByTokenEntries,
  getPreviousRoomToLeave,
  resolveRoomCodeToLeave,
} from "./runtime-store-state.js";
import { createRetryPacer } from "./retry-pacer.js";
import {
  createDurableWriteQueue,
  NonRetryableWriteError,
  type DurableWriteQueueOptions,
  type DurableWriteRequest,
} from "./durable-write-queue.js";

type RedisMulti = {
  sadd: (...args: string[]) => RedisMulti;
  srem: (...args: string[]) => RedisMulti;
  del: (...keys: string[]) => RedisMulti;
  hset: (key: string, ...args: unknown[]) => RedisMulti;
  hdel: (key: string, ...fields: string[]) => RedisMulti;
  zadd: (key: string, score: string, member: string) => RedisMulti;
  zrem: (key: string, ...members: string[]) => RedisMulti;
  exec: () => Promise<unknown>;
};

type RedisClient = {
  connect: () => Promise<unknown>;
  quit: () => Promise<unknown>;
  multi: (...args: unknown[]) => RedisMulti;
  hgetall: (key: string) => Promise<Record<string, string>>;
  hget: (key: string, field: string) => Promise<string | null>;
  smembers: (key: string) => Promise<string[]>;
  scard: (key: string) => Promise<number>;
  sadd: (key: string, ...members: string[]) => Promise<unknown>;
  srem: (key: string, ...members: string[]) => Promise<unknown>;
  zadd: (key: string, score: string, member: string) => Promise<unknown>;
  zremrangebyscore: (key: string, min: number, max: number) => Promise<unknown>;
  zrange: (key: string, start: number, stop: number) => Promise<string[]>;
  zrem: (key: string, ...members: string[]) => Promise<unknown>;
  zscore: (key: string, member: string) => Promise<string | null>;
  set: (
    key: string,
    value: string,
    nx: "NX",
    px: "PX",
    milliseconds: number,
  ) => Promise<string | null>;
  eval: (
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ) => Promise<unknown>;
  del: (...keys: string[]) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
};

/**
 * Exported so the bootstrap's logging hook shares this exact union rather than
 * re-declaring it: a structurally identical copy diverges silently the moment a
 * new reason is added here.
 */
export type PendingOperationLogContext = {
  operationName: string;
  pendingCount: number;
  reason: "backpressure" | "timeout" | "failed" | "retry";
};

type RedisRuntimeSession = {
  id: string;
  instanceId: string | null;
  remoteAddress: string | null;
  origin: string | null;
  roomCode: string | null;
  memberId: string | null;
  displayName: string;
  memberToken: string | null;
  joinedAt: number | null;
  invalidMessageCount: number;
};

type RuntimeStoreOptions = {
  keyPrefix?: string;
  /**
   * How long a DISCONNECTED member's identity survives before their token stops
   * reclaiming it. Per identity, not per room — see
   * `DEFAULT_MEMBER_TOKEN_RETENTION_MS`.
   */
  memberTokenRetentionMs?: number;
  now?: () => number;
  maxPendingOperations?: number;
  pendingOperationTimeoutMs?: number;
  /**
   * Retry policy for the queued session writes. Bounded on purpose: a room code
   * that has been recycled must not inherit an ancient write, and the writes are
   * ordered per session, so a queue that retried forever would also stall every
   * later write for that session. See `durable-write-queue`.
   */
  writeRetry?: Pick<
    DurableWriteQueueOptions,
    "maxAttempts" | "initialRetryDelayMs" | "maxRetryDelayMs" | "sleep"
  >;
  redisClient?: RedisClient;
  onPendingOperationError?: (
    context: PendingOperationLogContext,
    error: unknown,
  ) => void;
  metricsCollector?: Pick<
    MetricsCollector,
    "observeRedisRuntimeStoreDuration" | "observeRedisRuntimeStoreFailure"
  >;
};

const RUNTIME_STORE_METHOD_NAMES = [
  "registerSession",
  "flush",
  "confirmWrites",
  "unregisterSession",
  "markSessionJoinedRoom",
  "markSessionLeftRoom",
  "recordEvent",
  "getSession",
  "listSessionsByRoom",
  "getConnectionCount",
  "getActiveRoomCount",
  "getActiveMemberCount",
  "getStartedAt",
  "getRecentEventCounts",
  "getLifetimeEventCounts",
  "getActiveRoomCodes",
  "getRoom",
  "getOrCreateRoom",
  "addMember",
  "findMemberIdByToken",
  "isMemberTokenBlocked",
  "blockMemberToken",
  "tryClaimMessageSlot",
  "releaseMessageSlot",
  "acquireRoomLock",
  "releaseRoomLock",
  "removeMember",
  "revokeMemberToken",
  "evictMemberToken",
  "hasRoomResidue",
  "getRoomGeneration",
  "markRoomGeneration",
  "deleteRoom",
  "heartbeatNode",
  "listNodeStatuses",
  "purgeNodeStatus",
  "countClusterActiveRooms",
  "listClusterActiveRoomCodes",
  "listClusterSessionsByRoom",
  "listClusterSessions",
  "close",
] as const;

function assertRuntimeStoreShape(
  value: object,
): asserts value is RuntimeStore & { close: () => Promise<void> } {
  for (const methodName of RUNTIME_STORE_METHOD_NAMES) {
    if (typeof Reflect.get(value, methodName) !== "function") {
      throw new TypeError(
        `Redis runtime store is missing method: ${methodName}`,
      );
    }
  }
}

function normalizeNullable(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function encodeNullable(value: string | null | undefined): string {
  return value ?? "";
}

function sessionKey(prefix: string, sessionId: string): string {
  return `${prefix}session:${sessionId}`;
}

function roomSessionsKey(prefix: string, roomCode: string): string {
  return `${prefix}room:${roomCode}:sessions`;
}

function roomMembersKey(prefix: string, roomCode: string): string {
  return `${prefix}room:${roomCode}:members`;
}

function roomMemberTokensKey(prefix: string, roomCode: string): string {
  return `${prefix}room:${roomCode}:member-tokens`;
}

function roomMemberTokenExpiryKey(prefix: string, roomCode: string): string {
  return `${prefix}room:${roomCode}:member-token-expiry`;
}

function roomGenerationKey(prefix: string, roomCode: string): string {
  return `${prefix}room:${roomCode}:generation`;
}

function blockedTokensKey(prefix: string, roomCode: string): string {
  return `${prefix}room:${roomCode}:blocked-member-tokens`;
}

function dedupSlotKey(prefix: string, roomCode: string, key: string): string {
  return `${prefix}room:${roomCode}:dedup:${key}`;
}

function dedupTrackingZsetKey(prefix: string, roomCode: string): string {
  return `${prefix}room:${roomCode}:dedup-slots`;
}

function roomLockKey(prefix: string, roomCode: string, key: string): string {
  return `${prefix}room:${roomCode}:lock:${key}`;
}

const ROOM_LOCK_RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function nodesKey(prefix: string): string {
  return `${prefix}nodes`;
}

function nodeStatusKey(prefix: string, instanceId: string): string {
  return `${prefix}node:${instanceId}`;
}

/**
 * What a teardown leaves in the generation key instead of deleting it.
 *
 * Deleting made "this room was torn down" indistinguishable from "this room
 * never had a generation", so a join that pinned `""` against a legacy room
 * matched just as well after the room was deleted — and rebuilt the indexes of
 * a room whose persisted record was gone, stranding the code with them (#242
 * review). Generations are UUIDs, so this value can never be mistaken for one.
 *
 * It does NOT expire. A TTL would have to outlive every write that could still
 * be holding the old pin, and nothing bounds those: a session chain waits on a
 * command that was never cancelled, and that command ends when Redis answers,
 * not when a timer says so. A tombstone that lapsed first would let the join's
 * `""` pin match an absent key all over again, which is the whole hazard (#242
 * review). What reclaims it instead is the next occupant: `markRoomGeneration`
 * overwrites the key, so the cost is one short string per room code that has
 * been deleted and not yet reused. Deliberately NOT counted by
 * `hasRoomResidue`, so a tombstone never keeps a code reserved.
 */
const ROOM_GENERATION_TOMBSTONE = "deleted";

const DEFAULT_MAX_PENDING_OPERATIONS = 256;
const DEFAULT_PENDING_OPERATION_TIMEOUT_MS = 5_000;
// Floor TTL applied only when the caller's expiresAt is already non-positive
// (GC pause, event-loop jitter, clock drift). Positive but small TTLs are
// respected as-is so callers retain control over the dedup window semantics.
const DEDUP_SLOT_MIN_TTL_MS = 1_000;

function serializeSession(session: Session): RedisRuntimeSession {
  return {
    id: session.id,
    instanceId: session.instanceId ?? null,
    remoteAddress: session.remoteAddress,
    origin: session.origin,
    roomCode: session.roomCode,
    memberId: session.memberId,
    displayName: session.displayName,
    memberToken: session.memberToken,
    joinedAt: session.joinedAt,
    invalidMessageCount: session.invalidMessageCount,
  };
}

/**
 * The complete session record as Redis hash fields.
 *
 * Shared by `registerSession` and the join write so the two cannot describe a
 * session differently — a join that wrote a strict subset was how a lost
 * registration turned into a permanently unreadable session hash (#242).
 */
function sessionHashRecord(
  session: Session,
  roomCodeOverride?: string,
): Record<string, string> {
  const serialized = serializeSession(session);
  return {
    id: serialized.id,
    instanceId: encodeNullable(serialized.instanceId),
    remoteAddress: encodeNullable(serialized.remoteAddress),
    origin: encodeNullable(serialized.origin),
    roomCode: roomCodeOverride ?? encodeNullable(serialized.roomCode),
    memberId: encodeNullable(serialized.memberId),
    displayName: serialized.displayName,
    memberToken: encodeNullable(serialized.memberToken),
    joinedAt: serialized.joinedAt === null ? "" : String(serialized.joinedAt),
    invalidMessageCount: String(serialized.invalidMessageCount),
  };
}

function flattenHashRecord(record: Record<string, string>): string[] {
  return Object.entries(record).flat();
}

function deserializeSession(fields: Record<string, string>): Session | null {
  if (!fields.id) {
    return null;
  }

  return {
    id: fields.id,
    connectionState: "detached",
    socket: null,
    instanceId: normalizeNullable(fields.instanceId),
    remoteAddress: normalizeNullable(fields.remoteAddress),
    origin: normalizeNullable(fields.origin),
    roomCode: normalizeNullable(fields.roomCode),
    memberId: normalizeNullable(fields.memberId),
    displayName: fields.displayName || fields.id,
    memberToken: normalizeNullable(fields.memberToken),
    joinedAt:
      fields.joinedAt && fields.joinedAt.length > 0
        ? Number(fields.joinedAt)
        : null,
    invalidMessageCount: Number(fields.invalidMessageCount ?? "0"),
    rateLimitState: {
      roomCreate: { windowStart: 0, count: 0 },
      roomJoin: { windowStart: 0, count: 0 },
      videoShare: { windowStart: 0, count: 0 },
      playbackUpdate: { tokens: 0, lastRefillAt: 0 },
      syncRequest: { windowStart: 0, count: 0 },
      syncPing: { tokens: 0, lastRefillAt: 0 },
    },
  };
}

/**
 * Revoke a member token, optionally only while the memberId is still bound to
 * the caller's session (or bound to nobody).
 *
 * The guard has to read the SHARED binding, not a node-local one: after a member
 * reconnects onto another node, the old node's local map still lists the old
 * session as the member, so a node-local check would let that node's explicit
 * leave revoke the identity the new node is actively using (#237 review).
 */
const REVOKE_MEMBER_TOKEN_LUA = `
local bound = redis.call("HGET", KEYS[1], ARGV[1])
if ARGV[2] ~= "" and bound and bound ~= ARGV[2] then
  return 0
end
redis.call("HDEL", KEYS[2], ARGV[1])
redis.call("ZREM", KEYS[3], ARGV[1])
return 1
`;

/**
 * Evict a member in one commit: block the token and end the identity together.
 *
 * Two independent writes could not be made consistent by ordering alone — once
 * the block landed there was nothing to roll it back with if the revoke then
 * failed (#237 review). One script either does both or neither.
 */
const EVICT_MEMBER_LUA = `
redis.call("ZADD", KEYS[1], ARGV[3], ARGV[2])
redis.call("HDEL", KEYS[2], ARGV[1])
redis.call("ZREM", KEYS[3], ARGV[1])
return 1
`;

/**
 * Delete a room's runtime keys only while its generation is the one the caller
 * decided against. `ARGV[1]` is `""` for "no generation", which matches only an
 * absent key — a room that predates generations is still collected, one that has
 * since been stamped by a new occupant is left alone.
 */
const DELETE_ROOM_LUA = `
if ARGV[1] ~= "*" then
  local stored = redis.call("GET", KEYS[1])
  if (stored or "") ~= ARGV[1] then
    return 0
  end
end
for index = 3, #KEYS do
  redis.call("DEL", KEYS[index])
end
redis.call("SET", KEYS[1], ARGV[3])
redis.call("SREM", KEYS[2], ARGV[2])
return 1
`;

/**
 * Drop a member's presence and start their identity's retention clock — but
 * only if they still HAVE an identity.
 *
 * A kick deletes the token and its expiry entry, and the socket close that
 * follows still runs this path. Registering an expiry unconditionally then left
 * a `member-token-expiry` entry with no token behind it, which nothing collects
 * once the room goes quiet (the prune is lazy). The binding check has to be in
 * the same script as both writes, or the same interleaving reappears between
 * them (#237 review).
 */
const REMOVE_MEMBER_LUA = `
local bound = redis.call("HGET", KEYS[1], ARGV[1])
if ARGV[2] ~= "" and bound and bound ~= ARGV[2] then
  return 0
end
redis.call("HDEL", KEYS[1], ARGV[1])
if redis.call("HEXISTS", KEYS[2], ARGV[1]) == 1 then
  redis.call("ZADD", KEYS[3], ARGV[3], ARGV[1])
end
return 1
`;

/**
 * Any key still present means the code is not free to hand out.
 *
 * The two score-indexed sets are trimmed by the current time first. Redis does
 * not drop zset members when their score passes, and the lazy sweeps that
 * normally do it (`isMemberTokenBlocked`, `tryClaimMessageSlot`) are only
 * reached through a room that no longer exists — so a long-lapsed block or a
 * dedup slot whose TTL ran out years ago would keep the code reserved forever
 * (#237 review).
 */
const ROOM_RESIDUE_LUA = `
redis.call("ZREMRANGEBYSCORE", KEYS[4], "-inf", ARGV[1])
redis.call("ZREMRANGEBYSCORE", KEYS[6], "-inf", ARGV[1])
for index = 1, #KEYS do
  if redis.call("EXISTS", KEYS[index]) == 1 then
    return 1
  end
end
return 0
`;

const MARK_ROOM_GENERATION_LUA = `
redis.call("SET", KEYS[1], ARGV[1])
return 1
`;

/**
 * Seat a session in a room: full session record, session index, room index.
 *
 * One script rather than a transaction, for two reasons that only matter once
 * the write can be RETRIED (#242):
 *
 * - **The whole session record travels with it.** `registerSession` is a
 *   separate queued write and can have failed; a join that patched only
 *   `roomCode` on top of that left a hash with no \`id\`, which `loadSession`
 *   reads as no session at all — so the joiner was missing from every state
 *   built off the shared view, and the stored sharer's reconnect handed the
 *   share to a stand-in. Writing the full record makes the join self-healing.
 * - **It is conditional on the room generation.** Room codes are recycled, so a
 *   retry of this write must never land on the room that took the code over in
 *   the meantime. Reading the generation and writing under it in one script is
 *   what makes the check sound: a read-then-write from the client leaves a
 *   window that the recycle can fit through — the same reasoning as
 *   \`DELETE_ROOM_LUA\` (#237 review).
 *
 * \`ARGV[1]\` is the generation the caller pinned before its FIRST attempt — an
 * empty string for a room that predates generations, which matches only an
 * absent key. Every attempt carries it, so even the first is protected against
 * a recycle that happens between reading it and writing.
 *
 * KEYS: 1 generation, 2 session hash, 3 sessions set, 4 room sessions,
 * 5 rooms set, 6 (optional) previous room sessions.
 * ARGV: 1 expected generation, 2 sessionId, 3 roomCode, 4.. hash field/value pairs.
 */
const JOIN_ROOM_INDEX_LUA = `
if (redis.call("GET", KEYS[1]) or "") ~= ARGV[1] then
  return 0
end
if #KEYS >= 6 then
  redis.call("SREM", KEYS[6], ARGV[2])
end
local fields = {}
for index = 4, #ARGV do
  fields[#fields + 1] = ARGV[index]
end
if #fields > 0 then
  redis.call("HSET", KEYS[2], unpack(fields))
end
redis.call("SADD", KEYS[3], ARGV[2])
redis.call("SADD", KEYS[4], ARGV[2])
redis.call("SADD", KEYS[5], ARGV[3])
return 1
`;

async function loadSession(
  redis: RedisClient,
  prefix: string,
  sessionId: string,
): Promise<Session | null> {
  const fields = await redis.hgetall(sessionKey(prefix, sessionId));
  if (Object.keys(fields).length === 0) {
    return null;
  }
  return deserializeSession(fields);
}

/**
 * Drop an emptied room from the index.
 *
 * Emptiness needs BOTH indexes, and the check plus the write are one script. A
 * join writes the member binding (`addMember`) before the session index
 * (`onRoomJoined` → `markSessionJoinedRoom`), so between those two the session
 * set is still empty while the room is already in use; a read-then-write from
 * the client could also let a whole reconnect land between the check and the
 * write (#237 review).
 *
 * Member tokens are NOT touched here. Their retention is per identity — see
 * `PRUNE_MEMBER_TOKENS_LUA` — because hanging it off "the room emptied" never
 * released anything while the room stayed busy, and in a cluster only the node
 * that happened to observe the emptying ever acted on it.
 */
const CLEANUP_EMPTY_ROOM_LUA = `
if redis.call("SCARD", KEYS[1]) ~= 0 then
  return 0
end
if redis.call("HLEN", KEYS[3]) ~= 0 then
  return 0
end
redis.call("SREM", KEYS[2], ARGV[1])
return 1
`;

/**
 * Collect identities whose retention has run out.
 *
 * A zset scored by expiry, pruned lazily on read/write — the same shape this
 * store already uses for blocked tokens. Redis hash fields cannot carry their
 * own TTL, and a per-member key would make token lookup a scan.
 *
 * Deleted in batches. Handing an unbounded result set to `unpack` overflows
 * Lua's stack once enough identities expire between two token accesses, and the
 * error aborts the script BEFORE the zset is trimmed — so every later access
 * re-ran the same doomed script and the room could never be joined again (#237
 * review). `ZREM` on exactly the batch just deleted (not `ZREMRANGEBYSCORE`
 * over the whole range) is what makes stopping early safe.
 *
 * Stopping early only softens the boundary: an identity may stay resolvable a
 * little past its retention until a later access finishes the sweep. Retention
 * is "at least this long", never "at most".
 */
const PRUNE_MEMBER_TOKENS_BATCH = 500;
const PRUNE_MEMBER_TOKENS_MAX_BATCHES = 20;
const PRUNE_MEMBER_TOKENS_LUA = `
local removed = 0
for _ = 1, tonumber(ARGV[3]) do
  local expired = redis.call(
    "ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, tonumber(ARGV[2])
  )
  if #expired == 0 then
    return removed
  end
  redis.call("HDEL", KEYS[2], unpack(expired))
  redis.call("ZREM", KEYS[1], unpack(expired))
  removed = removed + #expired
end
return removed
`;

/**
 * Best-effort housekeeping: drop a room that has no sessions and no members
 * from the active-room set. Never fails its caller.
 *
 * It rides along at the end of operations whose REAL work is something else —
 * removing one session from one room's index — and those operations now report
 * whether that work landed. Letting a transient failure here reject the whole
 * thing said "the index was not cleaned" about a write that had already
 * succeeded, and the leave path answered by withholding the `room:state` the
 * room was owed (#235 review).
 *
 * Swallowing is safe because a stale entry is collected anyway: `deleteRoom`
 * purges `<prefix>rooms` when the room is torn down, and it retries through
 * `pendingRuntimeTeardowns`. Nothing correctness-bearing reads this set —
 * `hasRoomResidue` treats a stale entry as "code still dirty" and simply picks
 * another room code.
 */
async function cleanupEmptyRoomIndex(
  redis: RedisClient,
  prefix: string,
  roomCode: string,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await redis.eval(
      CLEANUP_EMPTY_ROOM_LUA,
      3,
      roomSessionsKey(prefix, roomCode),
      `${prefix}rooms`,
      roomMembersKey(prefix, roomCode),
      roomCode,
    );
  } catch (error) {
    onError(error);
  }
}

export async function createRedisRuntimeStore(
  redisUrl: string,
  options: RuntimeStoreOptions = {},
): Promise<RuntimeStore & { close: () => Promise<void> }> {
  const redis = (options.redisClient ??
    new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    })) as RedisClient;
  const keyPrefix = options.keyPrefix ?? "bsp:runtime:";
  const now = options.now ?? Date.now;
  const memberTokenRetentionMs =
    options.memberTokenRetentionMs ?? DEFAULT_MEMBER_TOKEN_RETENTION_MS;
  const maxPendingOperations =
    options.maxPendingOperations ?? DEFAULT_MAX_PENDING_OPERATIONS;
  const pendingOperationTimeoutMs =
    options.pendingOperationTimeoutMs ?? DEFAULT_PENDING_OPERATION_TIMEOUT_MS;
  const metricsCollector = options.metricsCollector;
  const localRuntimeStore = createInMemoryRuntimeStore(now);
  const pendingOperations = new Set<Promise<unknown>>();
  /**
   * One entry per queued write, released only once every command it started has
   * really finished. Checked alongside `pendingOperations` rather than merged
   * into it: `flush` must keep meaning "the queue drained" and must not start
   * waiting on a command nobody can cancel.
   */
  const heldCommandCapacity = new Set<Promise<void>>();

  await redis.connect();

  /**
   * Every session-scoped write goes through here: ordered per session, retried
   * with backoff, and confirmable. Before #242 a queued write got one attempt
   * and its failure was swallowed, so a blip silently cost the write.
   */
  /**
   * Caps each Redis command and remembers the ones that outlive their cap.
   *
   * Only the cap and the tracking are used — the retry SCHEDULE belongs to
   * `sessionWriteQueue`, which drives the retries. Sharing the primitive is
   * what keeps "a timeout is not a cancel" from having a fourth private
   * implementation here (#242 review).
   */
  const commandPacer = createRetryPacer({
    initialDelayMs: pendingOperationTimeoutMs,
    maxDelayMs: pendingOperationTimeoutMs,
  });

  const sessionWriteQueue = createDurableWriteQueue({
    ...options.writeRetry,
    onRetryScheduled: (info) => {
      logPendingOperationError(
        {
          operationName: info.operationName,
          pendingCount: pendingOperations.size,
          reason: "retry",
        },
        info.error,
      );
    },
  });

  function logPendingOperationError(
    context: PendingOperationLogContext,
    error: unknown,
  ): void {
    if (options.onPendingOperationError) {
      options.onPendingOperationError(context, error);
      return;
    }
    console.log(
      JSON.stringify({
        event: "redis_runtime_store_operation_failed",
        timestamp: new Date().toISOString(),
        operationName: context.operationName,
        pendingCount: context.pendingCount,
        reason: context.reason,
        result: context.reason === "backpressure" ? "rejected" : "error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  function ensurePendingCapacity(operationName: string): void {
    if (
      pendingOperations.size < maxPendingOperations &&
      heldCommandCapacity.size < maxPendingOperations
    ) {
      return;
    }
    const error = new Error(
      `Redis runtime store backpressure for ${operationName}.`,
    );
    logPendingOperationError(
      {
        operationName,
        pendingCount: pendingOperations.size,
        reason: "backpressure",
      },
      error,
    );
    throw error;
  }

  function trackOperation<T>(
    operationName: string,
    operation: Promise<T>,
  ): Promise<T | undefined> {
    const startedAt = performance.now();
    let failureRecorded = false;
    const recordFailureOnce = () => {
      if (failureRecorded) {
        return;
      }
      failureRecorded = true;
      metricsCollector?.observeRedisRuntimeStoreFailure(operationName);
    };
    const trackedOperation = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error(
          `Redis runtime store operation timed out: ${operationName}.`,
        );
        recordFailureOnce();
        logPendingOperationError(
          {
            operationName,
            pendingCount: pendingOperations.size,
            reason: "timeout",
          },
          error,
        );
        reject(error);
      }, pendingOperationTimeoutMs);

      void operation.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          recordFailureOnce();
          logPendingOperationError(
            {
              operationName,
              pendingCount: pendingOperations.size,
              reason: "failed",
            },
            error,
          );
          reject(error);
        },
      );
    });
    const handledOperation = trackedOperation.catch(() => undefined);
    pendingOperations.add(handledOperation);
    void handledOperation.finally(() => {
      pendingOperations.delete(handledOperation);
      metricsCollector?.observeRedisRuntimeStoreDuration(
        operationName,
        performance.now() - startedAt,
      );
    });
    return handledOperation;
  }

  /**
   * `trackOperation`, but the returned promise reports the write's REAL outcome:
   * it rejects when the write fails, and it never resolves early.
   *
   * Deliberately outside the pending-operation timeout. That timeout rejects
   * without cancelling the underlying command, so an operation that merely ran
   * slow still landed in Redis afterwards — and the caller had already been told
   * it failed. For a kick that meant the admin saw `block_failed` and the
   * session stayed connected while the shared store went on to block and revoke
   * it anyway (#237 review). Callers of this helper act on the answer, so an
   * answer that can be wrong is worse than a slow one; the operation is still
   * registered below for backpressure accounting.
   */
  function trackAwaitedOperation<T>(
    operationName: string,
    operation: Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    const settled = operation.catch(() => undefined);
    pendingOperations.add(settled);
    void settled.finally(() => {
      pendingOperations.delete(settled);
      metricsCollector?.observeRedisRuntimeStoreDuration(
        operationName,
        performance.now() - startedAt,
      );
    });
    return operation.catch((error: unknown) => {
      metricsCollector?.observeRedisRuntimeStoreFailure(operationName);
      logPendingOperationError(
        {
          operationName,
          pendingCount: pendingOperations.size,
          reason: "failed",
        },
        error,
      );
      throw error;
    });
  }

  /** Reports a swallowed housekeeping failure without failing its operation. */
  function reportEmptyRoomCleanupFailure(error: unknown): void {
    logPendingOperationError(
      {
        operationName: "cleanup_empty_room_index",
        pendingCount: pendingOperations.size,
        reason: "failed",
      },
      error,
    );
  }

  /** Collect identities past their retention. Lazy — called on token reads/writes. */
  async function pruneExpiredMemberTokens(code: string): Promise<void> {
    await redis.eval(
      PRUNE_MEMBER_TOKENS_LUA,
      2,
      roomMemberTokenExpiryKey(keyPrefix, code),
      roomMemberTokensKey(keyPrefix, code),
      String(now()),
      String(PRUNE_MEMBER_TOKENS_BATCH),
      String(PRUNE_MEMBER_TOKENS_MAX_BATCHES),
    );
  }

  /**
   * Returns the queued write's REAL outcome, so a caller that acts on whether it
   * landed can await it. `trackOperation` deliberately swallows the rejection
   * for backpressure accounting, and `flush` waits on those swallowed copies
   * with `Promise.allSettled` — so awaiting the queue says only that it drained,
   * never that the write succeeded (#235 review). `confirmWrites` is the one
   * that answers the second question (#242).
   *
   * The retries themselves live in `sessionWriteQueue`; this wrapper only adds
   * the backpressure accounting and the failure log. `trackAwaitedOperation` is
   * deliberately not reused: its timeout would fire mid-backoff and report a
   * write failed while the queue was still working on it.
   */
  /**
   * Caps ONE attempt, not the whole write.
   *
   * A hung Redis command has to stop pinning a pending slot, which is what the
   * old per-operation timeout did — but there it also ended the write, so a
   * command that was merely slow landed afterwards with the caller already told
   * it had failed. Applied per attempt it becomes a retry trigger instead: every
   * queued write here is idempotent (`HSET`/`SADD`/`SREM`, and an `EVAL` guarded
   * by the room generation), so re-running one that secretly landed changes
   * nothing (#242).
   */
  function withAttemptTimeout(
    operationName: string,
    operation: () => Promise<void>,
  ): Required<Pick<DurableWriteRequest, "run" | "settle">> {
    // Every command this write ever started, error-swallowed. The timeout races
    // a command, it cannot abort one, so a "failed" attempt may still be on its
    // way to Redis — and the queue must not hand this session's key to the
    // compensating write until it has landed (#242 review).
    const started: Array<Promise<void>> = [];
    const run = async () => {
      const command = operation();
      const answered = command.then(
        () => undefined,
        () => undefined,
      );
      started.push(answered);
      // Capacity is held per COMMAND, released as each one answers — not when
      // the caller was answered. A write whose attempts all timed out rejects
      // long before its commands stop running, and freeing the slot there let
      // the next session's write take it and leave one more uncancellable
      // command behind, so the configured cap stopped bounding anything (#242
      // review).
      heldCommandCapacity.add(answered);
      void answered.finally(() => {
        heldCommandCapacity.delete(answered);
      });
      await commandPacer.capAttempt(command, pendingOperationTimeoutMs, () => {
        const error = new Error(
          `Redis runtime store operation timed out: ${operationName}.`,
        );
        logPendingOperationError(
          {
            operationName,
            pendingCount: pendingOperations.size,
            reason: "timeout",
          },
          error,
        );
        return error;
      });
    };
    return {
      run,
      settle: async () => {
        await Promise.all(started);
      },
    };
  }

  function queueSessionOperation(
    sessionId: string,
    operationName: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    ensurePendingCapacity(operationName);
    const startedAt = performance.now();
    const outcome = sessionWriteQueue.enqueue({
      key: sessionId,
      operationName,
      ...withAttemptTimeout(operationName, operation),
    });
    const settled = outcome.catch(() => undefined);
    pendingOperations.add(settled);
    void settled.finally(() => {
      pendingOperations.delete(settled);
      metricsCollector?.observeRedisRuntimeStoreDuration(
        operationName,
        performance.now() - startedAt,
      );
    });

    const reported = outcome.catch((error: unknown) => {
      metricsCollector?.observeRedisRuntimeStoreFailure(operationName);
      logPendingOperationError(
        {
          operationName,
          pendingCount: pendingOperations.size,
          reason: "failed",
        },
        error,
      );
      throw error;
    });
    // `reported` is a NEW promise, so the queue's own handled-marker does not
    // cover it. Callers that drop it — `unregisterSession`, and any test that
    // fires a write without awaiting — would otherwise crash the process on an
    // unhandled rejection. Marking it here rather than at each call site is
    // what keeps a future fire-and-forget caller safe by default.
    void reported.catch(() => undefined);
    return reported;
  }

  const store = {
    registerSession(session: Session) {
      localRuntimeStore.registerSession(session);
      // Queued like every other session write, so it is ordered against them and
      // retried on failure instead of dropped. The returned promise carries the
      // real outcome; nothing is obliged to await it, and `queueSessionOperation`
      // already marks the rejection handled (#242).
      const record = sessionHashRecord(session);
      const outcome = queueSessionOperation(
        session.id,
        "register_session",
        async () => {
          await redis
            .multi()
            .sadd(`${keyPrefix}sessions`, session.id)
            .hset(sessionKey(keyPrefix, session.id), record)
            .exec();
        },
      );
      return outcome;
    },
    async flush() {
      await Promise.allSettled(Array.from(pendingOperations));
    },
    /**
     * Unlike `flush`, this REPORTS. `flush` waits on error-swallowed copies, so
     * a failed write drains exactly like a successful one; callers that need to
     * know the shared view is complete have to ask this instead (#242).
     */
    async confirmWrites() {
      await sessionWriteQueue.confirm();
    },
    async purgeSessionsByInstance(instanceId: string) {
      await store.flush();
      const sessionIds = await redis.smembers(`${keyPrefix}sessions`);
      let purgedCount = 0;

      for (const sessionId of sessionIds) {
        const session = await loadSession(redis, keyPrefix, sessionId);
        if (!session || session.instanceId !== instanceId) {
          continue;
        }

        const transaction = redis.multi();
        transaction.srem(`${keyPrefix}sessions`, sessionId);
        transaction.del(sessionKey(keyPrefix, sessionId));

        if (session.roomCode) {
          transaction.srem(
            roomSessionsKey(keyPrefix, session.roomCode),
            sessionId,
          );
        }

        if (session.roomCode && session.memberId) {
          const currentSessionId = await redis.hget(
            roomMembersKey(keyPrefix, session.roomCode),
            session.memberId,
          );
          if (currentSessionId === session.id) {
            // Clears the stale session→member binding left by the previous run
            // of this instance. It must NOT delete the member token: this runs
            // at startup, right before those very clients reconnect, and
            // dropping their tokens is what handed everybody a new `memberId`
            // after each restart (#234).
            //
            // It does start the identity's retention clock, in the same
            // transaction. This is a disconnect like any other — it just took a
            // process crash to notice — and without it a member who never comes
            // back would keep their token forever, since `removeMember` is the
            // only other place that arms it (#237 review).
            transaction.hdel(
              roomMembersKey(keyPrefix, session.roomCode),
              session.memberId,
            );
            // Only while the identity still exists. A kick deletes the token and
            // its expiry entry; if the process died before the socket close ran,
            // this path picks the binding up at startup and would otherwise
            // register an expiry for a token that is not there — the same defect
            // `REMOVE_MEMBER_LUA` fixed on the ordinary path (#237 review).
            if (
              (await redis.hget(
                roomMemberTokensKey(keyPrefix, session.roomCode),
                session.memberId,
              )) !== null
            ) {
              transaction.zadd(
                roomMemberTokenExpiryKey(keyPrefix, session.roomCode),
                String(now() + memberTokenRetentionMs),
                session.memberId,
              );
            }
          }
        }

        await transaction.exec();
        if (session.roomCode) {
          await cleanupEmptyRoomIndex(
            redis,
            keyPrefix,
            session.roomCode,
            reportEmptyRoomCleanupFailure,
          );
        }
        purgedCount += 1;
      }

      return purgedCount;
    },
    unregisterSession(sessionId: string) {
      const session = localRuntimeStore.getSession(sessionId);
      localRuntimeStore.unregisterSession(sessionId);
      queueSessionOperation(sessionId, "unregister_session", async () => {
        const roomCode =
          session?.roomCode ??
          (await loadSession(redis, keyPrefix, sessionId))?.roomCode;
        const transaction = redis.multi();
        transaction.srem(`${keyPrefix}sessions`, sessionId);
        transaction.del(sessionKey(keyPrefix, sessionId));
        if (roomCode) {
          transaction.srem(roomSessionsKey(keyPrefix, roomCode), sessionId);
        }
        await transaction.exec();
        if (roomCode) {
          await cleanupEmptyRoomIndex(
            redis,
            keyPrefix,
            roomCode,
            reportEmptyRoomCleanupFailure,
          );
        }
      });
    },
    markSessionJoinedRoom(sessionId: string, roomCode: string) {
      ensurePendingCapacity("mark_session_joined_room");
      void localRuntimeStore.markSessionJoinedRoom(sessionId, roomCode);
      // Read HERE, at the moment the join is made — not inside the operation
      // body, and not per attempt.
      //
      // Room codes are recycled, and the guard only works if the pinned value
      // predates any recycle of the room instance this join is for. The body
      // does not run until the session's chain drains, which is unbounded: a
      // prior write for the same session may still be retrying. Pinning in
      // there would read whatever generation existed by then — including the
      // NEW occupant's, after which the Lua check passes and this join seats
      // its session in a room it never joined (#242 review, #237).
      //
      // A failed read makes the write non-retryable rather than re-reading it
      // later, for the same reason: a second read is a second chance to pin the
      // wrong instance. The join is refused and the client retries it, which is
      // the trade this path already makes for the index write itself.
      const pinnedGeneration = commandPacer
        .capAttempt(
          redis.get(roomGenerationKey(keyPrefix, roomCode)),
          pendingOperationTimeoutMs,
          () =>
            new Error(`Timed out reading the generation of room ${roomCode}.`),
        )
        // An absent generation pins as `""`, which a room that predates #237
        // still matches. What it must NOT match is a room deleted since the
        // pin — see `ROOM_GENERATION_TOMBSTONE`, which is what the teardown
        // leaves behind instead of an absent key (#242 review).
        .then((generation) => generation ?? "")
        .catch((error: unknown) => {
          throw new NonRetryableWriteError(
            `Could not pin the generation of room ${roomCode}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "room_generation_unreadable",
          );
        });
      pinnedGeneration.catch(() => undefined);
      return queueSessionOperation(
        sessionId,
        "mark_session_joined_room",
        async () => {
          // Concurrent with the session read, so the guard costs no extra
          // round trip on the path a join actually waits for.
          const [storedSession, expectedGeneration] = await Promise.all([
            loadSession(redis, keyPrefix, sessionId),
            pinnedGeneration,
          ]);
          const localSession = localRuntimeStore.getSession(sessionId);
          const roomCodeToLeave = getPreviousRoomToLeave(
            storedSession?.roomCode ?? null,
            roomCode,
          );
          // The local mirror is this node's own live session, so it is the
          // authority on every field but the room code. Falling back to what
          // Redis already has keeps a re-seat from blanking a record we cannot
          // reconstruct; an empty record would be worse than a stale one.
          const record = localSession
            ? sessionHashRecord(localSession, roomCode)
            : storedSession
              ? sessionHashRecord(storedSession, roomCode)
              : { id: sessionId, roomCode };
          const keys = [
            roomGenerationKey(keyPrefix, roomCode),
            sessionKey(keyPrefix, sessionId),
            `${keyPrefix}sessions`,
            roomSessionsKey(keyPrefix, roomCode),
            `${keyPrefix}rooms`,
            ...(roomCodeToLeave
              ? [roomSessionsKey(keyPrefix, roomCodeToLeave)]
              : []),
          ];
          const applied = await redis.eval(
            JOIN_ROOM_INDEX_LUA,
            keys.length,
            ...keys,
            expectedGeneration,
            sessionId,
            roomCode,
            ...flattenHashRecord(record),
          );
          if (Number(applied) !== 1) {
            // Not retryable: a generation only ever moves forward, so no later
            // attempt can find its way back to the room this write was for.
            throw new NonRetryableWriteError(
              `Room ${roomCode} changed hands before the join index write landed.`,
              "room_generation_changed",
            );
          }
          if (roomCodeToLeave) {
            await cleanupEmptyRoomIndex(
              redis,
              keyPrefix,
              roomCodeToLeave,
              reportEmptyRoomCleanupFailure,
            );
          }
        },
      );
    },
    markSessionLeftRoom(sessionId: string, roomCode?: string | null) {
      ensurePendingCapacity("mark_session_left_room");
      void localRuntimeStore.markSessionLeftRoom(sessionId, roomCode);
      // No generation guard, unlike its join sibling: every write here is keyed
      // by THIS session's id, and session ids are never reused. A retry that
      // lands after the code has been recycled removes a session the new room
      // never had and blanks a room code on a hash the new room does not own —
      // both no-ops. Only the join ADDS the session to a room, which is the
      // write a recycled code could turn into a ghost member (#242).
      return queueSessionOperation(
        sessionId,
        "mark_session_left_room",
        async () => {
          const targetRoomCode = resolveRoomCodeToLeave(
            (await loadSession(redis, keyPrefix, sessionId))?.roomCode ?? null,
            roomCode,
          );
          if (!targetRoomCode) {
            return;
          }
          await redis
            .multi()
            .hset(sessionKey(keyPrefix, sessionId), "roomCode", "")
            .srem(roomSessionsKey(keyPrefix, targetRoomCode), sessionId)
            .exec();
          await cleanupEmptyRoomIndex(
            redis,
            keyPrefix,
            targetRoomCode,
            reportEmptyRoomCleanupFailure,
          );
        },
      );
    },
    recordEvent(event: string, timestamp?: number) {
      localRuntimeStore.recordEvent(event, timestamp);
    },
    getSession(sessionId: string) {
      return localRuntimeStore.getSession(sessionId);
    },
    listSessionsByRoom(roomCode: string) {
      return localRuntimeStore.listSessionsByRoom(roomCode);
    },
    getConnectionCount() {
      return localRuntimeStore.getConnectionCount();
    },
    getActiveRoomCount() {
      return localRuntimeStore.getActiveRoomCount();
    },
    getActiveMemberCount() {
      return localRuntimeStore.getActiveMemberCount();
    },
    getStartedAt() {
      return localRuntimeStore.getStartedAt();
    },
    getRecentEventCounts(currentTime?: number) {
      return localRuntimeStore.getRecentEventCounts(currentTime);
    },
    getLifetimeEventCounts() {
      return localRuntimeStore.getLifetimeEventCounts();
    },
    getActiveRoomCodes() {
      return localRuntimeStore.getActiveRoomCodes();
    },
    async getRoom(code: string) {
      await pruneExpiredMemberTokens(code);
      const memberTokens = await redis.hgetall(
        roomMemberTokensKey(keyPrefix, code),
      );
      const memberSessionIds = await redis.hgetall(
        roomMembersKey(keyPrefix, code),
      );
      if (
        Object.keys(memberTokens).length === 0 &&
        Object.keys(memberSessionIds).length === 0
      ) {
        return localRuntimeStore.getRoom(code);
      }

      const room: ActiveRoom = {
        code,
        members: new Map(),
        memberTokens: new Map(),
      };
      for (const [memberId, memberToken] of Object.entries(memberTokens)) {
        room.memberTokens.set(memberId, memberToken);
      }
      for (const [memberId, sessionId] of Object.entries(memberSessionIds)) {
        const session = await loadSession(redis, keyPrefix, sessionId);
        if (session) {
          room.members.set(memberId, session);
        }
      }
      return room;
    },
    getOrCreateRoom(code: string) {
      return localRuntimeStore.getOrCreateRoom(code);
    },
    addMember(
      code: string,
      memberId: string,
      session: Session,
      memberToken: string,
    ) {
      ensurePendingCapacity("add_member");
      const room = localRuntimeStore.addMember(
        code,
        memberId,
        session,
        memberToken,
      );
      void trackOperation(
        "add_member",
        redis
          .multi()
          .hset(roomMembersKey(keyPrefix, code), memberId, session.id)
          .hset(roomMemberTokensKey(keyPrefix, code), memberId, memberToken)
          // Back in use: take this identity off the clock. Per member, not the
          // whole hash — `PERSIST`ing the hash kept every departed visitor of a
          // busy room alive forever (#237 review).
          .zrem(roomMemberTokenExpiryKey(keyPrefix, code), memberId)
          .exec(),
      );
      return room;
    },
    async findMemberIdByToken(code: string, memberToken: string) {
      // Redis is the ONLY authority here. Falling back to the local mirror on a
      // miss let a node that had once hosted this member keep answering from its
      // own cache: a revoke performed on another node updates Redis and that
      // node, never this one, so a later join landing here would re-accept a
      // token an explicit leave or a kick had already ended (#237 review).
      //
      // Draining first is what the fallback used to cover — this store's writes
      // are asynchronous, so a join reading immediately after `addMember` could
      // otherwise miss its own write.
      await store.flush();
      await pruneExpiredMemberTokens(code);
      const memberTokens = await redis.hgetall(
        roomMemberTokensKey(keyPrefix, code),
      );
      return findMemberIdByTokenEntries(
        Object.entries(memberTokens),
        memberToken,
      );
    },
    blockMemberToken(code: string, memberToken: string, expiresAt: number) {
      ensurePendingCapacity("block_member_token");
      // Durable-first, same as `revokeMemberToken`: the kick awaits this and
      // then reports the member evicted, so an unconfirmed write would report an
      // eviction that had not happened on any other node yet, and mirroring
      // before it landed would leave this node blocking a token nobody else does.
      return trackAwaitedOperation(
        "block_member_token",
        redis.zadd(
          blockedTokensKey(keyPrefix, code),
          String(expiresAt),
          memberToken,
        ),
      ).then(() => {
        localRuntimeStore.blockMemberToken(code, memberToken, expiresAt);
      });
    },
    async isMemberTokenBlocked(
      code: string,
      memberToken: string,
      currentTime = now(),
    ) {
      await redis.zremrangebyscore(
        blockedTokensKey(keyPrefix, code),
        0,
        currentTime,
      );
      const score = await redis.zscore(
        blockedTokensKey(keyPrefix, code),
        memberToken,
      );
      if (score !== null) {
        return true;
      }
      return localRuntimeStore.isMemberTokenBlocked(
        code,
        memberToken,
        currentTime,
      );
    },
    async tryClaimMessageSlot(
      roomCode: string,
      key: string,
      expiresAt: number,
    ) {
      const currentTime = now();
      const requestedTtlMs = expiresAt - currentTime;
      let ttlMs: number;
      if (requestedTtlMs <= 0) {
        ttlMs = DEDUP_SLOT_MIN_TTL_MS;
        // Redact the slot key before logging: its body contains caller-provided
        // URLs and actor/session identifiers. Keep only the non-sensitive kind
        // prefix (before the first ':') and a short hash for correlation.
        const colonIndex = key.indexOf(":");
        const keyKind = colonIndex === -1 ? key : key.slice(0, colonIndex);
        const keyHash = createHash("sha256")
          .update(key)
          .digest("hex")
          .slice(0, 16);
        console.log(
          JSON.stringify({
            event: "dedup_slot_ttl_clamped",
            timestamp: new Date(currentTime).toISOString(),
            roomCode,
            keyKind,
            keyHash,
            requestedTtlMs,
            appliedTtlMs: ttlMs,
          }),
        );
      } else {
        ttlMs = requestedTtlMs;
      }
      const effectiveExpiresAt = Math.max(expiresAt, currentTime + ttlMs);
      const slotKey = dedupSlotKey(keyPrefix, roomCode, key);
      const result = await redis.set(slotKey, "1", "NX", "PX", ttlMs);
      if (result !== null) {
        const trackingKey = dedupTrackingZsetKey(keyPrefix, roomCode);
        try {
          // Await so deleteRoom's ZRANGE always sees this entry.
          // If tracking fails, the slot still expires via its TTL.
          await Promise.all([
            redis.zadd(trackingKey, String(effectiveExpiresAt), slotKey),
            redis.zremrangebyscore(trackingKey, 0, now() - 1),
          ]);
        } catch {
          // Tracking write failed; deleteRoom may miss this slot in ZRANGE,
          // but the slot will expire on its own within the TTL window.
        }
      }
      return result !== null;
    },
    async releaseMessageSlot(roomCode: string, key: string) {
      const slotKey = dedupSlotKey(keyPrefix, roomCode, key);
      const trackingKey = dedupTrackingZsetKey(keyPrefix, roomCode);
      await Promise.all([redis.del(slotKey), redis.zrem(trackingKey, slotKey)]);
    },
    async acquireRoomLock(
      roomCode: string,
      key: string,
      token: string,
      expiresAt: number,
    ) {
      const currentTime = now();
      const ttlMs = Math.max(expiresAt - currentTime, 1);
      const lockKey = roomLockKey(keyPrefix, roomCode, key);
      const result = await redis.set(lockKey, token, "NX", "PX", ttlMs);
      return result !== null;
    },
    async releaseRoomLock(roomCode: string, key: string, token: string) {
      const lockKey = roomLockKey(keyPrefix, roomCode, key);
      const result = await redis.eval(ROOM_LOCK_RELEASE_LUA, 1, lockKey, token);
      return result === 1;
    },
    removeMember(code: string, memberId: string, session?: Session) {
      ensurePendingCapacity("remove_member");
      const removal = localRuntimeStore.removeMember(code, memberId, session);
      // Presence only. The member token itself is deliberately kept so a
      // reconnect can reclaim this `memberId` (#234) — but it goes on its own
      // clock, so a room that never empties still releases the people who left
      // it. The script starts that clock only while a token is actually there.
      // `trackAwaitedOperation` rather than `trackOperation`: it registers the
      // write for backpressure exactly the same way, but hands back the REAL
      // outcome instead of the error-swallowed copy, so `durable` can reject
      // (#235 review).
      const durable = trackAwaitedOperation(
        "remove_member",
        redis.eval(
          REMOVE_MEMBER_LUA,
          3,
          roomMembersKey(keyPrefix, code),
          roomMemberTokensKey(keyPrefix, code),
          roomMemberTokenExpiryKey(keyPrefix, code),
          memberId,
          session?.id ?? "",
          String(now() + memberTokenRetentionMs),
        ),
      ).then(() => undefined);
      // Marks `durable` handled without consuming it: callers that DO await it
      // still see the rejection, while the reaper and the join-rollback — which
      // decide nothing from this write — no longer turn a Redis hiccup into an
      // unhandled rejection.
      void durable.catch(() => undefined);
      return { ...removal, durable };
    },
    evictMemberToken(
      code: string,
      memberId: string,
      memberToken: string,
      blockedUntil: number,
    ) {
      ensurePendingCapacity("evict_member_token");
      return trackAwaitedOperation(
        "evict_member_token",
        redis.eval(
          EVICT_MEMBER_LUA,
          3,
          blockedTokensKey(keyPrefix, code),
          roomMemberTokensKey(keyPrefix, code),
          roomMemberTokenExpiryKey(keyPrefix, code),
          memberId,
          memberToken,
          String(blockedUntil),
        ),
      ).then(() => {
        localRuntimeStore.evictMemberToken(
          code,
          memberId,
          memberToken,
          blockedUntil,
        );
      });
    },
    revokeMemberToken(code: string, memberId: string, session?: Session) {
      ensurePendingCapacity("revoke_member_token");
      // Durable-first: the local mirror is only updated once Redis accepted the
      // revocation. Mirroring first left a partial apply behind when the write
      // failed — the caller saw a rejection while this node had already dropped
      // the token (#237 review).
      //
      // Awaited, and rejecting: the kick disconnects the socket and reports
      // success as soon as this resolves, so resolving before the write landed
      // would report an eviction while the old token still resolved.
      return trackAwaitedOperation(
        "revoke_member_token",
        redis.eval(
          REVOKE_MEMBER_TOKEN_LUA,
          3,
          roomMembersKey(keyPrefix, code),
          roomMemberTokensKey(keyPrefix, code),
          roomMemberTokenExpiryKey(keyPrefix, code),
          memberId,
          session?.id ?? "",
        ),
      ).then(() => {
        localRuntimeStore.revokeMemberToken(code, memberId, session);
      });
    },
    async hasRoomResidue(code: string) {
      // Pruned first, so identities that have merely aged out do not keep the
      // code reserved.
      await pruneExpiredMemberTokens(code);
      // Deliberately without the generation key: it is not state a new room can
      // inherit (its own stamp overwrites it), and counting it would mean a code
      // is only ever freed by a successful teardown — losing the path where the
      // residue simply ages out.
      const found = await redis.eval(
        ROOM_RESIDUE_LUA,
        6,
        roomMembersKey(keyPrefix, code),
        roomMemberTokensKey(keyPrefix, code),
        roomMemberTokenExpiryKey(keyPrefix, code),
        blockedTokensKey(keyPrefix, code),
        roomSessionsKey(keyPrefix, code),
        dedupTrackingZsetKey(keyPrefix, code),
        String(now()),
      );
      return Number(found) === 1;
    },
    async getRoomGeneration(code: string) {
      return await redis.get(roomGenerationKey(keyPrefix, code));
    },
    markRoomGeneration(code: string, generation: string) {
      ensurePendingCapacity("mark_room_generation");
      return trackAwaitedOperation(
        "mark_room_generation",
        redis.eval(
          MARK_ROOM_GENERATION_LUA,
          1,
          roomGenerationKey(keyPrefix, code),
          generation,
        ),
      ).then(() => undefined);
    },
    deleteRoom(code: string, expectedGeneration?: string | null) {
      ensurePendingCapacity("delete_room");
      // Shared first here, unlike the other teardowns: whether this delete may
      // proceed at all is decided by the script, against the generation every
      // node agrees on. Dropping the local copy before knowing the answer would
      // be exactly the wipe the generation exists to prevent (#237 review).
      return trackAwaitedOperation(
        "delete_room",
        (async () => {
          const trackingKey = dedupTrackingZsetKey(keyPrefix, code);
          const dedupKeys = await redis.zrange(trackingKey, 0, -1);
          const keys = [
            roomGenerationKey(keyPrefix, code),
            `${keyPrefix}rooms`,
            roomMembersKey(keyPrefix, code),
            roomMemberTokensKey(keyPrefix, code),
            roomMemberTokenExpiryKey(keyPrefix, code),
            blockedTokensKey(keyPrefix, code),
            roomSessionsKey(keyPrefix, code),
            trackingKey,
            ...dedupKeys,
          ];
          return await redis.eval(
            DELETE_ROOM_LUA,
            keys.length,
            ...keys,
            expectedGeneration === undefined ? "*" : (expectedGeneration ?? ""),
            code,
            ROOM_GENERATION_TOMBSTONE,
          );
        })(),
      ).then((applied) => {
        if (Number(applied) !== 1) {
          return false;
        }
        localRuntimeStore.deleteRoom(code);
        return true;
      });
    },
    async close() {
      // Let outstanding writes finish the attempt they are on and give up
      // rather than back off again: the shutdown step that calls this gets a
      // few seconds, and spending the whole retry budget here on writes that a
      // dead Redis was never going to accept would record the step as failed
      // and exit the process non-zero (#242).
      sessionWriteQueue.stopRetrying();
      await Promise.allSettled(Array.from(pendingOperations));
      // `pendingOperations` holds the CALLERS' answers, and a write that timed
      // out answered long before its command did. Quitting on that alone closes
      // the connection under commands still in flight, which is the same
      // "a timeout is not a cancel" gap `settle` closes for the session chain —
      // so wait for the chain releases too, bounded so a dead Redis cannot
      // stretch the close step (#242 review).
      await commandPacer.settleTracked(pendingOperationTimeoutMs);
      await redis.quit();
    },
    async heartbeatNode(status: ClusterNodeStatus) {
      await localRuntimeStore.heartbeatNode(status);
      await redis
        .multi()
        .sadd(nodesKey(keyPrefix), status.instanceId)
        .hset(nodeStatusKey(keyPrefix, status.instanceId), {
          instanceId: status.instanceId,
          version: status.version,
          startedAt: String(status.startedAt),
          lastHeartbeatAt: String(status.lastHeartbeatAt),
          staleAt: String(status.staleAt),
          expiresAt: String(status.expiresAt),
          connectionCount: String(status.connectionCount),
          activeRoomCount: String(status.activeRoomCount),
          activeMemberCount: String(status.activeMemberCount),
        })
        .exec();
    },
    async listNodeStatuses(currentTime = now()) {
      const instanceIds = await redis.smembers(nodesKey(keyPrefix));
      const statuses = await Promise.all(
        instanceIds.map(async (instanceId) => {
          const fields = await redis.hgetall(
            nodeStatusKey(keyPrefix, instanceId),
          );
          if (Object.keys(fields).length === 0) {
            return null;
          }

          const status: ClusterNodeStatus = {
            instanceId: fields.instanceId || instanceId,
            version: fields.version || "unknown",
            startedAt: Number(fields.startedAt ?? "0"),
            lastHeartbeatAt: Number(fields.lastHeartbeatAt ?? "0"),
            staleAt: Number(fields.staleAt ?? "0"),
            expiresAt: Number(fields.expiresAt ?? "0"),
            connectionCount: Number(fields.connectionCount ?? "0"),
            activeRoomCount: Number(fields.activeRoomCount ?? "0"),
            activeMemberCount: Number(fields.activeMemberCount ?? "0"),
            health: "ok",
          };

          status.health =
            currentTime > status.expiresAt
              ? "offline"
              : currentTime > status.staleAt
                ? "stale"
                : "ok";
          return status;
        }),
      );

      return statuses
        .filter((status): status is ClusterNodeStatus => status !== null)
        .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    },
    async purgeNodeStatus(instanceId: string) {
      await localRuntimeStore.purgeNodeStatus(instanceId);
      await redis
        .multi()
        .del(nodeStatusKey(keyPrefix, instanceId))
        .srem(nodesKey(keyPrefix), instanceId)
        .exec();
    },
    async countClusterActiveRooms() {
      return redis.scard(`${keyPrefix}rooms`);
    },
    async listClusterActiveRoomCodes() {
      return (await redis.smembers(`${keyPrefix}rooms`)).sort();
    },
    async listClusterSessionsByRoom(roomCode: string) {
      const sessionIds = await redis.smembers(
        roomSessionsKey(keyPrefix, roomCode),
      );
      const sessions = await Promise.all(
        sessionIds.map((sessionId) => loadSession(redis, keyPrefix, sessionId)),
      );
      return sessions.filter((session): session is Session => session !== null);
    },
    async listClusterSessions() {
      const sessionIds = await redis.smembers(`${keyPrefix}sessions`);
      const sessions = await Promise.all(
        sessionIds.map((sessionId) => loadSession(redis, keyPrefix, sessionId)),
      );
      return sessions.filter((session): session is Session => session !== null);
    },
  };

  assertRuntimeStoreShape(store);
  return store;
}
