import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  calculateErrorRate,
  summarizeLatencies,
  summarizeThroughput,
  type LatencySummary,
  type ThroughputSummary,
} from "./stats.js";

type OptionMap = Map<string, string | boolean>;

export type BenchmarkResult = {
  schemaVersion: 1;
  scenario: string;
  startedAt: string;
  completedAt: string;
  config: Record<string, unknown>;
  metrics: {
    throughput: ThroughputSummary;
    latency: LatencySummary;
    phases?: Record<string, LatencySummary>;
    errorRatePercent: number;
    errors: number;
  };
  notes: string[];
};

export function parseCliOptions(argv: string[]): OptionMap {
  const options = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const nextToken = argv[index + 1];
    if (!nextToken || nextToken.startsWith("--")) {
      options.set(key, true);
      continue;
    }

    options.set(key, nextToken);
    index += 1;
  }

  return options;
}

export function readNumberOption(
  options: OptionMap,
  key: string,
  defaultValue: number,
): number {
  const rawValue = options.get(key);
  if (rawValue === undefined || rawValue === true) {
    return defaultValue;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric option --${key}: ${String(rawValue)}`);
  }

  return parsed;
}

export function readStringOption(
  options: OptionMap,
  key: string,
  defaultValue?: string,
): string | undefined {
  const rawValue = options.get(key);
  if (rawValue === undefined || rawValue === true) {
    return defaultValue;
  }

  return String(rawValue);
}

export function buildBenchmarkResult(input: {
  scenario: string;
  startedAtMs: number;
  completedAtMs: number;
  attempted: number;
  completed: number;
  errors: number;
  latencySamplesMs: number[];
  phaseSamplesMs?: Record<string, number[]>;
  config: Record<string, unknown>;
  notes?: string[];
}): BenchmarkResult {
  const totalObservations = input.completed + input.errors;

  return {
    schemaVersion: 1,
    scenario: input.scenario,
    startedAt: new Date(input.startedAtMs).toISOString(),
    completedAt: new Date(input.completedAtMs).toISOString(),
    config: input.config,
    metrics: {
      throughput: summarizeThroughput({
        attempted: input.attempted,
        completed: input.completed,
        durationMs: input.completedAtMs - input.startedAtMs,
      }),
      latency: summarizeLatencies(input.latencySamplesMs),
      ...(input.phaseSamplesMs
        ? {
            phases: Object.fromEntries(
              Object.entries(input.phaseSamplesMs).map(([phase, samples]) => [
                phase,
                summarizeLatencies(samples),
              ]),
            ),
          }
        : {}),
      errorRatePercent: calculateErrorRate(input.errors, totalObservations),
      errors: input.errors,
    },
    notes: input.notes ?? [],
  };
}

export async function emitBenchmarkResult(
  result: BenchmarkResult,
  outputPath?: string,
) {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;

  if (outputPath) {
    const absolutePath = resolve(outputPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, serialized, "utf8");
  }

  process.stdout.write(serialized);
}
