import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { createRedisRuntimeStore } from "../src/redis-runtime-store.js";
import type { AttachedSession, Session } from "../src/types.js";

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
    } as unknown as AttachedSession["socket"],
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
        zadd() {
          return this;
        },
        zrem() {
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
    async get() {
      return null;
    },
    // 仅用于 releaseRoomLock 的 CAS 脚本;这些用例不走锁路径,返回 null 表示未释放。
    async eval() {
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
    // The purge clears the stale session→member binding, but must NOT revoke
    // identity: it runs at startup, immediately before those same clients
    // reconnect, and dropping their tokens is what reissued every member a new
    // memberId after each restart (#234).
    assert.equal(room?.memberTokens.get("member-restart"), "token-restart");
    assert.equal(
      await observer.findMemberIdByToken("ROOMRS", "token-restart"),
      "member-restart",
    );
  } finally {
    await store.close();
    await observer.close();
  }
});

test("redis runtime store keeps the member token when only presence is dropped", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  const store = await createRedisRuntimeStore(REDIS_URL, { keyPrefix });
  const observer = await createRedisRuntimeStore(REDIS_URL, { keyPrefix });
  const session = createSession("session-presence");
  session.memberId = "member-presence";
  session.memberToken = "token-presence";

  try {
    store.registerSession(session);
    store.markSessionJoinedRoom(session.id, "ROOMPR");
    store.addMember("ROOMPR", session.memberId, session, session.memberToken);
    await store.flush?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    // A disconnect: presence goes, identity stays, so the reconnect can reclaim
    // the same memberId.
    store.removeMember("ROOMPR", session.memberId, session);
    await store.flush?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(
      await observer.findMemberIdByToken("ROOMPR", "token-presence"),
      "member-presence",
    );

    // An explicit leave / kick: identity goes too.
    store.revokeMemberToken("ROOMPR", session.memberId);
    await store.flush?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(
      await observer.findMemberIdByToken("ROOMPR", "token-presence"),
      null,
    );
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

test("redis runtime store counts a timed-out operation failure only once", async () => {
  const pending = createDeferred<unknown>();
  const failureOperations: string[] = [];
  const store = await createRedisRuntimeStore("redis://example.test:6379", {
    redisClient: createFakeRedisClient([pending.promise]),
    pendingOperationTimeoutMs: 5,
    metricsCollector: {
      observeRedisRuntimeStoreDuration() {},
      observeRedisRuntimeStoreFailure(operation) {
        failureOperations.push(operation);
      },
    },
  });

  try {
    const session = createSession("session-timeout");
    store.registerSession(session);

    await new Promise((resolve) => setTimeout(resolve, 20));
    pending.reject(new Error("late redis failure"));
    await store.flush?.();

    assert.deepEqual(failureOperations, ["register_session"]);
  } finally {
    await store.close();
  }
});

test("redis runtime store bounds how long a disconnected identity survives", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  // A retention short enough to observe. Production derives it from
  // `emptyRoomTtlMs` so tokens outlive the room, never the reverse.
  const store = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    memberTokenRetentionMs: 120,
  });
  const session = createSession("session-retention");
  session.memberId = "member-retention";
  session.memberToken = "token-retention";

  try {
    store.registerSession(session);
    store.markSessionJoinedRoom(session.id, "ROOMRT");
    store.addMember("ROOMRT", session.memberId, session, session.memberToken);
    await store.flush?.();

    // Still connected: no clock at all, so someone who never leaves keeps their
    // identity however long the session lasts.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      await store.findMemberIdByToken("ROOMRT", "token-retention"),
      "member-retention",
    );

    // The last session goes. Identity outlives the disconnect...
    store.removeMember("ROOMRT", session.memberId, session);
    store.unregisterSession(session.id);
    await store.flush?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      await store.findMemberIdByToken("ROOMRT", "token-retention"),
      "member-retention",
    );

    // ...but not indefinitely, and this no longer waits on the room emptying:
    // retention is per identity, so it runs out even in a room that stays busy.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      await store.findMemberIdByToken("ROOMRT", "token-retention"),
      null,
    );
  } finally {
    await store.close();
  }
});

