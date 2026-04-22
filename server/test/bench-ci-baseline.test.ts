import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  compareBenchmarkToBaseline,
  loadCiBenchmarkBaseline,
  renderCiBenchmarkSummary,
  type CiBenchmarkScenario,
} from "../../bench/lib/ci-baseline.js";
import { type BenchmarkResult } from "../../bench/lib/cli.js";
import { runCiScenario } from "../../bench/lib/ci-light-runner.js";

function createScenario(): CiBenchmarkScenario {
  return {
    scenario: "single-node-room",
    command: {
      memberCount: 12,
      durationSeconds: 6,
      updatesPerSecond: 6,
      sampledWatchers: 4,
    },
    baseline: {
      errorRatePercent: 0,
      p95Ms: 10,
      sampleCount: 144,
    },
    policy: {
      maxErrorRatePercent: 1,
      maxP95RegressionMultiplier: 4,
    },
  };
}

function createResult(input: {
  errorRatePercent: number;
  p95Ms: number;
  sampleCount?: number;
}): BenchmarkResult {
  return {
    schemaVersion: 1,
    scenario: "single-node-room",
    startedAt: "2026-04-22T10:00:00.000Z",
    completedAt: "2026-04-22T10:00:06.000Z",
    config: {},
    metrics: {
      throughput: {
        attempted: 144,
        completed: 144,
        durationSeconds: 6,
        attemptedPerSecond: 24,
        completedPerSecond: 24,
      },
      latency: {
        sampleCount: input.sampleCount ?? 144,
        minMs: 1,
        meanMs: 2,
        p50Ms: 2,
        p95Ms: input.p95Ms,
        p99Ms: input.p95Ms,
        maxMs: input.p95Ms,
      },
      errorRatePercent: input.errorRatePercent,
      errors: 0,
    },
    notes: [],
  };
}

test("compareBenchmarkToBaseline passes when metrics stay within policy", () => {
  const comparison = compareBenchmarkToBaseline({
    baseline: createScenario(),
    result: createResult({ errorRatePercent: 0, p95Ms: 35 }),
  });

  assert.equal(comparison.passed, true);
  assert.deepEqual(comparison.failures, []);
});

test("compareBenchmarkToBaseline reports error rate and latency regressions", () => {
  const comparison = compareBenchmarkToBaseline({
    baseline: createScenario(),
    result: createResult({ errorRatePercent: 2.5, p95Ms: 45 }),
  });

  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.failures, [
    "error rate 2.5% exceeded 1%",
    "P95 45ms exceeded 40ms (4x baseline)",
  ]);
});

test("compareBenchmarkToBaseline fails when sample count falls below baseline", () => {
  const comparison = compareBenchmarkToBaseline({
    baseline: createScenario(),
    result: createResult({ errorRatePercent: 0, p95Ms: 20, sampleCount: 0 }),
  });

  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.failures, [
    "sample count 0 fell below baseline 144",
  ]);
});

test("renderCiBenchmarkSummary includes pass fail statuses", () => {
  const summary = renderCiBenchmarkSummary({
    baselinePath: "bench/ci-light-baseline.json",
    comparisons: [
      compareBenchmarkToBaseline({
        baseline: createScenario(),
        result: createResult({ errorRatePercent: 0, p95Ms: 20 }),
      }),
    ],
  });

  assert.match(summary, /CI Benchmark Summary/);
  assert.match(summary, /single-node-room - PASS/);
  assert.match(summary, /Baseline file: `bench\/ci-light-baseline.json`/);
});

test("runCiScenario rejects missing required numeric command values", async () => {
  await assert.rejects(
    () =>
      runCiScenario("single-node-room", {
        memberCount: 6,
        durationSeconds: 5,
        sampledWatchers: 3,
      }),
    /Invalid numeric command value for updatesPerSecond: undefined/,
  );
});

test("runCiScenario rejects non-positive required numeric command values", async () => {
  await assert.rejects(
    () =>
      runCiScenario("reconnect-storm", {
        memberCount: 8,
        reconnectTimeoutMs: 0,
      }),
    /Invalid numeric command value for reconnectTimeoutMs: 0/,
  );
});

test("loadCiBenchmarkBaseline rejects missing required policy fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bsp-ci-baseline-"));
  const baselinePath = join(directory, "baseline.json");
  await writeFile(
    baselinePath,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-04-22T10:00:00.000Z",
      scenarios: [
        {
          scenario: "single-node-room",
          command: {
            memberCount: 12,
            durationSeconds: 6,
            updatesPerSecond: 6,
            sampledWatchers: 4,
          },
          baseline: {
            errorRatePercent: 0,
            p95Ms: 10,
            sampleCount: 144,
          },
          policy: {
            maxP95RegressionMultiplier: 4,
          },
        },
      ],
    }),
    "utf8",
  );

  await assert.rejects(
    () => loadCiBenchmarkBaseline(baselinePath),
    /Invalid numeric field scenarios\[0\]\.policy\.maxErrorRatePercent: undefined/,
  );
});

test("loadCiBenchmarkBaseline rejects an empty scenario list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bsp-ci-baseline-empty-"));
  const baselinePath = join(directory, "baseline.json");
  await writeFile(
    baselinePath,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-04-22T10:00:00.000Z",
      scenarios: [],
    }),
    "utf8",
  );

  await assert.rejects(
    () => loadCiBenchmarkBaseline(baselinePath),
    /Invalid baseline scenarios: expected at least one scenario/,
  );
});

test("loadCiBenchmarkBaseline rejects unsupported ci-light scenarios", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "bsp-ci-baseline-unsupported-"),
  );
  const baselinePath = join(directory, "baseline.json");
  await writeFile(
    baselinePath,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-04-22T10:00:00.000Z",
      scenarios: [
        {
          scenario: "redis-broadcast",
          command: {
            memberCount: 12,
          },
          baseline: {
            errorRatePercent: 0,
            p95Ms: 10,
            sampleCount: 144,
          },
          policy: {
            maxErrorRatePercent: 1,
            maxP95RegressionMultiplier: 4,
          },
        },
      ],
    }),
    "utf8",
  );

  await assert.rejects(
    () => loadCiBenchmarkBaseline(baselinePath),
    /Invalid scenarios\[0\]\.scenario: redis-broadcast/,
  );
});
