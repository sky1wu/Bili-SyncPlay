import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import {
  createRedisRuntimeStore,
  JOIN_ROOM_INDEX_LUA,
} from "../src/redis-runtime-store.js";
import { NonRetryableWriteError } from "../src/durable-write-queue.js";
import type { AttachedSession, Session } from "../src/types.js";
import { seatSession, settleRuntimeWrites } from "./runtime-seat-helpers.js";

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
    disconnect() {},
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
    // 默认脚本结果；需要覆盖 claim/release 语义的用例会自行实现 eval。
    async eval() {
      return null;
    },
  };
}

test("redis runtime store close gives up on a Redis that never answers QUIT, and says so", async () => {
  let disconnectCalls = 0;
  const unfinished: Array<{
    pendingOperations: number;
    pendingCommands: number;
    pendingOperationBudgetMs: number;
    quitOutcome: string;
    budgetMs: number;
  }> = [];
  const store = await createRedisRuntimeStore("redis://unused", {
    redisClient: {
      ...createFakeRedisClient([]),
      quit: () => new Promise(() => undefined),
      disconnect: () => {
        disconnectCalls += 1;
      },
    },
    closeQuitTimeoutMs: 20,
    onCloseUnfinished: (info) => {
      unfinished.push(info);
    },
  });

  const startedAt = Date.now();
  await store.close();
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(disconnectCalls, 1);
  assert.deepEqual(unfinished, [
    {
      pendingOperations: 0,
      pendingCommands: 0,
      pendingAttempts: 0,
      pendingOperationBudgetMs: 5_000,
      quitOutcome: "timed_out",
      budgetMs: 20,
    },
  ]);
});

test("redis runtime store bounds its pre-QUIT drain and counts every active Redis command", async () => {
  const neverAnswers = new Promise<unknown>(() => undefined);
  let disconnectCalls = 0;
  const unfinished: Array<{
    pendingOperations: number;
    pendingCommands: number;
    pendingOperationBudgetMs: number;
    quitOutcome: string;
    budgetMs: number;
  }> = [];
  const store = await createRedisRuntimeStore("redis://unused", {
    redisClient: {
      ...createFakeRedisClient([neverAnswers]),
      zadd: () => neverAnswers,
      zremrangebyscore: () => neverAnswers,
      quit: () => neverAnswers,
      disconnect: () => {
        disconnectCalls += 1;
      },
    },
    pendingOperationTimeoutMs: 20,
    closeQuitTimeoutMs: 20,
    onPendingOperationError() {},
    onCloseUnfinished: (info) => {
      unfinished.push(info);
    },
  });

  store.getOrCreateRoom("ROOMCLOSE");
  store.addMember(
    "ROOMCLOSE",
    "member-close",
    createSession("session-close"),
    "token-close",
  );
  // This helper deliberately gives a live caller the command's real outcome;
  // shutdown must bound its own wait without changing that API contract.
  void store.blockMemberToken("ROOMCLOSE", "token-close", 60_000);
  // Direct reads can outlive an upstream shutdown step too. Since #277 this one
  // answers its caller at `pendingOperationTimeoutMs` — hence the catch — while
  // its command stays tracked, so the drain below still has to wait for it.
  void Promise.resolve(
    store.isMemberTokenBlocked("ROOMCLOSE", "token-close"),
  ).catch(() => undefined);

  const startedAt = Date.now();
  await store.close();
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(disconnectCalls, 1);
  // Three numbers because they answer three different questions, and the drain
  // waits on both of the last two: `pendingCommands` is what is on the wire and
  // reads zero in the gaps between one attempt's commands, while
  // `pendingAttempts` counts whole attempts and stays non-zero across exactly
  // those gaps. Reporting only the first is how a close could say
  // `pendingCommands: 0` and skip the report entirely (#270 review).
  assert.deepEqual(unfinished, [
    {
      pendingOperations: 1,
      pendingCommands: 3,
      // Two: the queued write's attempt, and the capped read — whose command
      // `boundCommand` keeps tracked after answering its caller, which is what
      // makes it visible to this report at all (#277).
      pendingAttempts: 2,
      pendingOperationBudgetMs: 20,
      quitOutcome: "timed_out",
      budgetMs: 20,
    },
  ]);
});

test("runtime seat helper rejects when the add-member write is lost", async () => {
  const addMemberFailure = Promise.reject(new Error("add-member write lost"));
  addMemberFailure.catch(() => undefined);
  const operationFailures: string[] = [];
  const store = await createRedisRuntimeStore("redis://unused", {
    redisClient: {
      ...createFakeRedisClient([Promise.resolve(null), addMemberFailure]),
      // `markSessionJoinedRoom` uses this script; one means its guarded index
      // write landed, isolating the failure to `addMember` below.
      async eval() {
        return 1;
      },
    },
    writeRetry: { maxAttempts: 1 },
    onPendingOperationError(context) {
      operationFailures.push(`${context.operationName}:${context.reason}`);
    },
  });

  try {
    await assert.rejects(
      seatSession(store, createSession("session-add-failed"), {
        roomCode: "ROOMAF",
        memberId: "member-add-failed",
        memberToken: "token-add-failed",
      }),
      /Runtime seat member-add-failed in ROOMAF was not persisted/,
    );
    assert.deepEqual(operationFailures, ["add_member:failed"]);
  } finally {
    await store.close();
  }
});

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
    // Both stores seat through the barrier rather than a sleep. The reads below
    // are cross-instance, so what they need is the WRITER's queue drained — a
    // fixed 25ms bought that on an idle machine and nothing at all on a loaded
    // CI runner (#247).
    await seatSession(storeA, sessionA, {
      roomCode: "ROOM01",
      memberId: "member-a",
      memberToken: "token-a",
    });
    await seatSession(storeB, sessionB, {
      roomCode: "ROOM01",
      memberId: "member-b",
      memberToken: "token-b",
    });

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

    // `blockMemberToken` settles once the block is durable, so awaiting it is
    // the barrier the sleep was standing in for.
    await storeA.blockMemberToken("ROOM01", "token-a", currentTime + 500);
    assert.equal(await storeB.isMemberTokenBlocked("ROOM01", "token-a"), true);

    currentTime += 600;
    assert.equal(await storeB.isMemberTokenBlocked("ROOM01", "token-a"), false);

    // `removeMember` answers synchronously and hands its durable write back on
    // the side; `markSessionLeftRoom` reports its own outcome. Both are waited
    // for, then the queue behind `unregisterSession` is drained.
    const removal = storeA.removeMember("ROOM01", "member-a", sessionA);
    await removal.durable;
    await storeA.markSessionLeftRoom(sessionA.id, "ROOM01");
    storeA.unregisterSession(sessionA.id);
    await settleRuntimeWrites(storeA);

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
    await seatSession(storeA, session, {
      roomCode: "ROOM02",
      memberId: "member-display",
      memberToken: "token-display",
    });

    session.displayName = "Alice";
    await storeA.registerSession(session);

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
    await settleRuntimeWrites(store);

    const roomA = await observer.listClusterSessionsByRoom("ROOMA1");
    const roomB = await observer.listClusterSessionsByRoom("ROOMB1");
    const clusterSessions =
      await observer.listClusterSessions("maintenance_pass");
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

  try {
    await seatSession(store, session, {
      roomCode: "ROOMRS",
      memberId: "member-restart",
      memberToken: "token-restart",
    });

    assert.equal(
      (await observer.listClusterSessionsByRoom("ROOMRS")).length,
      1,
    );
    assert.equal(await store.purgeSessionsByInstance?.("room-node-a"), 1);

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

  try {
    await seatSession(store, session, {
      roomCode: "ROOMPR",
      memberId: "member-presence",
      memberToken: "token-presence",
    });

    // A disconnect: presence goes, identity stays, so the reconnect can reclaim
    // the same memberId.
    const removal = store.removeMember("ROOMPR", "member-presence", session);
    await removal.durable;

    assert.equal(
      await observer.findMemberIdByToken("ROOMPR", "token-presence"),
      "member-presence",
    );

    // An explicit leave / kick: identity goes too.
    await store.revokeMemberToken("ROOMPR", "member-presence");

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
  const claimCalls: Array<{
    script: string;
    numKeys: number;
    args: Array<string | number>;
  }> = [];
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async eval(
      script: string,
      numKeys: number,
      ...args: Array<string | number>
    ) {
      claimCalls.push({ script, numKeys, args });
      return 1;
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
      "claim-token-1",
      currentTime - 10,
    );
    assert.equal(claimed, true, "slot should still be claimed via minimum TTL");
    assert.equal(claimCalls.length, 1);
    assert.equal(claimCalls[0]?.numKeys, 2);
    assert.match(claimCalls[0]?.script ?? "", /SET.*NX.*PX/s);
    assert.match(claimCalls[0]?.script ?? "", /ZADD/);
    assert.equal(claimCalls[0]?.args.at(-1), 1_000);

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
  const ttlCalls: number[] = [];
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async eval(
      _script: string,
      _numKeys: number,
      ...args: Array<string | number>
    ) {
      ttlCalls.push(Number(args.at(-1)));
      return 1;
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
      "claim-token-1",
      currentTime + 5_000,
    );
    assert.equal(claimedLarge, true);
    assert.equal(ttlCalls.at(-1), 5_000);

    // Small but positive TTL: must not be extended to the floor — the caller
    // controls the dedup window and clamping would change its semantics.
    const claimedSmall = await store.tryClaimMessageSlot(
      "ROOMYY",
      "share:actor:url:2",
      "claim-token-2",
      currentTime + 50,
    );
    assert.equal(claimedSmall, true);
    assert.equal(ttlCalls.at(-1), 50);

    const clampLogged = logs.some((line) =>
      line.includes("dedup_slot_ttl_clamped"),
    );
    assert.equal(clampLogged, false);
  } finally {
    console.log = originalLog;
    await store.close();
  }
});