test("redis runtime store lifts the retention clock when someone reconnects", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  const store = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    memberTokenRetentionMs: 150,
  });
  // A second instance stands in for another node: its local mirror is empty, so
  // it can only answer from Redis. Asking `store` itself would be answered from
  // the copy `addMember` just put back in its own map, which is exactly the
  // reading that cannot tell whether Redis still holds the token.
  const observer = await createRedisRuntimeStore(REDIS_URL, { keyPrefix });
  const session = createSession("session-relift");
  session.memberId = "member-relift";
  session.memberToken = "token-relift";

  try {
    store.registerSession(session);
    store.markSessionJoinedRoom(session.id, "ROOMRL");
    store.addMember("ROOMRL", session.memberId, session, session.memberToken);
    await store.flush?.();

    store.removeMember("ROOMRL", session.memberId, session);
    store.unregisterSession(session.id);
    await store.flush?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Reconnect inside the window: the clock must be lifted, not merely
    // restarted, or a room that keeps churning members would eventually drop
    // identities while people are still in it.
    const reconnected = createSession("session-relift-2");
    reconnected.memberId = "member-relift";
    reconnected.memberToken = "token-relift";
    store.registerSession(reconnected);
    store.markSessionJoinedRoom(reconnected.id, "ROOMRL");
    store.addMember("ROOMRL", "member-relift", reconnected, "token-relift");
    await store.flush?.();

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      await observer.findMemberIdByToken("ROOMRL", "token-relift"),
      "member-relift",
    );
  } finally {
    await store.close();
    await observer.close();
  }
});

test("redis runtime store empties a room in a single atomic step", async () => {
  // The emptiness check and the write it authorises must be ONE command. Read-
  // then-write from the client let a whole reconnect land in between: `SCARD`
  // saw zero, the returning client's join + `addMember` ran, and only then did
  // the cleanup drop a now-active room from the index.
  const evalCalls: Array<{ script: string; args: Array<string | number> }> = [];
  const forbidden: string[] = [];
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async scard() {
      forbidden.push("scard");
      return 0;
    },
    async srem() {
      forbidden.push("srem");
      return null;
    },
    async pexpire() {
      forbidden.push("pexpire");
      return 1;
    },
    async hgetall() {
      return { id: "session-atomic", roomCode: "ROOMAT" };
    },
    async eval(
      script: string,
      _numKeys: number,
      ...args: Array<string | number>
    ) {
      evalCalls.push({ script, args });
      return 1;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:atomic:",
    redisClient: fakeRedis,
  });

  try {
    store.markSessionLeftRoom("session-atomic", "ROOMAT");
    await store.flush?.();

    const cleanup = evalCalls.find((call) => call.script.includes("SCARD"));
    assert.ok(cleanup, "the empty-room cleanup must run as a script");
    // Same script also does the write, so nothing can interleave with the
    // decision it just made, and it consults BOTH indexes: a join writes the
    // member binding before the session index.
    assert.ok(cleanup.script.includes("HLEN"));
    assert.ok(cleanup.script.includes("SREM"));
    assert.deepEqual(forbidden, []);
  } finally {
    await store.close();
  }
});

test("redis runtime store keeps tokens while a member binding exists but the session index has not caught up", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  const store = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    memberTokenRetentionMs: 120,
  });
  const observer = await createRedisRuntimeStore(REDIS_URL, { keyPrefix });
  const session = createSession("session-window");
  session.memberId = "member-window";
  session.memberToken = "token-window";

  try {
    // A join writes the member binding first and the session index only after
    // (`onRoomJoined` → `markSessionJoinedRoom`). Reproduce exactly that window.
    store.addMember("ROOMWD", session.memberId, session, session.memberToken);
    await store.flush?.();

    // An old connection's cleanup lands right here. The room looks session-less
    // but is very much in use, so nothing may be put on a clock.
    store.markSessionLeftRoom("session-window", "ROOMWD");
    await store.flush?.();
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(
      await observer.findMemberIdByToken("ROOMWD", "token-window"),
      "member-window",
    );
  } finally {
    await store.close();
    await observer.close();
  }
});

