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
