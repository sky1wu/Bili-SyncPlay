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

test("durable write queue waits for the abandoned command before it retries", async () => {
  // A timed-out attempt races its command rather than aborting it. Starting the
  // next attempt straight away left up to `maxAttempts` uncancellable commands
  // out at once for a single write — and the internal retries never go back
  // through the store's capacity check, so nothing saw them (#242 review).
  let live = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const started: Array<Promise<void>> = [];
  const queue = createDurableWriteQueue({
    maxAttempts: 4,
    sleep: () => Promise.resolve(),
  });

  const outcome = queue.enqueue({
    key: "session-a",
    operationName: "write",
    run: async () => {
      const command = new Promise<void>((resolve) => {
        live += 1;
        peak = Math.max(peak, live);
        releases.push(() => {
          live -= 1;
          resolve();
        });
      });
      started.push(command);
      // Stands in for the raced attempt timeout: the attempt gives up while the
      // command it started is still running.
      throw new Error("attempt timed out");
    },
    settle: async () => {
      await Promise.all(started);
    },
  });
  outcome.catch(() => undefined);

  // Let every retry that is going to happen happen.
  for (let tick = 0; tick < 8; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    releases.shift()?.();
  }
  await assert.rejects(outcome, /timed out/);

  assert.equal(peak, 1, `one live command per write at a time, saw ${peak}`);
});

test("durable write queue answers queued writes as soon as it is told to stop", async () => {
  // A write queued behind a key whose command never comes back was out of reach
  // of the stop check: `close()` then sat on an outcome that could never settle
  // and the shutdown step was guaranteed to overrun (#242 review).
  // `maxAttempts: 1`, so the first write is ANSWERED while its command is still
  // out; with retries it would be blocked on that same command by design.
  const queue = createDurableWriteQueue({
    maxAttempts: 1,
    sleep: () => Promise.resolve(),
  });
  let releaseCommand: (() => void) | null = null;
  const command = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });

  const first = queue.enqueue({
    key: "session-a",
    operationName: "first",
    run: async () => {
      // Stands in for the raced attempt timeout: answered, command still out.
      throw new Error("attempt timed out");
    },
    settle: () => command,
  });
  first.catch(() => undefined);
  await assert.rejects(first, /timed out/);

  let secondRan = false;
  const second = queue.enqueue({
    key: "session-a",
    operationName: "second",
    run: async () => {
      secondRan = true;
    },
  });
  second.catch(() => undefined);

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(secondRan, false, "it is queued behind the live command");

  queue.stopRetrying();
  // Answered immediately, without waiting for the command that will not answer.
  await assert.rejects(second, /shutting down/);
  assert.equal(secondRan, false, "and it must not run either");

  (releaseCommand as (() => void) | null)?.();
  await queue.drain();
});