test("late claim tracking and release cannot alter a newer owner's slot", async () => {
  const currentTime = 1_000;
  const slots = new Map<string, { token: string; expiresAt: number }>();
  const trackingScores = new Map<string, number>();
  const delayedClaim = {
    gate: createDeferred<void>(),
    operation: null as Promise<unknown> | null,
  };

  function applyMessageSlotScript(
    script: string,
    numKeys: number,
    args: Array<string | number>,
  ): number {
    assert.equal(numKeys, 2);
    const slotKey = String(args[0]);
    const token = String(args[2]);
    if (script.includes("local claimed")) {
      const ttlMs = Number(args[3]);
      const existing = slots.get(slotKey);
      if (existing && existing.expiresAt > currentTime) {
        return 0;
      }
      slots.set(slotKey, { token, expiresAt: currentTime + ttlMs });
      trackingScores.set(slotKey, currentTime + ttlMs);
      return 1;
    }
    if (
      script.includes("redis.call('GET'") &&
      slots.get(slotKey)?.token !== token
    ) {
      return 0;
    }
    slots.delete(slotKey);
    trackingScores.delete(slotKey);
    return 1;
  }

  function createOwnershipClient(delayFirstClaim: boolean) {
    let shouldDelayClaim = delayFirstClaim;
    return {
      ...createFakeRedisClient([]),
      eval(
        script: string,
        numKeys: number,
        ...args: Array<string | number>
      ): Promise<unknown> {
        if (shouldDelayClaim && script.includes("local claimed")) {
          shouldDelayClaim = false;
          delayedClaim.operation = delayedClaim.gate.promise.then(() =>
            applyMessageSlotScript(script, numKeys, args),
          );
          return delayedClaim.operation;
        }
        return Promise.resolve(applyMessageSlotScript(script, numKeys, args));
      },
    };
  }

  const storeA = await createRedisRuntimeStore("redis://unused", {
    redisClient: createOwnershipClient(true),
    keyPrefix: "bsp:test:dedup-owner:",
    now: () => currentTime,
    pendingOperationTimeoutMs: 20,
    closeQuitTimeoutMs: 20,
    onPendingOperationError() {},
    onCloseUnfinished() {},
  });
  const storeB = await createRedisRuntimeStore("redis://unused", {
    redisClient: createOwnershipClient(false),
    keyPrefix: "bsp:test:dedup-owner:",
    now: () => currentTime,
  });

  try {
    await assert.rejects(
      storeA.tryClaimMessageSlot(
        "ROOMOW",
        "playback:1",
        "owner-a",
        currentTime + 500,
      ),
      /timed out/,
    );
    assert.equal(
      await storeB.tryClaimMessageSlot(
        "ROOMOW",
        "playback:1",
        "owner-b",
        currentTime + 1_000,
      ),
      true,
    );

    delayedClaim.gate.resolve(undefined);
    assert.ok(delayedClaim.operation);
    await delayedClaim.operation;
    assert.deepEqual(Array.from(slots.values()), [
      { token: "owner-b", expiresAt: currentTime + 1_000 },
    ]);
    assert.deepEqual(Array.from(trackingScores.values()), [
      currentTime + 1_000,
    ]);
    assert.equal(
      await storeA.releaseMessageSlot("ROOMOW", "playback:1", "owner-a"),
      false,
      "the old owner must not release the replacement slot",
    );
    assert.equal(
      await storeB.releaseMessageSlot("ROOMOW", "playback:1", "owner-b"),
      true,
    );
    assert.equal(trackingScores.size, 0);
  } finally {
    await storeA.close();
    await storeB.close();
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

test("redis runtime store keeps a timed-out add-member command under backpressure until it answers", async () => {
  const firstOperation = createDeferred<unknown>();
  const fakeRedis = createFakeRedisClient([firstOperation.promise]);
  const store = await createRedisRuntimeStore("redis://unused", {
    redisClient: fakeRedis,
    maxPendingOperations: 1,
    pendingOperationTimeoutMs: 10,
    onPendingOperationError() {},
  });
  store.getOrCreateRoom("ROOMCAP");

  try {
    store.addMember(
      "ROOMCAP",
      "member-a",
      createSession("member-a"),
      "token-a",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.throws(
      () =>
        store.addMember(
          "ROOMCAP",
          "member-b",
          createSession("member-b"),
          "token-b",
        ),
      /backpressure/,
    );
  } finally {
    firstOperation.resolve(null);
    await store.close();
  }
});

test("a command that SETTLES releases the capacity a stalled one holds", async () => {
  // The companion to the test above, and the reason this connection may not
  // carry a `commandTimeout` (#271 review). The admission gate counts commands
  // that outlived their cap precisely so a join whose read timed out cannot
  // start another one every timeout window (#242 review) — and a backstop
  // settles exactly those commands. What the gate would then bound is not
  // ioredis's queue but a RATE: `maxPendingOperations` new commands per
  // timeout, for as long as the stall lasts.
  //
  // A rejection is what `commandTimeout` produces, so that is what this models.
  const firstOperation = createDeferred<unknown>();
  const fakeRedis = createFakeRedisClient([firstOperation.promise]);
  const store = await createRedisRuntimeStore("redis://unused", {
    redisClient: fakeRedis,
    maxPendingOperations: 1,
    pendingOperationTimeoutMs: 10,
    onPendingOperationError() {},
  });
  store.getOrCreateRoom("ROOMCAP2");

  try {
    store.addMember(
      "ROOMCAP2",
      "member-a",
      createSession("member-a"),
      "token-a",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The caller was already answered by the cap; now the COMMAND answers too,
    // which is the only difference from the test above.
    firstOperation.reject(new Error("Command timed out"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Admitted. Under a real stall this repeats every timeout window.
    store.addMember(
      "ROOMCAP2",
      "member-b",
      createSession("member-b"),
      "token-b",
    );
  } finally {
    await store.close();
  }
});

test("redis runtime store retries a timed-out write instead of dropping it", async () => {
  // The first attempt outlives its cap: the timeout has to end THAT ATTEMPT and
  // hand the write back to the retry queue, rather than end the write (#242).
  //
  // The slow command then ANSWERS, which is what releases the retry — the queue
  // deliberately does not open a second attempt while the first command is
  // still out there, or one write could leave `maxAttempts` uncancellable
  // commands behind at once (#242 review).
  const slowOperation = createDeferred<unknown>();
  const fakeRedis = createFakeRedisClient([slowOperation.promise]);
  const errors: string[] = [];
  const store = await createRedisRuntimeStore("redis://unused", {
    redisClient: fakeRedis,
    pendingOperationTimeoutMs: 20,
    writeRetry: { initialRetryDelayMs: 1 },
    onPendingOperationError(context) {
      errors.push(context.reason);
    },
  });
  const answered = setTimeout(() => {
    slowOperation.reject(new Error("slow redis command finally answered"));
  }, 40);

  try {
    store.registerSession(createSession("timed-out"));
    // Resolves only because the second attempt got a fresh `multi()`, which the
    // fake answers with a resolved exec.
    await store.confirmWrites?.();

    assert.ok(errors.includes("timeout"));
    assert.ok(errors.includes("retry"));
    assert.equal(errors.includes("failed"), false);
  } finally {
    clearTimeout(answered);
    slowOperation.reject(new Error("cleanup"));
    await store.close();
  }
});

test("redis runtime store counts one failure per write, not per attempt", async () => {
  const failureOperations: string[] = [];
  const errors: string[] = [];
  // Every attempt rejects, so the write is genuinely lost — and it must be
  // reported exactly once however many times the queue tried.
  const rejections = Array.from({ length: 8 }, () =>
    Promise.reject(new Error("redis failure")),
  );
  for (const rejection of rejections) {
    rejection.catch(() => undefined);
  }
  const store = await createRedisRuntimeStore("redis://example.test:6379", {
    redisClient: createFakeRedisClient(rejections),
    pendingOperationTimeoutMs: 5,
    writeRetry: { maxAttempts: 3, initialRetryDelayMs: 1 },
    onPendingOperationError(context) {
      errors.push(context.reason);
    },
    metricsCollector: {
      observeRedisRuntimeStoreDuration() {},
      observeRedisRuntimeStoreFailure(operation) {
        failureOperations.push(operation);
      },
    },
  });

  try {
    store.registerSession(createSession("session-timeout"));
    await assert.rejects(async () => {
      await store.confirmWrites?.();
    });

    assert.deepEqual(failureOperations, ["register_session"]);
    // Two retries scheduled between the three attempts.
    assert.equal(errors.filter((reason) => reason === "retry").length, 2);
    assert.equal(errors.filter((reason) => reason === "failed").length, 1);
  } finally {
    await store.close();
  }
});

test("redis runtime store confirms writes separately from draining them", async () => {
  const rejection = Promise.reject(new Error("redis failure"));
  rejection.catch(() => undefined);
  const store = await createRedisRuntimeStore("redis://example.test:6379", {
    redisClient: createFakeRedisClient([rejection]),
    writeRetry: { maxAttempts: 1 },
  });

  try {
    store.registerSession(createSession("session-unconfirmed"));
    // `flush` only ever says the queue emptied — a failed write drains exactly
    // like a successful one, which is the conflation #242 exists to end.
    await store.flush?.();
    await assert.rejects(async () => {
      await store.confirmWrites?.();
    }, /not confirmed/);
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

  try {
    await seatSession(store, session, {
      roomCode: "ROOMRT",
      memberId: "member-retention",
      memberToken: "token-retention",
    });

    // Still connected: no clock at all, so someone who never leaves keeps their
    // identity however long the session lasts.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      await store.findMemberIdByToken("ROOMRT", "token-retention"),
      "member-retention",
    );

    // The last session goes. Identity outlives the disconnect...
    const removal = store.removeMember("ROOMRT", "member-retention", session);
    await removal.durable;
    store.unregisterSession(session.id);
    await settleRuntimeWrites(store);
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

  try {
    await seatSession(store, session, {
      roomCode: "ROOMRL",
      memberId: "member-relift",
      memberToken: "token-relift",
    });

    const removal = store.removeMember("ROOMRL", "member-relift", session);
    await removal.durable;
    store.unregisterSession(session.id);
    await settleRuntimeWrites(store);

    // Reconnect inside the window: the clock must be lifted, not merely
    // restarted, or a room that keeps churning members would eventually drop
    // identities while people are still in it.
    const reconnected = createSession("session-relift-2");
    await seatSession(store, reconnected, {
      roomCode: "ROOMRL",
      memberId: "member-relift",
      memberToken: "token-relift",
    });

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
  const visitor = createSession("session-visitor");

  try {
    // The host never leaves, so the room is never empty and a room-scoped clock
    // would never start. A public room with a steady trickle of visitors then
    // accumulates one token per visitor, forever.
    await seatSession(store, host, {
      roomCode: "ROOMBZ",
      memberId: "member-host",
      memberToken: "token-host",
    });
    await seatSession(store, visitor, {
      roomCode: "ROOMBZ",
      memberId: "member-visitor",
      memberToken: "token-visitor",
    });

    const removal = store.removeMember("ROOMBZ", "member-visitor", visitor);
    await removal.durable;
    await store.markSessionLeftRoom(visitor.id, "ROOMBZ");
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

  try {
    await seatSession(store, session, {
      roomCode: "ROOMCR",
      memberId: "member-crashed",
      memberToken: "token-crashed",
    });

    // The process crashed and came back under the same instanceId.
    assert.equal(await store.purgeSessionsByInstance?.("crashed-node"), 1);

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

  try {
    await seatSession(store, session, {
      roomCode: "ROOMEV",
      memberId: "member-evict",
      memberToken: "token-evict",
    });

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

  try {
    await seatSession(store, session, {
      roomCode: "ROOMKX",
      memberId: "member-kicked",
      memberToken: "token-kicked",
    });

    // The kick takes the token and its retention entry away...
    await store.evictMemberToken(
      "ROOMKX",
      "member-kicked",
      "token-kicked",
      Date.now() + 60_000,
    );
    await store.flush?.();

    // ...and the socket close arrives afterwards, as it always does.
    const removal = store.removeMember("ROOMKX", "member-kicked", session);
    await removal.durable;

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

  try {
    await seatSession(store, session, {
      roomCode: "ROOMCK",
      memberId: "member-crash-kicked",
      memberToken: "token-crash-kicked",
    });

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

    await store.registerSession(session);
    await store.markSessionJoinedRoom(session.id, "ROOMRS");

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
      "claim-token-lapsed",
      currentTime + 200,
    );
    await store.flush?.();
    assert.equal(await store.hasRoomResidue("ROOMLP"), true);

    currentTime += 3_600_000;
    await new Promise((resolve) => setTimeout(resolve, 250));

    // The blocked-token index uses the injected application clock, while the
    // dedup index is tied to Redis's own TTL clock. Both must lapse before this
    // code is reusable, and neither zset removes expired scores on its own.
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
  //
  // The caller only hears about it once the retries are spent, so every attempt
  // has to fail here — a single rejection would now be absorbed (#242).
  let execAttempts = 0;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    multi() {
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
          execAttempts += 1;
          return Promise.reject(new Error("index write failed"));
        },
      };
    },
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
    writeRetry: { maxAttempts: 3, initialRetryDelayMs: 1 },
  });

  try {
    await assert.rejects(
      store.markSessionLeftRoom("session-dirty", "ROOMDT"),
      /index write failed/,
    );
    assert.equal(execAttempts, 3, "the write must have been retried first");
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

test("redis runtime store reports a failed join-index write to the caller", async () => {
  // Mirror image of the leave side: the join's own bootstrap `room:state` is
  // rebuilt from the index this write maintains, so a write that has not landed
  // produces a state missing the member who just joined — and the ownership
  // decision taken from it is wrong in the one case it exists for, the stored
  // sharer reconnecting (#235 review). `flush` cannot report it.
  let evalAttempts = 0;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async hgetall() {
      return { id: "session-join", roomCode: "" };
    },
    async get() {
      return "gen-1";
    },
    async eval() {
      evalAttempts += 1;
      throw new Error("join write failed");
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:join:",
    redisClient: fakeRedis,
    writeRetry: { maxAttempts: 3, initialRetryDelayMs: 1 },
  });

  try {
    await assert.rejects(
      store.markSessionJoinedRoom("session-join", "ROOMJN"),
      /join write failed/,
    );
    assert.equal(evalAttempts, 3, "the write must have been retried first");
    await store.flush?.();
  } finally {
    await store.close();
  }
});

test("redis runtime store pins the room generation a join retry must still match", async () => {
  // Room codes are recycled. A retry that outlived the room instance it was
  // meant for would seat this session in whichever room took the code over, so
  // the generation is read ONCE — before the first attempt writes anything —
  // and every attempt carries it (#242, #237). Reading it per attempt instead
  // would let the retry re-pin itself onto the new occupant.
  const generationReads: string[] = [];
  const expectedGenerations: string[] = [];
  let evalAttempts = 0;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async hgetall() {
      return { id: "session-recycled", roomCode: "" };
    },
    async get(key: string) {
      generationReads.push(key);
      // The code changes hands right after the first read. A store that read
      // the generation again on the retry would happily write into "gen-2".
      return generationReads.length === 1 ? "gen-1" : "gen-2";
    },
    async eval(
      _script: string,
      numKeys: number,
      ...args: Array<string | number>
    ) {
      evalAttempts += 1;
      // The expected generation is the first ARGV, i.e. straight after the keys.
      expectedGenerations.push(String(args[numKeys]));
      if (evalAttempts === 1) {
        throw new Error("transient redis failure");
      }
      return 1;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:recycled:",
    redisClient: fakeRedis,
    writeRetry: { maxAttempts: 4, initialRetryDelayMs: 1 },
  });

  try {
    await store.markSessionJoinedRoom("session-recycled", "ROOMRC");
    assert.equal(evalAttempts, 2);
    assert.equal(generationReads.length, 1, "the generation is read once");
    assert.deepEqual(expectedGenerations, ["gen-1", "gen-1"]);
  } finally {
    await store.close();
  }
});

test("redis runtime store stops retrying a join whose room code changed hands", async () => {
  let evalAttempts = 0;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async hgetall() {
      return { id: "session-moved", roomCode: "" };
    },
    async get() {
      return "gen-1";
    },
    // The script declines: by the time it ran, the code carried another
    // generation.
    async eval() {
      evalAttempts += 1;
      return 0;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:moved:",
    redisClient: fakeRedis,
    writeRetry: { maxAttempts: 4, initialRetryDelayMs: 1 },
  });

  try {
    await assert.rejects(
      store.markSessionJoinedRoom("session-moved", "ROOMMV"),
      /changed hands/,
    );
    // Declined, never retried: a generation only moves forward, so no later
    // attempt could find its way back.
    assert.equal(evalAttempts, 1);
  } finally {
    await store.close();
  }
});

test("redis runtime store re-writes the whole session record when a join seats it", async () => {
  // `registerSession` is a separate queued write and can have failed. A join
  // that patched only `roomCode` on top of that left a hash with no `id`, which
  // `loadSession` reads as no session at all — so the joiner was missing from
  // every state built off the shared view, and the stored sharer's reconnect
  // handed the share to a stand-in (#242).
  let evalArgs: Array<string | number> = [];
  const fakeRedis = {
    ...createFakeRedisClient([
      Promise.reject(new Error("registration write failed")),
    ]),
    async hgetall() {
      // The registration never landed, so Redis holds nothing for it.
      return {};
    },
    async get() {
      return "gen-1";
    },
    async eval(
      _script: string,
      _numKeys: number,
      ...args: Array<string | number>
    ) {
      evalArgs = args;
      return 1;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:heal:",
    redisClient: fakeRedis,
    writeRetry: { maxAttempts: 1 },
  });

  try {
    const session = createSession("session-heal");
    session.displayName = "Alice";
    session.memberId = "member-heal";
    session.memberToken = "token-heal";
    void store.registerSession(session);
    await store.markSessionJoinedRoom(session.id, "ROOMHL");

    const fields = evalArgs.map(String);
    for (const field of [
      "id",
      "instanceId",
      "remoteAddress",
      "origin",
      "roomCode",
      "memberId",
      "displayName",
      "memberToken",
      "joinedAt",
      "invalidMessageCount",
    ]) {
      assert.ok(
        fields.includes(field),
        `the join write must carry ${field}, not just the room code`,
      );
    }
    assert.ok(fields.includes("session-heal"));
    assert.ok(fields.includes("Alice"));
    assert.ok(fields.includes("member-heal"));
    // And it is still the write that puts the session into both indexes.
    assert.ok(fields.includes("ROOMHL"));
  } finally {
    await store.close();
  }
});

test("redis runtime store never leaks an unhandled rejection from a dropped write", async () => {
  // `queueSessionOperation` returns a NEW promise (the one that logs and
  // re-throws), so the durable queue's own handled-marker does not cover it.
  // `unregisterSession` drops that promise on the floor, which crashed the
  // process on an unhandled rejection once every retry had failed (#242).
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  const rejection = Promise.reject(new Error("redis down"));
  rejection.catch(() => undefined);
  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:unhandled:",
    redisClient: createFakeRedisClient([rejection]),
    writeRetry: { maxAttempts: 1 },
  });

  try {
    store.unregisterSession("session-dropped");
    await store.flush?.();
    // Unhandled rejections are reported a macrotask after the microtask queue
    // drains, so give the process a tick to raise one.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await store.close();
  }
});

test("redis runtime store stops backing off once it is closing", async () => {
  // The close step is on a clock. Spending the whole retry budget on writes a
  // dead Redis was never going to accept would record the step as failed and
  // exit the process non-zero (#242).
  let attempts = 0;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    multi() {
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
          attempts += 1;
          return Promise.reject(new Error("redis down"));
        },
      };
    },
  };
  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:closing:",
    redisClient: fakeRedis,
    // A backoff long enough that a close which waited it out would be obvious.
    writeRetry: {
      maxAttempts: 6,
      initialRetryDelayMs: 10_000,
      maxRetryDelayMs: 10_000,
    },
  });

  store.registerSession(createSession("session-closing"));
  // Let the first attempt fail and park in the backoff.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(attempts, 1);

  const closedAt = Date.now();
  await store.close();
  assert.ok(
    Date.now() - closedAt < 5_000,
    "close must not wait out the retry backoff",
  );
  assert.equal(attempts, 1, "no further attempt after the close began");
});

test("redis runtime store pins the join generation before the queue gets to it", async () => {
  // The operation body does not run until the session's chain drains, and that
  // is unbounded — a prior write for the same session can hold it. Pinning in
  // there reads whatever generation exists by THEN, including the new
  // occupant's after a recycle, and the Lua check then waves the old join into
  // a room it never joined (#242 review).
  let currentGeneration = "gen-1";
  let evalAttempts = 0;
  const expectedGenerations: string[] = [];
  const slowRegistration = createDeferred<unknown>();
  const fakeRedis = {
    ...createFakeRedisClient([slowRegistration.promise]),
    async hgetall() {
      return { id: "session-queued", roomCode: "" };
    },
    async get() {
      return currentGeneration;
    },
    async eval(
      _script: string,
      numKeys: number,
      ...args: Array<string | number>
    ) {
      evalAttempts += 1;
      expectedGenerations.push(String(args[numKeys]));
      // Stands in for the script's own check against the live generation.
      return String(args[numKeys]) === currentGeneration ? 1 : 0;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:queued:",
    redisClient: fakeRedis,
    writeRetry: { maxAttempts: 4, initialRetryDelayMs: 1 },
  });

  try {
    const session = createSession("session-queued");
    // Occupies the session's chain: its first attempt is in flight, and
    // supersession only abandons RETRIES, so the join queues behind it.
    store.registerSession(session);
    const joined = store.markSessionJoinedRoom(session.id, "ROOMQD");
    joined.catch(() => undefined);

    // The join is pinned by now, but its body has not run. The code changes
    // hands while it waits.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(evalAttempts, 0, "the join body must still be queued");
    currentGeneration = "gen-2";
    slowRegistration.resolve(null);

    await assert.rejects(joined, /changed hands/);
    // Pinned at the call, so it still names the room the join was actually for.
    assert.deepEqual(expectedGenerations, ["gen-1"]);
    assert.equal(evalAttempts, 1);
  } finally {
    await store.close();
  }
});

test("redis runtime store refuses a join whose room generation cannot be read", async () => {
  // A second read is a second chance to pin the WRONG room instance, so an
  // unreadable generation refuses the join rather than retrying the read. The
  // client retries the join — the same trade this path makes for the index
  // write itself (#242 review).
  let evalAttempts = 0;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async hgetall() {
      return { id: "session-blind", roomCode: "" };
    },
    async get() {
      throw new Error("generation read failed");
    },
    async eval() {
      evalAttempts += 1;
      return 1;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:blind:",
    redisClient: fakeRedis,
    writeRetry: { maxAttempts: 4, initialRetryDelayMs: 1 },
  });

  try {
    await assert.rejects(
      store.markSessionJoinedRoom("session-blind", "ROOMBL"),
      /Could not pin the generation/,
    );
    assert.equal(evalAttempts, 0, "nothing may be written unguarded");
  } finally {
    await store.close();
  }
});

test("redis runtime store keeps a session's rollback behind the command it abandoned", async () => {
  // The attempt timeout races the Redis command; it does not abort it. If the
  // session's key were released when the CALLER is answered, the rollback the
  // handler performs would run first and the abandoned join would then land on
  // top of it — leaving a member the client was told does not exist, and one
  // that can win the share back (#242 review).
  const order: string[] = [];
  let releaseJoin: (() => void) | null = null;
  let evalCalls = 0;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    multi() {
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
          order.push("leave-write");
          return Promise.resolve(null);
        },
      };
    },
    async hgetall() {
      return { id: "session-late", roomCode: "" };
    },
    async get() {
      return "gen-1";
    },
    eval() {
      evalCalls += 1;
      if (evalCalls > 1) {
        // Later calls are the empty-room cleanup, not the join script.
        return Promise.resolve(1);
      }
      // Never settles inside the attempt window; lands only when released.
      return new Promise((resolve) => {
        releaseJoin = () => {
          order.push("join-write");
          resolve(1);
        };
      });
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:late:",
    redisClient: fakeRedis,
    pendingOperationTimeoutMs: 20,
    writeRetry: { maxAttempts: 1 },
  });

  try {
    const joined = store.markSessionJoinedRoom("session-late", "ROOMLT");
    await assert.rejects(joined, /timed out/);
    order.push("caller-answered");

    // The rollback the handler performs on a refused join.
    const left = store.markSessionLeftRoom("session-late", "ROOMLT");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      order,
      ["caller-answered"],
      "the rollback must not overtake the abandoned command",
    );

    (releaseJoin as (() => void) | null)?.();
    await left;
    assert.deepEqual(order, ["caller-answered", "join-write", "leave-write"]);
  } finally {
    (releaseJoin as (() => void) | null)?.();
    await store.close();
  }
});

