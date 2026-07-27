import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { connect, type Socket } from "node:net";
import test from "node:test";
import { WebSocket } from "ws";
import {
  createSyncServer,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
} from "../src/app.js";
import { createGlobalAdminServer } from "../src/global-admin-app.js";
import {
  installGracefulShutdown,
  type GracefulShutdownHandle,
  type ShutdownCloseTarget,
  type ShutdownSignalTarget,
} from "../src/bootstrap/graceful-shutdown.js";

type Harness = {
  signalTarget: ShutdownSignalTarget & {
    emit: (signal: NodeJS.Signals) => boolean;
    listenerCount: (signal: NodeJS.Signals) => number;
  };
  logs: string[];
  errors: string[];
  exitCodes: number[];
  exits: EventEmitter;
  /** Resolves on the next exit() call, without holding a timer of its own. */
  nextExit: () => Promise<number>;
};

function createHarness(): Harness {
  const emitter = new EventEmitter();
  const exits = new EventEmitter();
  return {
    signalTarget: {
      on: (signal, listener) => emitter.on(signal, listener),
      off: (signal, listener) => emitter.off(signal, listener),
      emit: (signal) => emitter.emit(signal),
      listenerCount: (signal) => emitter.listenerCount(signal),
    },
    logs: [],
    errors: [],
    exitCodes: [],
    exits,
    nextExit: () =>
      new Promise<number>((resolve) => {
        exits.once("exit", (code: number) => {
          resolve(code);
        });
      }),
  };
}

