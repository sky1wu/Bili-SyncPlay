import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createMaintenancePass,
  type MaintenancePassFailure,
} from "../src/maintenance-pass.js";

/** A call that never answers — a half-open connection, not a rejection. */
function hangForever<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

test("a pass that never answers is reported instead of waited on forever", async () => {
  const failures: MaintenancePassFailure[] = [];
  const pass = createMaintenancePass<void, string>({
    name: "test pass",
    intervalMs: 60_000,
    timeoutMs: 20,
    settleTimeoutMs: 20,
    run: () => hangForever(),
    onSuccess: () => "ok",
    onFailure: (failure) => {
      failures.push(failure);
      return "failed";
    },
  });

  try {
    // Without the cap this await never returns, which is exactly how the reaper
    // went silent: no result, no error, nothing counted (#261).
    assert.equal(await pass.runNow(), "failed");
    assert.deepEqual(
      failures.map((failure) => failure.reason),
      ["timed_out"],
    );
  } finally {
    await pass.stop();
  }
});

test("sequential passes each run", async () => {
  let started = 0;
  const pass = createMaintenancePass<void, string>({
    name: "test pass",
    intervalMs: 60_000,
    timeoutMs: 20,
    run: async () => {
      started += 1;
    },
    onSuccess: () => "ok",
    onFailure: (failure) => failure.reason,
  });

  try {
    // The overlap guard has to free its slot on the call's own answer. A guard
    // that only ever released on a timeout — or one hop too late — would skip
    // every second pass as `still_running` and halve the sweep rate.
    assert.equal(await pass.runNow(), "ok");
    assert.equal(await pass.runNow(), "ok");
    assert.equal(started, 2);
  } finally {
    await pass.stop();
  }
});

test("a pass never runs on top of a call that has not answered", async () => {
  let started = 0;
  let release!: () => void;
  let blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcomes: string[] = [];
  const pass = createMaintenancePass<void, string>({
    name: "test pass",
    intervalMs: 60_000,
    timeoutMs: 20,
    settleTimeoutMs: 50,
    run: async () => {
      started += 1;
      await blocked;
    },
    onSuccess: () => "ok",
    onFailure: (failure) => failure.reason,
  });

  try {
    outcomes.push(await pass.runNow());
    // The cap gave up on the first call; the call itself is still in flight, so
    // a second one would leave two commands outstanding against a dependency
    // that has answered neither.
    outcomes.push(await pass.runNow());
    assert.deepEqual(outcomes, ["timed_out", "stalled"]);
    assert.equal(started, 1);

    release();
    blocked = Promise.resolve();
    // A macrotask, so the released call really has answered rather than merely
    // been unblocked: the slot is cleared by a handler on that call.
    await delay(0);
    // And the slot is released the moment the call answers — a sequential
    // caller must not be told the previous pass is still running.
    assert.equal(await pass.runNow(), "ok");
    assert.equal(started, 2);
  } finally {
    await pass.stop();
  }
});

test("a pass still inside its cap is overlapped, not stalled", async () => {
  let started = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcomes: string[] = [];
  const pass = createMaintenancePass<void, string>({
    name: "test pass",
    intervalMs: 5,
    // Deliberately far longer than the interval — the configuration this
    // distinction exists for: `ROOM_CLEANUP_INTERVAL_MS` set below the cap.
    timeoutMs: 60_000,
    settleTimeoutMs: 5_000,
    run: async () => {
      started += 1;
      await blocked;
    },
    onSuccess: () => "ok",
    onFailure: (failure) => {
      outcomes.push(failure.reason);
      return failure.reason;
    },
  });

  // Not awaited: `runNow` occupies the slot synchronously, before its first
  // await, so the next call is guaranteed to meet a pass in flight.
  const inFlight = pass.runNow();

  try {
    assert.equal(await pass.runNow(), "overlapped");
    // The dependency is answering — it is just slower than the interval. A
    // reaper that reports these as failures raises its own alerting rate on a
    // Redis that is perfectly healthy (#262 review).
    assert.deepEqual(new Set(outcomes), new Set(["overlapped"]));
    assert.equal(started, 1);
  } finally {
    release();
    assert.equal(await inFlight, "ok");
    await pass.stop();
  }
});

test("the timer keeps recording outcomes while the dependency is hung", async () => {
  let started = 0;
  const outcomes: string[] = [];
  let sawThree!: () => void;
  const threeOutcomes = new Promise<void>((resolve) => {
    sawThree = resolve;
  });
  const pass = createMaintenancePass<void, string>({
    name: "test pass",
    intervalMs: 5,
    timeoutMs: 5,
    settleTimeoutMs: 20,
    run: () => {
      started += 1;
      return hangForever();
    },
    onSuccess: () => "ok",
    onFailure: (failure) => {
      outcomes.push(failure.reason);
      if (outcomes.length === 3) {
        sawThree();
      }
      return failure.reason;
    },
  });

  try {
    // The point of the whole change: a stalled dependency has to keep producing
    // outcome records. Before #261 this loop produced none — every tick issued
    // another command and none of them ever settled, so the failure series
    // stayed flat and no alert on it could fire.
    await threeOutcomes;
    assert.equal(outcomes[0], "timed_out");
    assert.deepEqual(new Set(outcomes.slice(1)), new Set(["stalled"]));
    // ...while issuing exactly one command, no matter how long the stall lasts.
    assert.equal(started, 1);
  } finally {
    await pass.stop();
  }
});

