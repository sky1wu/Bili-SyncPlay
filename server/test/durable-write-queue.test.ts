import assert from "node:assert/strict";
import test from "node:test";
import {
  createDurableWriteQueue,
  NonRetryableWriteError,
  SupersededWriteError,
} from "../src/durable-write-queue.js";

/** Runs the backoff instantly and records what the queue asked to wait. */
function createSleepRecorder(): {
  delays: number[];
  sleep: (delayMs: number) => Promise<void>;
} {
  const delays: number[] = [];
  return {
    delays,
    sleep: (delayMs) => {
      delays.push(delayMs);
      return Promise.resolve();
    },
  };
}

test("durable write queue retries a failed write instead of dropping it", async () => {
  const { delays, sleep } = createSleepRecorder();
  const queue = createDurableWriteQueue({
    sleep,
    initialRetryDelayMs: 10,
    maxRetryDelayMs: 40,
  });
  let attempts = 0;

  await queue.enqueue({
    key: "session-a",
    operationName: "write",
    run: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("redis blip");
      }
    },
  });

  assert.equal(attempts, 3);
  // Exponential, capped.
  assert.deepEqual(delays, [10, 20]);
});

test("durable write queue reports the failure once the attempts run out", async () => {
  const { sleep } = createSleepRecorder();
  const queue = createDurableWriteQueue({ sleep, maxAttempts: 2 });
  let attempts = 0;

  await assert.rejects(
    queue.enqueue({
      key: "session-a",
      operationName: "write",
      run: async () => {
        attempts += 1;
        throw new Error("redis down");
      },
    }),
    /redis down/,
  );
  assert.equal(attempts, 2);
});

test("durable write queue does not retry a write that can never apply", async () => {
  const { sleep } = createSleepRecorder();
  const queue = createDurableWriteQueue({ sleep, maxAttempts: 5 });
  let attempts = 0;

  await assert.rejects(
    queue.enqueue({
      key: "session-a",
      operationName: "write",
      run: async () => {
        attempts += 1;
        throw new NonRetryableWriteError("code recycled", "generation");
      },
    }),
    /code recycled/,
  );
  assert.equal(attempts, 1);
});

