import assert from "node:assert/strict";
import test from "node:test";
import { createRedisRuntimeStore } from "../src/redis-runtime-store.js";
import type { Session } from "../src/types.js";

const REDIS_URL = process.env.REDIS_URL;

function createKeyPrefix(): string {
  return `bsp:test:runtime:${Date.now()}:${Math.random().toString(16).slice(2)}:`;
}

function createSession(id: string): Session {
  return {
    id,
    connectionState: "attached",
    socket: {
      readyState: 1,
      OPEN: 1,
      send() {},
      close() {},
      terminate() {},
    } as Session["socket"],
    instanceId: `${id}-node`,
    remoteAddress: "127.0.0.1",
    origin: "chrome-extension://allowed-extension",
    roomCode: null,
    memberId: null,
    memberToken: null,
    displayName: id,
    joinedAt: null,
    invalidMessageCount: 0,
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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFakeRedisClient(execPromises: Promise<unknown>[]) {
  let multiIndex = 0;
  return {
    async connect() {},
    async quit() {},
    multi() {
      const execPromise = execPromises[multiIndex++] ?? Promise.resolve(null);
      return {
        sadd() {
          return this;
        },
        srem() {
          return this;
        },
        del() {
          return this;
        },
        hset() {
          return this;
        },
        hdel() {
          return this;
        },
        exec() {
          return execPromise;
        },
      };
    },
    async hgetall() {
      return {};
    },
    async hget() {
      return null;
    },
    async smembers() {
      return [];
    },
    async scard() {
      return 0;
    },
    async sadd() {
      return null;
    },
    async srem() {
      return null;
    },
    async zadd() {
      return null;
    },
    async zremrangebyscore() {
      return null;
    },
    async zrange() {
      return [];
    },
    async zrem() {
      return null;
    },
    async zscore() {
      return null;
    },
    async set() {
      return "OK";
    },
    async del() {
      return null;
    },
  };
}

test("redis runtime store shares room sessions and member token state across instances", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  let currentTime = 1_000;
  const keyPrefix = createKeyPrefix();
  const storeA = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    now: () => currentTime,
  });
  const storeB = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    now: () => currentTime,
  });
  const sessionA = createSession("session-a");
  const sessionB = createSession("session-b");

  try {
    storeA.registerSession(sessionA);
    storeB.registerSession(sessionB);
    storeA.markSessionJoinedRoom(sessionA.id, "ROOM01");
    storeB.markSessionJoinedRoom(sessionB.id, "ROOM01");
    storeA.addMember("ROOM01", "member-a", sessionA, "token-a");
    storeB.addMember("ROOM01", "member-b", sessionB, "token-b");

    await new Promise((resolve) => setTimeout(resolve, 25));

    const room = await storeA.getRoom("ROOM01");
    assert.ok(room);
    assert.deepEqual(Array.from(room.members.keys()).sort(), [
      "member-a",
      "member-b",
    ]);
    assert.equal(room.members.get("member-a")?.connectionState, "detached");
    assert.equal(room.members.get("member-a")?.socket, null);
    assert.equal(room.members.get("member-b")?.connectionState, "detached");
    assert.equal(room.members.get("member-b")?.socket, null);
    assert.equal(await storeA.countClusterActiveRooms(), 1);
    assert.equal(
      await storeB.findMemberIdByToken("ROOM01", "token-b"),
      "member-b",
    );

    storeA.blockMemberToken("ROOM01", "token-a", currentTime + 500);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(await storeB.isMemberTokenBlocked("ROOM01", "token-a"), true);

    currentTime += 600;
    assert.equal(await storeB.isMemberTokenBlocked("ROOM01", "token-a"), false);

    await storeA.removeMember("ROOM01", "member-a", sessionA);
    storeA.markSessionLeftRoom(sessionA.id, "ROOM01");
    storeA.unregisterSession(sessionA.id);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const roomAfterRemoval = await storeB.getRoom("ROOM01");
    assert.ok(roomAfterRemoval);
    assert.deepEqual(Array.from(roomAfterRemoval.members.keys()), ["member-b"]);
  } finally {
    await storeA.close();
    await storeB.close();
  }
});