test("redis runtime store declines a join pinned before the room was torn down", async () => {
  // Deleting the generation key made "torn down" indistinguishable from "never
  // had a generation", so a join that pinned `""` against a legacy room matched
  // just as well after the room was deleted — and rebuilt the indexes of a room
  // whose persisted record was gone (#242 review). The teardown leaves a
  // tombstone instead.
  let generation: string | null = null;
  let releaseJoinScript: (() => void) | null = null;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async hgetall() {
      return { id: "session-tombstoned", roomCode: "" };
    },
    async get() {
      return generation;
    },
    async zrange() {
      return [];
    },
    eval(script: string, numKeys: number, ...args: Array<string | number>) {
      // `HSET` is the join script's alone; the teardown only deletes and SREMs.
      if (!script.includes("HSET")) {
        // The teardown script: it stamps the tombstone it was handed, which is
        // the last ARGV now that the tombstone carries no TTL.
        generation = String(args[args.length - 1]);
        return Promise.resolve(1);
      }
      // The join script. Held so the teardown can land between the pin and the
      // write — the very window the tombstone exists to close.
      const expected = String(args[numKeys]);
      return new Promise((resolve) => {
        releaseJoinScript = () => {
          resolve((generation ?? "") === expected ? 1 : 0);
        };
      });
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:tombstone:",
    redisClient: fakeRedis,
    writeRetry: { maxAttempts: 1 },
  });

  try {
    // The room never had a generation, so the join pins `""`.
    const joined = store.markSessionJoinedRoom("session-tombstoned", "ROOMTS");
    joined.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(releaseJoinScript, "the join must have pinned and be waiting");

    // It is torn down, which stamps the tombstone rather than clearing the key.
    assert.equal(await store.deleteRoom("ROOMTS", null), true);
    assert.equal(generation, "deleted");

    // The pinned write now lands. An absent key would have matched `""` all
    // over again and rebuilt the room's indexes.
    (releaseJoinScript as (() => void) | null)?.();
    await assert.rejects(joined, /changed hands/);
  } finally {
    (releaseJoinScript as (() => void) | null)?.();
    await store.close();
  }
});

