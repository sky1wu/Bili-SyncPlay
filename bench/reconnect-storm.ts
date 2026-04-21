import {
  buildBenchmarkResult,
  emitBenchmarkResult,
  parseCliOptions,
  readNumberOption,
  readStringOption,
} from "./lib/cli.js";
import { runReconnectStormBenchmark } from "./lib/room-bench.js";

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  const memberCount = readNumberOption(options, "members", 500);
  const reconnectTimeoutMs = readNumberOption(
    options,
    "reconnect-timeout-ms",
    5_000,
  );
  const outputPath = readStringOption(options, "output");

  const benchmark = await runReconnectStormBenchmark({
    memberCount,
    reconnectTimeoutMs,
  });

  await emitBenchmarkResult(
    buildBenchmarkResult({
      scenario: "reconnect-storm",
      startedAtMs: benchmark.startedAtMs,
      completedAtMs: benchmark.completedAtMs,
      attempted: benchmark.attempted,
      completed: benchmark.completed,
      errors: benchmark.errors,
      latencySamplesMs: benchmark.latencySamplesMs,
      config: {
        memberCount,
        reconnectTimeoutMs,
        nodeMode: "single-node",
      },
      notes: [
        "Each reconnect latency measures socket open plus room rejoin until the first room state arrives.",
      ],
    }),
    outputPath,
  );
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});
