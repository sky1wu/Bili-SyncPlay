import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type BenchmarkResult } from "./cli.js";

export type CiBenchmarkPolicy = {
  maxErrorRatePercent: number;
  maxP95RegressionMultiplier: number;
};

export type CiBenchmarkScenario = {
  scenario: BenchmarkResult["scenario"];
  command: Record<string, number | string>;
  baseline: {
    errorRatePercent: number;
    p95Ms: number;
    sampleCount: number;
  };
  policy: CiBenchmarkPolicy;
};

export type CiBenchmarkBaselineFile = {
  schemaVersion: 1;
  generatedAt: string;
  scenarios: CiBenchmarkScenario[];
};

export type CiBenchmarkComparison = {
  scenario: BenchmarkResult["scenario"];
  passed: boolean;
  actual: {
    errorRatePercent: number;
    p95Ms: number;
    sampleCount: number;
  };
  baseline: CiBenchmarkScenario["baseline"];
  policy: CiBenchmarkPolicy;
  failures: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRequiredFiniteNumber(
  source: Record<string, unknown>,
  key: string,
  context: string,
): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `Invalid numeric field ${context}.${key}: ${String(value)}`,
    );
  }

  return value;
}

function readRequiredPositiveNumber(
  source: Record<string, unknown>,
  key: string,
  context: string,
): number {
  const value = readRequiredFiniteNumber(source, key, context);
  if (value <= 0) {
    throw new Error(
      `Invalid positive numeric field ${context}.${key}: ${value}`,
    );
  }

  return value;
}

function validateCiBenchmarkScenario(
  scenario: unknown,
  index: number,
): CiBenchmarkScenario {
  const context = `scenarios[${index}]`;
  if (!isRecord(scenario)) {
    throw new Error(`Invalid ${context}: expected object`);
  }

  if (
    scenario.scenario !== "single-node-room" &&
    scenario.scenario !== "reconnect-storm"
  ) {
    throw new Error(
      `Invalid ${context}.scenario: ${String(scenario.scenario)}`,
    );
  }

  if (!isRecord(scenario.command)) {
    throw new Error(`Invalid ${context}.command: expected object`);
  }
  if (!isRecord(scenario.baseline)) {
    throw new Error(`Invalid ${context}.baseline: expected object`);
  }
  if (!isRecord(scenario.policy)) {
    throw new Error(`Invalid ${context}.policy: expected object`);
  }

  return {
    scenario: scenario.scenario,
    command: Object.fromEntries(
      Object.entries(scenario.command).map(([key, value]) => {
        if (typeof value !== "number" && typeof value !== "string") {
          throw new Error(
            `Invalid command field ${context}.command.${key}: ${String(value)}`,
          );
        }

        return [key, value];
      }),
    ),
    baseline: {
      errorRatePercent: readRequiredFiniteNumber(
        scenario.baseline,
        "errorRatePercent",
        `${context}.baseline`,
      ),
      p95Ms: readRequiredPositiveNumber(
        scenario.baseline,
        "p95Ms",
        `${context}.baseline`,
      ),
      sampleCount: readRequiredPositiveNumber(
        scenario.baseline,
        "sampleCount",
        `${context}.baseline`,
      ),
    },
    policy: {
      maxErrorRatePercent: readRequiredFiniteNumber(
        scenario.policy,
        "maxErrorRatePercent",
        `${context}.policy`,
      ),
      maxP95RegressionMultiplier: readRequiredPositiveNumber(
        scenario.policy,
        "maxP95RegressionMultiplier",
        `${context}.policy`,
      ),
    },
  };
}

export async function loadCiBenchmarkBaseline(
  baselinePath: string,
): Promise<CiBenchmarkBaselineFile> {
  const raw = await readFile(resolve(baselinePath), "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("Invalid baseline file: expected object");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `Invalid baseline schemaVersion: ${String(parsed.schemaVersion)}`,
    );
  }
  if (
    typeof parsed.generatedAt !== "string" ||
    parsed.generatedAt.length === 0
  ) {
    throw new Error(
      `Invalid baseline generatedAt: ${String(parsed.generatedAt)}`,
    );
  }
  if (!Array.isArray(parsed.scenarios)) {
    throw new Error("Invalid baseline scenarios: expected array");
  }
  if (parsed.scenarios.length === 0) {
    throw new Error(
      "Invalid baseline scenarios: expected at least one scenario",
    );
  }

  return {
    schemaVersion: 1,
    generatedAt: parsed.generatedAt,
    scenarios: parsed.scenarios.map((scenario, index) =>
      validateCiBenchmarkScenario(scenario, index),
    ),
  };
}

