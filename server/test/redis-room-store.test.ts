import assert from "node:assert/strict";
import test from "node:test";
import Redis from "ioredis";
import { createRedisRoomStore } from "../src/redis-room-store.js";

const REDIS_URL = process.env.REDIS_URL;

test("redis room reaper does not delete rooms whose expiresAt was cleared after zset candidate selection", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const store = await createRedisRoomStore(REDIS_URL);
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();

  const roomCode = `T${Date.now().toString(36).slice(-5).toUpperCase()}`
    .padEnd(6, "A")
    .slice(0, 6);

  try {
    const room = await store.createRoom({
      code: roomCode,
      joinToken: "join-token-123456",
      createdAt: 1,
    });

    const expired = await store.updateRoom(room.code, room.version, {
      expiresAt: 10,
      lastActiveAt: 2,
    });
    assert.equal(expired.ok, true);
    if (!expired.ok) {
      throw new Error("Expected update to succeed.");
    }

    const revived = await store.updateRoom(room.code, expired.room.version, {
      expiresAt: null,
      lastActiveAt: 3,
    });
    assert.equal(revived.ok, true);
    if (!revived.ok) {
      throw new Error("Expected room revival to succeed.");
    }

    await redis.zadd("bsp:room-expiry", "10", room.code);

    const deletedCount = await store.deleteExpiredRooms(10);
    assert.equal(deletedCount, 0);

    const remainingRoom = await store.getRoom(room.code);
    assert.ok(remainingRoom);
    assert.equal(remainingRoom?.expiresAt, null);
    assert.equal(await redis.zscore("bsp:room-expiry", room.code), null);
  } finally {
    await store.deleteRoom(roomCode);
    await redis.quit();
    await store.close();
  }
});

