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
  closeCalls = 0;
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
  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSING;
  }
}

let createdSockets: FakeWebSocket[] = [];

// Controls the stubbed global `fetch` used by the connection-check probe. When
// `blockFetch` is true the probe's fetch hangs until `releaseFetch()` is called,
// letting a test interleave an admin close while the probe is mid-await.
let blockFetch = false;
let releaseFetch: (() => void) | null = null;

function installGlobals(): { restore: () => void } {
  const original = {
    WebSocket: (globalThis as Record<string, unknown>).WebSocket,
    chrome: (globalThis as Record<string, unknown>).chrome,
    self: (globalThis as Record<string, unknown>).self,
    fetch: (globalThis as Record<string, unknown>).fetch,
  };
  createdSockets = [];
  blockFetch = false;
  releaseFetch = null;
  Object.assign(globalThis, {
    WebSocket: FakeWebSocket,
    chrome: { runtime: { getURL: () => "chrome-extension://test/" } },
    self: { setTimeout, clearTimeout },
    fetch: () => {
      const result = {
        ok: true,
        json: async () => ({ data: { websocketAllowed: true } }),
      };
      if (blockFetch) {
        return new Promise((resolve) => {
          releaseFetch = () => resolve(result);
        });
      }
      return Promise.resolve(result);
    },
  });
  return {
    restore() {
      Object.assign(globalThis, original);
    },
  };
}

function createHarness(options: { withProbeFetch?: boolean } = {}) {
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
    getPendingLocalShareGeneration: () =>
      runtimeState.share.pendingLocalShareGeneration,
    sendJoinRequest: () => {},
    sendToServer: () => {},
    handleServerMessage: async () => {},
    // Returning null skips the connection-check / healthcheck fetches so the
    // probe goes straight to opening the (faked) socket. Opt into the
    // connection-check fetch to exercise the in-flight probe-abort window.
    buildConnectionCheckUrl: () =>
      options.withProbeFetch
        ? "https://localhost:9999/api/connection-check"
        : null,
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
    // The live socket reference is torn down (it is the closing socket itself,
    // so no extra close() is needed).
    assert.equal(harness.runtimeState.connection.socket, null);
    assert.equal(socket.closeCalls, 0);
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
    // A re-flush marker: `flushPendingShare` already nulled `pendingSharedVideo`
    // after rejoin but the replacement is still confirming the re-sent share, so
    // `shareReflushPending` stays true. A late close on the old socket must not
    // touch the live state nor drop the marker the new connection is confirming.
    harness.runtimeState.room.pendingSharedVideo = null;
    harness.runtimeState.room.shareReflushPending = true;

    firstSocket.emit("close", closeEvent());

    assert.deepEqual(harness.clearPendingLocalShareReasons, []);
    assert.equal(harness.runtimeState.connection.connected, true);
  } finally {
    harness?.controller.clearReconnectTimer();
    globals.restore();
  }
});

test("a superseded socket close clears a direct-send marker that will not be re-flushed", async () => {
  const globals = installGlobals();
  let harness: ReturnType<typeof createHarness> | undefined;
  try {
    harness = createHarness();

    await harness.controller.connect();
    const firstSocket = createdSockets[0];
    firstSocket.readyState = FakeWebSocket.CLOSING;
    await harness.controller.connect();
    const secondSocket = createdSockets[1];
    assert.equal(harness.runtimeState.connection.socket, secondSocket);

    harness.runtimeState.connection.connected = true;
    // A share was sent directly on the now-dead old socket (generation 1, not
    // queued for re-flush): nothing will reconfirm it, so its marker must be
    // cleared rather than suppress the post-reconnect room state until timeout.
    harness.runtimeState.room.pendingSharedVideo = null;
    harness.runtimeState.room.shareReflushPending = false;
    harness.runtimeState.share.pendingLocalShareGeneration = 1;

    firstSocket.emit("close", closeEvent());

    assert.deepEqual(harness.clearPendingLocalShareReasons, [
      "superseded socket closed before share confirmation",
    ]);
    // The live replacement connection is untouched.
    assert.equal(harness.runtimeState.connection.connected, true);
    assert.equal(harness.runtimeState.connection.socket, secondSocket);
  } finally {
    harness?.controller.clearReconnectTimer();
    globals.restore();
  }
});

test("a superseded socket close keeps a direct-send marker owned by a newer connection", async () => {
  const globals = installGlobals();
  let harness: ReturnType<typeof createHarness> | undefined;
  try {
    harness = createHarness();

    await harness.controller.connect();
    const firstSocket = createdSockets[0];
    firstSocket.readyState = FakeWebSocket.CLOSING;
    await harness.controller.connect();
    const secondSocket = createdSockets[1];
    assert.equal(harness.runtimeState.connection.socket, secondSocket);

    harness.runtimeState.connection.connected = true;
    // The user sent a fresh direct share on the NEW connection (generation 2)
    // after the old socket was superseded. The old socket's late close must NOT
    // clear that newer marker, even though it is a direct send (not a re-flush).
    harness.runtimeState.room.pendingSharedVideo = null;
    harness.runtimeState.room.shareReflushPending = false;
    harness.runtimeState.share.pendingLocalShareGeneration = 2;

    firstSocket.emit("close", closeEvent());

    assert.deepEqual(harness.clearPendingLocalShareReasons, []);
    assert.equal(harness.runtimeState.connection.socket, secondSocket);
  } finally {
    harness?.controller.clearReconnectTimer();
    globals.restore();
  }
});