test("redis runtime store leaves a tombstone where a torn-down room's generation was", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  // Against the real script, because the tombstone IS the script: a fake that
  // stands in for `DELETE_ROOM_LUA` cannot tell a `SET` from a `DEL` (#242
  // review).
  const keyPrefix = createKeyPrefix();
  const store = await createRedisRuntimeStore(REDIS_URL, { keyPrefix });
  const session = createSession("session-tombstone");

  try {
    store.registerSession(session);
    await store.markSessionJoinedRoom(session.id, "ROOMTB");
    session.memberId = "member-tombstone";
    session.memberToken = "token-tombstone";
    store.addMember("ROOMTB", session.memberId, session, session.memberToken);
    await store.flush?.();

    assert.equal(await store.getRoomGeneration("ROOMTB"), null);
    assert.equal(await store.deleteRoom("ROOMTB", null), true);

    // Deleting the key made "torn down" indistinguishable from "never had a
    // generation", so a write pinned at `""` matched the room it was about to
    // resurrect.
    assert.equal(await store.getRoomGeneration("ROOMTB"), "deleted");
    // Which is what the join script compares a pre-teardown pin against; the
    // ordering half of that is pinned by the fake-driven test above.
    // The tombstone must not keep the code reserved: it is deliberately absent
    // from the residue check, so the code is free to be handed out again.
    assert.equal(await store.hasRoomResidue("ROOMTB"), false);
  } finally {
    await store.close();
  }
});

