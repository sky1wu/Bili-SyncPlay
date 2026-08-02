import assert from "node:assert/strict";
import test from "node:test";
import { createPendingResyncQueue } from "../src/pending-resync-queue.js";

const instantSleep = (): Promise<void> => Promise.resolve();

test("pending resync queue keeps retrying a publish until it lands", async () => {
  // The share-ownership resync is the one broadcast nothing else repeats: the
  // room stopped advancing, so no later `video:share` or `playback:update` will
  // correct a dropped one (#242).
  const attempts: string[] = [];
  const queue = createPendingResyncQueue({
    sleep: instantSleep,
    publish: async (roomCode) => {
      attempts.push(roomCode);
      if (attempts.length < 3) {
        throw new Error("bus rejected");
      }
    },
  });

  queue.request("ROOM01");
  await queue.drain();

  assert.deepEqual(attempts, ["ROOM01", "ROOM01", "ROOM01"]);
  assert.equal(queue.size(), 0);
});

test("pending resync queue gives up only after its whole budget", async () => {
  const abandoned: Array<{ roomCode: string; attempts: number }> = [];
  const failures: number[] = [];
  let attempts = 0;
  const queue = createPendingResyncQueue({
    sleep: instantSleep,
    maxAttempts: 3,
    publish: async () => {
      attempts += 1;
      throw new Error("bus down");
    },
    onAttemptFailed: ({ attempt }) => failures.push(attempt),
    onAbandoned: (info) =>
      abandoned.push({ roomCode: info.roomCode, attempts: info.attempts }),
  });

  queue.request("ROOM01");
  await queue.drain();

  assert.equal(attempts, 3);
  assert.deepEqual(failures, [1, 2]);
  assert.deepEqual(abandoned, [{ roomCode: "ROOM01", attempts: 3 }]);
});

test("pending resync queue collapses repeat requests for one room", async () => {
  const attempts: string[] = [];
  const queue = createPendingResyncQueue({
    sleep: instantSleep,
    publish: async (roomCode) => {
      attempts.push(roomCode);
    },
  });

  queue.request("ROOM01");
  queue.request("ROOM01");
  queue.request("ROOM01");
  await queue.drain();

  // Two publishes, not three. The event carries no payload — the consumer
  // rebuilds the room's CURRENT state — so one publish satisfies every request
  // made before it started; the extra one covers the requests that arrived
  // while the first was already in flight.
  assert.deepEqual(attempts, ["ROOM01", "ROOM01"]);

  // And once the queue is idle, a fresh request costs exactly one publish.
  attempts.length = 0;
  queue.request("ROOM01");
  await queue.drain();
  assert.deepEqual(attempts, ["ROOM01"]);
});

test("pending resync queue publishes again for a request made mid-flight", async () => {
  // The in-flight attempt may be consumed before the change being announced is
  // visible, so a request that arrives during it still owes another publish.
  let releaseFirst: (() => void) | null = null;
  const attempts: string[] = [];
  const queue = createPendingResyncQueue({
    sleep: instantSleep,
    publish: (roomCode) => {
      attempts.push(roomCode);
      if (attempts.length === 1) {
        return new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve();
    },
  });

  queue.request("ROOM01");
  await new Promise((resolve) => setTimeout(resolve, 5));
  queue.request("ROOM01");
  (releaseFirst as (() => void) | null)?.();
  await queue.drain();

  assert.deepEqual(attempts, ["ROOM01", "ROOM01"]);
});

test("pending resync queue treats a hung publish as a failed attempt", async () => {
  let attempts = 0;
  const queue = createPendingResyncQueue({
    sleep: instantSleep,
    attemptTimeoutMs: 10,
    publish: () => {
      attempts += 1;
      // The first call never settles: without a cap it would pin the record and
      // the resync would never be re-sent.
      return attempts === 1 ? new Promise<void>(() => {}) : Promise.resolve();
    },
  });

  queue.request("ROOM01");
  await queue.drain();

  assert.equal(attempts, 2);
});

test("pending resync queue never refuses a room, however long the backlog", async () => {
  // This notification fires precisely because a room stopped advancing, so a
  // room turned away has nothing else coming to fix a `sharedByMemberId` naming
  // a member who is gone. A backlog is reported, never shed (#242 review).
  const backlogged: string[] = [];
  const published: string[] = [];
  let releaseAll: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  const queue = createPendingResyncQueue({
    sleep: instantSleep,
    backlogWarnThreshold: 2,
    publish: async (roomCode) => {
      await gate;
      published.push(roomCode);
    },
    onBacklog: ({ roomCode }) => backlogged.push(roomCode),
  });

  for (const roomCode of ["ROOM01", "ROOM02", "ROOM03", "ROOM04"]) {
    queue.request(roomCode);
  }

  assert.equal(queue.size(), 4, "nothing may be turned away");
  assert.deepEqual(backlogged, ["ROOM03", "ROOM04"], "past the threshold");

  (releaseAll as (() => void) | null)?.();
  await queue.drain();
  assert.deepEqual(published.sort(), ["ROOM01", "ROOM02", "ROOM03", "ROOM04"]);
});

test("pending resync queue still serves a request made while a doomed batch retried", async () => {
  // The batch that gives up describes an EARLIER change; a request that arrived
  // during its retries describes a later one and is owed a publish of its own.
  // Dropping it with the exhausted batch is the same permanent loss this queue
  // exists to prevent (#242).
  const abandoned: string[] = [];
  let attempts = 0;
  let requestedAgain = false;
  const queue = createPendingResyncQueue({
    sleep: instantSleep,
    maxAttempts: 2,
    publish: async (roomCode) => {
      attempts += 1;
      if (attempts <= 2) {
        if (!requestedAgain) {
          requestedAgain = true;
          // Arrives mid-batch, i.e. while the record is still outstanding.
          queue.request(roomCode);
        }
        throw new Error("bus rejected");
      }
    },
    onAbandoned: ({ roomCode }) => abandoned.push(roomCode),
  });

  queue.request("ROOM01");
  await queue.drain();

  assert.deepEqual(abandoned, ["ROOM01"], "the first batch ran out of budget");
  // Attempt 3 is the fresh batch the mid-flight request earned.
  assert.equal(attempts, 3);
  assert.equal(queue.size(), 0);
});

test("pending resync queue stops opening new batches once it is winding down", async () => {
  // Each batch costs a full retry budget, and the drain is otherwise unbounded
  // in how many a record may run — two of them exceed the shutdown step that
  // waits for them, and an overrun step is a FAILED step, after which the bus
  // is torn down anyway (#242 review).
  const attempts: string[] = [];
  let releaseFirst: (() => void) | null = null;
  const queue = createPendingResyncQueue({
    sleep: instantSleep,
    publish: (roomCode) => {
      attempts.push(roomCode);
      if (attempts.length === 1) {
        return new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve();
    },
  });

  queue.request("ROOM01");
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Mid-batch: at runtime this earns a second batch (see the test above).
  queue.request("ROOM01");

  queue.stopAfterCurrentBatch();
  (releaseFirst as (() => void) | null)?.();
  await queue.drain();

  assert.deepEqual(attempts, ["ROOM01"], "the second batch must not open");
  assert.equal(queue.size(), 0);
});
