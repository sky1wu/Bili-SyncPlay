import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createNodeHeartbeat,
  heartbeatTimeoutMs,
  type NodeHeartbeatRuntimeStore,
} from "../src/node-heartbeat.js";
import { createRedisRuntimeStore } from "../src/redis-runtime-store.js";
import type { ClusterNodeStatus } from "../src/types.js";

const REDIS_URL = process.env.REDIS_URL;

/**
 * Honest fixture: `NodeHeartbeatRuntimeStore` is the narrow slice a beat
 * touches, so this satisfies it without a cast.
 */
function createStubRuntimeStore(
  heartbeatNode: (status: ClusterNodeStatus) => Promise<void>,
): NodeHeartbeatRuntimeStore {
  return {
    getStartedAt: () => 1,
    getConnectionCount: () => 2,
    getActiveRoomCount: () => 3,
    getActiveMemberCount: () => 4,
    heartbeatNode,
  };
}

function createKeyPrefix(): string {
  return `bsp:test:heartbeat:${Date.now()}:${Math.random().toString(16).slice(2)}:`;
}

test("node heartbeat writes shared node status into redis runtime store", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  let currentTime = 1_000;
  const instanceId = `node-heartbeat-${Date.now().toString(36)}`;
  const keyPrefix = createKeyPrefix();
  const sharedRuntimeStore = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    now: () => currentTime,
  });
  const heartbeat = createNodeHeartbeat({
    enabled: true,
    instanceId,
    serviceVersion: "test-version",
    runtimeStore: sharedRuntimeStore,
    intervalMs: 50,
    ttlMs: 200,
    now: () => currentTime,
  });

  try {
    await heartbeat.beat();

    let statuses = await sharedRuntimeStore.listNodeStatuses(
      "maintenance_pass",
      currentTime,
    );
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]?.instanceId, instanceId);
    assert.equal(statuses[0]?.version, "test-version");
    assert.equal(statuses[0]?.health, "ok");

    currentTime += 120;
    statuses = await sharedRuntimeStore.listNodeStatuses(
      "maintenance_pass",
      currentTime,
    );
    assert.equal(statuses[0]?.health, "stale");

    currentTime += 120;
    statuses = await sharedRuntimeStore.listNodeStatuses(
      "maintenance_pass",
      currentTime,
    );
    assert.equal(statuses[0]?.health, "offline");
  } finally {
    await heartbeat.stop();
    await sharedRuntimeStore.close();
  }
});

test("a beat hung on Redis is reported instead of leaving both series silent", async () => {
  const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
  let started = 0;
  const heartbeat = createNodeHeartbeat({
    enabled: true,
    instanceId: "node-a",
    serviceVersion: "test-version",
    // A half-open connection: `heartbeatNode` is a direct MULTI on the shared
    // store — it does not go through the write queue, so nothing on that path
    // bounds it and no error ever comes back (#263).
    runtimeStore: createStubRuntimeStore(() => {
      started += 1;
      return new Promise(() => undefined);
    }),
    // Interval 100ms, TTL 300ms, so the cap is 50ms: half an interval, a third
    // of the TTL.
    intervalMs: 100,
    ttlMs: 300,
    now: () => 10,
    logEvent: (event, data) => {
      logged.push({ event, data });
    },
  });

  try {
    // Before the cap this never returned. No `node_heartbeat_sent`, and — the
    // part that made it invisible — no `node_heartbeat_failed` either: the
    // `.catch` on the beat was never reached, so the node aged out of the
    // cluster index while its own logs said nothing at all.
    await heartbeat.beat();
    // And a second beat must not put another EXEC on a connection that has
    // answered neither.
    await heartbeat.beat();
  } finally {
    await heartbeat.stop();
  }

  assert.equal(started, 1);
  assert.deepEqual(
    logged.map((entry) => entry.event),
    [
      "node_heartbeat_failed",
      "node_heartbeat_failed",
      // stop() returns on its budget rather than waiting the stall out, and
      // says so: `close_runtime_store` is about to quit that connection.
      "node_heartbeat_abandoned_at_shutdown",
    ],
  );
  assert.deepEqual(
    logged
      .filter((entry) => entry.event === "node_heartbeat_failed")
      .map((entry) => entry.data.reason),
    ["node_heartbeat_write_timeout", "node_heartbeat_write_stalled"],
  );
  assert.equal(logged[0]?.data.timeoutMs, 50);
  assert.equal(logged[2]?.data.pendingBeats, 1);
});