test("redis runtime store stops resolving a token revoked on another node", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  const nodeA = await createRedisRuntimeStore(REDIS_URL, { keyPrefix });
  const nodeB = await createRedisRuntimeStore(REDIS_URL, { keyPrefix });
  const onA = createSession("session-node-a");
  onA.memberId = "member-roaming";
  onA.memberToken = "token-roaming";

  try {
    // The member was hosted by A, so A's local mirror holds the mapping.
    nodeA.addMember("ROOMND", onA.memberId, onA, onA.memberToken);
    await nodeA.flush?.();
    assert.equal(
      await nodeA.findMemberIdByToken("ROOMND", "token-roaming"),
      "member-roaming",
    );

    // They reconnect onto B and then leave / are kicked there. Only B and Redis
    // learn about it — A is never told.
    await nodeB.revokeMemberToken("ROOMND", "member-roaming");
    await nodeB.flush?.();

    // A must not re-accept it from its own cache: that would undo an explicit
    // leave or a kick for anyone whose next join happens to land on A.
    assert.equal(
      await nodeA.findMemberIdByToken("ROOMND", "token-roaming"),
      null,
    );
  } finally {
    await nodeA.close();
    await nodeB.close();
  }
});

test("redis runtime store declines a revoke from a session that no longer owns the member", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  const store = await createRedisRuntimeStore(REDIS_URL, { keyPrefix });
  const oldSession = createSession("session-old");
  oldSession.memberId = "member-shared";
  oldSession.memberToken = "token-shared";
  const newSession = createSession("session-new");
  newSession.memberId = "member-shared";
  newSession.memberToken = "token-shared";

  try {
    store.addMember("ROOMOW", "member-shared", oldSession, "token-shared");
    await store.flush?.();
    // The member reconnected — possibly onto another node — and the shared
    // binding now names the new session.
    store.addMember("ROOMOW", "member-shared", newSession, "token-shared");
    await store.flush?.();

    // The stale session leaves. It must not revoke the identity its successor
    // is using; the old node's local view still thinks it is the member, so the
    // decision has to be made against the shared binding.
    await store.revokeMemberToken("ROOMOW", "member-shared", oldSession);
    await store.flush?.();

    assert.equal(
      await store.findMemberIdByToken("ROOMOW", "token-shared"),
      "member-shared",
    );

    // The session that does own it still can.
    await store.revokeMemberToken("ROOMOW", "member-shared", newSession);
    await store.flush?.();
    assert.equal(
      await store.findMemberIdByToken("ROOMOW", "token-shared"),
      null,
    );
  } finally {
    await store.close();
  }
});

test("redis runtime store surfaces a failed member token revocation to the caller", async () => {
  // The kick awaits this and then disconnects the socket and reports success.
  // A revoke that resolves before the write landed — or swallows its failure —
  // reports an eviction while the old token still resolves everywhere else.
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async eval() {
      throw new Error("redis unavailable");
    },
  };
  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:revoke-fail:",
    redisClient: fakeRedis,
  });

  try {
    await assert.rejects(
      Promise.resolve(store.revokeMemberToken("ROOMRV", "member-rv")),
      /redis unavailable/,
    );
  } finally {
    await store.close();
  }
});

test("redis runtime store releases a departed visitor from a room that never empties", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  const store = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    memberTokenRetentionMs: 120,
  });
  const host = createSession("session-host");
  host.memberId = "member-host";
  host.memberToken = "token-host";
  const visitor = createSession("session-visitor");
  visitor.memberId = "member-visitor";
  visitor.memberToken = "token-visitor";

  try {
    // The host never leaves, so the room is never empty and a room-scoped clock
    // would never start. A public room with a steady trickle of visitors then
    // accumulates one token per visitor, forever.
    store.registerSession(host);
    store.markSessionJoinedRoom(host.id, "ROOMBZ");
    store.addMember("ROOMBZ", host.memberId, host, host.memberToken);
    store.registerSession(visitor);
    store.markSessionJoinedRoom(visitor.id, "ROOMBZ");
    store.addMember("ROOMBZ", visitor.memberId, visitor, visitor.memberToken);
    await store.flush?.();

    store.removeMember("ROOMBZ", visitor.memberId, visitor);
    store.markSessionLeftRoom(visitor.id, "ROOMBZ");
    await store.flush?.();
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(
      await store.findMemberIdByToken("ROOMBZ", "token-visitor"),
      null,
      "the visitor's identity must be released even though the room stayed busy",
    );
    // The host is still connected, so their identity is untouched.
    assert.equal(
      await store.findMemberIdByToken("ROOMBZ", "token-host"),
      "member-host",
    );
  } finally {
    await store.close();
  }
});

