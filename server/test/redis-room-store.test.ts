import assert from "node:assert/strict";
import test from "node:test";
import Redis from "ioredis";
import { createRedisRoomStore, expiryScore } from "../src/redis-room-store.js";

const REDIS_URL = process.env.REDIS_URL;

type Store = Awaited<ReturnType<typeof createRedisRoomStore>>;

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

    await store.saveRoom({ ...room, expiresAt: 1_500, lastActiveAt: 900 });
    assert.equal(await redis.zscore(roomsKey, room.code), "1500");
  } finally {
    await store.deleteRoom("SCORE1");
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

    assert.equal(await store.deleteExpiredRooms(10), 1);
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

    assert.equal(await store.deleteExpiredRooms(10), 0);
    assert.ok(await store.getRoom(room.code));
    assert.equal(await redis.zscore(roomsKey, room.code), "inf");
  } finally {
    await store.deleteRoom("REVIVE");
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
    assert.equal(await store.deleteExpiredRooms(100), 1);
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
  } finally {
    await store.deleteRoom("LIVE01");
    await redis.del(roomsKey);
    await redis.quit();
    await store.close();
  }
});

test("redis room reconcile sweeps orphans again once the cooldown lapses", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("resweep");
  const roomsKey = `${namespace}:rooms-by-expiry`;
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

    clock += 60_000;
    assert.equal(await store.countRooms({ includeExpired: true }), 1);

    clock += 900_000;
    assert.equal(await store.countRooms({ includeExpired: true }), 0);
    assert.equal(await redis.zcard(roomsKey), 0);
  } finally {
    await redis.del(roomsKey);
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
    await store.deleteRoom("OLDER1");
    await store.deleteRoom("NEWER1");
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
    await store.deleteRoom("CASRM1");
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
    await store.deleteRoom("PRECIS");
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
    await store.deleteRoom("COLLID");
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
    await store.deleteRoom("LIVEAA");
    await store.deleteRoom("GONEBB");
    await store.deleteRoom("LATERC");
    await redis.del(`${namespace}:rooms-by-expiry`);
    await redis.quit();
    await store.close();
  }
});

test("redis room save rolls the room body back when indexing fails", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const namespace = uniqueNamespace("saveroll");
  const roomsKey = `${namespace}:rooms-by-expiry`;
  const store = await createRedisRoomStore(REDIS_URL, { namespace });
  const redis = await connect();

  try {
    const room = await store.createRoom({
      code: "SAVERB",
      joinToken: "join-token-123456",
      createdAt: 1,
    });
    const before = await store.getRoom(room.code);
    assert.ok(before);

    // Wrong type for the set key: the body is written first and the ZADD then
    // fails. Reporting the failure is not enough — the caller believes nothing
    // was saved, so the body must still hold its previous state, or the index
    // would carry a score for a room state that never took effect.
    await redis.del(roomsKey);
    await redis.set(roomsKey, "not-a-sorted-set");

    await assert.rejects(() =>
      store.saveRoom({ ...before, expiresAt: 500, lastActiveAt: 400 }),
    );
    assert.deepEqual(await store.getRoom(room.code), before);

    // A save that would have created the body must leave none behind.
    await assert.rejects(() =>
      store.saveRoom({ ...before, code: "SAVENW", expiresAt: 600 }),
    );
    assert.equal(await redis.exists(`${namespace}:room:SAVENW`), 0);
  } finally {
    await redis.del(
      `${namespace}:room:SAVERB`,
      `${namespace}:room:SAVENW`,
      roomsKey,
    );
    await redis.quit();
    await store.close();
  }
});

test("redis room reaper triggers the reconcile itself", async (t) => {
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
    assert.equal(await store.deleteExpiredRooms(100), 1);
    assert.equal(await redis.exists(`${namespace}:room:NOREAD`), 0);
    assert.equal(await redis.zscore(roomsKey, "NOREAD"), null);
  } finally {
    await redis.del(`${namespace}:room:NOREAD`, roomsKey);
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
    await store.deleteRoom("FMTCHK");
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
    assert.equal(await store.deleteExpiredRooms(100), 1);
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
    assert.equal(await store.deleteExpiredRooms(100), 1);
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

    assert.equal(await store.deleteExpiredRooms(100), 1);
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

    // The body is kept: it cannot be interpreted, so deleting it would be a
    // guess. It also must not creep back into the set on the next reconcile.
    assert.equal(await redis.exists(`${namespace}:room:ROTTEN`), 1);
    clock += 900_000;
    assert.equal(await store.countRooms({ includeExpired: true }), 1);
  } finally {
    await redis.del(
      `${namespace}:room:STAYOK`,
      `${namespace}:room:ROTTEN`,
      roomsKey,
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

    // The genuinely expired room is still collected.
    assert.equal(await store.deleteExpiredRooms(100), 1);
    assert.equal(await redis.exists(`${namespace}:room:EXPIRE`), 0);
    // The wrong-type key itself is left alone rather than destroyed.
    assert.equal(await redis.exists(`${namespace}:room:WRONGT`), 1);
  } finally {
    await redis.del(
      `${namespace}:room:OKROOM`,
      `${namespace}:room:WRONGT`,
      `${namespace}:room:EXPIRE`,
      roomsKey,
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
    await store.countRooms({ includeExpired: true });
    await redis.del(`${namespace}:room:${doomed.code}`);
    await redis.hset(`${namespace}:room:${doomed.code}`, "field", "value");
    assert.notEqual(await redis.zscore(roomsKey, doomed.code), null);

    // Without the guard the script raises on the first candidate and the room
    // ordered after it is never collected.
    assert.equal(await store.deleteExpiredRooms(100), 1);
    assert.equal(await redis.exists(`${namespace}:room:REAPME`), 0);
    assert.equal(await redis.zscore(roomsKey, doomed.code), null);
    assert.equal(await redis.exists(`${namespace}:room:BADKEY`), 1);
  } finally {
    await redis.del(
      `${namespace}:room:BADKEY`,
      `${namespace}:room:REAPME`,
      roomsKey,
    );
    await redis.quit();
    await store.close();
  }
});