test("redis room reaper drops reaped rooms from the room index", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = `bsp-test-reap-${Date.now().toString(36)}`;
  const indexKey = `${namespace}:room-index`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();

  try {
    const room = await store.createRoom({
      code: "REAP01",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    assert.notEqual(await redis.zscore(indexKey, room.code), null);

    const expiring = await store.updateRoom(room.code, room.version, {
      expiresAt: 10,
      lastActiveAt: 2,
    });
    assert.equal(expiring.ok, true);

    assert.equal(await store.deleteExpiredRooms(10), 1);

    // The reaper used to delete the room body and its expiry entry while
    // leaving the index entry behind, so the index grew by one per expired
    // room forever and every listing scanned all of them.
    assert.equal(await redis.zscore(indexKey, room.code), null);
    assert.equal(await redis.zcard(indexKey), 0);
    assert.equal(await store.countRooms({ includeExpired: true }), 0);
  } finally {
    await redis.del(indexKey, `${namespace}:room-expiry`);
    await redis.quit();
    await store.close();
  }
});

test("redis room listing prunes index entries left by older builds", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = `bsp-test-stale-${Date.now().toString(36)}`;
  const indexKey = `${namespace}:room-index`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();

  try {
    const room = await store.createRoom({
      code: "LIVE01",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    // Stands in for an entry a pre-fix reaper left behind: indexed, but with
    // no room body to load.
    await redis.zadd(indexKey, "5", "GHOST1");
    assert.equal(await redis.zcard(indexKey), 2);

    const rooms = await store.listRooms({
      keyword: undefined,
      includeExpired: true,
      page: 1,
      pageSize: 50,
      sortBy: "lastActiveAt",
      sortOrder: "desc",
    });

    assert.deepEqual(
      rooms.map((listed) => listed.code),
      [room.code],
    );
    assert.equal(await redis.zscore(indexKey, "GHOST1"), null);
    assert.equal(await redis.zcard(indexKey), 1);
  } finally {
    await store.deleteRoom("LIVE01");
    await redis.del(indexKey, `${namespace}:room-expiry`);
    await redis.quit();
    await store.close();
  }
});

test("redis room store backfills index entries missing from legacy databases", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = `bsp-test-backfill-${Date.now().toString(36)}`;
  const indexKey = `${namespace}:room-index`;
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();

  let store: Awaited<ReturnType<typeof createRedisRoomStore>> | null = null;
  try {
    // A room body with no index member: exactly the shape left by databases
    // created before the room index existed, which shipped without a backfill.
    await redis.set(
      `${namespace}:room:LEGACY`,
      JSON.stringify({
        code: "LEGACY",
        joinToken: "join-token-123456",
        createdAt: 50,
        ownerMemberId: null,
        ownerDisplayName: null,
        sharedVideo: null,
        playback: null,
        version: 0,
        lastActiveAt: 60,
        expiresAt: null,
      }),
    );
    assert.equal(await redis.zcard(indexKey), 0);

    store = await createRedisRoomStore(REDIS_URL, { namespace });

    // The repair runs off the startup path so readiness is not delayed by a
    // keyspace walk; listing is what awaits it, so assert through a listing.
    const rooms = await store.listRooms({
      keyword: undefined,
      includeExpired: true,
      page: 1,
      pageSize: 50,
      sortBy: "createdAt",
      sortOrder: "desc",
    });
    assert.deepEqual(
      rooms.map((listed) => listed.code),
      ["LEGACY"],
    );
    assert.equal(await redis.zscore(indexKey, "LEGACY"), "60");
  } finally {
    await redis.del(
      `${namespace}:room:LEGACY`,
      indexKey,
      `${namespace}:room-expiry`,
    );
    await redis.quit();
    await store?.close();
  }
});

test("redis room index backfill escapes glob metacharacters in the namespace", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  // Square brackets are a Redis glob character class, so an unescaped
  // SCAN MATCH would match nothing here and silently skip the repair.
  const namespace = `bsp-test[glob]-${Date.now().toString(36)}`;
  const indexKey = `${namespace}:room-index`;
  const roomBodyKey = `${namespace}:room:BRACKT`;
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();

  let store: Awaited<ReturnType<typeof createRedisRoomStore>> | null = null;
  try {
    await redis.set(
      roomBodyKey,
      JSON.stringify({
        code: "BRACKT",
        joinToken: "join-token-123456",
        createdAt: 50,
        ownerMemberId: null,
        ownerDisplayName: null,
        sharedVideo: null,
        playback: null,
        version: 0,
        lastActiveAt: 60,
        expiresAt: null,
      }),
    );

    store = await createRedisRoomStore(REDIS_URL, { namespace });
    const rooms = await store.listRooms({
      keyword: undefined,
      includeExpired: true,
      page: 1,
      pageSize: 50,
      sortBy: "lastActiveAt",
      sortOrder: "desc",
    });

    assert.deepEqual(
      rooms.map((listed) => listed.code),
      ["BRACKT"],
    );
  } finally {
    await redis.del(roomBodyKey, indexKey, `${namespace}:room-expiry`);
    await redis.quit();
    await store?.close();
  }
});

test("redis room listing sorts by createdAt without a keyspace scan", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = `bsp-test-created-${Date.now().toString(36)}`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();

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

    // createdAt ordering used to come from a KEYS scan; it now reads the same
    // index as lastActiveAt and sorts the loaded bodies.
    const descending = await store.listRooms({
      keyword: undefined,
      includeExpired: true,
      page: 1,
      pageSize: 50,
      sortBy: "createdAt",
      sortOrder: "desc",
    });
    assert.deepEqual(
      descending.map((listed) => listed.code),
      ["NEWER1", "OLDER1"],
    );

    const ascending = await store.listRooms({
      keyword: undefined,
      includeExpired: true,
      page: 1,
      pageSize: 50,
      sortBy: "createdAt",
      sortOrder: "asc",
    });
    assert.deepEqual(
      ascending.map((listed) => listed.code),
      ["OLDER1", "NEWER1"],
    );
  } finally {
    await store.deleteRoom("OLDER1");
    await store.deleteRoom("NEWER1");
    await redis.del(`${namespace}:room-index`, `${namespace}:room-expiry`);
    await redis.quit();
    await store.close();
  }
});

