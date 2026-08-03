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
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 30_000;

function skipWhenWindows(t: TestContext): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  t.skip(
    "SIGTERM graceful-shutdown assertions require POSIX signal semantics.",
  );
  return true;
}

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

/**
 * Accepts TCP connections and never answers, so a client waiting for a protocol
 * handshake (here: ioredis) blocks indefinitely.
 */
async function startBlackHoleListener(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server: NetServer = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start the black-hole listener.");
  }

  return {
    port: address.port,
    close: async () => {
      // `server.close()` only calls back once every connection is gone, and a
      // socket left behind by the killed child never gets there on its own.
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      server.close();
      await once(server, "close");
    },
  };
}

function startEntry(
  entryPath: string,
  env: NodeJS.ProcessEnv,
): { child: ChildProcessWithoutNullStreams; collected: { text: string } } {
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
  return { child, collected };
}

async function stopAndWait(
  child: ChildProcessWithoutNullStreams,
): Promise<[number | null, NodeJS.Signals | null]> {
  const exited = once(child, "exit") as Promise<
    [number | null, NodeJS.Signals | null]
  >;
  child.kill("SIGTERM");
  const stopTimer = setTimeout(() => {
    child.kill("SIGKILL");
  }, STOP_TIMEOUT_MS);
  try {
    return await exited;
  } finally {
    clearTimeout(stopTimer);
  }
}

async function assertGracefulStop(
  entryPath: string,
  env: NodeJS.ProcessEnv,
  listeningNeedle: string,
): Promise<void> {
  const { child, collected } = startEntry(entryPath, env);

  try {
    await waitForOutput(child, listeningNeedle, collected, START_TIMEOUT_MS);

    const [code, signal] = await stopAndWait(child);

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

test("the server entry point exits gracefully on SIGTERM", async (t) => {
  if (skipWhenWindows(t)) {
    return;
  }
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

test("a SIGTERM during startup does not hang the process", async (t) => {
  if (skipWhenWindows(t)) {
    return;
  }
  // ROOM_STORE_PROVIDER=redis makes startup await `redis.connect()`. Pointing
  // it at a socket that accepts and never answers wedges the entry point inside
  // `await createSyncServer(...)`, which is exactly where the handlers used to
  // not exist yet: as PID 1 the signal would be dropped and `docker stop` would
  // fall through to SIGKILL.
  const blackHole = await startBlackHoleListener();

  const port = await reserveFreePort();
  const { child, collected } = startEntry("server/src/index.ts", {
    PORT: String(port),
    ALLOWED_ORIGINS: "chrome-extension://entrypoint-signal-test",
    METRICS_PORT: "",
    ROOM_STORE_PROVIDER: "redis",
    REDIS_URL: `redis://127.0.0.1:${blackHole.port}`,
  });

  try {
    // Printed by logEffectiveOriginPolicy, i.e. right before the awaited startup.
    await waitForOutput(
      child,
      "[security] ALLOWED_ORIGINS=",
      collected,
      30_000,
    );

    const [code, signal] = await stopAndWait(child);

    assert.equal(
      signal,
      null,
      `Expected the process to exit on its own, got signal ${signal}. Output:\n${collected.text}`,
    );
    assert.ok(
      collected.text.includes("during startup"),
      `Expected a startup-signal log. Output:\n${collected.text}`,
    );
    assert.ok(
      !collected.text.includes("listening on http://"),
      `The server must not start listening after a stop signal. Output:\n${collected.text}`,
    );
    // Startup can never finish here, so the entry aborts it rather than waiting
    // out the full shutdown budget; either way it must not need a SIGKILL.
    assert.equal(
      code,
      1,
      `Expected exit code 1 for an aborted startup, got ${code}. Output:\n${collected.text}`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await blackHole.close();
  }
});

test("the global admin entry point exits gracefully on SIGTERM", async (t) => {
  if (skipWhenWindows(t)) {
    return;
  }
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