test("redis runtime store leaves the local mirror untouched when a revoke fails", async () => {
  // Durable-first. Mirroring before the shared write landed left a partial
  // apply: the caller saw a rejection while this node had already dropped the
  // token, so the member stayed connected holding one nothing would accept.
  let failEval = false;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async eval() {
      if (failEval) {
        throw new Error("redis unavailable");
      }
      return 0;
    },
    async hgetall() {
      return {};
    },
  };
  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:partial:",
    redisClient: fakeRedis,
  });
  const session = createSession("session-partial");
  session.memberId = "member-partial";
  session.memberToken = "token-partial";

  try {
    store.addMember("ROOMPT", "member-partial", session, "token-partial");
    await store.flush?.();

    failEval = true;
    await assert.rejects(
      Promise.resolve(store.revokeMemberToken("ROOMPT", "member-partial")),
      /redis unavailable/,
    );

    // Nothing changed on this node either: no half-revoked identity to clean up.
    // (Redis is empty in this fake, so `getRoom` falls back to the local mirror,
    // which is exactly the state under test.)
    failEval = false;
    const room = await store.getRoom("ROOMPT");
    assert.equal(room?.memberTokens.get("member-partial"), "token-partial");
  } finally {
    await store.flush?.();
    await store.close();
  }
});

test("redis runtime store starts the retention clock for bindings cleared at startup", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  let currentTime = 1_000;
  const store = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    now: () => currentTime,
    memberTokenRetentionMs: 5_000,
  });
  const observer = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    now: () => currentTime,
  });
  const session = createSession("session-crashed");
  session.instanceId = "crashed-node";
  session.memberId = "member-crashed";
  session.memberToken = "token-crashed";

  try {
    store.registerSession(session);
    store.markSessionJoinedRoom(session.id, "ROOMCR");
    store.addMember("ROOMCR", session.memberId, session, session.memberToken);
    await store.flush?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    // The process crashed and came back under the same instanceId.
    assert.equal(await store.purgeSessionsByInstance?.("crashed-node"), 1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    // The identity survives, so the client that is about to reconnect keeps it.
    assert.equal(
      await observer.findMemberIdByToken("ROOMCR", "token-crashed"),
      "member-crashed",
    );

    // But it is on the clock like any other disconnect. `removeMember` never ran
    // for this member, so without arming it here they would keep their token
    // forever — the room can stay alive on another node indefinitely.
    currentTime += 5_001;
    assert.equal(
      await observer.findMemberIdByToken("ROOMCR", "token-crashed"),
      null,
    );
  } finally {
    await store.close();
    await observer.close();
  }
});

test("redis runtime store prunes a large expired identity set without wedging the room", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  let currentTime = 1_000;
  const store = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    now: () => currentTime,
    memberTokenRetentionMs: 1,
  });

  try {
    // Past what `unpack` tolerates in one go — measured against this Redis, the
    // unbounded form starts failing with "too many results to unpack" somewhere
    // between 7500 and 8000. The error aborted the script before the zset was
    // trimmed, so every later access re-ran the same doomed script and the room
    // could never be joined again.
    const memberCount = 8_500;
    for (let index = 0; index < memberCount; index += 1) {
      const session = createSession(`session-bulk-${index}`);
      session.memberId = `member-bulk-${index}`;
      session.memberToken = `token-bulk-${index}`;
      store.addMember("ROOMBK", session.memberId, session, session.memberToken);
      store.removeMember("ROOMBK", session.memberId, session);
      // Drain periodically: this store caps how many writes may be in flight.
      if (index % 100 === 99) {
        await store.flush?.();
      }
    }
    await store.flush?.();

    currentTime += 1_000;
    // Must not throw, and must actually resolve — a wedged script fails here.
    assert.equal(
      await store.findMemberIdByToken("ROOMBK", "token-bulk-0"),
      null,
    );
    assert.equal(
      await store.findMemberIdByToken(
        "ROOMBK",
        `token-bulk-${memberCount - 1}`,
      ),
      null,
    );

    // A fresh member can still join the room afterwards.
    const rejoin = createSession("session-bulk-after");
    rejoin.memberId = "member-bulk-after";
    rejoin.memberToken = "token-bulk-after";
    store.addMember("ROOMBK", rejoin.memberId, rejoin, rejoin.memberToken);
    await store.flush?.();
    assert.equal(
      await store.findMemberIdByToken("ROOMBK", "token-bulk-after"),
      "member-bulk-after",
    );
  } finally {
    await store.close();
  }
});

