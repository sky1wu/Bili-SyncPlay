import {
  buildBenchmarkResult,
  emitBenchmarkResult,
  parseCliOptions,
  readNumberOption,
  readStringOption,
} from "./lib/cli.js";
import { ensureRedis } from "./lib/redis-harness.js";
import { runPlaybackBroadcastBenchmark } from "./lib/room-bench.js";

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  const memberCount = readNumberOption(options, "members", 100);
  const durationSeconds = readNumberOption(options, "duration-seconds", 60);
  const updatesPerSecond = readNumberOption(options, "updates-per-second", 10);
  const watcherCount = readNumberOption(options, "sample-watchers", 8);
  const outputPath = readStringOption(options, "output");

  const redis = await ensureRedis(true);

  try {
    const benchmark = await runPlaybackBroadcastBenchmark({
      scenario: "redis-broadcast",
      memberCount,
      durationSeconds,
      updatesPerSecond,
      watcherCount,
      redisUrl: redis.redisUrl,
    });

    await emitBenchmarkResult(
      buildBenchmarkResult({
        scenario: "redis-broadcast",
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
          redisMode: redis.mode,
        },
        notes: [
          "Owner traffic is pinned to node A and followers to node B to emphasize cross-node fan-out.",
          "Latency samples are collected from watcher sockets attached to the remote node.",
        ],
      }),
      outputPath,
    );
  } finally {
    await redis.cleanup();
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});
