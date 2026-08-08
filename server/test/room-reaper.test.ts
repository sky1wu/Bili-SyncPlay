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
  let declared = 0;
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
      declareRoomReaper: () => {
        declared += 1;
      },
      recordRoomReaperSweep: (result) => {
        sweeps.push(result);
      },
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
  // Declared once, at construction — a process that never builds a reaper must
  // not export the series at all, or "rate dropped to 0" fires on it forever.
  assert.equal(declared, 1);
  assert.deepEqual(logged, ["room_expired_deleted", "room_expired_deleted"]);
});

test("room reaper records a failed sweep under its own result", async () => {
  const sweeps: string[] = [];
  let declared = 0;
  const reaper = createRoomReaper({
    intervalMs: 60_000,
    deleteExpiredRooms: async () => {
      throw new Error("redis is gone");
    },
    logEvent: () => undefined,
    metricsCollector: {
      declareRoomReaper: () => {
        declared += 1;
      },
      recordRoomReaperSweep: (result) => {
        sweeps.push(result);
      },
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
  // Declared at construction, so the series exists even for a reaper whose
  // every sweep fails — otherwise the failure counter would have nothing to
  // sit beside.
  assert.equal(declared, 1);
});

test("a sweep hung on Redis is recorded as an error, not as silence", async () => {
  const sweeps: string[] = [];
  const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
  let started = 0;
  const reaper = createRoomReaper({
    intervalMs: 60_000,
    // A half-open connection: the command was accepted and no answer, no error
    // and no close ever comes back. `maxRetriesPerRequest` does not bound this
    // — it bounds retries, not the wait for a command already sent (#261).
    deleteExpiredRooms: () => {
      started += 1;
      return new Promise(() => undefined);
    },
    logEvent: (event, data) => {
      logged.push({ event, data });
    },
    metricsCollector: {
      declareRoomReaper: () => undefined,
      recordRoomReaperSweep: (result) => {
        sweeps.push(result);
      },
    },
    now: () => 10,
    sweepTimeoutMs: 20,
  });

  try {
    // Before the cap this never returned: the reaper stopped collecting rooms
    // while both series of `room_reaper_sweeps_total` stayed flat, so an alert
    // on the failure rate could not fire and only a restart recovered it.
    assert.equal(await reaper.runNow(), 0);
    // And a second pass must not put another command on a connection that has
    // answered neither.
    assert.equal(await reaper.runNow(), 0);
  } finally {
    await reaper.stop();
  }

  assert.equal(started, 1);
  assert.deepEqual(sweeps, ["error", "error"]);
  assert.deepEqual(
    logged.map((entry) => entry.event),
    [
      "room_persist_failed",
      "room_persist_failed",
      // stop() returns on its budget rather than waiting out the stall — and
      // says the EVAL is still on the connection `close_room_store` is about to
      // quit. That overrun used to surface as a failed shutdown step.
      "room_reaper_sweep_abandoned_at_shutdown",
    ],
  );
  assert.equal(logged[2]?.data.pendingSweeps, 1);
  assert.equal(logged[2]?.data.result, "timeout");
  // Told apart in the log, since they share the metric's `error` label: a
  // stalled sweep and one that piled up behind it are different repairs.
  assert.deepEqual(
    logged
      .filter((entry) => entry.event === "room_persist_failed")
      .map((entry) => entry.data.reason),
    ["room_reaper_sweep_timeout", "room_reaper_sweep_stalled"],
  );
  assert.equal(logged[0]?.data.timeoutMs, 20);
});

test("a sweep that threw names its own reason", async () => {
  const logged: Array<Record<string, unknown>> = [];
  const reaper = createRoomReaper({
    intervalMs: 60_000,
    deleteExpiredRooms: async () => {
      throw new Error("redis is gone");
    },
    logEvent: (_event, data) => {
      logged.push(data);
    },
    now: () => 10,
  });

  try {
    assert.equal(await reaper.runNow(), 0);
  } finally {
    await reaper.stop();
  }

  // The reason a Redis error has always carried; a timeout must not be filed
  // under it, or the runbook cannot tell "Redis answered with an error" from
  // "Redis never answered".
  assert.equal(logged[0]?.reason, "room_reaper_failed");
  assert.equal(logged[0]?.error, "redis is gone");
  // Nothing came near the cap, so naming it here would be noise.
  assert.equal("timeoutMs" in (logged[0] ?? {}), false);
});