test("redis runtime store surfaces a failed room teardown to the caller", async () => {
  // The persisted room is deleted in the same breath, after which nothing will
  // ever name this room code again — a silent failure strands the runtime keys.
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async zrange() {
      return [];
    },
    // The teardown is one conditional script now, so that is what has to fail.
    async eval() {
      throw new Error("redis unavailable");
    },
  };
  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:teardown:",
    redisClient: fakeRedis,
  });

  try {
    await assert.rejects(
      Promise.resolve(store.deleteRoom("ROOMTD")),
      /redis unavailable/,
    );
  } finally {
    await store.close();
  }
});

test("redis runtime store commits the block and the revoke of a kick together", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  const currentTime = 1_000;
  const store = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    now: () => currentTime,
  });
  const observer = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    now: () => currentTime,
  });
  const session = createSession("session-evict");
  session.memberId = "member-evict";
  session.memberToken = "token-evict";

  try {
    store.addMember("ROOMEV", session.memberId, session, session.memberToken);
    await store.flush?.();

    // One commit. As two independent writes, a block that landed could not be
    // rolled back when the revoke then failed: the admin saw the kick fail while
    // the member kept working until their next reconnect, which was refused.
    await store.evictMemberToken(
      "ROOMEV",
      "member-evict",
      "token-evict",
      currentTime + 60_000,
    );
    await store.flush?.();

    assert.equal(
      await observer.isMemberTokenBlocked("ROOMEV", "token-evict", currentTime),
      true,
    );
    assert.equal(
      await observer.findMemberIdByToken("ROOMEV", "token-evict"),
      null,
    );
  } finally {
    await store.close();
    await observer.close();
  }
});

test("redis runtime store leaves a kick entirely unapplied when it fails", async () => {
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async eval() {
      throw new Error("redis unavailable");
    },
  };
  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:evict-fail:",
    redisClient: fakeRedis,
  });
  const session = createSession("session-evict-fail");
  session.memberId = "member-evict-fail";
  session.memberToken = "token-evict-fail";

  try {
    store.addMember("ROOMEF", session.memberId, session, session.memberToken);
    await store.flush?.();

    await assert.rejects(
      Promise.resolve(
        store.evictMemberToken(
          "ROOMEF",
          "member-evict-fail",
          "token-evict-fail",
          // A real future instant: the local block store prunes by wall clock,
          // so a small absolute number would read as already expired and the
          // assertion below could not tell a stray block from none.
          Date.now() + 60_000,
        ),
      ),
      /redis unavailable/,
    );

    // Neither half applied locally either — no block left behind for a kick the
    // admin was told had failed.
    assert.equal(
      await store.isMemberTokenBlocked("ROOMEF", "token-evict-fail"),
      false,
    );
  } finally {
    await store.flush?.();
    await store.close();
  }
});

test("redis runtime store declines a teardown decided against an older room generation", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  const store = await createRedisRuntimeStore(REDIS_URL, { keyPrefix });
  const previous = createSession("session-gen-old");
  previous.memberId = "member-gen-old";
  previous.memberToken = "token-gen-old";
  const current = createSession("session-gen-new");
  current.memberId = "member-gen-new";
  current.memberToken = "token-gen-new";

  try {
    await store.markRoomGeneration("ROOMGN", "generation-1");
    store.addMember(
      "ROOMGN",
      previous.memberId,
      previous,
      previous.memberToken,
    );
    await store.flush?.();

    // A teardown is decided against the room as it stands now.
    const decidedAgainst = await store.getRoomGeneration("ROOMGN");
    assert.equal(decidedAgainst, "generation-1");

    // Before it runs, the code comes back into use as a different room.
    await store.markRoomGeneration("ROOMGN", "generation-2");
    store.addMember("ROOMGN", current.memberId, current, current.memberToken);
    await store.flush?.();

    await store.deleteRoom("ROOMGN", decidedAgainst);
    await store.flush?.();

    // The stale teardown must not take the new room's state with it.
    assert.equal(
      await store.findMemberIdByToken("ROOMGN", "token-gen-new"),
      "member-gen-new",
    );

    // A teardown decided against the CURRENT generation still works.
    await store.deleteRoom("ROOMGN", "generation-2");
    await store.flush?.();
    assert.equal(
      await store.findMemberIdByToken("ROOMGN", "token-gen-new"),
      null,
    );
  } finally {
    await store.close();
  }
});