test("redis runtime store waits for in-flight commands before closing the connection", async () => {
  // `pendingOperations` holds the CALLERS' answers, and a write that timed out
  // answered long before its command did. Quitting on that alone closes the
  // connection under commands still in flight — the same "a timeout is not a
  // cancel" gap `settle` closes for the session chain (#242 review).
  const order: string[] = [];
  let releaseCommand: (() => void) | null = null;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async quit() {
      order.push("quit");
      return "OK";
    },
    async hgetall() {
      return { id: "session-closing", roomCode: "" };
    },
    async get() {
      return "gen-1";
    },
    eval() {
      return new Promise((resolve) => {
        releaseCommand = () => {
          order.push("command-landed");
          resolve(1);
        };
      });
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:closing-drain:",
    redisClient: fakeRedis,
    pendingOperationTimeoutMs: 100,
    writeRetry: { maxAttempts: 1 },
  });

  const joined = store.markSessionJoinedRoom("session-closing", "ROOMCL");
  await assert.rejects(joined, /timed out/);
  assert.deepEqual(order, [], "the command has not answered yet");

  const closing = store.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, [], "close must not quit under a live command");

  (releaseCommand as (() => void) | null)?.();
  await closing;
  assert.deepEqual(order, ["command-landed", "quit"]);
});

