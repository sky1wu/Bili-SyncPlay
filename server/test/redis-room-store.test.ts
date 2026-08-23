import assert from "node:assert/strict";
import test from "node:test";
import { Redis, ReplyError } from "ioredis";
import {
  createRedisRoomStore,
  expiryScore,
  type RedisRoomStoreClient,
} from "../src/redis-room-store.js";

const REDIS_URL = process.env.REDIS_URL;

type Store = Awaited<ReturnType<typeof createRedisRoomStore>>;
type Sweep = Awaited<ReturnType<Store["deleteExpiredRooms"]>>;

/**
 * A setup barrier for tests that mutate the room index through a second Redis
 * connection. The store starts its bootstrap reconcile in the background, so
 * constructing drift before this resolves makes the fixture race that pass.
 */
async function settleRoomIndexBootstrap(store: Store): Promise<void> {
  await store.reconcileRoomIndex();
}

async function acknowledgeOrphanClaims(
  store: Store,
  sweep: Sweep,
): Promise<void> {
  assert.ok(store.acknowledgeOrphanedIndexClaims);
  assert.ok(sweep.orphanedIndexClaims);
  await store.acknowledgeOrphanedIndexClaims(sweep.orphanedIndexClaims);
}

function orphanClaimKeys(namespace: string): {
  hash: string;
  queue: string;
} {
  return {
    hash: `${namespace}:room-index-orphans`,
    queue: `${namespace}:room-index-orphans-queue`,
  };
}

async function seedOrphanClaims(
  redis: Redis,
  namespace: string,
  claims: readonly { code: string; token: string }[],
): Promise<void> {
  const keys = orphanClaimKeys(namespace);
  await redis.hset(
    keys.hash,
    ...claims.flatMap(({ code, token }) => [code, token]),
  );
  const pipeline = redis.pipeline();
  claims.forEach(({ code }, index) => {
    pipeline.zadd(keys.queue, index + 1, code);
  });
  pipeline.zadd(keys.queue, claims.length, "!sequence");
  await pipeline.exec();
}