test("redis room update applies the patch, bumps version, and maintains both indexes", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = `bsp-test-cas-${Date.now().toString(36)}`;
  const indexKey = `${namespace}:room-index`;
  const expiryKey = `${namespace}:room-expiry`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();

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
    assert.equal(updated.room.expiresAt, 900);
    assert.equal(updated.room.createdAt, 1);
    assert.deepEqual(await store.getRoom(room.code), updated.room);
    assert.equal(await redis.zscore(indexKey, room.code), "800");
    assert.equal(await redis.zscore(expiryKey, room.code), "900");

    // Clearing expiresAt must drop the expiry entry but keep the room indexed.
    const revived = await store.updateRoom(room.code, updated.room.version, {
      expiresAt: null,
      lastActiveAt: 850,
    });
    assert.equal(revived.ok, true);
    assert.equal(await redis.zscore(expiryKey, room.code), null);
    assert.equal(await redis.zscore(indexKey, room.code), "850");

    // A stale expected version must lose, and must not write anything.
    const stale = await store.updateRoom(room.code, room.version, {
      lastActiveAt: 999,
    });
    assert.equal(stale.ok, false);
    if (stale.ok) {
      throw new Error("Expected stale update to be rejected.");
    }
    assert.equal(stale.reason, "version_conflict");
    assert.equal(await redis.zscore(indexKey, room.code), "850");
    assert.equal((await store.getRoom(room.code))?.lastActiveAt, 850);

    const missing = await store.updateRoom("NOSUCH", 0, { lastActiveAt: 1 });
    assert.equal(missing.ok, false);
    if (missing.ok) {
      throw new Error("Expected update of a missing room to be rejected.");
    }
    assert.equal(missing.reason, "not_found");
  } finally {
    await store.deleteRoom("CASRM1");
    await redis.del(indexKey, expiryKey);
    await redis.quit();
    await store.close();
  }
});

test("redis room update preserves playback number precision through the CAS script", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = `bsp-test-precision-${Date.now().toString(36)}`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();

  try {
    const room = await store.createRoom({
      code: "PRECIS",
      joinToken: "join-token-123456",
      createdAt: 1,
    });

    // The CAS script must never re-encode the room body: cjson formats numbers
    // with %.14g, which would round these away.
    const playback = {
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

    const stored = await store.getRoom(room.code);
    assert.deepEqual(stored?.playback, playback);
  } finally {
    await store.deleteRoom("PRECIS");
    await redis.del(`${namespace}:room-index`, `${namespace}:room-expiry`);
    await redis.quit();
    await store.close();
  }
});

test("redis room count answers from the indexes without loading room bodies", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = `bsp-test-count-${Date.now().toString(36)}`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();

  try {
    const live = await store.createRoom({
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

    // Keyword filtering runs on index members, and still honours expiry.
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

    // Counts must agree with what listing reports.
    const listed = await store.listRooms({
      keyword: undefined,
      includeExpired: false,
      page: 1,
      pageSize: 50,
      sortBy: "lastActiveAt",
      sortOrder: "desc",
    });
    assert.equal(listed.length, 2);
    assert.equal(live.code, "LIVEAA");
  } finally {
    await store.deleteRoom("LIVEAA");
    await store.deleteRoom("GONEBB");
    await store.deleteRoom("LATERC");
    await redis.del(`${namespace}:room-index`, `${namespace}:room-expiry`);
    await redis.quit();
    await store.close();
  }
});

test("redis room index repair sweeps orphaned members so counts stay honest", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = `bsp-test-sweep-${Date.now().toString(36)}`;
  const indexKey = `${namespace}:room-index`;
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();

  let store: Awaited<ReturnType<typeof createRedisRoomStore>> | null = null;
  try {
    // Members left behind by a pre-fix reaper. countRooms no longer loads
    // bodies, so only the startup sweep can clear these — otherwise every
    // count and the rooms_non_expired metric would stay inflated forever.
    await redis.zadd(indexKey, "10", "GHOSTA", "20", "GHOSTB");
    assert.equal(await redis.zcard(indexKey), 2);

    store = await createRedisRoomStore(REDIS_URL, { namespace });
    assert.equal(await store.countRooms({ includeExpired: true }), 0);
    assert.equal(await redis.zcard(indexKey), 0);
  } finally {
    await redis.del(indexKey, `${namespace}:room-expiry`);
    await redis.quit();
    await store?.close();
  }
});