test("a beat that threw keeps its own reason and does not name the cap", async () => {
  const logged: Array<Record<string, unknown>> = [];
  const heartbeat = createNodeHeartbeat({
    enabled: true,
    instanceId: "node-a",
    serviceVersion: "test-version",
    runtimeStore: createStubRuntimeStore(() => {
      throw new Error("redis is gone");
    }),
    intervalMs: 100,
    ttlMs: 300,
    now: () => 10,
    logEvent: (_event, data) => {
      logged.push(data);
    },
  });

  try {
    await heartbeat.beat();
  } finally {
    await heartbeat.stop();
  }

  assert.equal(logged[0]?.reason, "node_heartbeat_write_failed");
  assert.equal(logged[0]?.error, "redis is gone");
  assert.equal("timeoutMs" in (logged[0] ?? {}), false);
});

test("start() beats immediately, not one interval from now", async () => {
  const beats: ClusterNodeStatus[] = [];
  let announceFirst!: () => void;
  const firstBeat = new Promise<void>((resolve) => {
    announceFirst = resolve;
  });
  const heartbeat = createNodeHeartbeat({
    enabled: true,
    instanceId: "node-a",
    serviceVersion: "test-version",
    runtimeStore: createStubRuntimeStore(async (status) => {
      beats.push(status);
      announceFirst();
    }),
    // Far longer than this test will wait, so only the beat `start()` fires
    // itself can satisfy it. With a short interval the timer would cover for a
    // `start()` that had dropped the immediate beat, and the test would pass on
    // a regression.
    intervalMs: 60_000,
    ttlMs: 180_000,
    now: () => 10,
  });

  try {
    heartbeat.start();
    // The cluster index has to carry this node from the moment it starts
    // serving; waiting a whole interval leaves other nodes free to treat a
    // healthy new node as absent.
    await firstBeat;
    assert.equal(beats[0]?.instanceId, "node-a");
    assert.equal(beats[0]?.connectionCount, 2);
    // staleAt is two intervals out — one missed beat is not yet news — capped
    // by the TTL and floored at a single interval; expiresAt is the full TTL.
    // Both are stamped from the same instant the beat was built.
    assert.equal(beats[0]?.staleAt, 120_010);
    assert.equal(beats[0]?.expiresAt, 180_010);
  } finally {
    await heartbeat.stop();
  }
});

test("stop() ends the timer", async () => {
  let beats = 0;
  let announceSecond!: () => void;
  const twoBeats = new Promise<void>((resolve) => {
    announceSecond = resolve;
  });
  const heartbeat = createNodeHeartbeat({
    enabled: true,
    instanceId: "node-a",
    serviceVersion: "test-version",
    runtimeStore: createStubRuntimeStore(async () => {
      beats += 1;
      if (beats === 2) {
        announceSecond();
      }
    }),
    intervalMs: 5,
    ttlMs: 300,
    now: () => 10,
  });

  // The beat timer is deliberately `unref`'d — a heartbeat is not work the
  // process should stay alive for. In the server the HTTP listener holds the
  // loop open; here nothing does, so without this the loop drains and the wait
  // below never resolves.
  const keepLoopAlive = setInterval(() => undefined, 1_000);

  try {
    heartbeat.start();
    // Waits for the timer to have fired rather than asserting a count after a
    // fixed window: Node does not replay ticks missed while the event loop was
    // stalled, so a short window makes a correct implementation fail under
    // load.
    await twoBeats;
    await heartbeat.stop();

    const atStop = beats;
    await delay(40);
    // Or shutdown leaves a handle beating against a store that is being closed.
    assert.equal(beats, atStop);
  } finally {
    clearInterval(keepLoopAlive);
  }
});

test("stop() waits for the beat in flight", async () => {
  let settled = false;
  let announceStarted!: () => void;
  let releaseBeat!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseBeat = resolve;
  });

  const heartbeat = createNodeHeartbeat({
    enabled: true,
    instanceId: "node-a",
    serviceVersion: "test-version",
    runtimeStore: createStubRuntimeStore(async () => {
      announceStarted();
      await blocked;
      // Crossing a macrotask is what gives this test its teeth — see the
      // matching note in maintenance-pass.test.ts.
      await delay(0);
      settled = true;
    }),
    // Long enough that the beat is still inside its cap when stop() runs.
    intervalMs: 60_000,
    ttlMs: 180_000,
    now: () => 10,
  });

  heartbeat.start();
  await started;
  const stopped = heartbeat.stop();
  // `close_runtime_store` follows this step; returning before the beat settles
  // would leave its EXEC racing `redis.quit()`.
  assert.equal(settled, false);
  releaseBeat();
  await stopped;
  assert.equal(settled, true);
});

test("a disabled heartbeat neither beats nor arms a timer", async () => {
  let beats = 0;
  const heartbeat = createNodeHeartbeat({
    enabled: false,
    instanceId: "node-a",
    serviceVersion: "test-version",
    runtimeStore: createStubRuntimeStore(async () => {
      beats += 1;
    }),
    intervalMs: 5,
    ttlMs: 300,
    now: () => 10,
  });

  heartbeat.start();
  await heartbeat.beat();
  await delay(30);
  await heartbeat.stop();
  assert.equal(beats, 0);
});

