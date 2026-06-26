import assert from "node:assert/strict";
import test from "node:test";
import type { SharedVideo } from "@bili-syncplay/protocol";
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
  const adminResets: string[] = [];

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
    onAdminSessionReset: (reason) => {
      adminResets.push(reason);
    },
    formatAdminSessionResetReason: (reason) => reason,
    reconnectFailedMessage: () => "reconnect failed",
  });

  return {
    runtimeState,
    controller,
    clearPendingLocalShareReasons,
    adminResets,
  };
}

const sampleVideo: SharedVideo = {
  videoId: "BV199W9zEEcH",
  url: "https://www.bilibili.com/video/BV199W9zEEcH",
  title: "New Video",
};

function closeEvent(reason = "") {
  return { code: 1006, reason, wasClean: false };
}

test("socket close keeps the pending local share marker while a share is queued for re-flush", async () => {
  const globals = installGlobals();
  let harness: ReturnType<typeof createHarness> | undefined;
  try {
    harness = createHarness();

    await harness.controller.connect();
    const socket = createdSockets[0];
    harness.runtimeState.connection.connected = true;
    // The share was queued (offline/CLOSING branch) and will be re-flushed on
    // reconnect, so the confirmation marker must survive this close.
    harness.runtimeState.room.pendingSharedVideo = sampleVideo;

    socket.emit("close", closeEvent());

    assert.deepEqual(harness.clearPendingLocalShareReasons, []);
    assert.equal(harness.runtimeState.connection.connected, false);
  } finally {
    harness?.controller.clearReconnectTimer();
    globals.restore();
  }
});

test("socket close clears the pending local share marker when no share is queued", async () => {
  const globals = installGlobals();
  let harness: ReturnType<typeof createHarness> | undefined;
  try {
    harness = createHarness();

    await harness.controller.connect();
    const socket = createdSockets[0];
    harness.runtimeState.connection.connected = true;
    // Nothing queued to re-flush: the in-flight share is lost, so the marker
    // must be cleared to let fresh room state apply.
    harness.runtimeState.room.pendingSharedVideo = null;

    socket.emit("close", closeEvent());

    assert.deepEqual(harness.clearPendingLocalShareReasons, [
      "socket closed before share confirmation",
    ]);
    assert.equal(harness.runtimeState.connection.connected, false);
  } finally {
    harness?.controller.clearReconnectTimer();
    globals.restore();
  }
});

test("socket close still applies an admin session reset even with a queued share", async () => {
  const globals = installGlobals();
  let harness: ReturnType<typeof createHarness> | undefined;
  try {
    harness = createHarness();

    await harness.controller.connect();
    const socket = createdSockets[0];
    harness.runtimeState.connection.connected = true;
    harness.runtimeState.room.pendingSharedVideo = sampleVideo;

    socket.emit("close", closeEvent("Admin kicked member"));

    // The admin reset must take effect regardless of the queued share / marker
    // handling, so the client honours the kick instead of silently rejoining.
    assert.deepEqual(harness.adminResets, ["Admin kicked member"]);
  } finally {
    harness?.controller.clearReconnectTimer();
    globals.restore();
  }
});

test("socket controller ignores the close of a superseded socket", async () => {
  const globals = installGlobals();
  let harness: ReturnType<typeof createHarness> | undefined;
  try {
    harness = createHarness();

    await harness.controller.connect();
    const firstSocket = createdSockets[0];
    // The first socket is dying; a replacement connection is opened (mirrors the
    // CLOSING-window share / clock-sync calling `connect()`).
    firstSocket.readyState = FakeWebSocket.CLOSING;
    await harness.controller.connect();
    const secondSocket = createdSockets[1];
    assert.notEqual(secondSocket, firstSocket);
    assert.equal(harness.runtimeState.connection.socket, secondSocket);

    harness.runtimeState.connection.connected = true;
    // Even with nothing queued (which on the current socket would clear the
    // marker), the superseded socket's close must not touch the live state:
    // after `flushPendingShare` nulls `pendingSharedVideo`, a late old close
    // would otherwise drop the marker the new connection is still confirming.
    harness.runtimeState.room.pendingSharedVideo = null;

    firstSocket.emit("close", closeEvent());

    assert.deepEqual(harness.clearPendingLocalShareReasons, []);
    assert.equal(harness.runtimeState.connection.connected, true);
  } finally {
    harness?.controller.clearReconnectTimer();
    globals.restore();
  }
});

test("socket controller still applies an admin reset from a superseded socket", async () => {
  const globals = installGlobals();
  let harness: ReturnType<typeof createHarness> | undefined;
  try {
    harness = createHarness();

    await harness.controller.connect();
    const firstSocket = createdSockets[0];
    firstSocket.readyState = FakeWebSocket.CLOSING;
    await harness.controller.connect();

    // An admin kick on the old connection must still tear down the session even
    // though the socket has been superseded, so the kicked user cannot rejoin.
    firstSocket.emit("close", closeEvent("Admin kicked member"));

    assert.deepEqual(harness.adminResets, ["Admin kicked member"]);
  } finally {
    harness?.controller.clearReconnectTimer();
    globals.restore();
  }
});
