import assert from "node:assert/strict";
import test from "node:test";
import { createRedisEventStore } from "../src/admin/redis-event-store.js";

const REDIS_URL = process.env.REDIS_URL;

function createStreamKey(): string {
  return `bsp:test:events:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

test("redis event store appends, trims, and queries events across store instances", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const streamKey = createStreamKey();
  const storeA = await createRedisEventStore(REDIS_URL, {
    streamKey,
    maxLen: 2,
  });
  const storeB = await createRedisEventStore(REDIS_URL, {
    streamKey,
    maxLen: 2,
  });

  try {
    await storeA.append({
      event: "room_created",
      timestamp: "2026-03-26T11:00:00.000Z",
      data: {
        roomCode: "ROOM01",
        sessionId: "session-1",
        remoteAddress: "127.0.0.1",
        origin: "chrome-extension://allowed-extension",
        result: "ok",
      },
    });
    const joined = await storeB.append({
      event: "room_joined",
      timestamp: "2026-03-26T11:00:01.000Z",
      data: {
        roomCode: "ROOM01",
        sessionId: "session-2",
        result: "ok",
      },
    });
    await storeA.append({
      event: "room_closed",
      timestamp: "2026-03-26T11:00:02.000Z",
      data: {
        roomCode: "ROOM02",
        sessionId: "session-3",
        result: "ok",
      },
    });

    const room01 = await storeA.query({
      roomCode: "ROOM01",
      page: 1,
      pageSize: 10,
    });
    assert.equal(room01.total, 1);
    assert.equal(room01.items[0]?.id, joined.id);

    const joinedOnly = await storeB.query({
      event: "room_joined",
      page: 1,
      pageSize: 10,
    });
    assert.equal(joinedOnly.total, 1);
    assert.equal(joinedOnly.items[0]?.sessionId, "session-2");

    const trimmed = await storeA.query({
      page: 1,
      pageSize: 10,
    });
    assert.equal(trimmed.total, 2);
    assert.equal(
      trimmed.items.some((item) => item.event === "room_created"),
      false,
    );
  } finally {
    await storeA.close();
    await storeB.close();
  }
});
