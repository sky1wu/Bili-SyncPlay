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

test("pending resync queue never gives up on a record by itself", async () => {
  // A per-record attempt budget is just a slower way to discard the
  // notification: the room is idle by definition, so nothing follows the
  // give-up and its clients keep a `sharedByMemberId` naming a member who left
  // (#242 review). Only an explicit stop ends the retries.
  const failures: number[] = [];
  let attempts = 0;
  const queue = createPendingResyncQueue({
    sleep: instantSleep,
    publish: async () => {
      attempts += 1;
      if (attempts < 25) {
        throw new Error("bus down");
      }
    },
    onAttemptFailed: ({ attempt }) => failures.push(attempt),
  });

  queue.request("ROOM01");
  await queue.drain();

  // Well past any budget a bounded queue would have had.
  assert.equal(attempts, 25);
  assert.equal(failures.length, 24);
  assert.equal(queue.size(), 0);
});

test("pending resync queue keeps knocking at the backoff ceiling", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const queue = createPendingResyncQueue({
    initialRetryDelayMs: 10,
    maxRetryDelayMs: 40,
    sleep: (delayMs) => {
      delays.push(delayMs);
      return Promise.resolve();
    },
    publish: async () => {
      attempts += 1;
      if (attempts < 6) {
        throw new Error("bus down");
      }
    },
  });

  queue.request("ROOM01");
  await queue.drain();

  // Exponential, then flat — it settles into a pace rather than giving up.
  assert.deepEqual(delays, [10, 20, 40, 40, 40]);
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

test("pending resync queue keeps at most one publish in flight per room", async () => {
  // The attempt cap races the bus call; it cannot abort it. With an unbounded
  // retry loop behind it, starting a fresh publish on every timeout piles up
  // one in-flight Redis command per retry for as long as the bus stays hung,
  // and every one of them then spills into `roomEventBus.close()` (#242 review).
  let calls = 0;
  const queue = createPendingResyncQueue({
    sleep: instantSleep,
    attemptTimeoutMs: 5,
    publish: () => {
      calls += 1;
      // Never settles: the bus is hung rather than rejecting.
      return new Promise<void>(() => {});
    },
  });

  queue.request("ROOM01");
  // Long enough for many attempt windows to have elapsed.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls, 1, "the record must wait, not pile on");

  queue.stopRetrying();
  await queue.drain();
  assert.equal(calls, 1);
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

test("pending resync queue stops on demand so shutdown is bounded", async () => {
  // `drain` is unbounded by design — records retry until they land — so the
  // shutdown step calls `stopRetrying` first, leaving at most ONE in-flight
  // attempt to wait for (#242 review).
  let attempts = 0;
  let releaseFirst: (() => void) | null = null;
  const queue = createPendingResyncQueue({
    sleep: instantSleep,
    publish: () => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise<void>((_resolve, reject) => {
          releaseFirst = () => reject(new Error("bus down"));
        });
      }
      return Promise.reject(new Error("bus down"));
    },
  });

  queue.request("ROOM01");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(attempts, 1);

  queue.stopRetrying();
  (releaseFirst as (() => void) | null)?.();
  await queue.drain();

  assert.equal(attempts, 1, "the in-flight attempt must be the last one");
  assert.equal(queue.size(), 0);
});

test("pending resync queue waits out its abandoned calls before the drain returns", async () => {
  // "We stopped retrying" is not "the call came back", and the bus is closed
  // straight after the drain (#242 review).
  const order: string[] = [];
  let releasePublish: (() => void) | null = null;
  const queue = createPendingResyncQueue({
    sleep: instantSleep,
    // Small, so the record itself stops promptly and the ONLY thing that can
    // still hold the drain is the abandoned call.
    attemptTimeoutMs: 5,
    abandonedDrainTimeoutMs: 1_000,
    publish: () =>
      new Promise<void>((resolve) => {
        releasePublish = () => {
          order.push("publish-settled");
          resolve();
        };
      }),
  });

  queue.request("ROOM01");
  await new Promise((resolve) => setTimeout(resolve, 20));
  queue.stopRetrying();

  const drained = queue.drain().then(() => {
    order.push("drain-returned");
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  (releasePublish as (() => void) | null)?.();
  await drained;

  assert.deepEqual(order, ["publish-settled", "drain-returned"]);
});

test("pending resync queue bounds how long it waits for an abandoned call", async () => {
  // Bounded, because an unbounded wait would only move the shutdown overrun
  // from the bus close to this step.
  const queue = createPendingResyncQueue({
    sleep: instantSleep,
    attemptTimeoutMs: 5,
    // Never answers at all.
    publish: () => new Promise<void>(() => {}),
  });

  queue.request("ROOM01");
  await new Promise((resolve) => setTimeout(resolve, 20));
  queue.stopRetrying();
  await queue.drain();

  assert.equal(queue.size(), 0);
});

test("pending resync queue caps how many rooms it publishes at once", async () => {
  // The backlog is uncapped on purpose, so without a concurrency limit a bus
  // that recovers after a long outage turns every retained record into a
  // simultaneous publish — an unbounded backlog becoming an unbounded burst,
  // and one that bypasses `firePublishRoomEvent`'s own cap (#242 review).
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const queue = createPendingResyncQueue({
    sleep: instantSleep,
    maxConcurrentPublishes: 3,
    publish: () => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise<void>((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve();
        });
      });
    },
  });

  for (let index = 0; index < 20; index += 1) {
    queue.request(`ROOM${index}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(queue.size(), 20, "every room keeps its record");
  assert.equal(peak, 3, `at most 3 publishes at once, saw ${peak}`);

  while (releases.length > 0) {
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await queue.drain();
  assert.equal(peak, 3);
});
