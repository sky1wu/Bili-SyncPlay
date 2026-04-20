import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Redis } from "ioredis";
import type { MetricsCollector } from "./admin/metrics.js";
import type { ActiveRoom, ClusterNodeStatus, Session } from "./types.js";
import {
  createInMemoryRuntimeStore,
  type RuntimeStore,
} from "./runtime-store.js";
import {
  findMemberIdByTokenEntries,
  getPreviousRoomToLeave,
  resolveRoomCodeToLeave,
  shouldRemoveMemberBinding,
} from "./runtime-store-state.js";

type RedisMulti = {
  sadd: (...args: string[]) => RedisMulti;
  srem: (...args: string[]) => RedisMulti;
  del: (...keys: string[]) => RedisMulti;
  hset: (key: string, ...args: unknown[]) => RedisMulti;
  hdel: (key: string, ...fields: string[]) => RedisMulti;
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
  del: (...keys: string[]) => Promise<unknown>;
};

type PendingOperationLogContext = {
  operationName: string;
  pendingCount: number;
  reason: "backpressure" | "timeout" | "failed";
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
  now?: () => number;
  maxPendingOperations?: number;
  pendingOperationTimeoutMs?: number;
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
  "removeMember",
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

function blockedTokensKey(prefix: string, roomCode: string): string {
  return `${prefix}room:${roomCode}:blocked-member-tokens`;
}

function dedupSlotKey(prefix: string, roomCode: string, key: string): string {
  return `${prefix}room:${roomCode}:dedup:${key}`;
}

function dedupTrackingZsetKey(prefix: string, roomCode: string): string {
  return `${prefix}room:${roomCode}:dedup-slots`;
}

function nodesKey(prefix: string): string {
  return `${prefix}nodes`;
}

function nodeStatusKey(prefix: string, instanceId: string): string {
  return `${prefix}node:${instanceId}`;
}

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

async function cleanupEmptyRoomIndex(
  redis: RedisClient,
  prefix: string,
  roomCode: string,
): Promise<void> {
  if ((await redis.scard(roomSessionsKey(prefix, roomCode))) === 0) {
    await redis.srem(`${prefix}rooms`, roomCode);
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
  const maxPendingOperations =
    options.maxPendingOperations ?? DEFAULT_MAX_PENDING_OPERATIONS;
  const pendingOperationTimeoutMs =
    options.pendingOperationTimeoutMs ?? DEFAULT_PENDING_OPERATION_TIMEOUT_MS;
  const metricsCollector = options.metricsCollector;
  const localRuntimeStore = createInMemoryRuntimeStore(now);
  const pendingOperations = new Set<Promise<unknown>>();
  const sessionOperationChains = new Map<string, Promise<void>>();

  await redis.connect();

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
    if (pendingOperations.size < maxPendingOperations) {
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

  function queueSessionOperation(
    sessionId: string,
    operationName: string,
    operation: () => Promise<void>,
  ): void {
    ensurePendingCapacity(operationName);
    const previous = sessionOperationChains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(operation)
      .finally(() => {
        if (sessionOperationChains.get(sessionId) === next) {
          sessionOperationChains.delete(sessionId);
        }
      });
    sessionOperationChains.set(sessionId, next);
    void trackOperation(operationName, next);
  }

  const store = {
    registerSession(session: Session) {
      ensurePendingCapacity("register_session");
      localRuntimeStore.registerSession(session);
      const serialized = serializeSession(session);
      void trackOperation(
        "register_session",
        redis
          .multi()
          .sadd(`${keyPrefix}sessions`, session.id)
          .hset(sessionKey(keyPrefix, session.id), {
            id: serialized.id,
            instanceId: encodeNullable(serialized.instanceId),
            remoteAddress: encodeNullable(serialized.remoteAddress),
            origin: encodeNullable(serialized.origin),
            roomCode: encodeNullable(serialized.roomCode),
            memberId: encodeNullable(serialized.memberId),
            displayName: serialized.displayName,
            memberToken: encodeNullable(serialized.memberToken),
            joinedAt:
              serialized.joinedAt === null ? "" : String(serialized.joinedAt),
            invalidMessageCount: String(serialized.invalidMessageCount),
          })
          .exec(),
      );
    },
    async flush() {
      await Promise.allSettled(Array.from(pendingOperations));
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
            transaction.hdel(
              roomMembersKey(keyPrefix, session.roomCode),
              session.memberId,
            );
            transaction.hdel(
              roomMemberTokensKey(keyPrefix, session.roomCode),
              session.memberId,
            );
          }
        }

        await transaction.exec();
        if (session.roomCode) {
          await cleanupEmptyRoomIndex(redis, keyPrefix, session.roomCode);
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
          await cleanupEmptyRoomIndex(redis, keyPrefix, roomCode);
        }
      });
    },
    markSessionJoinedRoom(sessionId: string, roomCode: string) {
      ensurePendingCapacity("mark_session_joined_room");
      localRuntimeStore.markSessionJoinedRoom(sessionId, roomCode);
      queueSessionOperation(sessionId, "mark_session_joined_room", async () => {
        const previousRoomCode =
          (await loadSession(redis, keyPrefix, sessionId))?.roomCode ?? null;
        const roomCodeToLeave = getPreviousRoomToLeave(
          previousRoomCode,
          roomCode,
        );
        const transaction = redis.multi();
        if (roomCodeToLeave) {
          transaction.srem(
            roomSessionsKey(keyPrefix, roomCodeToLeave),
            sessionId,
          );
        }
        transaction.hset(
          sessionKey(keyPrefix, sessionId),
          "roomCode",
          roomCode,
        );
        transaction.sadd(roomSessionsKey(keyPrefix, roomCode), sessionId);
        transaction.sadd(`${keyPrefix}rooms`, roomCode);
        await transaction.exec();
        if (roomCodeToLeave) {
          await cleanupEmptyRoomIndex(redis, keyPrefix, roomCodeToLeave);
        }
      });
    },
    markSessionLeftRoom(sessionId: string, roomCode?: string | null) {
      ensurePendingCapacity("mark_session_left_room");
      localRuntimeStore.markSessionLeftRoom(sessionId, roomCode);
      queueSessionOperation(sessionId, "mark_session_left_room", async () => {
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
        await cleanupEmptyRoomIndex(redis, keyPrefix, targetRoomCode);
      });
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
          .exec(),
      );
      return room;
    },
    async findMemberIdByToken(code: string, memberToken: string) {
      const memberTokens = await redis.hgetall(
        roomMemberTokensKey(keyPrefix, code),
      );
      const matchedMemberId = findMemberIdByTokenEntries(
        Object.entries(memberTokens),
        memberToken,
      );
      if (matchedMemberId) {
        return matchedMemberId;
      }
      return localRuntimeStore.findMemberIdByToken(code, memberToken);
    },
    blockMemberToken(code: string, memberToken: string, expiresAt: number) {
      ensurePendingCapacity("block_member_token");
      localRuntimeStore.blockMemberToken(code, memberToken, expiresAt);
      void trackOperation(
        "block_member_token",
        redis.zadd(
          blockedTokensKey(keyPrefix, code),
          String(expiresAt),
          memberToken,
        ),
      );
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
    removeMember(code: string, memberId: string, session?: Session) {
      ensurePendingCapacity("remove_member");
      const removal = localRuntimeStore.removeMember(code, memberId, session);
      void trackOperation(
        "remove_member",
        (async () => {
          const currentSessionId = await redis.hget(
            roomMembersKey(keyPrefix, code),
            memberId,
          );
          if (shouldRemoveMemberBinding(currentSessionId, session?.id)) {
            await redis
              .multi()
              .hdel(roomMembersKey(keyPrefix, code), memberId)
              .hdel(roomMemberTokensKey(keyPrefix, code), memberId)
              .exec();
          }
        })(),
      );
      return removal;
    },
    deleteRoom(code: string) {
      ensurePendingCapacity("delete_room");
      localRuntimeStore.deleteRoom(code);
      void trackOperation(
        "delete_room",
        (async () => {
          const trackingKey = dedupTrackingZsetKey(keyPrefix, code);
          const dedupKeys = await redis.zrange(trackingKey, 0, -1);
          const multi = redis
            .multi()
            .del(roomMembersKey(keyPrefix, code))
            .del(roomMemberTokensKey(keyPrefix, code))
            .del(blockedTokensKey(keyPrefix, code))
            .del(roomSessionsKey(keyPrefix, code))
            .del(trackingKey)
            .srem(`${keyPrefix}rooms`, code);
          if (dedupKeys.length > 0) {
            multi.del(...dedupKeys);
          }
          return multi.exec();
        })(),
      );
    },
    async close() {
      await Promise.allSettled(Array.from(pendingOperations));
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