test("durable write queue keeps writes for one key strictly ordered", async () => {
  const queue = createDurableWriteQueue();
  const order: string[] = [];
  const release: Array<() => void> = [];

  const first = queue.enqueue({
    key: "session-a",
    operationName: "first",
    run: () =>
      new Promise<void>((resolve) => {
        order.push("first-start");
        release.push(() => {
          order.push("first-end");
          resolve();
        });
      }),
  });
  const second = queue.enqueue({
    key: "session-a",
    operationName: "second",
    run: async () => {
      order.push("second-start");
    },
  });

  // The second write must not have started while the first was running.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ["first-start"]);
  release[0]?.();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("durable write queue abandons a retry once a newer write for the key arrives", async () => {
  // A retry that outlives the write meant to replace it fights it rather than
  // helping it — the newer write is the one describing the state the caller
  // wants (#242).
  let releaseSleep: (() => void) | null = null;
  const queue = createDurableWriteQueue({
    maxAttempts: 5,
    sleep: () =>
      new Promise<void>((resolve) => {
        releaseSleep = resolve;
      }),
  });
  let staleAttempts = 0;

  const stale = queue.enqueue({
    key: "session-a",
    operationName: "stale",
    run: async () => {
      staleAttempts += 1;
      throw new Error("redis blip");
    },
  });
  stale.catch(() => undefined);
  // Let the first attempt fail and park in the backoff.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(staleAttempts, 1);

  const fresh = queue.enqueue({
    key: "session-a",
    operationName: "fresh",
    run: async () => undefined,
  });
  (releaseSleep as (() => void) | null)?.();

  await assert.rejects(stale, SupersededWriteError);
  await fresh;
  assert.equal(staleAttempts, 1, "the superseded write must not try again");
});

test("durable write queue separates draining from confirming", async () => {
  const queue = createDurableWriteQueue({
    maxAttempts: 1,
    sleep: () => Promise.resolve(),
  });
  const failed = queue.enqueue({
    key: "session-a",
    operationName: "write",
    run: async () => {
      throw new Error("redis down");
    },
  });
  failed.catch(() => undefined);

  // Draining says only that the queue emptied — the conflation #242 ends.
  await queue.drain();
  assert.equal(queue.size(), 0);
  await assert.rejects(queue.confirm(), /not confirmed/);
});

test("durable write queue remembers a failure until it is confirmed away", async () => {
  const queue = createDurableWriteQueue({
    maxAttempts: 1,
    sleep: () => Promise.resolve(),
  });
  queue
    .enqueue({
      key: "session-a",
      operationName: "write",
      run: async () => {
        throw new Error("redis down");
      },
    })
    .catch(() => undefined);
  await queue.drain();

  await assert.rejects(queue.confirm(), /not confirmed/);
  // Reading clears it: the answer is "since you last asked".
  await queue.confirm();
});

test("durable write queue does not count a superseded write as unconfirmed", async () => {
  let releaseSleep: (() => void) | null = null;
  const queue = createDurableWriteQueue({
    maxAttempts: 5,
    sleep: () =>
      new Promise<void>((resolve) => {
        releaseSleep = resolve;
      }),
  });

  const stale = queue.enqueue({
    key: "session-a",
    operationName: "stale",
    run: async () => {
      throw new Error("redis blip");
    },
  });
  stale.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const fresh = queue.enqueue({
    key: "session-a",
    operationName: "fresh",
    run: async () => undefined,
  });
  (releaseSleep as (() => void) | null)?.();
  await assert.rejects(stale, SupersededWriteError);
  await fresh;

  // The newer write landed, so the key IS in the state the caller wanted.
  await queue.confirm();
});

test("durable write queue drops writes that have not started once it is winding down", async () => {
  // A queue can hold several writes for one session, and they run one at a
  // time. Letting each still open an attempt held the close step for a whole
  // attempt timeout apiece, so the step overran and the process exited non-zero
  // over writes nobody was waiting for (#242 review). What survives
  // `stopRetrying` is bounded by ONE attempt: the one already running.
  const started: string[] = [];
  let releaseFirst: (() => void) | null = null;
  const queue = createDurableWriteQueue({ sleep: () => Promise.resolve() });

  const first = queue.enqueue({
    key: "session-a",
    operationName: "first",
    run: () =>
      new Promise<void>((resolve) => {
        started.push("first");
        releaseFirst = resolve;
      }),
  });
  const queued = ["second", "third"].map((operationName) => {
    const outcome = queue.enqueue({
      key: "session-a",
      operationName,
      run: async () => {
        started.push(operationName);
      },
    });
    outcome.catch(() => undefined);
    return outcome;
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(started, ["first"], "only the first write may be running");

  queue.stopRetrying();
  (releaseFirst as (() => void) | null)?.();

  await first;
  for (const outcome of queued) {
    await assert.rejects(outcome, /shutting down/);
  }
  assert.deepEqual(started, ["first"]);
});

test("durable write queue holds the key until an abandoned command really finishes", async () => {
  // A timeout races a command, it cannot abort one. Releasing the key when the
  // caller is answered lets the compensating write — queued on this same key —
  // run FIRST, and the abandoned command then lands on top of its own rollback
  // (#242 review).
  const order: string[] = [];
  let releaseAbandoned: (() => void) | null = null;
  const queue = createDurableWriteQueue({
    maxAttempts: 1,
    sleep: () => Promise.resolve(),
  });

  const abandonedCommand = new Promise<void>((resolve) => {
    releaseAbandoned = () => {
      order.push("abandoned-command-landed");
      resolve();
    };
  });

  const gaveUp = queue.enqueue({
    key: "session-a",
    operationName: "join",
    run: async () => {
      // Stands in for the raced timeout: the attempt reports failure while the
      // command it started keeps going.
      throw new Error("attempt timed out");
    },
    settle: () => abandonedCommand,
  });
  await assert.rejects(gaveUp, /timed out/);
  order.push("caller-answered");

  // The rollback the caller now performs.
  const rollback = queue.enqueue({
    key: "session-a",
    operationName: "leave",
    run: async () => {
      order.push("rollback-ran");
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ["caller-answered"], "the rollback must wait");

  (releaseAbandoned as (() => void) | null)?.();
  await rollback;

  assert.deepEqual(order, [
    "caller-answered",
    "abandoned-command-landed",
    "rollback-ran",
  ]);
});