test("an aborted in-flight probe is not reused by a later connect", async () => {
  const globals = installGlobals();
  let harness: ReturnType<typeof createHarness> | undefined;
  try {
    harness = createHarness({ withProbeFetch: true });

    await harness.controller.connect();
    const firstSocket = createdSockets[0];
    harness.runtimeState.connection.connected = true;
    firstSocket.readyState = FakeWebSocket.CLOSING;

    // A CLOSING-window reconnect parks on its hanging connection-check fetch.
    blockFetch = true;
    const doomed = harness.controller.connect();
    const parkedRelease = releaseFetch;

    // An admin kick aborts that probe and must also null `connectProbe` so it is
    // not reused.
    firstSocket.emit("close", closeEvent("Admin kicked member"));
    assert.equal(harness.runtimeState.connection.connectProbe, null);

    // A fresh connect must open a new socket instead of awaiting the doomed
    // probe (which would never open a connection).
    blockFetch = false;
    await harness.controller.connect();
    assert.equal(createdSockets.length, 2);
    assert.equal(harness.runtimeState.connection.socket, createdSockets[1]);

    // Releasing the doomed probe must not clobber the fresh probe's bookkeeping.
    parkedRelease?.();
    await doomed;
    assert.equal(harness.runtimeState.connection.socket, createdSockets[1]);
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
    const secondSocket = createdSockets[1];

    // An admin kick on the old connection must still tear down the session even
    // though the socket has been superseded, so the kicked user cannot rejoin.
    firstSocket.emit("close", closeEvent("Admin disconnected session"));

    assert.deepEqual(harness.adminResets, ["Admin disconnected session"]);
    // The live replacement socket must be closed (otherwise it lingers as a
    // ghost connection that already rejoined), and the ref nulled so its own
    // close is treated as superseded and never reconnects.
    assert.equal(secondSocket.closeCalls, 1);
    assert.equal(firstSocket.closeCalls, 0);
    assert.equal(harness.runtimeState.connection.socket, null);
  } finally {
    harness?.controller.clearReconnectTimer();
    globals.restore();
  }
});

test("a CLOSING-window reconnect clears the stale connected flag for the CONNECTING replacement", async () => {
  const globals = installGlobals();
  let harness: ReturnType<typeof createHarness> | undefined;
  try {
    harness = createHarness();

    await harness.controller.connect();
    const firstSocket = createdSockets[0];
    // The old connection was online; its socket is now CLOSING but the close
    // event has not dispatched, so `connected` still reads the stale true.
    harness.runtimeState.connection.connected = true;
    firstSocket.readyState = FakeWebSocket.CLOSING;

    await harness.controller.connect();
    const secondSocket = createdSockets[1];

    assert.notEqual(secondSocket, firstSocket);
    assert.equal(harness.runtimeState.connection.socket, secondSocket);
    // The replacement is only CONNECTING; until its `open` fires the connection
    // is not writable. `connected` must be cleared so requestCreateRoom /
    // requestJoinRoom (which gate on `connected` after `await connect()`) do not
    // hand room:create / room:join to a non-OPEN socket that drops them.
    assert.equal(secondSocket.readyState, FakeWebSocket.CONNECTING);
    assert.equal(harness.runtimeState.connection.connected, false);
  } finally {
    harness?.controller.clearReconnectTimer();
    globals.restore();
  }
});

test("an admin reset aborts an in-flight reconnect probe instead of opening a ghost socket", async () => {
  const globals = installGlobals();
  let harness: ReturnType<typeof createHarness> | undefined;
  try {
    harness = createHarness({ withProbeFetch: true });

    // First connect: the connection-check fetch resolves immediately and opens
    // the live socket.
    await harness.controller.connect();
    const firstSocket = createdSockets[0];
    harness.runtimeState.connection.connected = true;
    firstSocket.readyState = FakeWebSocket.CLOSING;

    // A CLOSING-window reconnect starts but its connection-check fetch now hangs,
    // so the probe is parked before it can create the replacement socket.
    blockFetch = true;
    const probe = harness.controller.connect();

    // The admin kick lands on the old socket while the probe is still awaiting.
    firstSocket.emit("close", closeEvent("Admin kicked member"));

    // Releasing the fetch lets the probe resume; it must detect the abort and
    // bail out rather than open a room-less ghost connection.
    releaseFetch?.();
    await probe;

    assert.deepEqual(harness.adminResets, ["Admin kicked member"]);
    // No replacement socket was created, and the live ref stays torn down so the
    // admin reason is not cleared by a stray `open`.
    assert.equal(createdSockets.length, 1);
    assert.equal(harness.runtimeState.connection.socket, null);
    assert.equal(harness.runtimeState.connection.connected, false);
  } finally {
    harness?.controller.clearReconnectTimer();
    globals.restore();
  }
});
