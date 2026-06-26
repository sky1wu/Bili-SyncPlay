import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundRuntimeState } from "../src/background/runtime-state";
import { createSocketController } from "../src/background/socket-controller";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  url: string;
  private readonly listeners = new Map<string, (event: unknown) => void>();

  constructor(url: string) {
    this.url = url;
    createdSockets.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(type, handler);
  }

  emit(type: string, event: unknown): void {
    this.listeners.get(type)?.(event);
  }

  send(): void {}
  close(): void {}
}

let createdSockets: FakeWebSocket[] = [];

function installGlobals(): { restore: () => void } {
  const original = {
    WebSocket: (globalThis as Record<string, unknown>).WebSocket,
    chrome: (globalThis as Record<string, unknown>).chrome,
    self: (globalThis as Record<string, unknown>).self,
  };
  createdSockets = [];
  Object.assign(globalThis, {
    WebSocket: FakeWebSocket,
    chrome: { runtime: { getURL: () => "chrome-extension://test/" } },
    self: { setTimeout, clearTimeout },
  });
  return {
    restore() {
      Object.assign(globalThis, original);
    },
  };
}

function createHarness() {
  const runtimeState = createBackgroundRuntimeState();
  runtimeState.connection.serverUrl = "ws://localhost:9999";
  runtimeState.room.roomCode = "ROOM01";
  const clearPendingLocalShareReasons: string[] = [];

  const controller = createSocketController({
    connectionState: runtimeState.connection,
    roomSessionState: runtimeState.room,
    maxReconnectAttempts: 5,
    log: () => {},
    logInvalidServerUrl: () => {},
    logConnectionProbeFailure: () => {},
    notifyAll: () => {},
    stopClockSyncTimer: () => {},
    syncClock: () => {},
    startClockSyncTimer: () => {},
    clearPendingLocalShare: (reason) => {
      clearPendingLocalShareReasons.push(reason);
    },
    sendJoinRequest: () => {},
    sendToServer: () => {},
    handleServerMessage: async () => {},
    // Returning null skips the connection-check / healthcheck fetches so the
    // probe goes straight to opening the (faked) socket.
    buildConnectionCheckUrl: () => null,
    buildHealthcheckUrl: () => null,
    onOpen: () => {},
    onAdminSessionReset: () => {},
    formatAdminSessionResetReason: (reason) => reason,
    reconnectFailedMessage: () => "reconnect failed",
  });

  return { runtimeState, controller, clearPendingLocalShareReasons };
}

const closeEvent = { code: 1006, reason: "", wasClean: false };

test("socket controller ignores the close event of a superseded socket", async () => {
  const globals = installGlobals();
  try {
    const harness = createHarness();

    await harness.controller.connect();
    const firstSocket = createdSockets[0];
    assert.equal(harness.runtimeState.connection.socket, firstSocket);

    // The first socket is dying (CLOSING) but its close event has not fired yet.
    // A replacement connection is opened (mirrors the explicit-share-during-
    // CLOSING offline branch calling `connect()`).
    firstSocket.readyState = FakeWebSocket.CLOSING;
    await harness.controller.connect();
    const secondSocket = createdSockets[1];
    assert.notEqual(secondSocket, firstSocket);
    assert.equal(harness.runtimeState.connection.socket, secondSocket);

    harness.runtimeState.connection.connected = true;

    // The stale first socket finally emits close. It must be ignored: clearing
    // the pending local share here would drop the share-confirmation marker.
    firstSocket.emit("close", closeEvent);

    assert.deepEqual(harness.clearPendingLocalShareReasons, []);
    assert.equal(harness.runtimeState.connection.connected, true);
  } finally {
    globals.restore();
  }
});

test("socket controller processes the close event of the current socket", async () => {
  const globals = installGlobals();
  try {
    const harness = createHarness();

    await harness.controller.connect();
    const socket = createdSockets[0];
    harness.runtimeState.connection.connected = true;

    socket.emit("close", closeEvent);

    assert.deepEqual(harness.clearPendingLocalShareReasons, [
      "socket closed before share confirmation",
    ]);
    assert.equal(harness.runtimeState.connection.connected, false);
  } finally {
    globals.restore();
  }
});