test("redis runtime store leaves a generation tombstone that cannot expire", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  // A TTL would have to outlive every write still holding the old pin, and
  // nothing bounds those — a session chain waits on a command that was never
  // cancelled. A tombstone that lapsed first lets the join's `""` pin match an
  // absent key all over again (#242 review).
  const keyPrefix = createKeyPrefix();
  const store = await createRedisRuntimeStore(REDIS_URL, { keyPrefix });
  const probe = new Redis(REDIS_URL);
  const session = createSession("session-tombstone-ttl");

  try {
    store.registerSession(session);
    await store.markSessionJoinedRoom(session.id, "ROOMTT");
    await store.flush?.();
    assert.equal(await store.deleteRoom("ROOMTT", null), true);

    const key = `${keyPrefix}room:ROOMTT:generation`;
    assert.equal(await probe.get(key), "deleted");
    // -1 is redis for "no expiry"; anything positive is a lapsing tombstone.
    assert.equal(await probe.pttl(key), -1);
  } finally {
    await probe.quit();
    await store.close();
  }
});

test("redis runtime store holds backpressure capacity until the command finishes", async () => {
  // The retry budget rejects the outcome long before the commands stop running.
  // Freeing the slot there let the next session's write take it and leave one
  // more uncancellable command behind, so the configured cap stopped bounding
  // anything (#242 review).
  const releases: Array<() => void> = [];
  let hangCommands = true;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async hgetall() {
      return {};
    },
    async get() {
      return "gen-1";
    },
    eval() {
      if (!hangCommands) {
        return Promise.resolve(1);
      }
      return new Promise((resolve) => {
        releases.push(() => resolve(1));
      });
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:capacity:",
    redisClient: fakeRedis,
    maxPendingOperations: 1,
    pendingOperationTimeoutMs: 20,
    writeRetry: { maxAttempts: 1 },
  });

  try {
    const first = store.markSessionJoinedRoom("session-cap-a", "ROOMCA");
    await assert.rejects(first, /timed out/);
    // The caller has been answered, but the command is still out there — so the
    // slot it occupies must not be handed to anybody else.
    assert.throws(
      () => store.markSessionJoinedRoom("session-cap-b", "ROOMCB"),
      /backpressure/,
    );

    hangCommands = false;
    for (const release of releases) {
      release();
    }
    // A tick for the commands to answer: capacity is released by the command
    // itself, and `flush` cannot stand in for that — its outcome settled back
    // when the attempt timed out.
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Once the commands answer, capacity comes back.
    await store.markSessionJoinedRoom("session-cap-c", "ROOMCC");
  } finally {
    for (const release of releases) {
      release();
    }
    await store.close();
  }
});

test("redis runtime store drains the generation read it started at enqueue", async () => {
  // That `GET` belongs to the write but is started before it — so it is in
  // neither `settle`'s list nor anything else, and `close()` could `quit()`
  // straight through it (#242 review).
  const order: string[] = [];
  let releaseGet: (() => void) | null = null;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async quit() {
      order.push("quit");
      return "OK";
    },
    async hgetall() {
      return {};
    },
    get() {
      return new Promise<string | null>((resolve) => {
        releaseGet = () => {
          order.push("generation-read-answered");
          resolve("gen-1");
        };
      });
    },
    async eval() {
      return 1;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:enqueue-read:",
    redisClient: fakeRedis,
    pendingOperationTimeoutMs: 30,
    writeRetry: { maxAttempts: 1 },
  });

  const joined = store.markSessionJoinedRoom("session-read", "ROOMRD");
  await assert.rejects(joined, /Timed out reading the generation/);

  const closing = store.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, [], "close must not quit under the pinned read");

  (releaseGet as (() => void) | null)?.();
  await closing;
  assert.deepEqual(order, ["generation-read-answered", "quit"]);
});

