import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { buildBenchmarkResult } from "../../bench/lib/cli.js";
import { ensureRedis } from "../../bench/lib/redis-harness.js";
import {
  createBenchMessageCollector,
  runPlaybackBroadcastBenchmark,
  runReconnectStormBenchmark,
} from "../../bench/lib/room-bench.js";
import {
  calculateErrorRate,
  summarizeLatencies,
  summarizeThroughput,
} from "../../bench/lib/stats.js";
import { type RawData } from "ws";

class FakeMessageSocket extends EventEmitter {
  emitMessage(message: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(message)) as RawData);
  }
}

test("benchmark stats summarize percentile and throughput fields deterministically", () => {
  assert.deepEqual(summarizeLatencies([12, 10, 20, 18, 14]), {
    sampleCount: 5,
    minMs: 10,
    meanMs: 14.8,
    p50Ms: 14,
    p95Ms: 20,
    p99Ms: 20,
    maxMs: 20,
  });

  assert.deepEqual(
    summarizeThroughput({
      attempted: 40,
      completed: 36,
      durationMs: 4_000,
    }),
    {
      attempted: 40,
      completed: 36,
      durationSeconds: 4,
      attemptedPerSecond: 10,
      completedPerSecond: 9,
    },
  );
  assert.equal(calculateErrorRate(4, 40), 10);
});

test("benchmark result uses a stable JSON-friendly schema", () => {
  const result = buildBenchmarkResult({
    scenario: "single-node-room",
    startedAtMs: Date.UTC(2026, 3, 22, 10, 0, 0),
    completedAtMs: Date.UTC(2026, 3, 22, 10, 0, 5),
    attempted: 80,
    completed: 76,
    errors: 4,
    latencySamplesMs: [8, 10, 12, 14],
    config: { memberCount: 100, updatesPerSecond: 10 },
    notes: ["sampled watchers"],
  });

  assert.deepEqual(result, {
    schemaVersion: 1,
    scenario: "single-node-room",
    startedAt: "2026-04-22T10:00:00.000Z",
    completedAt: "2026-04-22T10:00:05.000Z",
    config: { memberCount: 100, updatesPerSecond: 10 },
    metrics: {
      throughput: {
        attempted: 80,
        completed: 76,
        durationSeconds: 5,
        attemptedPerSecond: 16,
        completedPerSecond: 15.2,
      },
      latency: {
        sampleCount: 4,
        minMs: 8,
        meanMs: 11,
        p50Ms: 10,
        p95Ms: 14,
        p99Ms: 14,
        maxMs: 14,
      },
      errorRatePercent: 5,
      errors: 4,
    },
    notes: ["sampled watchers"],
  });
});

test("playback benchmark skips drain bookkeeping when no watchers are sampled", async () => {
  const benchmark = await runPlaybackBroadcastBenchmark({
    scenario: "single-node-room",
    memberCount: 1,
    durationSeconds: 0.1,
    updatesPerSecond: 1,
    watcherCount: 0,
  });

  assert.equal(benchmark.watcherCount, 0);
  assert.equal(benchmark.attempted, 0);
  assert.equal(benchmark.completed, 0);
  assert.equal(benchmark.errors, 0);
  assert.equal(benchmark.latencySamplesMs.length, 0);
  assert.equal(
    benchmark.completedAtMs - benchmark.startedAtMs < 3_000,
    true,
    "benchmark should not spend 5s draining empty pending watcher sets",
  );
});

test("playback benchmark clamps sampled watcher count to zero", async () => {
  const benchmark = await runPlaybackBroadcastBenchmark({
    scenario: "single-node-room",
    memberCount: 3,
    durationSeconds: 0.1,
    updatesPerSecond: 1,
    watcherCount: -1,
  });

  assert.equal(benchmark.watcherCount, 0);
  assert.equal(benchmark.attempted, 0);
  assert.equal(benchmark.completed, 0);
  assert.equal(benchmark.errors, 0);
});

