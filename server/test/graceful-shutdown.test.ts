import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createWsUpgradeHandler } from "../src/ws-session-handler.js";
import {
  createSyncServer,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
} from "../src/app.js";
import { createGlobalAdminServer } from "../src/global-admin-app.js";
import {
  createSharedServerShutdownSteps,
  runShutdownSteps,
} from "../src/bootstrap/server-bootstrap.js";
import { createInMemoryAdminCommandBus } from "../src/admin-command-bus.js";
import { createInMemoryRoomEventBus } from "../src/room-event-bus.js";
import { createInMemoryRoomStore } from "../src/room-store.js";
import type { GlobalEventStore } from "../src/admin/global-event-store.js";
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

test("a shutdown step that threw exits with code 1", async () => {
  const harness = createHarness();
  install(harness, async () => [
    { step: "close_room_store", result: "error", error: "…" },
  ]);

  harness.signalTarget.emit("SIGTERM");
  await flush();

  assert.deepEqual(harness.exitCodes, [1]);
  assert.ok(
    harness.errors.some((line) => line.includes("close_room_store (error)")),
    `Missing failed-step log: ${harness.errors.join(" | ")}`,
  );
  assert.ok(!harness.logs.some((line) => line.includes("shutdown complete")));
});

test("a shutdown step that only ran out of its budget still exits cleanly", async () => {
  // The budget exists because the work these steps wait on is I/O this process
  // cannot cancel. Giving up on it is the designed outcome, not a fault —
  // exiting non-zero for it turned every "what if this particular call hangs?"
  // into a correctness claim with no last answer (#242).
  const harness = createHarness();
  install(harness, async () => [
    { step: "close_shared_runtime_store", result: "timeout", error: "…" },
  ]);

  harness.signalTarget.emit("SIGTERM");
  await flush();

  assert.deepEqual(harness.exitCodes, [0]);
  // Still loud: only the exit code distinguishes the two.
  assert.ok(
    harness.errors.some((line) =>
      line.includes("close_shared_runtime_store (timeout)"),
    ),
    `Missing degraded-step log: ${harness.errors.join(" | ")}`,
  );
});