function uniqueNamespace(label: string): string {
  return `bsp-test-${label}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

async function connect(): Promise<Redis> {
  const redis = new Redis(REDIS_URL as string, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();
  return redis;
}

function createFakeRoomStoreRedis(
  quit: () => Promise<unknown>,
  commands: Partial<Pick<RedisRoomStoreClient, "get" | "zrange">> = {},
): {
  client: RedisRoomStoreClient;
  disconnectCalls: () => number;
} {
  let disconnectCalls = 0;
  return {
    client: {
      connect: async () => undefined,
      quit,
      disconnect: () => {
        disconnectCalls += 1;
      },
      get: commands.get ?? (async () => null),
      scan: async () => ["0", []],
      zscan: async () => ["0", []],
      zscore: async () => null,
      eval: async () => null,
      zrange: commands.zrange ?? (async () => []),
      zrangebyscore: async () => [],
      zcard: async () => 0,
      zcount: async () => 0,
      ping: async () => "PONG",
    },
    disconnectCalls: () => disconnectCalls,
  };
}

test("redis room store close gives up on a Redis that never answers QUIT, and says so", async () => {
  const redis = createFakeRoomStoreRedis(() => new Promise(() => undefined));
  const unfinished: Array<{ quitOutcome: string; budgetMs: number }> = [];
  const store = await createRedisRoomStore("redis://unused", {
    redisClient: redis.client,
    closeQuitTimeoutMs: 20,
    onCloseUnfinished: (info) => {
      unfinished.push(info);
    },
  });

  const startedAt = Date.now();
  await store.close();
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(redis.disconnectCalls(), 1);
  assert.deepEqual(unfinished, [{ quitOutcome: "timed_out", budgetMs: 20 }]);
});

function legacyRoomBody(
  code: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    code,
    joinToken: "join-token-123456",
    createdAt: 50,
    ownerMemberId: null,
    ownerDisplayName: null,
    sharedVideo: null,
    playback: null,
    version: 0,
    lastActiveAt: 60,
    expiresAt: null,
    ...overrides,
  });
}

const LIST_ALL = {
  keyword: undefined,
  includeExpired: true,
  page: 1,
  pageSize: 50,
  sortBy: "lastActiveAt",
  sortOrder: "desc",
} as const;

test("redis room store scores non-expiring rooms at +inf and expiring ones at their expiry", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("score");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const room = await store.createRoom({
      code: "SCORE1",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    // A brand new room never expires, so it sits above every timestamp and can
    // never be picked up as a reaper candidate.
    assert.equal(await redis.zscore(roomsKey, room.code), "inf");

    const expiring = await store.updateRoom(room.code, room.version, {
      expiresAt: 900,
      lastActiveAt: 800,
    });
    assert.equal(expiring.ok, true);
    assert.equal(await redis.zscore(roomsKey, room.code), "900");

    if (!expiring.ok) {
      throw new Error("Expected update to succeed.");
    }
    const revived = await store.updateRoom(room.code, expiring.room.version, {
      expiresAt: null,
      lastActiveAt: 850,
    });
    assert.equal(revived.ok, true);
    assert.equal(await redis.zscore(roomsKey, room.code), "inf");

    if (!revived.ok) {
      throw new Error("Expected revive to succeed.");
    }
    const reexpired = await store.updateRoom(room.code, revived.room.version, {
      expiresAt: 1_500,
      lastActiveAt: 900,
    });
    assert.equal(reexpired.ok, true);
    assert.equal(await redis.zscore(roomsKey, room.code), "1500");
  } finally {
    await redis.del(`${namespace}:room:SCORE1`);
    await redis.del(roomsKey);
    await redis.quit();
    await store.close();
  }
});

test("redis room reaper deletes expired rooms and drops their membership", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("reap");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const room = await store.createRoom({
      code: "REAP01",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    const expiring = await store.updateRoom(room.code, room.version, {
      expiresAt: 10,
      lastActiveAt: 2,
    });
    assert.equal(expiring.ok, true);

    assert.equal(
      (await store.deleteExpiredRooms(10)).deletedRoomCodes.length,
      1,
    );
    assert.equal(await store.getRoom(room.code), null);
    assert.equal(await redis.zscore(roomsKey, room.code), null);
    assert.equal(await store.countRooms({ includeExpired: true }), 0);
  } finally {
    await redis.del(roomsKey);
    await redis.quit();
    await store.close();
  }
});

test("redis room reaper rescores rather than deletes a room whose expiry was cleared", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("revive");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const room = await store.createRoom({
      code: "REVIVE",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    // Stale low score against a body that no longer expires: the reaper picks
    // it up as a candidate and must repair it instead of deleting the room.
    await redis.zadd(roomsKey, "10", room.code);

    assert.equal(
      (await store.deleteExpiredRooms(10)).deletedRoomCodes.length,
      0,
    );
    assert.ok(await store.getRoom(room.code));
    assert.equal(await redis.zscore(roomsKey, room.code), "inf");
  } finally {
    await redis.del(`${namespace}:room:REVIVE`);
    await redis.del(roomsKey);
    await redis.quit();
    await store.close();
  }
});

test("redis room store migrates a database that predates the sorted set", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("migrate");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const redis = await connect();

  let store: Store | null = null;
  try {
    // Room bodies with no membership at all, as every database looks before
    // this set exists. Reads must not report them missing.
    await redis.set(`${namespace}:room:OLDONE`, legacyRoomBody("OLDONE"));
    await redis.set(
      `${namespace}:room:OLDTWO`,
      legacyRoomBody("OLDTWO", { expiresAt: 70, lastActiveAt: 65 }),
    );
    assert.equal(await redis.exists(roomsKey), 0);

    store = await createRedisRoomStore(REDIS_URL, { namespace });

    const rooms = await store.listRooms(LIST_ALL);
    assert.deepEqual(rooms.map((listed) => listed.code).sort(), [
      "OLDONE",
      "OLDTWO",
    ]);
    assert.equal(await redis.zscore(roomsKey, "OLDONE"), "inf");
    // The expiring one is now reapable, which it was not before migration.
    assert.equal(await redis.zscore(roomsKey, "OLDTWO"), "70");
    assert.equal(await store.countRooms({ includeExpired: true }), 2);
    assert.equal(await store.countRooms({ includeExpired: false }), 1);
    assert.equal(
      (await store.deleteExpiredRooms(100)).deletedRoomCodes.length,
      1,
    );
  } finally {
    await redis.del(
      `${namespace}:room:OLDONE`,
      `${namespace}:room:OLDTWO`,
      roomsKey,
    );
    await redis.quit();
    await store?.close();
  }
});

test("redis room store migration escapes glob metacharacters in the namespace", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  // Square brackets are a Redis glob character class, so an unescaped
  // SCAN MATCH would match nothing here and silently skip the migration.
  const namespace = uniqueNamespace("glob[x]");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const redis = await connect();

  let store: Store | null = null;
  try {
    await redis.set(`${namespace}:room:BRACKT`, legacyRoomBody("BRACKT"));

    store = await createRedisRoomStore(REDIS_URL, { namespace });
    const rooms = await store.listRooms(LIST_ALL);

    assert.deepEqual(
      rooms.map((listed) => listed.code),
      ["BRACKT"],
    );
  } finally {
    await redis.del(`${namespace}:room:BRACKT`, roomsKey);
    await redis.quit();
    await store?.close();
  }
});

test("redis room store reconcile does not replay a stale body snapshot", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("snapshot");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const redis = await connect();

  let store: Store | null = null;
  try {
    await redis.set(`${namespace}:room:RACING`, legacyRoomBody("RACING"));
    store = await createRedisRoomStore(REDIS_URL, { namespace });
    await store.listRooms(LIST_ALL);

    const current = await store.getRoom("RACING");
    assert.ok(current);
    const updated = await store.updateRoom("RACING", current.version, {
      expiresAt: 4_000,
      lastActiveAt: 200,
    });
    assert.equal(updated.ok, true);
    assert.equal(await redis.zscore(roomsKey, "RACING"), "4000");

    // A reconcile that runs later must take the score from the body as it is
    // now, never from a snapshot read before that update landed — restoring
    // "+inf" here would make the room unreapable forever.
    await redis.del(roomsKey);
    await store.close();
    store = await createRedisRoomStore(REDIS_URL, { namespace });
    await store.listRooms(LIST_ALL);
    assert.equal(await redis.zscore(roomsKey, "RACING"), "4000");
  } finally {
    await redis.del(`${namespace}:room:RACING`, roomsKey);
    await redis.quit();
    await store?.close();
  }
});

test("redis room listing prunes members whose room body is gone", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("orphan");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const orphanKeys = orphanClaimKeys(namespace);
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const room = await store.createRoom({
      code: "LIVE01",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    await redis.zadd(roomsKey, "+inf", "GHOST1");
    assert.equal(await redis.zcard(roomsKey), 2);

    const rooms = await store.listRooms(LIST_ALL);

    assert.deepEqual(
      rooms.map((listed) => listed.code),
      [room.code],
    );
    assert.equal(await redis.zscore(roomsKey, "GHOST1"), null);
    // Removing the member keeps listing/counting accurate, but must not consume
    // the runtime-cleanup debt that only the reaper's caller can settle.
    const swept = await store.deleteExpiredRooms(0);
    assert.deepEqual(swept.orphanedIndexCodes, ["GHOST1"]);
    assert.deepEqual(swept.deletedRoomCodes, []);
    assert.ok(await redis.hget(orphanKeys.hash, "GHOST1"));
    assert.ok(await redis.zscore(orphanKeys.queue, "GHOST1"));
    await acknowledgeOrphanClaims(store, swept);
    assert.equal(await redis.hlen(orphanKeys.hash), 0);
    assert.equal(await redis.zscore(orphanKeys.queue, "GHOST1"), null);
  } finally {
    await redis.del(`${namespace}:room:LIVE01`);
    await redis.del(roomsKey, orphanKeys.hash, orphanKeys.queue);
    await redis.quit();
    await store.close();
  }
});

test("redis room orphan prune keeps the index member when its cleanup handoff fails", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("orphanhandoff");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const orphanKeys = orphanClaimKeys(namespace);
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    await settleRoomIndexBootstrap(store);
    await redis.zadd(roomsKey, "+inf", "GHOST2");
    // HGET now raises WRONGTYPE. The handoff must be attempted before the
    // member is removed so a later pass still has a retry trail.
    await redis.set(orphanKeys.hash, "wrong type");

    assert.deepEqual(await store.listRooms(LIST_ALL), []);
    assert.equal(await redis.zscore(roomsKey, "GHOST2"), "inf");

    // The rotating queue is equally required. Its WRONGTYPE failure must also
    // retain the index member instead of stranding a hash-only claim.
    await redis.del(orphanKeys.hash);
    await redis.set(orphanKeys.queue, "wrong type");
    assert.deepEqual(await store.listRooms(LIST_ALL), []);
    assert.equal(await redis.zscore(roomsKey, "GHOST2"), "inf");

    // Once both handoff keys are writable, the same listing retries the prune
    // and the next reaper sweep receives the code.
    await redis.del(orphanKeys.queue);
    assert.deepEqual(await store.listRooms(LIST_ALL), []);
    assert.equal(await redis.zscore(roomsKey, "GHOST2"), null);
    const swept = await store.deleteExpiredRooms(0);
    assert.deepEqual(swept.orphanedIndexCodes, ["GHOST2"]);
    await acknowledgeOrphanClaims(store, swept);
  } finally {
    await redis.del(roomsKey, orphanKeys.hash, orphanKeys.queue);
    await redis.quit();
    await store.close();
  }
});

test("redis room reaper validates the orphan handoff before deleting any room", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("reaperhandoff");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const orphanKeys = orphanClaimKeys(namespace);
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    await settleRoomIndexBootstrap(store);
    const room = await store.createRoom({
      code: "EARLY1",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    const expiring = await store.updateRoom(room.code, room.version, {
      expiresAt: 10,
    });
    assert.equal(expiring.ok, true);
    await redis.zadd(roomsKey, 20, "ZZORPH");
    await redis.zadd(orphanKeys.queue, 0, "!sequence");
    await redis.set(orphanKeys.hash, "wrong type");

    // EARLY1 sorts before the orphan. Without a sweep-wide preflight the Lua
    // script deletes it, then hits WRONGTYPE while staging ZZORPH; the caller
    // receives no deletedCodes and runtime teardown loses its only trail.
    await assert.rejects(store.deleteExpiredRooms(100), /WRONGTYPE/);
    assert.ok(await redis.get(`${namespace}:room:EARLY1`));
    assert.equal(await redis.zscore(roomsKey, "EARLY1"), "10");
    assert.equal(await redis.zscore(roomsKey, "ZZORPH"), "20");

    await redis.del(orphanKeys.hash);
    const swept = await store.deleteExpiredRooms(100);
    assert.deepEqual(swept.deletedRoomCodes, ["EARLY1"]);
    assert.deepEqual(swept.orphanedIndexCodes, ["ZZORPH"]);
    await acknowledgeOrphanClaims(store, swept);
  } finally {
    await redis.del(
      `${namespace}:room:EARLY1`,
      roomsKey,
      orphanKeys.hash,
      orphanKeys.queue,
    );
    await redis.quit();
    await store.close();
  }
});

test("redis room reconcile sweeps orphans again when the reconciler drives it", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("resweep");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const orphanKeys = orphanClaimKeys(namespace);
  let clock = 1_000_000;
  const store = await createRedisRoomStore(REDIS_URL, {
    namespace,
    now: () => clock,
  });
  const redis = await connect();

  try {
    assert.equal(await store.countRooms({ includeExpired: true }), 0);

    // Stands in for a node still on an older build reaping a room without
    // touching this set, after this process already reconciled.
    await redis.zadd(roomsKey, "+inf", "LATEGH");
    assert.equal(await store.countRooms({ includeExpired: true }), 1);

    // No amount of elapsed time makes a read reconcile any more: the pass used
    // to be triggered by whichever read first arrived after a cooldown lapsed,
    // which charged one unlucky caller per interval for a keyspace walk and
    // hid the cost under that caller's metric label.
    clock += 900_000 * 4;
    assert.equal(await store.countRooms({ includeExpired: true }), 1);
    assert.equal(await redis.zcard(roomsKey), 1);

    // createRoomIndexReconciler calls exactly this on its own timer.
    await store.reconcileRoomIndex();
    assert.equal(await store.countRooms({ includeExpired: true }), 0);
    assert.equal(await redis.zcard(roomsKey), 0);
    const swept = await store.deleteExpiredRooms(clock);
    assert.deepEqual(swept.orphanedIndexCodes, ["LATEGH"]);
    await acknowledgeOrphanClaims(store, swept);
  } finally {
    await redis.del(roomsKey, orphanKeys.hash, orphanKeys.queue);
    await redis.quit();
    await store.close();
  }
});

test("redis room store still reconciles once before answering the first read", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("bootstrapreconcile");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const redis = await connect();

  let store: Store | null = null;
  try {
    // A room body written before this index existed: the migration pass is the
    // only thing that can put it in the set, so a read that skipped waiting on
    // it would answer with the room missing.
    await redis.set(
      `${namespace}:room:OLDBLD`,
      legacyRoomBody("OLDBLD", { expiresAt: null, lastActiveAt: 5 }),
    );

    store = await createRedisRoomStore(REDIS_URL, { namespace });
    assert.equal(await store.countRooms({ includeExpired: true }), 1);
    assert.equal(await redis.zscore(roomsKey, "OLDBLD"), "inf");
  } finally {
    await redis.del(`${namespace}:room:OLDBLD`, roomsKey);
    await redis.quit();
    await store?.close();
  }
});

test("redis room bootstrap reconcile preserves orphan codes for the next reaper sweep", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("bootstraporphan");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const orphanKeys = orphanClaimKeys(namespace);
  const redis = await connect();

  let reconcilerStore: Store | null = null;
  let reaperStore: Store | null = null;
  try {
    // A body removed by an older build before this process starts. The
    // constructor's background reconcile wins the race in #258 and removes
    // the member before the reaper can see it.
    await redis.zadd(roomsKey, "+inf", "BOOTGH");
    reconcilerStore = await createRedisRoomStore(REDIS_URL, { namespace });
    await settleRoomIndexBootstrap(reconcilerStore);

    assert.equal(await redis.zscore(roomsKey, "BOOTGH"), null);
    // The standalone global-admin runs this reconcile but no reaper. Close that
    // store and let a separate room-serving process claim the shared handoff.
    await reconcilerStore.close();
    reconcilerStore = null;
    reaperStore = await createRedisRoomStore(REDIS_URL, { namespace });
    const first = await reaperStore.deleteExpiredRooms(0);
    assert.deepEqual(first.orphanedIndexCodes, ["BOOTGH"]);
    // Simulate the room process exiting after it received the claim but before
    // runtime teardown settled. The shared debt must survive for the next pass.
    await reaperStore.close();
    reaperStore = await createRedisRoomStore(REDIS_URL, { namespace });
    const retried = await reaperStore.deleteExpiredRooms(0);
    assert.deepEqual(retried.orphanedIndexCodes, ["BOOTGH"]);
    assert.deepEqual(retried.orphanedIndexClaims, first.orphanedIndexClaims);
    await acknowledgeOrphanClaims(reaperStore, retried);
    assert.deepEqual(
      (await reaperStore.deleteExpiredRooms(0)).orphanedIndexCodes,
      [],
    );
  } finally {
    await redis.del(roomsKey, orphanKeys.hash, orphanKeys.queue);
    await redis.quit();
    await reconcilerStore?.close();
    await reaperStore?.close();
  }
});

test("redis room reaper bounds the shared orphan handoff and skips a reused code", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("orphanbatch");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const orphanKeys = orphanClaimKeys(namespace);
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    await settleRoomIndexBootstrap(store);
    const orphanedCodes = Array.from(
      { length: 501 },
      (_, index) => `OR${index.toString().padStart(4, "0")}`,
    );
    await seedOrphanClaims(redis, namespace, [
      ...orphanedCodes.map((code) => ({ code, token: `claim-${code}` })),
      { code: "REUSED", token: "claim-reused" },
    ]);
    await store.createRoom({
      code: "REUSED",
      joinToken: "join-token-123456",
      createdAt: 1,
    });

    const deliveredCodes: string[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      const swept = await store.deleteExpiredRooms(0);
      assert.ok(swept.orphanedIndexCodes.length <= 500);
      deliveredCodes.push(...swept.orphanedIndexCodes);
      await acknowledgeOrphanClaims(store, swept);
      if ((await redis.hlen(orphanKeys.hash)) === 0) {
        break;
      }
    }
    assert.deepEqual(deliveredCodes.sort(), orphanedCodes);
    assert.equal(await redis.hlen(orphanKeys.hash), 0);
    assert.equal(await redis.zcard(orphanKeys.queue), 1);
    assert.ok(await store.getRoom("REUSED"));
  } finally {
    await redis.del(`${namespace}:room:REUSED`);
    await redis.del(roomsKey, orphanKeys.hash, orphanKeys.queue);
    await redis.quit();
    await store.close();
  }
});

test("redis room reaper keeps orphan claims behind corrupt room bodies", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("orphanbadbody");
  const orphanKeys = orphanClaimKeys(namespace);
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    await settleRoomIndexBootstrap(store);
    await seedOrphanClaims(redis, namespace, [
      { code: "BADTYP", token: "claim-wrong-type" },
      { code: "BADJSN", token: "claim-invalid-json" },
      { code: "BADSHAPE", token: "claim-invalid-shape" },
      { code: "REUSED", token: "claim-reused" },
    ]);
    await redis.hset(`${namespace}:room:BADTYP`, "field", "value");
    await redis.set(`${namespace}:room:BADJSN`, "{not valid json");
    await redis.set(
      `${namespace}:room:BADSHAPE`,
      legacyRoomBody("BADSHAPE", { joinToken: 123 }),
    );
    await store.createRoom({
      code: "REUSED",
      joinToken: "join-token-123456",
      createdAt: 1,
    });

    // Only a usable persisted room proves the code was recycled. Corruption
    // must keep rotating the debt until the bad body is repaired or removed.
    const blocked = await store.deleteExpiredRooms(0);
    assert.deepEqual(blocked.orphanedIndexCodes, []);
    assert.equal(
      await redis.hget(orphanKeys.hash, "BADTYP"),
      "claim-wrong-type",
    );
    assert.equal(
      await redis.hget(orphanKeys.hash, "BADJSN"),
      "claim-invalid-json",
    );
    assert.equal(
      await redis.hget(orphanKeys.hash, "BADSHAPE"),
      "claim-invalid-shape",
    );
    assert.equal(await redis.hget(orphanKeys.hash, "REUSED"), null);

    await redis.del(
      `${namespace}:room:BADTYP`,
      `${namespace}:room:BADJSN`,
      `${namespace}:room:BADSHAPE`,
    );
    const released = await store.deleteExpiredRooms(0);
    assert.deepEqual(released.orphanedIndexCodes.sort(), [
      "BADJSN",
      "BADSHAPE",
      "BADTYP",
    ]);
    await acknowledgeOrphanClaims(store, released);
    assert.equal(await redis.hlen(orphanKeys.hash), 0);
  } finally {
    await redis.del(`${namespace}:room:REUSED`);
    await redis.del(
      `${namespace}:room:BADTYP`,
      `${namespace}:room:BADJSN`,
      `${namespace}:room:BADSHAPE`,
      orphanKeys.hash,
      orphanKeys.queue,
    );
    await redis.quit();
    await store.close();
  }
});

test("redis room orphan acknowledgement cannot consume a newer claim", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("orphanack");
  const orphanKeys = orphanClaimKeys(namespace);
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const acknowledgeOrphanedIndexClaims = store.acknowledgeOrphanedIndexClaims;
  assert.ok(acknowledgeOrphanedIndexClaims);
  const redis = await connect();

  try {
    await settleRoomIndexBootstrap(store);
    await seedOrphanClaims(redis, namespace, [
      { code: "RECYC1", token: "new-claim" },
    ]);

    // A previous process can finish late after the code was reused and became
    // orphaned again. Its old token must not erase the new occurrence's debt.
    await acknowledgeOrphanedIndexClaims([
      { code: "RECYC1", token: "old-claim" },
    ]);
    assert.equal(await redis.hget(orphanKeys.hash, "RECYC1"), "new-claim");
    assert.ok(await redis.zscore(orphanKeys.queue, "RECYC1"));

    // A bad queue must be rejected before HDEL. Lua errors do not roll writes
    // back, so checking it after removing the hash entry would consume the
    // claim even though acknowledgement itself failed.
    await redis.del(orphanKeys.queue);
    await redis.set(orphanKeys.queue, "wrong type");
    await assert.rejects(
      acknowledgeOrphanedIndexClaims([{ code: "RECYC1", token: "new-claim" }]),
      /WRONGTYPE/,
    );
    assert.equal(await redis.hget(orphanKeys.hash, "RECYC1"), "new-claim");

    await redis.del(orphanKeys.queue);
    await redis.zadd(orphanKeys.queue, 1, "RECYC1");
    await acknowledgeOrphanedIndexClaims([
      { code: "RECYC1", token: "new-claim" },
    ]);
    assert.equal(await redis.hget(orphanKeys.hash, "RECYC1"), null);
    assert.equal(await redis.zscore(orphanKeys.queue, "RECYC1"), null);
  } finally {
    await redis.del(orphanKeys.hash, orphanKeys.queue);
    await redis.quit();
    await store.close();
  }
});

test("redis room listing sorts by createdAt without a keyspace scan", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("sort");
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    await store.createRoom({
      code: "OLDER1",
      joinToken: "join-token-123456",
      createdAt: 100,
    });
    await store.createRoom({
      code: "NEWER1",
      joinToken: "join-token-123456",
      createdAt: 200,
    });

    const descending = await store.listRooms({
      ...LIST_ALL,
      sortBy: "createdAt",
      sortOrder: "desc",
    });
    assert.deepEqual(
      descending.map((listed) => listed.code),
      ["NEWER1", "OLDER1"],
    );

    const ascending = await store.listRooms({
      ...LIST_ALL,
      sortBy: "createdAt",
      sortOrder: "asc",
    });
    assert.deepEqual(
      ascending.map((listed) => listed.code),
      ["OLDER1", "NEWER1"],
    );
  } finally {
    await redis.del(`${namespace}:room:OLDER1`);
    await redis.del(`${namespace}:room:NEWER1`);
    await redis.del(`${namespace}:rooms-by-expiry`);
    await redis.quit();
    await store.close();
  }
});

test("redis room update applies the patch, bumps version, and rejects stale writers", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("cas");
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const room = await store.createRoom({
      code: "CASRM1",
      joinToken: "join-token-123456",
      createdAt: 1,
    });

    const updated = await store.updateRoom(room.code, room.version, {
      expiresAt: 900,
      lastActiveAt: 800,
    });
    assert.equal(updated.ok, true);
    if (!updated.ok) {
      throw new Error("Expected update to succeed.");
    }
    assert.equal(updated.room.version, room.version + 1);
    assert.equal(updated.room.createdAt, 1);
    assert.deepEqual(await store.getRoom(room.code), updated.room);

    const stale = await store.updateRoom(room.code, room.version, {
      lastActiveAt: 999,
    });
    assert.equal(stale.ok, false);
    if (stale.ok) {
      throw new Error("Expected the stale update to be rejected.");
    }
    assert.equal(stale.reason, "version_conflict");
    assert.equal((await store.getRoom(room.code))?.lastActiveAt, 800);

    const missing = await store.updateRoom("NOSUCH", 0, { lastActiveAt: 1 });
    assert.equal(missing.ok, false);
    if (missing.ok) {
      throw new Error("Expected update of a missing room to be rejected.");
    }
    assert.equal(missing.reason, "not_found");
  } finally {
    await redis.del(`${namespace}:room:CASRM1`);
    await redis.del(`${namespace}:rooms-by-expiry`);
    await redis.quit();
    await store.close();
  }
});

test("redis room update preserves playback number precision", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("precision");
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const room = await store.createRoom({
      code: "PRECIS",
      joinToken: "join-token-123456",
      createdAt: 1,
    });

    // No script may re-encode the room body: Redis's cjson formats numbers
    // with %.14g, which rounds these away.
    const playback = {
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      currentTime: 1234.5678901234567,
      playState: "playing" as const,
      playbackRate: 1.25,
      updatedAt: 1783844580123,
      serverTime: 1783844580456,
      actorId: "member-1",
      seq: 9007199254740991,
    };
    const updated = await store.updateRoom(room.code, room.version, {
      playback,
      lastActiveAt: 1783844580456,
    });
    assert.equal(updated.ok, true);

    assert.deepEqual((await store.getRoom(room.code))?.playback, playback);
  } finally {
    await redis.del(`${namespace}:room:PRECIS`);
    await redis.del(`${namespace}:rooms-by-expiry`);
    await redis.quit();
    await store.close();
  }
});

test("redis room create leaves the winner untouched when a code collides", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("collide");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const winner = await store.createRoom({
      code: "COLLID",
      joinToken: "join-token-winner",
      createdAt: 1,
    });
    const expiring = await store.updateRoom(winner.code, winner.version, {
      expiresAt: 5_000,
      lastActiveAt: 100,
    });
    assert.equal(expiring.ok, true);

    await assert.rejects(() =>
      store.createRoom({
        code: "COLLID",
        joinToken: "join-token-loser",
        createdAt: 2,
      }),
    );

    // The losing create must not have rewritten the body or the score.
    assert.equal(
      (await store.getRoom("COLLID"))?.joinToken,
      "join-token-winner",
    );
    assert.equal(await redis.zscore(roomsKey, "COLLID"), "5000");
  } finally {
    await redis.del(`${namespace}:room:COLLID`);
    await redis.del(roomsKey);
    await redis.quit();
    await store.close();
  }
});

test("redis room count answers every filter from the sorted set alone", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("count");
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    await store.createRoom({
      code: "LIVEAA",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    const expiring = await store.createRoom({
      code: "GONEBB",
      joinToken: "join-token-123456",
      createdAt: 2,
    });
    const future = await store.createRoom({
      code: "LATERC",
      joinToken: "join-token-123456",
      createdAt: 3,
    });

    // Already past, so it must not count as non-expired.
    const expired = await store.updateRoom(expiring.code, expiring.version, {
      expiresAt: 1,
      lastActiveAt: 2,
    });
    assert.equal(expired.ok, true);
    // Far future, so it still counts.
    const pending = await store.updateRoom(future.code, future.version, {
      expiresAt: Date.now() + 3_600_000,
      lastActiveAt: 3,
    });
    assert.equal(pending.ok, true);

    assert.equal(await store.countRooms({ includeExpired: true }), 3);
    assert.equal(await store.countRooms({ includeExpired: false }), 2);
    assert.equal(
      await store.countRooms({ keyword: "gone", includeExpired: true }),
      1,
    );
    assert.equal(
      await store.countRooms({ keyword: "gone", includeExpired: false }),
      0,
    );
    assert.equal(
      await store.countRooms({ keyword: "zzz", includeExpired: true }),
      0,
    );

    // Counting and listing must agree.
    const listed = await store.listRooms({
      ...LIST_ALL,
      includeExpired: false,
    });
    assert.equal(listed.length, 2);
  } finally {
    await redis.del(`${namespace}:room:LIVEAA`);
    await redis.del(`${namespace}:room:GONEBB`);
    await redis.del(`${namespace}:room:LATERC`);
    await redis.del(`${namespace}:rooms-by-expiry`);
    await redis.quit();
    await store.close();
  }
});

test("redis room reaper waits for the migration pass before its first sweep", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("reapreconcile");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const redis = await connect();

  let store: Store | null = null;
  try {
    // A room body written by a node on an older build: no membership here, so
    // the reaper's own range query cannot see it. Nothing lists or counts in
    // this test — a deployment with no admin traffic and no metrics scrape
    // must still converge, or such a room lingers forever.
    await redis.set(
      `${namespace}:room:NOREAD`,
      legacyRoomBody("NOREAD", { expiresAt: 70, lastActiveAt: 65 }),
    );

    store = await createRedisRoomStore(REDIS_URL, { namespace });
    assert.equal(
      (await store.deleteExpiredRooms(100)).deletedRoomCodes.length,
      1,
    );
    assert.equal(await redis.exists(`${namespace}:room:NOREAD`), 0);
    assert.equal(await redis.zscore(roomsKey, "NOREAD"), null);
  } finally {
    await redis.del(`${namespace}:room:NOREAD`, roomsKey);
    await redis.quit();
    await store?.close();
  }
});

test("redis room reaper does not reconcile again after the migration pass", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("reapnoreconcile");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const redis = await connect();
  let clock = 1_000_000;

  let store: Store | null = null;
  try {
    store = await createRedisRoomStore(REDIS_URL, {
      namespace,
      now: () => clock,
    });
    // Settle the migration pass first, so what follows can only be a later one.
    assert.equal(
      (await store.deleteExpiredRooms(100)).deletedRoomCodes.length,
      0,
    );

    // Written straight to Redis afterwards, exactly as a node on an older
    // build would: expired, but with no membership for the reaper's range
    // query to find. A reaper tick that still reconciled would pick it up —
    // and pay for a keyspace walk to do so, which is the spike this change
    // removes from delete_expired_rooms.
    await redis.set(
      `${namespace}:room:LATEBD`,
      legacyRoomBody("LATEBD", { expiresAt: 70, lastActiveAt: 65 }),
    );

    // Well past the interval the pass used to be re-triggered on, so a tick
    // that still reconciled would be free to do so here.
    clock += 900_000 * 4;
    assert.equal(
      (await store.deleteExpiredRooms(100)).deletedRoomCodes.length,
      0,
    );
    assert.equal(await redis.exists(`${namespace}:room:LATEBD`), 1);

    // The reconciler's timer is what collects it, one tick later.
    await store.reconcileRoomIndex();
    assert.equal(
      (await store.deleteExpiredRooms(100)).deletedRoomCodes.length,
      1,
    );
    assert.equal(await redis.exists(`${namespace}:room:LATEBD`), 0);
  } finally {
    await redis.del(`${namespace}:room:LATEBD`, roomsKey);
    await redis.quit();
    await store?.close();
  }
});

test("redis room expiry score matches exactly what ZSCORE reads back", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("scorefmt");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const room = await store.createRoom({
      code: "FMTCHK",
      joinToken: "join-token-123456",
      createdAt: 1,
    });

    // The reconcile decides whether a member has drifted by comparing the
    // stored score against expiryScore() as strings. Emitting "+inf" while
    // Redis reads back "inf" made every non-expiring room — the common case —
    // compare as drifted forever, so the pass rewrote every room on every run
    // instead of writing nothing. Redis normalising the value is exactly why
    // this has to be asserted against a real ZSCORE rather than assumed.
    assert.equal(await redis.zscore(roomsKey, room.code), expiryScore(room));

    const expiring = await store.updateRoom(room.code, room.version, {
      expiresAt: 1783844580123,
      lastActiveAt: 800,
    });
    assert.equal(expiring.ok, true);
    if (!expiring.ok) {
      throw new Error("Expected update to succeed.");
    }
    assert.equal(
      await redis.zscore(roomsKey, room.code),
      expiryScore(expiring.room),
    );
  } finally {
    await redis.del(`${namespace}:room:FMTCHK`);
    await redis.del(roomsKey);
    await redis.quit();
    await store.close();
  }
});

test("redis room store keeps working when one room body is corrupt", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("corrupt");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const redis = await connect();

  let store: Store | null = null;
  try {
    await redis.set(`${namespace}:room:BROKEN`, "{not valid json");
    await redis.set(
      `${namespace}:room:GOODEX`,
      legacyRoomBody("GOODEX", { expiresAt: 70, lastActiveAt: 65 }),
    );

    store = await createRedisRoomStore(REDIS_URL, { namespace });

    // A single unparseable value must not stop the reconcile, the listing, or
    // — most importantly — the reaper that now waits on that reconcile.
    const rooms = await store.listRooms(LIST_ALL);
    assert.deepEqual(
      rooms.map((listed) => listed.code),
      ["GOODEX"],
    );
    assert.equal(
      (await store.deleteExpiredRooms(100)).deletedRoomCodes.length,
      1,
    );
    assert.equal(await redis.exists(`${namespace}:room:GOODEX`), 0);

    // The corrupt body is left alone rather than silently dropped.
    assert.equal(await redis.exists(`${namespace}:room:BROKEN`), 1);
  } finally {
    await redis.del(
      `${namespace}:room:BROKEN`,
      `${namespace}:room:GOODEX`,
      roomsKey,
    );
    await redis.quit();
    await store?.close();
  }
});

test("redis room create leaves no room body behind when indexing fails", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("createfail");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    // Wrong type for the set: SET NX succeeds, the ZADD then fails, and Lua
    // does not roll back on its own. room-service reads any create error as a
    // code collision and retries five times, so without the rollback one
    // request would strand five unreachable rooms.
    await redis.set(roomsKey, "not-a-sorted-set");

    await assert.rejects(() =>
      store.createRoom({
        code: "ORPHAN",
        joinToken: "join-token-123456",
        createdAt: 1,
      }),
    );
    assert.equal(await redis.exists(`${namespace}:room:ORPHAN`), 0);
  } finally {
    await redis.del(`${namespace}:room:ORPHAN`, roomsKey);
    await redis.quit();
    await store.close();
  }
});

test("redis room store skips bodies whose fields are the wrong shape", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("badshape");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const redis = await connect();

  let store: Store | null = null;
  try {
    // Valid JSON, unusable fields. expiryScore() would hand Redis "bad" as a
    // score, the reconcile's ZADD would fail, and because the reaper waits on
    // that reconcile and a failure skips the cooldown, every other expired
    // room would stop being collected.
    await redis.set(
      `${namespace}:room:BADEXP`,
      legacyRoomBody("BADEXP", { expiresAt: "bad" }),
    );
    await redis.set(
      `${namespace}:room:BADVER`,
      legacyRoomBody("BADVER", { version: "one" }),
    );
    await redis.set(
      `${namespace}:room:GOODEX`,
      legacyRoomBody("GOODEX", { expiresAt: 70, lastActiveAt: 65 }),
    );

    store = await createRedisRoomStore(REDIS_URL, { namespace });

    const rooms = await store.listRooms(LIST_ALL);
    assert.deepEqual(
      rooms.map((listed) => listed.code),
      ["GOODEX"],
    );
    assert.equal(
      (await store.deleteExpiredRooms(100)).deletedRoomCodes.length,
      1,
    );
    assert.equal(await redis.exists(`${namespace}:room:GOODEX`), 0);

    // The unusable bodies are left alone, not silently destroyed.
    assert.equal(await redis.exists(`${namespace}:room:BADEXP`), 1);
    assert.equal(await redis.exists(`${namespace}:room:BADVER`), 1);
  } finally {
    await redis.del(
      `${namespace}:room:BADEXP`,
      `${namespace}:room:BADVER`,
      `${namespace}:room:GOODEX`,
      roomsKey,
    );
    await redis.quit();
    await store?.close();
  }
});

test("redis room point reads reject parseable bodies that are not this room", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("pointvalidation");
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();
  const key = `${namespace}:room:BADONE`;

  try {
    await settleRoomIndexBootstrap(store);
    await redis.set(key, "{}");
    await assert.rejects(
      store.getRoom("BADONE"),
      /Room BADONE contains an invalid room body/,
    );

    await redis.set(key, legacyRoomBody("BADONE", { joinToken: 123 }));
    await assert.rejects(
      store.getRoom("BADONE"),
      /Room BADONE contains an invalid room body/,
    );

    await redis.set(key, legacyRoomBody("OTHER1"));
    await assert.rejects(
      store.getRoom("BADONE"),
      /Room BADONE contains an invalid room body/,
    );
  } finally {
    await redis.del(key);
    await redis.quit();
    await store.close();
  }
});

test("redis room reaper survives a body corrupted into a JSON scalar", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("scalar");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const doomed = await store.createRoom({
      code: "SCALAR",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    const expiring = await store.updateRoom(doomed.code, doomed.version, {
      expiresAt: 10,
      lastActiveAt: 2,
    });
    assert.equal(expiring.ok, true);

    // Valid JSON, but a scalar. cjson.decode returns a truthy number, and
    // indexing it raises a Lua error that aborts the reaper before it reaches
    // any other candidate — the member stays a candidate forever, so every
    // expired room ordered after it stops being collected too.
    await redis.set(`${namespace}:room:SCALAR`, "1");
    // A genuinely expired room that must still be collected.
    await redis.set(
      `${namespace}:room:VICTIM`,
      legacyRoomBody("VICTIM", { expiresAt: 20, lastActiveAt: 5 }),
    );
    await redis.zadd(roomsKey, "20", "VICTIM");

    assert.equal(
      (await store.deleteExpiredRooms(100)).deletedRoomCodes.length,
      1,
    );
    assert.equal(await redis.exists(`${namespace}:room:VICTIM`), 0);
    // The scalar body is left alone rather than deleted on a guess.
    assert.equal(await redis.exists(`${namespace}:room:SCALAR`), 1);
  } finally {
    await redis.del(
      `${namespace}:room:SCALAR`,
      `${namespace}:room:VICTIM`,
      roomsKey,
    );
    await redis.quit();
    await store.close();
  }
});

test("redis room count and listing agree about an unreadable room body", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("quarantine");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const orphanKeys = orphanClaimKeys(namespace);
  let clock = 1_000_000;
  const store = await createRedisRoomStore(REDIS_URL, {
    namespace,
    now: () => clock,
  });
  const redis = await connect();

  try {
    await store.createRoom({
      code: "STAYOK",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    const doomed = await store.createRoom({
      code: "ROTTEN",
      joinToken: "join-token-123456",
      createdAt: 2,
    });
    assert.equal(await store.countRooms({ includeExpired: true }), 2);

    // An indexed room whose body later becomes unreadable. Enumeration skips
    // it, so leaving it in the set makes ZCARD report a row listRooms will
    // never return — the admin table's total exceeds the page it can render.
    await redis.set(`${namespace}:room:${doomed.code}`, "{not valid json");

    const listed = await store.listRooms(LIST_ALL);
    assert.deepEqual(
      listed.map((room) => room.code),
      ["STAYOK"],
    );
    assert.equal(await store.countRooms({ includeExpired: true }), 1);
    assert.equal(await redis.zscore(roomsKey, "ROTTEN"), null);
    assert.ok(await redis.hget(orphanKeys.hash, "ROTTEN"));
    assert.ok(await redis.zscore(orphanKeys.queue, "ROTTEN"));

    // The body is kept: it cannot be interpreted, so deleting it would be a
    // guess. Its deferred claim must not run while that bad body still exists.
    assert.equal(await redis.exists(`${namespace}:room:ROTTEN`), 1);
    assert.deepEqual(
      (await store.deleteExpiredRooms(clock)).orphanedIndexCodes,
      [],
    );
    clock += 900_000;
    assert.equal(await store.countRooms({ includeExpired: true }), 1);

    // Once an operator removes the corrupt body, the deferred claim becomes
    // deliverable even though quarantine already removed the main index.
    await redis.del(`${namespace}:room:ROTTEN`);
    const released = await store.deleteExpiredRooms(clock);
    assert.deepEqual(released.orphanedIndexCodes, ["ROTTEN"]);
    await acknowledgeOrphanClaims(store, released);
  } finally {
    await redis.del(
      `${namespace}:room:STAYOK`,
      `${namespace}:room:ROTTEN`,
      roomsKey,
      orphanKeys.hash,
      orphanKeys.queue,
    );
    await redis.quit();
    await store.close();
  }
});

test("redis room store isolates a room key of the wrong type", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("wrongtype");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const orphanKeys = orphanClaimKeys(namespace);
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    await store.createRoom({
      code: "OKROOM",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    const doomed = await store.createRoom({
      code: "WRONGT",
      joinToken: "join-token-123456",
      createdAt: 2,
    });
    const victim = await store.createRoom({
      code: "EXPIRE",
      joinToken: "join-token-123456",
      createdAt: 3,
    });
    const expiring = await store.updateRoom(victim.code, victim.version, {
      expiresAt: 10,
      lastActiveAt: 3,
    });
    assert.equal(expiring.ok, true);

    // Corruption or a namespace collision leaves a room key that is not a
    // string. GET raises WRONGTYPE, and reading a batch as one Promise.all
    // would reject the whole reconcile — which the reaper waits on, so every
    // other expired room would stop being collected.
    await redis.del(`${namespace}:room:${doomed.code}`);
    await redis.hset(`${namespace}:room:${doomed.code}`, "field", "value");
    // Make it a reaper candidate too, so the Lua path is exercised.
    await redis.zadd(roomsKey, "5", doomed.code);

    const listed = await store.listRooms(LIST_ALL);
    assert.deepEqual(listed.map((room) => room.code).sort(), [
      "EXPIRE",
      "OKROOM",
    ]);
    assert.equal(await store.countRooms({ includeExpired: true }), 2);
    assert.equal(await redis.zscore(roomsKey, doomed.code), null);
    assert.ok(await redis.hget(orphanKeys.hash, doomed.code));

    // The genuinely expired room is still collected.
    const blocked = await store.deleteExpiredRooms(100);
    assert.equal(blocked.deletedRoomCodes.length, 1);
    assert.deepEqual(blocked.orphanedIndexCodes, []);
    assert.equal(await redis.exists(`${namespace}:room:EXPIRE`), 0);
    // The wrong-type key itself is left alone rather than destroyed.
    assert.equal(await redis.exists(`${namespace}:room:WRONGT`), 1);

    await redis.del(`${namespace}:room:WRONGT`);
    const released = await store.deleteExpiredRooms(100);
    assert.deepEqual(released.orphanedIndexCodes, ["WRONGT"]);
    await acknowledgeOrphanClaims(store, released);
  } finally {
    await redis.del(
      `${namespace}:room:OKROOM`,
      `${namespace}:room:WRONGT`,
      `${namespace}:room:EXPIRE`,
      roomsKey,
      orphanKeys.hash,
      orphanKeys.queue,
    );
    await redis.quit();
    await store.close();
  }
});

test("redis room reaper survives a candidate whose key turns the wrong type", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("reapwrong");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const orphanKeys = orphanClaimKeys(namespace);
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const doomed = await store.createRoom({
      code: "BADKEY",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    const victim = await store.createRoom({
      code: "REAPME",
      joinToken: "join-token-123456",
      createdAt: 2,
    });
    for (const [room, expiresAt] of [
      [doomed, 10],
      [victim, 20],
    ] as const) {
      const updated = await store.updateRoom(room.code, room.version, {
        expiresAt,
        lastActiveAt: 5,
      });
      assert.equal(updated.ok, true);
    }

    // Settle the reconcile first, then corrupt the key inside the cooldown
    // window: the member is still a reaper candidate, so the Lua script is
    // what has to survive the WRONGTYPE — nothing quarantined it beforehand.
    await settleRoomIndexBootstrap(store);
    await redis.del(`${namespace}:room:${doomed.code}`);
    await redis.hset(`${namespace}:room:${doomed.code}`, "field", "value");
    assert.notEqual(await redis.zscore(roomsKey, doomed.code), null);

    // Without the guard the script raises on the first candidate and the room
    // ordered after it is never collected.
    const blocked = await store.deleteExpiredRooms(100);
    assert.equal(blocked.deletedRoomCodes.length, 1);
    assert.deepEqual(blocked.orphanedIndexCodes, []);
    assert.equal(await redis.exists(`${namespace}:room:REAPME`), 0);
    assert.equal(await redis.zscore(roomsKey, doomed.code), null);
    assert.equal(await redis.exists(`${namespace}:room:BADKEY`), 1);
    assert.ok(await redis.hget(orphanKeys.hash, doomed.code));

    await redis.del(`${namespace}:room:BADKEY`);
    const released = await store.deleteExpiredRooms(100);
    assert.deepEqual(released.orphanedIndexCodes, ["BADKEY"]);
    await acknowledgeOrphanClaims(store, released);
  } finally {
    await redis.del(
      `${namespace}:room:BADKEY`,
      `${namespace}:room:REAPME`,
      roomsKey,
      orphanKeys.hash,
      orphanKeys.queue,
    );
    await redis.quit();
    await store.close();
  }
});

test("redis room store reports codes whose index entry outlived the room body", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("nobody");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const orphanKeys = orphanClaimKeys(namespace);
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    await settleRoomIndexBootstrap(store);
    const room = await store.createRoom({
      code: "NOBODY",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    const expiring = await store.updateRoom(room.code, room.version, {
      expiresAt: 10,
      lastActiveAt: 2,
    });
    assert.equal(expiring.ok, true);

    // The body disappears while the expiry index still lists the code.
    await redis.del(`${namespace}:room:NOBODY`);

    // Reporting it is what gets its runtime state collected. Staying silent
    // stranded that state, and since a code is only handed out once nothing
    // remains under it, the code stopped being allocatable altogether.
    const swept = await store.deleteExpiredRooms(10);
    // Reported, so its runtime state still gets collected — but apart from the
    // real deletions: no room died here, and metering it as one would inflate
    // reclamations with manual cleanups and corruption (#254 review).
    assert.deepEqual(swept.orphanedIndexCodes, ["NOBODY"]);
    assert.deepEqual(swept.deletedRoomCodes, []);
    assert.equal(await redis.zscore(roomsKey, "NOBODY"), null);
    await acknowledgeOrphanClaims(store, swept);
  } finally {
    await redis.del(roomsKey, orphanKeys.hash, orphanKeys.queue);
    await redis.quit();
    await store.close();
  }
});

test("redis room store reports which delete removed the room and still drops the index entry", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("delone");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const room = await store.createRoom({
      code: "DELONE",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    assert.equal(await redis.zscore(roomsKey, room.code), "inf");

    // The delete is idempotent, so both a losing concurrent reader and the
    // reaper can arrive after the room is already gone. Only the call that
    // actually removed the body may be counted as reclaiming a room.
    assert.equal(await store.deleteRoom(room), "deleted");
    assert.equal(await store.deleteRoom(room), "already_deleted");
    assert.equal(await store.getRoom(room.code), null);
    assert.equal(await redis.zscore(roomsKey, room.code), null);

    // An index entry whose body is already gone must still be dropped, and must
    // not be reported as a room this call reclaimed.
    await redis.zadd(roomsKey, "inf", "DELTWO");
    assert.equal(
      await store.deleteRoom({ ...room, code: "DELTWO" }),
      "already_deleted",
    );
    assert.equal(await redis.zscore(roomsKey, "DELTWO"), null);
  } finally {
    await redis.del(roomsKey);
    await redis.quit();
    await store.close();
  }
});

test("a room delete decided against one instance leaves its successor alone", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("delrecycle");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const first = await store.createRoom({
      code: "DELREC",
      joinToken: "join-token-first0",
      createdAt: 1,
    });
    // The caller stops waiting for its delete. Before that command reaches
    // Redis the room is gone anyway and the code is handed to a new room whose
    // owner has already been told their creation succeeded.
    assert.equal(await store.deleteRoom(first), "deleted");
    const second = await store.createRoom({
      code: "DELREC",
      joinToken: "join-token-second",
      createdAt: 2,
    });

    // Now the abandoned delete lands. Unguarded, it took whichever room held
    // the code (#277).
    assert.equal(await store.deleteRoom(first), "superseded");
    assert.equal((await store.getRoom("DELREC"))?.joinToken, second.joinToken);
    assert.equal(await redis.zscore(roomsKey, "DELREC"), "inf");
  } finally {
    await redis.del(`${namespace}:room:DELREC`);
    await redis.del(roomsKey);
    await redis.quit();
    await store.close();
  }
});

test("a room delete survives the changes an admin close itself causes", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  // The guard names the INSTANCE, not the bytes. An admin close disconnects
  // every member first and their leaves rewrite the record, so a guard that
  // compared the whole body would decline the action that caused the change —
  // and the caller would then skip the runtime teardown and the `room_deleted`
  // broadcast while reporting success (#277 review).
  const namespace = uniqueNamespace("delchange");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const target = await store.createRoom({
      code: "DELCHG",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    const leaveWrite = await store.updateRoom(target.code, target.version, {
      lastActiveAt: 2_000,
      expiresAt: 9_000,
    });
    assert.equal(leaveWrite.ok, true);

    assert.equal(await store.deleteRoom(target), "deleted");
    assert.equal(await store.getRoom("DELCHG"), null);
    assert.equal(await redis.zscore(roomsKey, "DELCHG"), null);
  } finally {
    await redis.del(`${namespace}:room:DELCHG`, roomsKey);
    await redis.quit();
    await store.close();
  }
});

test("a room delete leaves a body it cannot read to the quarantine", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("delunreadable");
  const roomKey = `${namespace}:room:DELBAD`;
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const target = await store.createRoom({
      code: "DELBAD",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    await redis.set(roomKey, "{not json");

    // Judging is impossible, so deleting would be a guess made on a request
    // path. The sweep's quarantine owns this case.
    assert.equal(await store.deleteRoom(target), "superseded");
    assert.equal(await store.deleteExpiredRoom("DELBAD", 9_000), "superseded");
    assert.equal(await redis.get(roomKey), "{not json");
  } finally {
    await redis.del(roomKey, roomsKey);
    await redis.quit();
    await store.close();
  }
});

test("an expired-room delete declines once the room stops being expired", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("delrevive");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const room = await store.createRoom({
      code: "DELREV",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    const expired = await store.updateRoom(room.code, room.version, {
      expiresAt: 500,
      lastActiveAt: 400,
    });
    assert.equal(expired.ok, true);
    if (!expired.ok) {
      throw new Error("Expected the expiry write to succeed.");
    }

    // A reader takes that expired snapshot. Before its delete runs, a node that
    // still has members there clears the expiry — the case the leave path is
    // already known to produce (#235 review).
    const revived = await store.updateRoom(room.code, expired.room.version, {
      expiresAt: null,
      lastActiveAt: 900,
    });
    assert.equal(revived.ok, true);

    // Judged from a fresh read inside the guarded write, so the snapshot that
    // said "expired" cannot collect a room that came back to life.
    assert.equal(await store.deleteExpiredRoom("DELREV", 1_000), "superseded");
    assert.ok(await store.getRoom("DELREV"));
    assert.equal(await redis.zscore(roomsKey, "DELREV"), "inf");

    // Still expired, so it is still collectable.
    const reexpired = await store.updateRoom(
      "DELREV",
      revived.ok ? revived.room.version : 0,
      {
        expiresAt: 900,
        lastActiveAt: 900,
      },
    );
    assert.equal(reexpired.ok, true);
    assert.equal(await store.deleteExpiredRoom("DELREV", 1_000), "deleted");
    assert.equal(await store.getRoom("DELREV"), null);
    assert.equal(await redis.zscore(roomsKey, "DELREV"), null);
  } finally {
    await redis.del(`${namespace}:room:DELREV`);
    await redis.del(roomsKey);
    await redis.quit();
    await store.close();
  }
});

test("a stalled GET is an unknown room body, not an absent one", async () => {
  // The listing reads every indexed room's body, and `readRoomBody` used to
  // answer null for ANY failure. That is right for a WRONGTYPE reply — it is a
  // fact about one key, and one bad key must not reject a whole batch — and
  // wrong for everything else, because a connection that stopped answering
  // fails every key in the batch at once. Answering "no body" there empties the
  // admin room list of live rooms and points the orphan prune at their index
  // members, which is the unknown-as-absent mistake `room-service` refuses to
  // make on this very store. Reachable since #271 gave this client a
  // `commandTimeout`; before that the batch hung instead (#271 review).
  const evals: string[] = [];
  const redis = createFakeRoomStoreRedis(async () => "OK", {
    zrange: async () => ["ABC123"],
    get: async () => {
      throw new Error("Command timed out");
    },
  });
  redis.client.eval = async (script: string) => {
    evals.push(script);
    return 0;
  };
  const store = await createRedisRoomStore("redis://unused", {
    redisClient: redis.client,
  });

  try {
    await assert.rejects(
      store.listRooms({
        page: 1,
        pageSize: 10,
        sortBy: "createdAt",
        sortOrder: "desc",
      }),
    );
    // And nothing was pruned or quarantined on the strength of an answer the
    // store never got.
    assert.deepEqual(evals, []);
  } finally {
    await store.close();
  }
});

test("a non-WRONGTYPE Redis reply is a dependency failure, not an unreadable key", async () => {
  const evals: string[] = [];
  const redis = createFakeRoomStoreRedis(async () => "OK", {
    zrange: async () => ["ABC123"],
    get: async () => {
      throw new ReplyError(
        "NOPERM this user has no permissions to run the 'get' command",
      );
    },
  });
  redis.client.eval = async (script: string) => {
    evals.push(script);
    return 0;
  };
  const store = await createRedisRoomStore("redis://unused", {
    redisClient: redis.client,
  });

  try {
    await assert.rejects(
      store.listRooms({
        page: 1,
        pageSize: 10,
        sortBy: "createdAt",
        sortOrder: "desc",
      }),
      /NOPERM/,
    );
    assert.deepEqual(evals, []);
  } finally {
    await store.close();
  }
});

test("a WRONGTYPE reply is still one unreadable key, not a dependency outage", async () => {
  // The discriminating half. A reply IS evidence about the key, so the batch
  // survives it and the index repair still runs — which is the behaviour the
  // fix above must not have taken away.
  const evals: string[] = [];
  const redis = createFakeRoomStoreRedis(async () => "OK", {
    zrange: async () => ["ABC123"],
    get: async () => {
      throw new ReplyError(
        "WRONGTYPE Operation against a key holding the wrong kind of value",
      );
    },
  });
  redis.client.eval = async (script: string) => {
    evals.push(script);
    return 0;
  };
  const store = await createRedisRoomStore("redis://unused", {
    redisClient: redis.client,
  });

  try {
    assert.deepEqual(
      await store.listRooms({
        page: 1,
        pageSize: 10,
        sortBy: "createdAt",
        sortOrder: "desc",
      }),
      [],
    );
    // Whether that is the orphan prune, the quarantine, or both is the repair
    // path's business; what this pins is that the batch reached it at all.
    assert.ok(evals.length > 0);
  } finally {
    await store.close();
  }
});