test("benchmark completion timestamp excludes cleanup overhead", async () => {
  const benchmark = await runPlaybackBroadcastBenchmark({
    scenario: "single-node-room",
    memberCount: 1,
    durationSeconds: 0.1,
    updatesPerSecond: 1,
    watcherCount: 0,
  });

  assert.equal(
    benchmark.completedAtMs - benchmark.startedAtMs < 3_000,
    true,
    "benchmark completion time should be recorded before async cleanup runs",
  );
});

test("playback benchmark supports member counts above default room and IP limits", async () => {
  const benchmark = await runPlaybackBroadcastBenchmark({
    scenario: "single-node-room",
    memberCount: 12,
    durationSeconds: 0.1,
    updatesPerSecond: 1,
    watcherCount: 0,
  });

  assert.equal(benchmark.watcherCount, 0);
  assert.equal(benchmark.attempted, 0);
  assert.equal(benchmark.errors, 0);
});

test("playback benchmark lifts playback rate limits to match benchmark load", async () => {
  const benchmark = await runPlaybackBroadcastBenchmark({
    scenario: "single-node-room",
    memberCount: 12,
    durationSeconds: 1,
    updatesPerSecond: 10,
    watcherCount: 1,
  });

  assert.equal(benchmark.attempted, 10);
  assert.equal(benchmark.completed, 10);
  assert.equal(benchmark.errors, 0);
});

test("bench collector keeps only tracked message types and caps buffered states", async () => {
  const socket = new FakeMessageSocket();
  const collector = createBenchMessageCollector(socket, {
    trackedTypes: ["room:state"],
    maxQueuePerType: 1,
  });

  try {
    socket.emitMessage({ type: "room:joined", payload: { ignored: true } });
    socket.emitMessage({ type: "room:state", payload: { seq: 1 } });
    socket.emitMessage({ type: "room:state", payload: { seq: 2 } });

    const state = await collector.next("room:state");
    assert.deepEqual(state.payload, { seq: 2 });
    assert.equal(await collector.maybeNext("room:joined", 50), null);
  } finally {
    collector.detach();
  }
});

test("bench collector delivers awaited room state without buffering a storm", async () => {
  const socket = new FakeMessageSocket();
  const collector = createBenchMessageCollector(socket, {
    trackedTypes: ["room:state"],
    maxQueuePerType: 1,
  });

  try {
    const statePromise = collector.next("room:state", 200);
    socket.emitMessage({ type: "room:state", payload: { seq: 1 } });
    socket.emitMessage({ type: "room:state", payload: { seq: 2 } });

    const state = await statePromise;
    assert.deepEqual(state.payload, { seq: 1 });
  } finally {
    collector.detach();
  }
});

test("ensureRedis reports a controlled startup error when redis-server is unavailable", async () => {
  const originalPath = process.env.PATH;
  const originalRedisUrl = process.env.REDIS_URL;
  process.env.PATH = "";
  delete process.env.REDIS_URL;

  try {
    await assert.rejects(
      () => ensureRedis(true),
      /Failed to start redis-server|Make sure redis-server is installed or set REDIS_URL/,
    );
  } finally {
    process.env.PATH = originalPath;
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  }
});

test("reconnect benchmark completion timestamp excludes cleanup overhead", async () => {
  const benchmark = await runReconnectStormBenchmark({
    memberCount: 4,
    reconnectTimeoutMs: 3_000,
  });

  assert.equal(benchmark.attempted, 4);
  assert.equal(
    benchmark.completedAtMs - benchmark.startedAtMs < 3_000,
    true,
    "reconnect benchmark completion time should be recorded before async cleanup runs",
  );
});

test("reconnect benchmark supports member counts above default room and IP limits", async () => {
  const benchmark = await runReconnectStormBenchmark({
    memberCount: 12,
    reconnectTimeoutMs: 3_000,
  });

  assert.equal(benchmark.attempted, 12);
  assert.equal(benchmark.errors, 0);
});

test("reconnect benchmark reports timeout failures without aborting the run", async () => {
  const benchmark = await runReconnectStormBenchmark({
    memberCount: 4,
    reconnectTimeoutMs: 1,
  });

  assert.equal(benchmark.attempted, 4);
  assert.equal(benchmark.completed + benchmark.errors, 4);
});