export function compareBenchmarkToBaseline(input: {
  baseline: CiBenchmarkScenario;
  result: BenchmarkResult;
}): CiBenchmarkComparison {
  const actual = {
    errorRatePercent: input.result.metrics.errorRatePercent,
    p95Ms: input.result.metrics.latency.p95Ms,
    sampleCount: input.result.metrics.latency.sampleCount,
  };

  const failures: string[] = [];
  if (actual.sampleCount < input.baseline.baseline.sampleCount) {
    failures.push(
      `sample count ${actual.sampleCount} fell below baseline ${input.baseline.baseline.sampleCount}`,
    );
  }

  if (actual.errorRatePercent > input.baseline.policy.maxErrorRatePercent) {
    failures.push(
      `error rate ${actual.errorRatePercent}% exceeded ${input.baseline.policy.maxErrorRatePercent}%`,
    );
  }

  const allowedP95Ms =
    input.baseline.baseline.p95Ms *
    input.baseline.policy.maxP95RegressionMultiplier;
  if (input.baseline.baseline.p95Ms > 0 && actual.p95Ms > allowedP95Ms) {
    failures.push(
      `P95 ${actual.p95Ms}ms exceeded ${allowedP95Ms}ms (${input.baseline.policy.maxP95RegressionMultiplier}x baseline)`,
    );
  }

  return {
    scenario: input.baseline.scenario,
    passed: failures.length === 0,
    actual,
    baseline: input.baseline.baseline,
    policy: input.baseline.policy,
    failures,
  };
}

export function renderCiBenchmarkSummary(input: {
  comparisons: CiBenchmarkComparison[];
  baselinePath: string;
}): string {
  const lines = [
    "# CI Benchmark Summary",
    "",
    `Baseline file: \`${input.baselinePath}\``,
    "",
  ];

  for (const comparison of input.comparisons) {
    const status = comparison.passed ? "PASS" : "FAIL";
    lines.push(`## ${comparison.scenario} - ${status}`);
    lines.push(
      `- Error rate: ${comparison.actual.errorRatePercent}% (baseline ${comparison.baseline.errorRatePercent}%, limit ${comparison.policy.maxErrorRatePercent}%)`,
    );
    lines.push(
      `- P95 latency: ${comparison.actual.p95Ms}ms (baseline ${comparison.baseline.p95Ms}ms, limit ${comparison.baseline.p95Ms * comparison.policy.maxP95RegressionMultiplier}ms)`,
    );
    lines.push(
      `- Sample count: ${comparison.actual.sampleCount} (baseline ${comparison.baseline.sampleCount})`,
    );

    if (comparison.failures.length > 0) {
      lines.push("- Failures:");
      for (const failure of comparison.failures) {
        lines.push(`  - ${failure}`);
      }
    }

    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function writeCiBenchmarkArtifacts(input: {
  outputDir: string;
  baselinePath: string;
  results: BenchmarkResult[];
  comparisons: CiBenchmarkComparison[];
}) {
  const absoluteOutputDir = resolve(input.outputDir);
  await mkdir(absoluteOutputDir, { recursive: true });

  await writeFile(
    resolve(absoluteOutputDir, "results.json"),
    `${JSON.stringify(input.results, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(absoluteOutputDir, "comparison.json"),
    `${JSON.stringify(input.comparisons, null, 2)}\n`,
    "utf8",
  );

  const summary = renderCiBenchmarkSummary({
    comparisons: input.comparisons,
    baselinePath: input.baselinePath,
  });
  await writeFile(resolve(absoluteOutputDir, "summary.md"), summary, "utf8");
}
