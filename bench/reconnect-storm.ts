import {
  emitBenchmarkResult,
  parseCliOptions,
  readNumberOption,
  readStringOption,
} from "./lib/cli.js";
import { runReconnectStormScenario } from "./lib/scenarios.js";

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  const memberCount = readNumberOption(options, "members", 500);
  const reconnectTimeoutMs = readNumberOption(
    options,
    "reconnect-timeout-ms",
    5_000,
  );
  const outputPath = readStringOption(options, "output");

  await emitBenchmarkResult(
    await runReconnectStormScenario({
      memberCount,
      reconnectTimeoutMs,
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
