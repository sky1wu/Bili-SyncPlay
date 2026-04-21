export type LatencySummary = {
  sampleCount: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
};

export type ThroughputSummary = {
  attempted: number;
  completed: number;
  durationSeconds: number;
  attemptedPerSecond: number;
  completedPerSecond: number;
};

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * ratio) - 1),
  );
  return sortedValues[index] ?? 0;
}

export function summarizeLatencies(latenciesMs: number[]): LatencySummary {
  if (latenciesMs.length === 0) {
    return {
      sampleCount: 0,
      minMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    };
  }

  const sorted = [...latenciesMs].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    sampleCount: sorted.length,
    minMs: round(sorted[0] ?? 0),
    meanMs: round(total / sorted.length),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

export function summarizeThroughput(input: {
  attempted: number;
  completed: number;
  durationMs: number;
}): ThroughputSummary {
  const durationSeconds =
    input.durationMs > 0 ? round(input.durationMs / 1_000) : 0;
  const safeDurationSeconds = durationSeconds > 0 ? durationSeconds : 1;

  return {
    attempted: input.attempted,
    completed: input.completed,
    durationSeconds,
    attemptedPerSecond: round(input.attempted / safeDurationSeconds),
    completedPerSecond: round(input.completed / safeDurationSeconds),
  };
}

export function calculateErrorRate(errorCount: number, totalCount: number) {
  if (totalCount <= 0) {
    return 0;
  }

  return round((errorCount / totalCount) * 100, 4);
}
