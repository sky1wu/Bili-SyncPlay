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

export async function loadCiBenchmarkBaseline(
  baselinePath: string,
): Promise<CiBenchmarkBaselineFile> {
  const raw = await readFile(resolve(baselinePath), "utf8");
  return JSON.parse(raw) as CiBenchmarkBaselineFile;
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