function install(
  harness: Harness,
  close?: ShutdownCloseTarget,
  overrides: {
    forceExitTimeoutMs?: number;
    startupAbortTimeoutMs?: number;
  } = {},
): GracefulShutdownHandle {
  return installGracefulShutdown({
    name: "test server",
    close,
    signalTarget: harness.signalTarget,
    log: (message) => harness.logs.push(message),
    logError: (message) => harness.errors.push(message),
    exit: (code) => {
      harness.exitCodes.push(code);
      harness.exits.emit("exit", code);
    },
    ...overrides,
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("SIGTERM runs close and exits with code 0", async () => {
  const harness = createHarness();
  let closeCalls = 0;
  install(harness, async () => {
    closeCalls += 1;
    return [];
  });

  harness.signalTarget.emit("SIGTERM");
  await flush();

  assert.equal(closeCalls, 1);
  assert.deepEqual(harness.exitCodes, [0]);
  assert.equal(harness.errors.length, 0);
  assert.ok(harness.logs.some((line) => line.includes("SIGTERM")));
});

test("SIGINT is handled as well", async () => {
  const harness = createHarness();
  let closeCalls = 0;
  install(harness, async () => {
    closeCalls += 1;
  });

  harness.signalTarget.emit("SIGINT");
  await flush();

  assert.equal(closeCalls, 1);
  assert.deepEqual(harness.exitCodes, [0]);
});

test("a shutdown step failure exits with code 1", async () => {
  const harness = createHarness();
  install(harness, async () => [
    { step: "close_room_store", result: "timeout", error: "…" },
  ]);

  harness.signalTarget.emit("SIGTERM");
  await flush();

  assert.deepEqual(harness.exitCodes, [1]);
  assert.ok(
    harness.errors.some((line) => line.includes("close_room_store (timeout)")),
    `Missing failed-step log: ${harness.errors.join(" | ")}`,
  );
  assert.ok(!harness.logs.some((line) => line.includes("shutdown complete")));
});

test("close runs once even if more signals arrive during shutdown", async () => {
  const harness = createHarness();
  let closeCalls = 0;
  let releaseClose: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  install(harness, async () => {
    closeCalls += 1;
    await closed;
  });

  harness.signalTarget.emit("SIGTERM");
  await flush();
  harness.signalTarget.emit("SIGTERM");
  await flush();

  assert.equal(closeCalls, 1);
  // The second signal forces an immediate non-zero exit instead of waiting.
  assert.deepEqual(harness.exitCodes, [1]);

  releaseClose?.();
  await flush();
  assert.equal(closeCalls, 1);
  assert.deepEqual(harness.exitCodes, [1, 0]);
});

test("a hung close is force-exited by the watchdog", async () => {
  const harness = createHarness();
  const exited = harness.nextExit();
  install(harness, () => new Promise<never>(() => undefined), {
    forceExitTimeoutMs: 20,
  });

  harness.signalTarget.emit("SIGTERM");
  // Nothing but the watchdog keeps the event loop alive here: awaiting a timer
  // of our own would mask an unref()'d watchdog, which is how this regressed.
  assert.equal(await exited, 1);
  assert.ok(harness.errors.some((line) => line.includes("timed out")));
  assert.equal(harness.signalTarget.listenerCount("SIGTERM"), 0);
});

test("a failing close exits with code 1", async () => {
  const harness = createHarness();
  install(harness, async () => {
    throw new Error("boom");
  });

  harness.signalTarget.emit("SIGTERM");
  await flush();

  assert.deepEqual(harness.exitCodes, [1]);
  assert.ok(harness.errors.some((line) => line.includes("shutdown failed")));
});

test("a signal during startup shuts down once the close target is attached", async () => {
  const harness = createHarness();
  const handle = install(harness, undefined, { startupAbortTimeoutMs: 60_000 });
  let closeCalls = 0;

  harness.signalTarget.emit("SIGTERM");
  await flush();

  // Nothing to close yet: the process must stay alive until startup finishes.
  assert.deepEqual(harness.exitCodes, []);
  assert.equal(closeCalls, 0);
  assert.ok(harness.logs.some((line) => line.includes("during startup")));

  const keepListening = handle.attachCloseTarget(async () => {
    closeCalls += 1;
    return [];
  });
  await flush();

  assert.equal(
    keepListening,
    false,
    "the caller must be told not to start listening",
  );
  assert.equal(closeCalls, 1);
  assert.deepEqual(harness.exitCodes, [0]);
});

test("a startup that never finishes is aborted after the startup timeout", async () => {
  const harness = createHarness();
  const exited = harness.nextExit();
  install(harness, undefined, { startupAbortTimeoutMs: 20 });

  harness.signalTarget.emit("SIGTERM");
  assert.equal(await exited, 1);
  assert.ok(
    harness.errors.some((line) => line.includes("startup did not finish")),
    `Missing startup abort log: ${harness.errors.join(" | ")}`,
  );
});

test("attachCloseTarget keeps the caller running when no signal arrived", async () => {
  const harness = createHarness();
  const handle = install(harness);

  assert.equal(
    handle.attachCloseTarget(async () => []),
    true,
  );
  assert.deepEqual(harness.exitCodes, []);

  harness.signalTarget.emit("SIGTERM");
  await flush();
  assert.deepEqual(harness.exitCodes, [0]);
});

const CLIENT_ORIGIN = "chrome-extension://shutdown-test";

async function startListeningSyncServer(): Promise<{
  server: Awaited<ReturnType<typeof createSyncServer>>;
  port: number;
}> {
  const server = await createSyncServer(
    { ...getDefaultSecurityConfig(), allowedOrigins: [CLIENT_ORIGIN] },
    getDefaultPersistenceConfig(),
    {
      logEvent: () => {},
      serviceVersion: "0.0.0-test",
      adminUiConfig: { enabled: false },
    },
  );
  server.httpServer.listen(0, "127.0.0.1");
  await once(server.httpServer, "listening");
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve the test server address.");
  }
  return { server, port: address.port };
}

// terminate() drops the TCP connection without a close handshake, which every
// client reports as 1006 — a crash and an intentional restart become
// indistinguishable, and the extension surfaces the shutdown as an error.
test("shutdown closes clients with a 1001 close frame", async () => {
  const { server, port } = await startListeningSyncServer();
  const client = new WebSocket(`ws://127.0.0.1:${port}`, {
    origin: CLIENT_ORIGIN,
  });
  await once(client, "open");
  const closed = once(client, "close") as Promise<[number, Buffer]>;

  assert.deepEqual(await server.close(), []);

  const [code, reason] = await closed;
  assert.equal(code, 1001);
  assert.equal(reason.toString(), "server_shutting_down");
});

test("a client that never answers the close frame is terminated", async () => {
  const { server, port } = await startListeningSyncServer();

  // A raw socket completes the upgrade and then ignores everything, including
  // the close frame — the handshake the ws client would answer automatically.
  const raw: Socket = connect(port, "127.0.0.1");
  await once(raw, "connect");
  raw.write(
    [
      "GET / HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Origin: ${CLIENT_ORIGIN}`,
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
  const [handshake] = (await once(raw, "data")) as [Buffer];
  assert.match(handshake.toString(), /^HTTP\/1\.1 101 /);

  // Subscribe before shutting down: the socket is torn down while `close()`
  // runs, and `once()` on an already-closed socket would never resolve.
  const rawClosed = once(raw, "close");
  const startedAt = Date.now();
  assert.deepEqual(await server.close(), []);
  await rawClosed;
  const elapsedMs = Date.now() - startedAt;

  // Bounded by the close-handshake grace, and well inside the step's 5s cap so
  // an unresponsive client cannot turn the shutdown into a failed step.
  assert.ok(
    elapsedMs < 5_000,
    `Expected the unresponsive client to be terminated within the grace, took ${elapsedMs}ms`,
  );
});

// A stop signal during startup tears the server down before the entry point
// ever calls listen(). Node reports ERR_SERVER_NOT_RUNNING for a server that
// never listened, and counting that as a failed step would turn this clean
// shutdown into exit code 1.
test("closing a server that never listened reports no failed steps", async () => {
  const server = await createSyncServer(
    getDefaultSecurityConfig(),
    getDefaultPersistenceConfig(),
    {
      logEvent: () => {},
      serviceVersion: "0.0.0-test",
      adminUiConfig: { enabled: false },
    },
  );

  assert.equal(server.httpServer.listening, false);
  assert.deepEqual(await server.close(), []);
});

test("closing a global admin server that never listened reports no failed steps", async () => {
  const server = await createGlobalAdminServer(
    getDefaultSecurityConfig(),
    getDefaultPersistenceConfig(),
    {
      logEvent: () => {},
      serviceVersion: "0.0.0-test",
      adminUiConfig: { enabled: false },
    },
  );

  assert.equal(server.httpServer.listening, false);
  assert.deepEqual(await server.close(), []);
});

test("handlers are detached after shutdown and by the returned detach", async () => {
  const harness = createHarness();
  const handle = install(harness, async () => []);

  assert.equal(harness.signalTarget.listenerCount("SIGTERM"), 1);
  assert.equal(harness.signalTarget.listenerCount("SIGINT"), 1);
  handle.detach();
  assert.equal(harness.signalTarget.listenerCount("SIGTERM"), 0);
  assert.equal(harness.signalTarget.listenerCount("SIGINT"), 0);

  const other = createHarness();
  install(other, async () => []);
  other.signalTarget.emit("SIGTERM");
  await flush();
  assert.equal(other.signalTarget.listenerCount("SIGTERM"), 0);
  assert.equal(other.signalTarget.listenerCount("SIGINT"), 0);
});