test("a shutdown that timed out AND threw still exits with code 1", async () => {
  const harness = createHarness();
  install(harness, async () => [
    { step: "close_shared_runtime_store", result: "timeout", error: "…" },
    { step: "close_room_store", result: "error", error: "…" },
  ]);

  harness.signalTarget.emit("SIGTERM");
  await flush();

  assert.deepEqual(harness.exitCodes, [1]);
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

/**
 * Resolves when the peer is gone, by FIN or by RST.
 *
 * `events.once(socket, "close")` rejects if the socket emits `error` first, and
 * a connection the server terminates surfaces as ECONNRESET on some Node
 * patch releases and a plain FIN on others — which is not a difference any
 * assertion here should depend on.
 */
function waitForSocketClose(socket: Socket): Promise<void> {
  return new Promise<void>((resolve) => {
    socket.on("error", () => undefined);
    socket.once("close", () => resolve());
  });
}

function writeUpgradeRequest(socket: Socket, port: number): void {
  socket.write(
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
}

test("a client that never answers the close frame is terminated", async () => {
  const { server, port } = await startListeningSyncServer();

  // A raw socket completes the upgrade and then ignores everything, including
  // the close frame — the handshake the ws client would answer automatically.
  const raw: Socket = connect(port, "127.0.0.1");
  await once(raw, "connect");
  writeUpgradeRequest(raw, port);
  const [handshake] = (await once(raw, "data")) as [Buffer];
  assert.match(handshake.toString(), /^HTTP\/1\.1 101 /);

  // Subscribe before shutting down: the socket is torn down while `close()`
  // runs, and subscribing to an already-closed socket would never resolve.
  const rawClosed = waitForSocketClose(raw);
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

// A socket accepted just before `httpServer.close()` can still deliver its
// upgrade request afterwards. Completing that handshake would hand out a
// WebSocket the shutdown immediately drops — a 1006 on a connection that was
// never usable — or leave `wss.close()` waiting on a client that appeared after
// the close-frame pass.
//
// The guarantee under test is only "no WebSocket is handed out, and the
// shutdown still reports no failed steps". How the request is refused is not
// ours to pin: node 22.23.1 answers it with an http 503 before the request
// reaches our handler, node 22.22.2 resets the connection instead (ECONNRESET),
// and `isShuttingDown` produces its own 503 on the paths where the handler does
// run — see the unit test below, which is what actually covers that gate.
test("an upgrade arriving after shutdown started never yields a WebSocket", async () => {
  const { server, port } = await startListeningSyncServer();

  // Connected before shutdown, but the upgrade request is still unsent.
  const late: Socket = connect(port, "127.0.0.1");
  await once(late, "connect");

  const refusal = new Promise<string>((resolve) => {
    late.once("data", (chunk: Buffer) => resolve(chunk.toString()));
    // Torn down without a reply — a refusal all the same. A persistent error
    // listener, so a later EPIPE/ECONNRESET cannot go unhandled either.
    late.on("error", () => resolve(""));
    late.once("close", () => resolve(""));
  });
  const closing = server.close();
  writeUpgradeRequest(late, port);

  const response = await refusal;
  assert.ok(
    !response.startsWith("HTTP/1.1 101"),
    `The upgrade must not complete during shutdown, got: ${JSON.stringify(response.slice(0, 80))}`,
  );
  assert.deepEqual(await closing, []);
  late.destroy();
});

test("the upgrade handler refuses upgrades while shutting down", async () => {
  const wss = new WebSocketServer({ noServer: true });
  let connections = 0;
  wss.on("connection", () => {
    connections += 1;
  });
  const handler = createWsUpgradeHandler({
    securityPolicy: {
      evaluateUpgrade: () => ({
        ok: true,
        context: { remoteAddress: "127.0.0.1", origin: CLIENT_ORIGIN },
      }),
    },
    wss,
    logEvent: () => {},
    isShuttingDown: () => true,
  });

  const socket = new PassThrough();
  const written: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => written.push(chunk));
  handler(
    { headers: {} } as unknown as IncomingMessage,
    socket,
    Buffer.alloc(0),
  );
  await once(socket, "close");

  assert.match(Buffer.concat(written).toString(), /^HTTP\/1\.1 503 /);
  assert.equal(connections, 0);
  wss.close();
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

// Neither entry point's shutdown touches these beyond a structural close()
// probe, so an inert implementation of the real contract is honest here — no
// cast needed, and a field added to either type surfaces as a type error.
const inertEventStore: GlobalEventStore = {
  append: (input) => ({
    id: "evt-test",
    timestamp: input.timestamp ?? "1970-01-01T00:00:00.000Z",
    event: input.event,
    roomCode: null,
    sessionId: null,
    remoteAddress: null,
    origin: null,
    result: null,
    details: { ...input.data },
  }),
  query: () => ({ items: [], total: 0 }),
  totalCountsByEvent: () => ({}),
  countsByEventInWindow: () => ({}),
};

test("room deletion owners drain before their dependencies close", async () => {
  const order: string[] = [];
  const steps = createSharedServerShutdownSteps({
    roomStore: {
      ...createInMemoryRoomStore({ now: () => 0 }),
      close: async () => {
        order.push("close_room_store");
      },
    },
    roomIndexReconciler: {
      runNow: async () => true,
      stop: async () => {
        order.push("stop_room_index_reconciler");
      },
    },
    eventStore: inertEventStore,
    adminCommandBus: createInMemoryAdminCommandBus(() => 0),
    roomEventBus: createInMemoryRoomEventBus(),
    closeAdminActionService: async () => {
      order.push("close_admin_action_service");
    },
    closeRoomService: async () => {
      order.push("close_room_service");
    },
    closeAdminServices: async () => {
      order.push("close_admin_services");
    },
  });

  assert.deepEqual(await runShutdownSteps(steps, () => undefined), []);

  // The reconciler and both effect owners still need the room store; the
  // deletion owners also need runtime state and the room-event bus, which close
  // later in the shared sequence.
  assert.deepEqual(order, [
    "stop_room_index_reconciler",
    "close_admin_action_service",
    "close_room_service",
    "close_room_store",
    "close_admin_services",
  ]);
});

test("the event store closes after every shared log producer", () => {
  const steps = createSharedServerShutdownSteps({
    roomStore: createInMemoryRoomStore({ now: () => 0 }),
    roomIndexReconciler: null,
    eventStore: inertEventStore,
    adminCommandBus: createInMemoryAdminCommandBus(() => 0),
    roomEventBus: createInMemoryRoomEventBus(),
    closeAdminActionService: async () => undefined,
    closeRoomService: async () => undefined,
    closeAdminServices: async () => undefined,
  });

  assert.equal(steps.at(-1)?.name, "close_event_store");
});