test("redis runtime store updates session display names when the session is re-registered", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  const storeA = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
  });
  const storeB = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
  });
  const session = createSession("session-display");

  try {
    storeA.registerSession(session);
    storeA.markSessionJoinedRoom(session.id, "ROOM02");
    session.memberId = "member-display";
    session.memberToken = "token-display";
    storeA.addMember("ROOM02", session.memberId, session, session.memberToken);
    await new Promise((resolve) => setTimeout(resolve, 25));

    session.displayName = "Alice";
    storeA.registerSession(session);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const room = await storeB.getRoom("ROOM02");
    assert.ok(room);
    assert.equal(room.members.get("member-display")?.displayName, "Alice");
  } finally {
    await storeA.close();
    await storeB.close();
  }
});

test("redis runtime store keeps only the latest room membership after rapid room switches", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  const store = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
  });
  const observer = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
  });
  const session = createSession("session-race");

  try {
    store.registerSession(session);
    store.markSessionJoinedRoom(session.id, "ROOMA1");
    store.markSessionJoinedRoom(session.id, "ROOMB1");
    await store.flush?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const roomA = await observer.listClusterSessionsByRoom("ROOMA1");
    const roomB = await observer.listClusterSessionsByRoom("ROOMB1");
    const clusterSessions = await observer.listClusterSessions();
    const storedSession = clusterSessions.find(
      (entry) => entry.id === session.id,
    );

    assert.deepEqual(
      roomA.map((entry) => entry.id),
      [],
    );
    assert.deepEqual(
      roomB.map((entry) => entry.id),
      [session.id],
    );
    assert.equal(storedSession?.roomCode, "ROOMB1");
  } finally {
    await store.close();
    await observer.close();
  }
});

test("redis runtime store can purge stale sessions for a restarted instance", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  const store = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
  });
  const observer = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
  });
  const session = createSession("session-restart");
  session.instanceId = "room-node-a";
  session.memberId = "member-restart";
  session.memberToken = "token-restart";

  try {
    store.registerSession(session);
    store.markSessionJoinedRoom(session.id, "ROOMRS");
    store.addMember("ROOMRS", session.memberId, session, session.memberToken);
    await store.flush?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(
      (await observer.listClusterSessionsByRoom("ROOMRS")).length,
      1,
    );
    assert.equal(await store.purgeSessionsByInstance?.("room-node-a"), 1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.deepEqual(await observer.listClusterSessionsByRoom("ROOMRS"), []);
    const room = await observer.getRoom("ROOMRS");
    assert.equal(room?.members.size ?? 0, 0);
  } finally {
    await store.close();
    await observer.close();
  }
});

test("redis runtime store clamps dedup slot TTL to a floor when expiresAt is already in the past", async () => {
  const setCalls: Array<{
    key: string;
    value: string;
    nx: string;
    px: string;
    ms: number;
  }> = [];
  const zaddCalls: Array<{ key: string; score: string; member: string }> = [];
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async set(
      key: string,
      value: string,
      nx: "NX",
      px: "PX",
      milliseconds: number,
    ) {
      setCalls.push({ key, value, nx, px, ms: milliseconds });
      return "OK";
    },
    async zadd(key: string, score: string, member: string) {
      zaddCalls.push({ key, score, member });
      return null;
    },
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message: unknown) => {
    logs.push(String(message));
  };

  const currentTime = 5_000;
  const store = await createRedisRuntimeStore("redis://unused", {
    redisClient: fakeRedis,
    keyPrefix: "bsp:test:dedup:",
    now: () => currentTime,
  });

  try {
    const claimed = await store.tryClaimMessageSlot(
      "ROOMXX",
      "share:actor:url:1",
      currentTime - 10,
    );
    assert.equal(claimed, true, "slot should still be claimed via minimum TTL");
    assert.equal(setCalls.length, 1);
    assert.ok(
      setCalls[0].ms >= 1_000,
      `expected minimum TTL >= 1000ms, got ${setCalls[0].ms}`,
    );
    assert.equal(setCalls[0].nx, "NX");
    assert.equal(setCalls[0].px, "PX");
    assert.equal(zaddCalls.length, 1);
    assert.equal(Number(zaddCalls[0].score), currentTime + setCalls[0].ms);

    const clampLog = logs
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.event === "dedup_slot_ttl_clamped");
    assert.ok(clampLog, "expected dedup_slot_ttl_clamped event to be logged");
    assert.equal(clampLog.roomCode, "ROOMXX");
    assert.equal(clampLog.requestedTtlMs, -10);
    assert.equal(clampLog.appliedTtlMs, 1_000);
    // Raw key must not be logged (contains caller URL + actor id).
    assert.equal(clampLog.key, undefined);
    assert.equal(clampLog.keyKind, "share");
    assert.equal(typeof clampLog.keyHash, "string");
    assert.match(clampLog.keyHash as string, /^[0-9a-f]{16}$/);
  } finally {
    console.log = originalLog;
    await store.close();
  }
});

