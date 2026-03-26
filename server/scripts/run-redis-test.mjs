import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

if (!process.env.REDIS_URL) {
  console.error(
    "REDIS_URL must be configured for npm run test:redis -w @bili-syncplay/server",
  );
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(scriptDir, "..");
const workspaceDir = resolve(serverDir, "..");
const tsxCli = resolve(workspaceDir, "node_modules", "tsx", "dist", "cli.mjs");

const child = spawn(process.execPath, [tsxCli, "--test", "test/**/*.ts"], {
  cwd: serverDir,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