test("redis runtime store does not register a retention entry for a member with no token", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  const store = await createRedisRuntimeStore(REDIS_URL, { keyPrefix });
  const observer = await createRedisRuntimeStore(REDIS_URL, { keyPrefix });
  const redis = new Redis(REDIS_URL);
  const session = createSession("session-kicked");
  session.memberId = "member-kicked";
  session.memberToken = "token-kicked";

  try {
    store.addMember("ROOMKX", session.memberId, session, session.memberToken);
    await store.flush?.();

    // The kick takes the token and its retention entry away...
    await store.evictMemberToken(
      "ROOMKX",
      "member-kicked",
      "token-kicked",
      Date.now() + 60_000,
    );
    await store.flush?.();

    // ...and the socket close arrives afterwards, as it always does.
    store.removeMember("ROOMKX", session.memberId, session);
    await store.flush?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Registering a retention entry here would leave one with no token behind
    // it, and the prune is lazy — nothing collects it once the room goes quiet.
    assert.equal(
      await redis.zscore(
        `${keyPrefix}room:ROOMKX:member-token-expiry`,
        "member-kicked",
      ),
      null,
    );
    assert.equal(
      await observer.findMemberIdByToken("ROOMKX", "token-kicked"),
      null,
    );
  } finally {
    await redis.quit();
    await store.close();
    await observer.close();
  }
});

test("redis runtime store waits for the real result of an awaited write", async () => {
  // The pending-operation timeout rejects without cancelling the command, so a
  // write that merely ran slow still landed — after its caller had been told it
  // failed. A kick reported `block_failed` while the shared store went on to
  // block and revoke the member anyway.
  let settleEval!: () => void;
  const evalGate = new Promise<void>((resolve) => {
    settleEval = resolve;
  });
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async eval() {
      await evalGate;
      return 1;
    },
  };
  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:slow-evict:",
    redisClient: fakeRedis,
    pendingOperationTimeoutMs: 20,
  });

  try {
    const eviction = store.evictMemberToken(
      "ROOMSL",
      "member-slow",
      "token-slow",
      Date.now() + 60_000,
    );
    let settledEarly = false;
    void Promise.resolve(eviction).then(
      () => {
        settledEarly = true;
      },
      () => {
        settledEarly = true;
      },
    );

    // Well past the timeout the wrapper used to reject on.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(
      settledEarly,
      false,
      "an awaited write must not report an outcome the store does not have yet",
    );

    settleEval();
    await eviction;
  } finally {
    await store.close();
  }
});

test("redis runtime store does not register a retention entry during startup purge without a token", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  const store = await createRedisRuntimeStore(REDIS_URL, { keyPrefix });
  const redis = new Redis(REDIS_URL);
  const session = createSession("session-crash-kicked");
  session.instanceId = "crashed-node";
  session.memberId = "member-crash-kicked";
  session.memberToken = "token-crash-kicked";

  try {
    store.registerSession(session);
    store.markSessionJoinedRoom(session.id, "ROOMCK");
    store.addMember("ROOMCK", session.memberId, session, session.memberToken);
    await store.flush?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Kicked, then the process died before the socket close ran — so the member
    // binding is still there for the startup purge to find.
    await store.evictMemberToken(
      "ROOMCK",
      "member-crash-kicked",
      "token-crash-kicked",
      Date.now() + 60_000,
    );
    await store.flush?.();

    assert.equal(await store.purgeSessionsByInstance?.("crashed-node"), 1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    // The identity is gone, so there is nothing to put on a clock. Registering
    // one anyway leaves an entry the lazy prune never reaches once the room goes
    // quiet — the same defect the ordinary remove path had.
    assert.equal(
      await redis.zscore(
        `${keyPrefix}room:ROOMCK:member-token-expiry`,
        "member-crash-kicked",
      ),
      null,
    );
  } finally {
    await redis.quit();
    await store.close();
  }
});

