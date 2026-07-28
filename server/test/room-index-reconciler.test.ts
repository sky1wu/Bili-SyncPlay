import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createRoomIndexReconciler } from "../src/room-index-reconciler.js";

test("room index reconciler runs the pass through the injected hook", async () => {
  let calls = 0;
  const reconciler = createRoomIndexReconciler({
    intervalMs: 60_000,
    reconcileRoomIndex: async () => {
      calls += 1;
    },
    logEvent: () => undefined,
  });

  try {
    assert.equal(await reconciler.runNow(), true);
    assert.equal(calls, 1);
  } finally {
    reconciler.stop();
  }
});

test("room index reconciler swallows a failed pass and logs it", async () => {
  const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
  const reconciler = createRoomIndexReconciler({
    intervalMs: 60_000,
    reconcileRoomIndex: () => Promise.reject(new Error("scan failed")),
    logEvent: (event, data) => {
      logged.push({ event, data });
    },
  });

  try {
    // Rethrowing here would surface out of the timer callback as an unhandled
    // rejection and take the process down on a Redis hiccup.
    assert.equal(await reconciler.runNow(), false);
    assert.deepEqual(
      logged.map((entry) => entry.event),
      ["room_index_reconcile_failed"],
    );
    assert.equal(logged[0]?.data.error, "scan failed");
  } finally {
    reconciler.stop();
  }
});

test("room index reconciler fires on its interval and stops on stop()", async () => {
  let calls = 0;
  const reconciler = createRoomIndexReconciler({
    intervalMs: 5,
    reconcileRoomIndex: async () => {
      calls += 1;
    },
    logEvent: () => undefined,
  });

  await delay(40);
  const whileRunning = calls;
  reconciler.stop();
  const atStop = calls;
  await delay(40);

  // The timer is what replaces the old read-path trigger; if it never fired,
  // the index would only ever be reconciled once per process.
  assert.ok(
    whileRunning >= 2,
    `expected repeated passes, saw ${String(whileRunning)}`,
  );
  // And it must stop, or shutdown leaves a handle keeping the process alive.
  assert.equal(calls, atStop);
});