test("redis runtime store refuses a join pinned after the room was torn down", async () => {
  // The Lua guard only ever covered a pin taken BEFORE the teardown: that pin
  // stops matching once the key holds the tombstone. A pin taken AFTER it reads
  // the tombstone and matches ITSELF, so the script applied and rebuilt the
  // indexes of a room that no longer exists (#242 review).
  let evalCalls = 0;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async hgetall() {
      return { id: "session-late-pin", roomCode: "" };
    },
    async get() {
      // The teardown already ran, so this is what the key holds.
      return "deleted";
    },
    async eval() {
      evalCalls += 1;
      return 1;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:late-pin:",
    redisClient: fakeRedis,
    writeRetry: { maxAttempts: 4, initialRetryDelayMs: 1 },
  });

  try {
    await assert.rejects(
      store.markSessionJoinedRoom("session-late-pin", "ROOMLP"),
      // The `reason`, not a message substring: the read-failure handler wraps
      // the message, and a wrapped one still CONTAINS the original — so a
      // regex would pass either way and never notice the relabelling.
      (error: unknown) =>
        error instanceof NonRetryableWriteError &&
        error.reason === "room_deleted",
    );
    assert.equal(evalCalls, 0, "nothing may be written against a dead room");
  } finally {
    await store.close();
  }
});

test("the join index script declines a stale generation and writes nothing", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  // The script IS the guard, and a fake client cannot run it — the store-level
  // tests only ever assert what the store does with a script that already
  // declined (#242 review).
  const keyPrefix = createKeyPrefix();
  const redis = new Redis(REDIS_URL);
  const generationKey = `${keyPrefix}room:ROOMSG:generation`;
  const sessionKey = `${keyPrefix}session:session-stale`;
  const roomSessionsKey = `${keyPrefix}room:ROOMSG:sessions`;

  const run = (expectedGeneration: string): Promise<unknown> =>
    redis.eval(
      JOIN_ROOM_INDEX_LUA,
      5,
      generationKey,
      sessionKey,
      `${keyPrefix}sessions`,
      roomSessionsKey,
      `${keyPrefix}rooms`,
      expectedGeneration,
      "session-stale",
      "ROOMSG",
      "id",
      "session-stale",
      "roomCode",
      "ROOMSG",
    );

  try {
    await redis.set(generationKey, "gen-2");

    // A pin taken under the room's PREVIOUS generation.
    assert.equal(Number(await run("gen-1")), 0);
    assert.equal(await redis.exists(sessionKey), 0, "no session hash written");
    assert.equal(await redis.scard(roomSessionsKey), 0, "no room index entry");

    // The tombstone a teardown leaves is likewise not the live generation.
    await redis.set(generationKey, "deleted");
    assert.equal(Number(await run("gen-2")), 0);
    assert.equal(await redis.exists(sessionKey), 0);

    // And the matching pin does apply, so the guard is not simply refusing all.
    assert.equal(Number(await run("deleted")), 1);
    assert.equal(await redis.exists(sessionKey), 1);
    assert.equal(await redis.scard(roomSessionsKey), 1);
  } finally {
    const keys = await redis.keys(`${keyPrefix}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    await redis.quit();
  }
});

test("redis runtime store keeps the full session record when a leave supersedes a lost registration", async () => {
  // A leave supersedes the RETRY of a `registerSession` that failed. When it
  // wrote only `roomCode`, everything else the registration carried — the new
  // `displayName` above all — never landed, and `confirm()` still reported
  // success because a superseded write is not counted as unconfirmed (#242
  // review).
  //
  // Fake-driven on purpose: against real Redis the registration succeeds on its
  // first attempt, so nothing is ever left for the leave to supersede and the
  // test cannot tell the two implementations apart.
  const hsetCalls: Array<Record<string, string> | string[]> = [];
  let execCalls = 0;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    multi() {
      const commands = {
        sadd() {
          return commands;
        },
        srem() {
          return commands;
        },
        del() {
          return commands;
        },
        hset(_key: string, ...args: unknown[]) {
          hsetCalls.push(
            args.length === 1
              ? (args[0] as Record<string, string>)
              : (args as string[]),
          );
          return commands;
        },
        hdel() {
          return commands;
        },
        zadd() {
          return commands;
        },
        zrem() {
          return commands;
        },
        exec() {
          execCalls += 1;
          // The registration's write fails, so its retry is what the leave
          // then supersedes.
          return execCalls === 1
            ? Promise.reject(new Error("registration write failed"))
            : Promise.resolve(null);
        },
      };
      return commands;
    },
    async hgetall() {
      return { id: "session-subset", roomCode: "ROOMSB" };
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:subset:",
    redisClient: fakeRedis,
    // Long enough that the registration is still waiting to retry when the
    // leave arrives and supersedes it.
    writeRetry: { maxAttempts: 5, initialRetryDelayMs: 10_000 },
  });

  try {
    const session = createSession("session-subset");
    session.displayName = "Renamed";
    session.memberId = "member-subset";
    session.memberToken = "token-subset";
    void store.registerSession(session);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      hsetCalls.length,
      1,
      "the registration attempt ran and failed",
    );

    session.roomCode = null;
    await store.markSessionLeftRoom(session.id, "ROOMSB");

    const leaveWrite = hsetCalls.at(-1);
    assert.ok(
      leaveWrite && !Array.isArray(leaveWrite),
      `the leave must write a full record, got ${JSON.stringify(leaveWrite)}`,
    );
    assert.equal(leaveWrite.roomCode, "", "the leave still blanks the room");
    assert.equal(leaveWrite.displayName, "Renamed", "the rename must land");
    assert.equal(leaveWrite.id, "session-subset", "the record stays readable");
    assert.equal(leaveWrite.memberId, "member-subset");
  } finally {
    await store.close();
  }
});

test("redis runtime store starts no session read when the generation pin is refused", async () => {
  // Started in parallel, that read outlived an operation that rejected on the
  // pin: in no tracking set, counted by no capacity check, and waited for by
  // nobody at close (#242 review).
  let sessionReads = 0;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async hgetall() {
      sessionReads += 1;
      return {};
    },
    async get() {
      return "deleted";
    },
    async eval() {
      return 1;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:no-parallel-read:",
    redisClient: fakeRedis,
    writeRetry: { maxAttempts: 1 },
  });

  try {
    await assert.rejects(
      store.markSessionJoinedRoom("session-noread", "ROOMNR"),
      (error: unknown) =>
        error instanceof NonRetryableWriteError &&
        error.reason === "room_deleted",
    );
    assert.equal(sessionReads, 0, "the read must not have been started");
  } finally {
    await store.close();
  }
});

test("redis runtime store retries a member removal instead of giving up on one attempt", async () => {
  // It used to get a single attempt, so a transient error made `durable` reject
  // for good: the member binding stayed in Redis with no retention clock armed,
  // and the reaper grew a latch to compensate for a failure a retry would have
  // healed (#242 review).
  let attempts = 0;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async eval() {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("remove member write failed");
      }
      return 1;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:remove-retry:",
    redisClient: fakeRedis,
    writeRetry: { maxAttempts: 3, initialRetryDelayMs: 1 },
  });

  try {
    const removal = store.removeMember("ROOMRM", "member-rm");
    assert.ok(removal.durable, "the removal reports a durable outcome");
    await removal.durable;
    assert.equal(attempts, 2, "the transient failure was retried");
  } finally {
    await store.close();
  }
});

test("redis runtime store flush waits for the session key to be released", async () => {
  // `pendingOperations` holds the CALLERS' answers, and an attempt that timed
  // out answered long before its command did — so `flush` returned while the
  // key was still held and the next broadcast saw stale data (#242 review).
  const order: string[] = [];
  let releaseCommand: (() => void) | null = null;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    multi() {
      const commands = {
        sadd: () => commands,
        srem: () => commands,
        del: () => commands,
        hset: () => commands,
        hdel: () => commands,
        zadd: () => commands,
        zrem: () => commands,
        exec: () =>
          new Promise((resolve) => {
            releaseCommand = () => {
              order.push("command-landed");
              resolve(null);
            };
          }),
      };
      return commands;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:flush-barrier:",
    redisClient: fakeRedis,
    pendingOperationTimeoutMs: 200,
    writeRetry: { maxAttempts: 1 },
  });

  try {
    store.registerSession(createSession("session-barrier"));
    // Past the attempt cap: the CALLER has been answered and the entry is out
    // of `pendingOperations`, while the command is still running. That is the
    // exact window `flush` used to slip through.
    await new Promise((resolve) => setTimeout(resolve, 260));

    const flushed = store.flush?.().then(() => {
      order.push("flush-returned");
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(order, [], "flush must not return under a live command");

    (releaseCommand as (() => void) | null)?.();
    await flushed;
    assert.deepEqual(order, ["command-landed", "flush-returned"]);
  } finally {
    (releaseCommand as (() => void) | null)?.();
    await store.close();
  }
});

test("redis runtime store flush reports a barrier it could not hold", async () => {
  // Resolving on the bound would say the barrier held when it had not, and the
  // caller goes straight on to read or broadcast from an index the write never
  // reached — the very failure `flush` exists to prevent (#242 review).
  let releaseCommand: (() => void) | null = null;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    multi() {
      const commands = {
        sadd: () => commands,
        srem: () => commands,
        del: () => commands,
        hset: () => commands,
        hdel: () => commands,
        zadd: () => commands,
        zrem: () => commands,
        exec: () =>
          new Promise((resolve) => {
            releaseCommand = () => resolve(null);
          }),
      };
      return commands;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:flush-reject:",
    redisClient: fakeRedis,
    pendingOperationTimeoutMs: 40,
    writeRetry: { maxAttempts: 1 },
  });

  try {
    store.registerSession(createSession("session-barrier-fail"));
    // Past the attempt cap, so the caller has been answered while the command
    // runs on and the key is still held.
    await new Promise((resolve) => setTimeout(resolve, 60));

    await assert.rejects(async () => {
      await store.flush?.();
    }, /flush timed out before the session keys were released/);
  } finally {
    (releaseCommand as (() => void) | null)?.();
    await store.close();
  }
});

test("redis runtime store does not let one session's removal supersede another's", async () => {
  // `REMOVE_MEMBER_LUA` is guarded on `session.id`, so a removal for a
  // DIFFERENT session succeeds by doing nothing. Sharing a queue key let it
  // supersede a still-retrying removal for the session that actually holds the
  // binding — which then stayed, with no retention clock armed (#242 review).
  const evalSessions: string[] = [];
  let attempts = 0;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    async eval(
      _script: string,
      numKeys: number,
      ...args: Array<string | number>
    ) {
      attempts += 1;
      // ARGV[2] is the guarding session id: KEYS come first, then memberId.
      evalSessions.push(String(args[numKeys + 1]));
      // The holder's first attempt fails, so its retry is what a shared key
      // would have let the other session's removal cancel.
      if (attempts === 1) {
        throw new Error("remove member write failed");
      }
      return 1;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:remove-key:",
    redisClient: fakeRedis,
    // Long enough that the holder is still waiting to retry when the other
    // session's removal is queued.
    writeRetry: { maxAttempts: 3, initialRetryDelayMs: 30 },
  });

  try {
    const holder = createSession("session-holder");
    const stale = createSession("session-stale");
    const holderRemoval = store.removeMember("ROOMRK", "member-rk", holder);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const staleRemoval = store.removeMember("ROOMRK", "member-rk", stale);

    await staleRemoval.durable;
    await holderRemoval.durable;

    assert.ok(
      evalSessions.includes("session-holder"),
      `the holder's removal must have been retried, saw ${evalSessions.join()}`,
    );
    assert.equal(
      evalSessions.filter((id) => id === "session-holder").length,
      2,
      "the holder's retry ran",
    );
  } finally {
    await store.close();
  }
});