test("stop() waits for the call in flight", async () => {
  let settled = false;
  let announceStarted!: () => void;
  let releasePass!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releasePass = resolve;
  });

  const pass = createMaintenancePass<void, string>({
    name: "test pass",
    intervalMs: 5,
    timeoutMs: 60_000,
    settleTimeoutMs: 5_000,
    run: async () => {
      announceStarted();
      await blocked;
      // Crossing a macrotask is what gives this test its teeth — a stop() that
      // does not track the call resumes on the microtask queue, which drains
      // before this resumes.
      await delay(0);
      settled = true;
    },
    onSuccess: () => "ok",
    onFailure: (failure) => failure.reason,
  });

  await started;
  const stopped = pass.stop();
  // The next shutdown step closes the Redis connection; returning before the
  // call settles would leave its command racing `redis.quit()`.
  assert.equal(settled, false);
  releasePass();
  await stopped;
  assert.equal(settled, true);
});

test("stop() gives up on a hung call inside its settle budget, and says so", async () => {
  let settled = false;
  const abandoned: Array<{ pendingCalls: number; budgetMs: number }> = [];
  const pass = createMaintenancePass<void, string>({
    name: "test pass",
    intervalMs: 60_000,
    timeoutMs: 10,
    settleTimeoutMs: 20,
    run: async () => {
      await hangForever();
      settled = true;
    },
    onSuccess: () => "ok",
    onFailure: (failure) => failure.reason,
    onSettleTimeout: (info) => {
      abandoned.push(info);
    },
  });

  assert.equal(await pass.runNow(), "timed_out");
  // Bounded, or a stalled Redis turns an orderly shutdown into a step that
  // overruns its timeout and is recorded as failed. This test hangs forever on
  // an unbounded wait.
  await pass.stop();
  assert.equal(settled, false);
  // And bounded is not the same as quiet: the command is still on the
  // connection that shutdown is about to close, and that used to be visible
  // only because the step timed out.
  assert.deepEqual(abandoned, [{ pendingCalls: 1, budgetMs: 20 }]);
});

test("stop() stays quiet when the call answered in time", async () => {
  let abandonedCalls = 0;
  const pass = createMaintenancePass<void, string>({
    name: "test pass",
    intervalMs: 60_000,
    timeoutMs: 20,
    settleTimeoutMs: 20,
    run: async () => undefined,
    onSuccess: () => "ok",
    onFailure: (failure) => failure.reason,
    onSettleTimeout: () => {
      abandonedCalls += 1;
    },
  });

  assert.equal(await pass.runNow(), "ok");
  await pass.stop();
  // An ordinary shutdown must not log a shutdown-degraded line, or the signal
  // means nothing on the one shutdown where it matters.
  assert.equal(abandonedCalls, 0);
});

test("a run that throws synchronously is reported as a failed pass", async () => {
  const failures: MaintenancePassFailure[] = [];
  const pass = createMaintenancePass<void, string>({
    name: "test pass",
    intervalMs: 60_000,
    timeoutMs: 20,
    run: () => {
      throw new Error("no connection");
    },
    onSuccess: () => "ok",
    onFailure: (failure) => {
      failures.push(failure);
      return "failed";
    },
  });

  try {
    assert.equal(await pass.runNow(), "failed");
    assert.deepEqual(
      failures.map((failure) => failure.reason),
      ["run_failed"],
    );
    // And the slot it never occupied stays free.
    assert.equal(await pass.runNow(), "failed");
    assert.equal(failures.length, 2);
  } finally {
    await pass.stop();
  }
});

test("a timer tick does not take the process down when a handler throws", async () => {
  let ticks = 0;
  let sawTick!: () => void;
  const ticked = new Promise<void>((resolve) => {
    sawTick = resolve;
  });
  const pass = createMaintenancePass<void, string>({
    name: "test pass",
    intervalMs: 5,
    timeoutMs: 20,
    run: async () => {
      ticks += 1;
      sawTick();
    },
    onSuccess: () => {
      // A bug in the caller's logging must not surface as an unhandled
      // rejection out of the timer callback.
      throw new Error("logging blew up");
    },
    onFailure: (failure) => failure.reason,
  });

  await ticked;
  await pass.stop();
  assert.ok(ticks >= 1);
});
