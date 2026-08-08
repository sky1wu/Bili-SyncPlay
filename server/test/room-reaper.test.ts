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
    // The store reports which rooms died so the caller can collect their
    // runtime state; the reaper only needs the counts. `room-service` adapts
    // the two in production.
    deleteExpiredRooms: async (currentTime) => {
      const swept = await store.deleteExpiredRooms(currentTime);
      return {
        deletedRooms: swept.deletedRoomCodes.length,
        orphanedIndexEntries: swept.orphanedIndexCodes.length,
      };
    },
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
      return { deletedRooms: 0, orphanedIndexEntries: 0 };
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

test("room reaper records every sweep, including the ones that collect nothing", async () => {
  const sweeps: string[] = [];
  const outcomes: Array<{
    deletedRooms: number;
    orphanedIndexEntries: number;
  }> = [
    { deletedRooms: 2, orphanedIndexEntries: 0 },
    { deletedRooms: 0, orphanedIndexEntries: 0 },
    { deletedRooms: 0, orphanedIndexEntries: 1 },
  ];
  const logged: string[] = [];
  const reaper = createRoomReaper({
    intervalMs: 60_000,
    deleteExpiredRooms: async () =>
      outcomes.shift() ?? { deletedRooms: 0, orphanedIndexEntries: 0 },
    logEvent: (event) => logged.push(event),
    metricsCollector: {
      recordRoomReaperSweep: (result) => sweeps.push(result),
    },
    now: () => 10,
  });

  try {
    await reaper.runNow();
    await reaper.runNow();
    await reaper.runNow();
  } finally {
    await reaper.stop();
  }

  // An empty sweep is the normal state of a healthy reaper: with steady traffic
  // the lazy read path deletes expired rooms before the sweep reaches them. The
  // deletion event goes quiet, so only a per-pass signal separates "idle" from
  // "stopped".
  assert.deepEqual(sweeps, ["ok", "ok", "ok"]);
  assert.deepEqual(logged, ["room_expired_deleted", "room_expired_deleted"]);
});

test("room reaper records a failed sweep under its own result", async () => {
  const sweeps: string[] = [];
  const reaper = createRoomReaper({
    intervalMs: 60_000,
    deleteExpiredRooms: async () => {
      throw new Error("redis is gone");
    },
    logEvent: () => undefined,
    metricsCollector: {
      recordRoomReaperSweep: (result) => sweeps.push(result),
    },
    now: () => 10,
  });

  try {
    assert.equal(await reaper.runNow(), 0);
  } finally {
    await reaper.stop();
  }

  // Failures need their own series: a reaper that runs every minute and throws
  // every minute is as broken as one that stopped, and `events_total` carries
  // no `reason` label to filter the failure log by.
  assert.deepEqual(sweeps, ["error"]);
});