test("redis runtime store counts an unanswered generation read against capacity", async () => {
  // Tracking it only for draining let a join whose generation read timed out
  // release its pending slot and start another read every timeout window, past
  // the configured cap without limit (#242 review).
  let releaseRead: (() => void) | null = null;
  let reads = 0;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    get() {
      reads += 1;
      return new Promise<string | null>((resolve) => {
        releaseRead = () => resolve("gen-1");
      });
    },
    async hgetall() {
      return {};
    },
    async eval() {
      return 1;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:read-capacity:",
    redisClient: fakeRedis,
    maxPendingOperations: 1,
    pendingOperationTimeoutMs: 20,
    writeRetry: { maxAttempts: 1 },
  });

  try {
    const first = store.markSessionJoinedRoom("session-r1", "ROOMR1");
    await assert.rejects(first, /Timed out reading the generation/);
    assert.equal(reads, 1);

    // The read is still out there, so the slot it occupies is not free.
    assert.throws(
      () => store.markSessionJoinedRoom("session-r2", "ROOMR2"),
      /backpressure/,
    );
    assert.equal(reads, 1, "and no second read was started");
  } finally {
    (releaseRead as (() => void) | null)?.();
    await store.close();
  }
});

test("redis runtime store flush waiters do not consume command capacity", async () => {
  // Routing the barrier through the command tracker made every concurrent
  // `flush` register as another unanswered command, so one slow write could be
  // amplified by its waiters until unrelated writes hit backpressure (#242
  // review).
  let releaseCommand: (() => void) | null = null;
  const fakeRedis = {
    ...createFakeRedisClient([]),
    multi() {
      const commands = {
        sadd: () => commands,
        srem: () => commands,
        del: () => commands,
        hset: () => commands,
        hdel: () => commands,
        zadd: () => commands,
        zrem: () => commands,
        exec: () =>
          new Promise((resolve) => {
            releaseCommand = () => resolve(null);
          }),
      };
      return commands;
    },
  };

  const store = await createRedisRuntimeStore("redis://unused", {
    keyPrefix: "bsp:test:flush-capacity:",
    redisClient: fakeRedis,
    maxPendingOperations: 4,
    pendingOperationTimeoutMs: 120,
    writeRetry: { maxAttempts: 1 },
  });

  try {
    store.registerSession(createSession("session-slow"));
    // Past the attempt cap, so `flush` gets past its `pendingOperations` wait
    // and reaches the key-release barrier — the part under test.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Ten callers waiting on the same drain. Only ONE Redis command exists.
    const waiters = Array.from({ length: 10 }, () => {
      const flushed = store.flush?.();
      flushed?.catch(() => undefined);
      return flushed;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Capacity must reflect the one real command, not its ten waiters.
    assert.doesNotThrow(() => {
      store.registerSession(createSession("session-unrelated"));
    }, "flush waiters must not consume command capacity");

    (releaseCommand as (() => void) | null)?.();
    await Promise.allSettled(waiters);
  } finally {
    (releaseCommand as (() => void) | null)?.();
    await store.close();
  }
});
