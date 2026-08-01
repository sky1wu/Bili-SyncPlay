import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createInMemoryRoomStore } from "../src/room-store.js";
import { createRoomReaper } from "../src/room-reaper.js";

test("room reaper deletes expired rooms through the store interface", async () => {
  const store = createInMemoryRoomStore();
  await store.createRoom({
    code: "ROOM01",
    joinToken: "join-token-123456",
    createdAt: 1,
  });
  const updated = await store.updateRoom("ROOM01", 0, {
    expiresAt: 10,
    lastActiveAt: 5,
  });
  assert.equal(updated.ok, true);

  const reaper = createRoomReaper({
    intervalMs: 60_000,
    // The reaper counts; the store reports which rooms died so the caller can
    // collect their runtime state. `room-service` adapts the two in production.
    deleteExpiredRooms: async (currentTime) =>
      (await store.deleteExpiredRooms(currentTime)).length,
    logEvent: () => undefined,
    now: () => 10,
  });

  try {
    const deletedCount = await reaper.runNow();
    assert.equal(deletedCount, 1);
    assert.equal(await store.getRoom("ROOM01"), null);
  } finally {
    await reaper.stop();
  }
});

test("room reaper stop() waits for the sweep in flight", async () => {
  let settled = false;
  let announceStarted!: () => void;
  let releaseSweep!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseSweep = resolve;
  });

  const reaper = createRoomReaper({
    intervalMs: 5,
    deleteExpiredRooms: async () => {
      announceStarted();
      await blocked;
      // Crossing a macrotask is what gives this test its teeth — see the
      // matching note in room-index-reconciler.test.ts.
      await delay(0);
      settled = true;
      return 0;
    },
    logEvent: () => undefined,
    now: () => 10,
  });

  await started;
  const stopped = reaper.stop();
  // close_room_store runs right after this shutdown step; returning before the
  // sweep settles would leave its EVAL racing redis.quit().
  assert.equal(settled, false);
  releaseSweep();
  await stopped;
  assert.equal(settled, true);
});
