import { Redis } from "ioredis";
import type { ActiveRoom, ClusterNodeStatus, Session } from "./types.js";
import {
  createInMemoryRuntimeStore,
  type RuntimeStore,
} from "./runtime-store.js";

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
};

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

function nodesKey(prefix: string): string {
  return `${prefix}nodes`;
}

function nodeStatusKey(prefix: string, instanceId: string): string {
  return `${prefix}node:${instanceId}`;
}

const DETACHED_SOCKET = {
  readyState: 3,
  OPEN: 1,
  send() {},
  close() {},
  terminate() {},
} as unknown as Session["socket"];

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
    socket: DETACHED_SOCKET,
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
  redis: Redis,
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
  redis: Redis,
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
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const keyPrefix = options.keyPrefix ?? "bsp:runtime:";
  const now = options.now ?? Date.now;
  const localRuntimeStore = createInMemoryRuntimeStore(now);
  const pendingOperations = new Set<Promise<unknown>>();

  await redis.connect();

  function trackOperation<T>(operation: Promise<T>): void {
    pendingOperations.add(operation);
    void operation.finally(() => {
      pendingOperations.delete(operation);
    });
  }

  const store = {
    registerSession(session: Session) {
      localRuntimeStore.registerSession(session);
      const serialized = serializeSession(session);
      trackOperation(
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
    unregisterSession(sessionId: string) {
      const session = localRuntimeStore.getSession(sessionId);
      localRuntimeStore.unregisterSession(sessionId);
      trackOperation(
        (async () => {
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
        })(),
      );
    },
    markSessionJoinedRoom(sessionId: string, roomCode: string) {
      const previousRoomCode = localRuntimeStore.getSession(sessionId)?.roomCode;
      localRuntimeStore.markSessionJoinedRoom(sessionId, roomCode);
      trackOperation(
        (async () => {
          const transaction = redis.multi();
          if (previousRoomCode && previousRoomCode !== roomCode) {
            transaction.srem(
              roomSessionsKey(keyPrefix, previousRoomCode),
              sessionId,
            );
          }
          transaction.hset(sessionKey(keyPrefix, sessionId), "roomCode", roomCode);
          transaction.sadd(roomSessionsKey(keyPrefix, roomCode), sessionId);
          transaction.sadd(`${keyPrefix}rooms`, roomCode);
          await transaction.exec();
          if (previousRoomCode && previousRoomCode !== roomCode) {
            await cleanupEmptyRoomIndex(redis, keyPrefix, previousRoomCode);
          }
        })(),
      );
    },
    markSessionLeftRoom(sessionId: string, roomCode?: string | null) {
      const targetRoomCode =
        roomCode ?? localRuntimeStore.getSession(sessionId)?.roomCode ?? null;
      localRuntimeStore.markSessionLeftRoom(sessionId, roomCode);
      if (!targetRoomCode) {
        return;
      }
      trackOperation(
        (async () => {
          await redis
            .multi()
            .hset(sessionKey(keyPrefix, sessionId), "roomCode", "")
            .srem(roomSessionsKey(keyPrefix, targetRoomCode), sessionId)
            .exec();
          await cleanupEmptyRoomIndex(redis, keyPrefix, targetRoomCode);
        })(),
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
      const memberTokens = await redis.hgetall(roomMemberTokensKey(keyPrefix, code));
      const memberSessionIds = await redis.hgetall(roomMembersKey(keyPrefix, code));
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
      const room = localRuntimeStore.addMember(code, memberId, session, memberToken);
      trackOperation(
        redis
          .multi()
          .hset(roomMembersKey(keyPrefix, code), memberId, session.id)
          .hset(roomMemberTokensKey(keyPrefix, code), memberId, memberToken)
          .exec(),
      );
      return room;
    },
    async findMemberIdByToken(code: string, memberToken: string) {
      const memberTokens = await redis.hgetall(roomMemberTokensKey(keyPrefix, code));
      for (const [memberId, token] of Object.entries(memberTokens)) {
        if (token === memberToken) {
          return memberId;
        }
      }
      return localRuntimeStore.findMemberIdByToken(code, memberToken);
    },
    blockMemberToken(code: string, memberToken: string, expiresAt: number) {
      localRuntimeStore.blockMemberToken(code, memberToken, expiresAt);
      trackOperation(
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
      const score = await redis.zscore(blockedTokensKey(keyPrefix, code), memberToken);
      if (score !== null) {
        return true;
      }
      return localRuntimeStore.isMemberTokenBlocked(code, memberToken, currentTime);
    },
    async removeMember(code: string, memberId: string, session?: Session) {
      const removal = localRuntimeStore.removeMember(code, memberId, session);
      const currentSessionId = await redis.hget(roomMembersKey(keyPrefix, code), memberId);
      if (!session || !currentSessionId || currentSessionId === session.id) {
        await redis
          .multi()
          .hdel(roomMembersKey(keyPrefix, code), memberId)
          .hdel(roomMemberTokensKey(keyPrefix, code), memberId)
          .exec();
      }
      return removal;
    },
    deleteRoom(code: string) {
      localRuntimeStore.deleteRoom(code);
      trackOperation(
        redis
          .multi()
          .del(roomMembersKey(keyPrefix, code))
          .del(roomMemberTokensKey(keyPrefix, code))
          .del(blockedTokensKey(keyPrefix, code))
          .del(roomSessionsKey(keyPrefix, code))
          .srem(`${keyPrefix}rooms`, code)
          .exec(),
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
        .pexpire(
          nodeStatusKey(keyPrefix, status.instanceId),
          Math.max(1, status.expiresAt - status.lastHeartbeatAt),
        )
        .exec();
    },
    async listNodeStatuses(currentTime = now()) {
      const instanceIds = await redis.smembers(nodesKey(keyPrefix));
      const statuses = await Promise.all(
        instanceIds.map(async (instanceId) => {
          const fields = await redis.hgetall(nodeStatusKey(keyPrefix, instanceId));
          if (Object.keys(fields).length === 0) {
            await redis.srem(nodesKey(keyPrefix), instanceId);
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
    async countClusterActiveRooms() {
      return redis.scard(`${keyPrefix}rooms`);
    },
    async listClusterSessionsByRoom(roomCode: string) {
      const sessionIds = await redis.smembers(roomSessionsKey(keyPrefix, roomCode));
      const sessions = await Promise.all(
        sessionIds.map((sessionId) => loadSession(redis, keyPrefix, sessionId)),
      );
      return sessions.filter((session): session is Session => session !== null);
    },
  };

  return store as unknown as RuntimeStore & { close: () => Promise<void> };
}