test("the beat cap lands before anything else can call this node late", () => {
  // The two settings that decide what a late beat costs. `staleAt` is one
  // interval out and `expiresAt` a full TTL, so a cap at or above either would
  // report a timeout nobody could still act on.
  assert.equal(heartbeatTimeoutMs(15_000, 45_000), 7_500);
  // TTL-bound: a deployment that beats rarely relative to its TTL must not
  // inherit a cap that outlives the expiry.
  assert.equal(heartbeatTimeoutMs(60_000, 45_000), 15_000);
  // Never above the interval, which is what makes the tick after a timeout a
  // `stalled` rather than an `overlapped`. Equal only in the degenerate case
  // where the 1ms floor is doing the work.
  for (const [intervalMs = 0, ttlMs = 0] of [
    [15_000, 45_000],
    [60_000, 45_000],
    [100, 300],
  ]) {
    assert.ok(heartbeatTimeoutMs(intervalMs, ttlMs) < intervalMs);
  }
  // The floor: a sub-millisecond cap would fire before the write left the
  // process, turning every beat into a timeout.
  assert.equal(heartbeatTimeoutMs(1, 1), 1);
});

test("start() is idempotent", async () => {
  let beats = 0;
  const logged: string[] = [];
  let announceFirst!: () => void;
  const firstBeat = new Promise<void>((resolve) => {
    announceFirst = resolve;
  });
  const heartbeat = createNodeHeartbeat({
    enabled: true,
    instanceId: "node-a",
    serviceVersion: "test-version",
    runtimeStore: createStubRuntimeStore(async () => {
      beats += 1;
      announceFirst();
    }),
    // Long enough that the timer cannot account for any beat below.
    intervalMs: 60_000,
    ttlMs: 180_000,
    now: () => 10,
    logEvent: (event) => logged.push(event),
  });

  try {
    heartbeat.start();
    // Two calls while the first beat is still in flight. The overlap guard
    // absorbs the beat itself, but it reports each one — a `start()` that is
    // not idempotent turns an idle restart path into skipped-beat noise.
    heartbeat.start();
    heartbeat.start();
    await firstBeat;
    // And once the beat has ANSWERED the guard no longer absorbs anything: this
    // is where a non-idempotent start() puts a second write on Redis. The old
    // implementation returned early on an existing timer; guarding only the
    // driver's timer would drop that guarantee, because `pass.start()` is
    // idempotent while the immediate beat beside it is not.
    await delay(0);
    heartbeat.start();
    await delay(0);

    assert.equal(beats, 1);
    assert.deepEqual(logged, ["node_heartbeat_sent"]);
  } finally {
    await heartbeat.stop();
  }
});

test("the beat timer does not hold the process open", async () => {
  const countRefdTimers = (): number =>
    process.getActiveResourcesInfo().filter((kind) => kind === "Timeout")
      .length;
  const heartbeat = createNodeHeartbeat({
    enabled: true,
    instanceId: "node-a",
    serviceVersion: "test-version",
    runtimeStore: createStubRuntimeStore(async () => undefined),
    intervalMs: 60_000,
    ttlMs: 180_000,
    now: () => 10,
  });

  // No awaits between the samples: `start()` arms the interval AND fires the
  // immediate beat, so exactly one ref'd timer is expected — the cap on that
  // beat, which clears as soon as it answers. A beat timer that had lost its
  // `unref` would make this two, and would keep a process alive that has
  // nothing else to do.
  const before = countRefdTimers();
  heartbeat.start();
  const after = countRefdTimers();

  try {
    assert.equal(after, before + 1);
  } finally {
    await heartbeat.stop();
  }
});

test("start() works again after stop()", async () => {
  let beats = 0;
  let announce!: () => void;
  let beaten = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const heartbeat = createNodeHeartbeat({
    enabled: true,
    instanceId: "node-a",
    serviceVersion: "test-version",
    runtimeStore: createStubRuntimeStore(async () => {
      beats += 1;
      announce();
    }),
    // Long enough that only the beat `start()` fires itself can be counted.
    intervalMs: 60_000,
    ttlMs: 180_000,
    now: () => 10,
  });

  heartbeat.start();
  await beaten;
  await heartbeat.stop();

  beaten = new Promise<void>((resolve) => {
    announce = resolve;
  });
  // A stopped heartbeat has to be startable again — `MaintenancePass.stop()`
  // clears its own timer for that reason, and the pre-driver implementation
  // reset its `timer` here. An idempotence flag that never resets would make
  // this silently do nothing, and the node would age out of the cluster index
  // with nothing in its log to say why.
  heartbeat.start();
  await beaten;

  try {
    assert.equal(beats, 2);
  } finally {
    await heartbeat.stop();
  }
});