test("redis runtime store preserves caller-provided TTL without clamping when expiresAt is in the future", async () => {
  const setCalls: Array<{ ms: number }> = [];
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async set(
      _key: string,
      _value: string,
      _nx: "NX",
      _px: "PX",
      milliseconds: number,
    ) {
      setCalls.push({ ms: milliseconds });
      return "OK";
    },
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message: unknown) => {
    logs.push(String(message));
  };

  const currentTime = 5_000;
  const store = await createRedisRuntimeStore("redis://unused", {
    redisClient: fakeRedis,
    keyPrefix: "bsp:test:dedup:",
    now: () => currentTime,
  });

  try {
    // Large positive TTL: used as-is.
    const claimedLarge = await store.tryClaimMessageSlot(
      "ROOMYY",
      "share:actor:url:1",
      currentTime + 5_000,
    );
    assert.equal(claimedLarge, true);
    assert.equal(setCalls.at(-1)?.ms, 5_000);

    // Small but positive TTL: must not be extended to the floor — the caller
    // controls the dedup window and clamping would change its semantics.
    const claimedSmall = await store.tryClaimMessageSlot(
      "ROOMYY",
      "share:actor:url:2",
      currentTime + 50,
    );
    assert.equal(claimedSmall, true);
    assert.equal(setCalls.at(-1)?.ms, 50);

    const clampLogged = logs.some((line) =>
      line.includes("dedup_slot_ttl_clamped"),
    );
    assert.equal(clampLogged, false);
  } finally {
    console.log = originalLog;
    await store.close();
  }
});

test("redis runtime store rejects new pending operations after reaching the configured cap", async () => {
  const firstOperation = createDeferred<unknown>();
  const fakeRedis = createFakeRedisClient([firstOperation.promise]);
  const errors: string[] = [];
  const store = await createRedisRuntimeStore("redis://unused", {
    redisClient: fakeRedis,
    maxPendingOperations: 1,
    onPendingOperationError(context) {
      errors.push(context.reason);
    },
  });

  try {
    store.registerSession(createSession("pending-a"));
    assert.throws(
      () => store.registerSession(createSession("pending-b")),
      /backpressure/,
    );
    assert.deepEqual(errors, ["backpressure"]);

    firstOperation.resolve(null);
    await store.flush?.();

    store.registerSession(createSession("pending-c"));
    await store.flush?.();
  } finally {
    await store.close();
  }
});

test("redis runtime store removes timed out pending operations and recovers", async () => {
  const firstOperation = createDeferred<unknown>();
  const secondOperation = createDeferred<unknown>();
  const fakeRedis = createFakeRedisClient([
    firstOperation.promise,
    secondOperation.promise,
  ]);
  const errors: string[] = [];
  const store = await createRedisRuntimeStore("redis://unused", {
    redisClient: fakeRedis,
    maxPendingOperations: 1,
    pendingOperationTimeoutMs: 20,
    onPendingOperationError(context) {
      errors.push(context.reason);
    },
  });

  try {
    store.registerSession(createSession("timed-out"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    await store.flush?.();

    secondOperation.resolve(null);
    store.registerSession(createSession("recovered"));
    await store.flush?.();

    assert.ok(errors.includes("timeout"));
  } finally {
    await store.close();
  }
});