test("redis room count is unaffected by expiry members left over from older builds", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = `bsp-test-orphanexp-${Date.now().toString(36)}`;
  const expiryKey = `${namespace}:room-expiry`;
  const indexKey = `${namespace}:room-index`;
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();

  let store: Awaited<ReturnType<typeof createRedisRoomStore>> | null = null;
  try {
    // Expiry members whose rooms are long gone, as a pre-fix delete would
    // leave them. ZCARD minus ZCOUNT would charge these against unrelated
    // live rooms and could report 0, so the startup sweep has to clear them.
    await redis.zadd(expiryKey, "1", "DEADAA", "2", "DEADBB", "3", "DEADCC");

    store = await createRedisRoomStore(REDIS_URL, { namespace });
    await store.createRoom({
      code: "ALIVEA",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    await store.createRoom({
      code: "ALIVEB",
      joinToken: "join-token-123456",
      createdAt: 2,
    });

    assert.equal(await store.countRooms({ includeExpired: false }), 2);
    assert.equal(await store.countRooms({ includeExpired: true }), 2);
    assert.equal(await redis.zcard(expiryKey), 0);
  } finally {
    await store?.deleteRoom("ALIVEA");
    await store?.deleteRoom("ALIVEB");
    await redis.del(indexKey, expiryKey);
    await redis.quit();
    await store?.close();
  }
});

test("redis room create clears a stale expiry member for a reused code", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = `bsp-test-reuse-${Date.now().toString(36)}`;
  const expiryKey = `${namespace}:room-expiry`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();

  try {
    // The code is handed out again while its previous occupant's expiry
    // member is still around; the new room has no expiresAt, so counting it
    // as expired would under-report until the next reaper cycle.
    await redis.zadd(expiryKey, "1", "REUSED");

    const room = await store.createRoom({
      code: "REUSED",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    assert.equal(room.expiresAt, null);
    assert.equal(await redis.zscore(expiryKey, "REUSED"), null);
    assert.equal(await store.countRooms({ includeExpired: false }), 1);

    // A losing create must leave the winner's entries untouched.
    await assert.rejects(() =>
      store.createRoom({
        code: "REUSED",
        joinToken: "join-token-other",
        createdAt: 2,
      }),
    );
    assert.equal(
      (await store.getRoom("REUSED"))?.joinToken,
      "join-token-123456",
    );
    assert.equal(await store.countRooms({ includeExpired: false }), 1);
  } finally {
    await store.deleteRoom("REUSED");
    await redis.del(`${namespace}:room-index`, expiryKey);
    await redis.quit();
    await store.close();
  }
});

test("redis room index repair sweeps again once the reconcile cooldown lapses", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = `bsp-test-resweep-${Date.now().toString(36)}`;
  const indexKey = `${namespace}:room-index`;
  let clock = 1_000_000;
  const store = await createRedisRoomStore(REDIS_URL, {
    namespace,
    now: () => clock,
  });
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();

  try {
    assert.equal(await store.countRooms({ includeExpired: true }), 0);

    // Stands in for a node still on the old build reaping a room without
    // removing its index member, after this process already swept.
    await redis.zadd(indexKey, "10", "LATEGH");
    assert.equal(await store.countRooms({ includeExpired: true }), 1);

    // Inside the cooldown nothing re-sweeps, so the orphan still counts.
    clock += 60_000;
    assert.equal(await store.countRooms({ includeExpired: true }), 1);

    // Past the cooldown the sweep runs again and the orphan is gone.
    clock += 300_000;
    assert.equal(await store.countRooms({ includeExpired: true }), 0);
    assert.equal(await redis.zcard(indexKey), 0);
  } finally {
    await redis.del(indexKey, `${namespace}:room-expiry`);
    await redis.quit();
    await store.close();
  }
});
