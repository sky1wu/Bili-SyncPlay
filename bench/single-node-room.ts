import {
  buildBenchmarkResult,
  emitBenchmarkResult,
  parseCliOptions,
  readNumberOption,
  readStringOption,
} from "./lib/cli.js";
import { runPlaybackBroadcastBenchmark } from "./lib/room-bench.js";

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  const memberCount = readNumberOption(options, "members", 100);
  const durationSeconds = readNumberOption(options, "duration-seconds", 60);
  const updatesPerSecond = readNumberOption(options, "updates-per-second", 10);
  const watcherCount = readNumberOption(options, "sample-watchers", 8);
  const outputPath = readStringOption(options, "output");

  const benchmark = await runPlaybackBroadcastBenchmark({
    scenario: "single-node-room",
    memberCount,
    durationSeconds,
    updatesPerSecond,
    watcherCount,
  });

  await emitBenchmarkResult(
    buildBenchmarkResult({
      scenario: "single-node-room",
      startedAtMs: benchmark.startedAtMs,
      completedAtMs: benchmark.completedAtMs,
      attempted: benchmark.attempted,
      completed: benchmark.completed,
      errors: benchmark.errors,
      latencySamplesMs: benchmark.latencySamplesMs,
      config: {
        memberCount,
        durationSeconds,
        updatesPerSecond,
        sampledWatchers: benchmark.watcherCount,
        nodeMode: benchmark.nodeMode,
      },
      notes: [
        "Latency samples are collected from a subset of watcher sockets.",
        "Throughput counts sampled playback deliveries rather than total room broadcasts.",
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
