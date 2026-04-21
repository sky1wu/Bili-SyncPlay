import assert from "node:assert/strict";
import test from "node:test";
import { buildBenchmarkResult } from "../../bench/lib/cli.js";
import {
  calculateErrorRate,
  summarizeLatencies,
  summarizeThroughput,
} from "../../bench/lib/stats.js";

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
