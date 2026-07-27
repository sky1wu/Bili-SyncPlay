/**
 * Guards the wiring, not the helper: `installGracefulShutdown` is unit-tested in
 * graceful-shutdown.test.ts, but the bug it fixes was an entry point that never
 * called it. Node ignores SIGTERM when no handler is installed and the process
 * is PID 1 (the container image runs `CMD ["node", "server/dist/index.js"]`),
 * so `docker stop` fell through to SIGKILL / exit 137.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 15_000;

async function reserveFreePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve a free port.");
  }
  const { port } = address;
  await new Promise<void>((resolveClose, reject) => {
    probe.close((error) => (error ? reject(error) : resolveClose()));
  });
  return port;
}

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  needle: string,
  collected: { text: string },
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolveWait, reject) => {
    if (collected.text.includes(needle)) {
      resolveWait();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ${JSON.stringify(needle)}. Output so far:\n${collected.text}`,
        ),
      );
    }, timeoutMs);
    const onData = (): void => {
      if (collected.text.includes(needle)) {
        cleanup();
        resolveWait();
      }
    };
    const onExit = (): void => {
      cleanup();
      reject(
        new Error(
          `Process exited before printing ${JSON.stringify(needle)}. Output:\n${collected.text}`,
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
}

async function assertGracefulStop(
  entryPath: string,
  env: NodeJS.ProcessEnv,
  listeningNeedle: string,
): Promise<void> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve(REPO_ROOT, entryPath)],
    { cwd: REPO_ROOT, env: { ...process.env, ...env } },
  );
  const collected = { text: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    collected.text += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    collected.text += chunk;
  });

  try {
    await waitForOutput(child, listeningNeedle, collected, START_TIMEOUT_MS);

    const exited = once(child, "exit") as Promise<
      [number | null, NodeJS.Signals | null]
    >;
    child.kill("SIGTERM");
    const stopTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, STOP_TIMEOUT_MS);
    const [code, signal] = await exited;
    clearTimeout(stopTimer);

    assert.equal(
      signal,
      null,
      `Expected a graceful exit, got signal ${signal}. Output:\n${collected.text}`,
    );
    assert.equal(
      code,
      0,
      `Expected exit code 0, got ${code}. Output:\n${collected.text}`,
    );
    assert.ok(
      collected.text.includes("shutting down gracefully"),
      `Missing shutdown log. Output:\n${collected.text}`,
    );
    assert.ok(
      collected.text.includes("shutdown complete"),
      `Missing completion log. Output:\n${collected.text}`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

test("the server entry point exits gracefully on SIGTERM", async () => {
  const port = await reserveFreePort();
  await assertGracefulStop(
    "server/src/index.ts",
    {
      PORT: String(port),
      ALLOWED_ORIGINS: "chrome-extension://entrypoint-signal-test",
      METRICS_PORT: "",
    },
    `listening on http://localhost:${port}`,
  );
});

test("the global admin entry point exits gracefully on SIGTERM", async () => {
  const port = await reserveFreePort();
  await assertGracefulStop(
    "server/src/global-admin-index.ts",
    {
      GLOBAL_ADMIN_PORT: String(port),
      ALLOWED_ORIGINS: "chrome-extension://entrypoint-signal-test",
      METRICS_PORT: "",
    },
    `global admin listening on http://localhost:${port}`,
  );
});