test("redis runtime store treats leftover session keys as residue on a room code", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  const store = await createRedisRuntimeStore(REDIS_URL, { keyPrefix });
  const session = createSession("session-residue");

  try {
    assert.equal(await store.hasRoomResidue("ROOMRS"), false);

    store.registerSession(session);
    store.markSessionJoinedRoom(session.id, "ROOMRS");
    await store.flush?.();
    await new Promise((resolve) => setTimeout(resolve, 25));

    // No members and no member tokens: the members/tokens view `getRoom` offers
    // reads as empty, which is what used to gate room code allocation.
    assert.equal((await store.getRoom("ROOMRS"))?.members.size ?? 0, 0);
    assert.equal(await store.hasRoomResidue("ROOMRS"), true);

    // A generation on its own is not residue: a new room overwrites it, and
    // counting it would mean only a successful teardown ever frees a code.
    const clean = await createRedisRuntimeStore(REDIS_URL, {
      keyPrefix: `${keyPrefix}gen:`,
    });
    try {
      await clean.markRoomGeneration("ROOMGO", "generation-1");
      assert.equal(await clean.hasRoomResidue("ROOMGO"), false);
    } finally {
      await clean.close();
    }
  } finally {
    await store.close();
  }
});

test("redis runtime store stops reserving a code whose blocked and dedup entries have lapsed", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  let currentTime = 1_000;
  const store = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    now: () => currentTime,
  });

  try {
    store.evictMemberToken(
      "ROOMLP",
      "member-lapsed",
      "token-lapsed",
      currentTime + 60_000,
    );
    await store.tryClaimMessageSlot(
      "ROOMLP",
      "dedup-lapsed",
      currentTime + 30_000,
    );
    await store.flush?.();
    assert.equal(await store.hasRoomResidue("ROOMLP"), true);

    currentTime += 3_600_000;

    // Redis does not drop zset members when their score passes, and the lazy
    // sweeps that normally do it are only reached through a room that no longer
    // exists — so without trimming here the code stayed reserved forever.
    assert.equal(await store.hasRoomResidue("ROOMLP"), false);
  } finally {
    await store.close();
  }
});

test("redis runtime store reports a failed room-index cleanup to the caller", async () => {
  // `markSessionLeftRoom` is the one session write whose caller acts on the
  // answer: a `room:state` published while the index still lists the session
  // hands the share back to the member who just left (#235 review). `flush`
  // cannot carry that answer — it waits on the error-swallowed copies
  // `trackOperation` keeps for backpressure accounting, so it reports only that
  // the queue drained.
  const fakeRedis = {
    ...createFakeRedisClient([Promise.reject(new Error("index write failed"))]),
    async hgetall() {
      return { id: "session-dirty", roomCode: "ROOMDT" };
    },
    async eval() {
      return 1;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:dirty:",
    redisClient: fakeRedis,
  });

  try {
    await assert.rejects(
      store.markSessionLeftRoom("session-dirty", "ROOMDT"),
      /index write failed/,
    );
    // The asymmetry the fix rests on: draining the queue looks like success.
    await store.flush?.();
  } finally {
    await store.close();
  }
});

test("redis runtime store confirms the index removal even when empty-room cleanup fails", async () => {
  // The transaction that removes this session from the room index is the write
  // the caller acts on; the empty-room cleanup that follows is housekeeping. A
  // transient failure in the latter used to reject the whole operation, so the
  // leave path read "the index was not cleaned" about a write that had already
  // landed and withheld the `room:state` the room was owed (#235 review).
  let cleanupAttempts = 0;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async hgetall() {
      return { id: "session-aux", roomCode: "ROOMAX" };
    },
    async eval() {
      cleanupAttempts += 1;
      throw new Error("cleanup script failed");
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:aux:",
    redisClient: fakeRedis,
  });

  try {
    await store.markSessionLeftRoom("session-aux", "ROOMAX");
    assert.ok(cleanupAttempts > 0, "the cleanup must actually have been tried");
  } finally {
    await store.close();
  }
});
