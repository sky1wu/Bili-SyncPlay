import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  installGracefulShutdown,
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
};

function createHarness(): Harness {
  const emitter = new EventEmitter();
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  return {
    signalTarget: {
      on: (signal, listener) => emitter.on(signal, listener),
      off: (signal, listener) => emitter.off(signal, listener),
      emit: (signal) => emitter.emit(signal),
      listenerCount: (signal) => emitter.listenerCount(signal),
    },
    logs,
    errors,
    exitCodes,
  };
}

function install(
  harness: Harness,
  close: () => Promise<void>,
  overrides: { forceExitTimeoutMs?: number } = {},
): () => void {
  return installGracefulShutdown({
    close,
    name: "test server",
    signalTarget: harness.signalTarget,
    log: (message) => harness.logs.push(message),
    logError: (message) => harness.errors.push(message),
    exit: (code) => harness.exitCodes.push(code),
    ...overrides,
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("SIGTERM runs close and exits with code 0", async () => {
  const harness = createHarness();
  let closeCalls = 0;
  install(harness, async () => {
    closeCalls += 1;
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

test("a hung close is force-exited after the watchdog timeout", async () => {
  const harness = createHarness();
  install(harness, () => new Promise<void>(() => undefined), {
    forceExitTimeoutMs: 10,
  });

  harness.signalTarget.emit("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(harness.exitCodes, [1]);
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

test("handlers are detached after shutdown and by the returned detach", async () => {
  const harness = createHarness();
  const detach = install(harness, async () => undefined);

  assert.equal(harness.signalTarget.listenerCount("SIGTERM"), 1);
  assert.equal(harness.signalTarget.listenerCount("SIGINT"), 1);
  detach();
  assert.equal(harness.signalTarget.listenerCount("SIGTERM"), 0);
  assert.equal(harness.signalTarget.listenerCount("SIGINT"), 0);

  const other = createHarness();
  install(other, async () => undefined);
  other.signalTarget.emit("SIGTERM");
  await flush();
  assert.equal(other.signalTarget.listenerCount("SIGTERM"), 0);
  assert.equal(other.signalTarget.listenerCount("SIGINT"), 0);
});
