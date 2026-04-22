import {
  emitBenchmarkResult,
  parseCliOptions,
  readNumberOption,
  readStringOption,
} from "./lib/cli.js";
import { runRedisBroadcastScenario } from "./lib/scenarios.js";

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  const memberCount = readNumberOption(options, "members", 100);
  const durationSeconds = readNumberOption(options, "duration-seconds", 60);
  const updatesPerSecond = readNumberOption(options, "updates-per-second", 10);
  const watcherCount = readNumberOption(options, "sample-watchers", 8);
  const outputPath = readStringOption(options, "output");

  await emitBenchmarkResult(
    await runRedisBroadcastScenario({
      memberCount,
      durationSeconds,
      updatesPerSecond,
      watcherCount,
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
