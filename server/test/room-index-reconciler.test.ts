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
    assert.equal(logged[0]?.data.reason, "room_index_reconcile_failed");
  } finally {
    reconciler.stop();
  }
});

test("a reconcile pass hung on Redis is reported and not piled on", async () => {
  const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
  let started = 0;
  const reconciler = createRoomIndexReconciler({
    intervalMs: 60_000,
    // Same stall as the reaper's (#261): the SCAN went out, nothing comes back.
    // Unbounded, this pass would also hold `stop_room_index_reconciler` until
    // the shutdown step itself timed out and was recorded as failed.
    reconcileRoomIndex: () => {
      started += 1;
      return new Promise(() => undefined);
    },
    logEvent: (event, data) => {
      logged.push({ event, data });
    },
    reconcileTimeoutMs: 20,
  });

  try {
    assert.equal(await reconciler.runNow(), false);
    assert.equal(await reconciler.runNow(), false);
  } finally {
    await reconciler.stop();
  }

  assert.equal(started, 1);
  assert.deepEqual(
    logged.map((entry) => entry.event),
    [
      "room_index_reconcile_failed",
      "room_index_reconcile_failed",
      // stop() returns on its budget instead of waiting the stall out — and
      // `close_room_store` runs immediately after this step, so it has to say
      // the SCAN is still on the connection. Before the cap that overrun was
      // visible only because the step itself timed out.
      "room_index_reconcile_abandoned_at_shutdown",
    ],
  );
  assert.deepEqual(
    logged
      .filter((entry) => entry.event === "room_index_reconcile_failed")
      .map((entry) => entry.data.reason),
    ["room_index_reconcile_timeout", "room_index_reconcile_stalled"],
  );
  assert.equal(logged[2]?.data.pendingPasses, 1);
  assert.equal(logged[2]?.data.result, "timeout");
  assert.equal(logged[0]?.data.timeoutMs, 20);
});

test("room index reconciler fires on its interval and stops on stop()", async () => {
  let calls = 0;
  // Waits for the second pass rather than asserting a count after a fixed
  // window: Node does not replay setInterval ticks missed while the event loop
  // was stalled, so a short wall-clock window makes a correct implementation
  // fail under load. The test times out if the timer never fires.
  let secondPass!: () => void;
  const sawTwoPasses = new Promise<void>((resolve) => {
    secondPass = resolve;
  });
  const reconciler = createRoomIndexReconciler({
    intervalMs: 5,
    reconcileRoomIndex: async () => {
      calls += 1;
      if (calls === 2) {
        secondPass();
      }
    },
    logEvent: () => undefined,
  });

  try {
    // The timer is what replaces the old read-path trigger; if it never fired,
    // the index would only ever be reconciled once per process.
    await sawTwoPasses;
  } finally {
    await reconciler.stop();
  }

  // And it must stop, or shutdown leaves a handle keeping the process alive.
  const atStop = calls;
  await delay(40);
  assert.equal(calls, atStop);
});

test("room index reconciler stop() waits for the pass in flight", async () => {
  let settled = false;
  let announceStarted!: () => void;
  let releasePass!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releasePass = resolve;
  });

  const reconciler = createRoomIndexReconciler({
    intervalMs: 5,
    reconcileRoomIndex: async () => {
      announceStarted();
      await blocked;
      // Crossing a macrotask is what gives this test its teeth: awaiting a
      // stop() that does not track the pass resumes on the microtask queue,
      // which drains before this timer fires, so `settled` is still false.
      // Without it both implementations happen to settle in the right order
      // and the test passes either way.
      await delay(0);
      settled = true;
    },
    logEvent: () => undefined,
  });

  await started;
  const stopped = reconciler.stop();
  // Shutdown closes the room store right after this step; returning before the
  // pass settles would leave a SCAN/GET/EVAL racing redis.quit().
  assert.equal(settled, false);
  releasePass();
  await stopped;
  assert.equal(settled, true);
});
