import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION } from "@bili-syncplay/protocol";
import { createBackgroundRuntimeState } from "../src/background/runtime-state";
import { createShareController } from "../src/background/share-controller";

function installSelfStub() {
  const originalSelf = globalThis.self;
  Object.assign(globalThis, {
    self: {
      setTimeout,
      clearTimeout,
    },
  });

  return {
    restore() {
      Object.assign(globalThis, { self: originalSelf });
    },
  };
}

function setSocketReadyState(
  runtimeState: ReturnType<typeof createBackgroundRuntimeState>,
  readyState: number,
): void {
  runtimeState.connection.socket = { readyState } as WebSocket;
}

function createControllerHarness() {
  const runtimeState = createBackgroundRuntimeState();
  // Default the connected-path tests to a writable socket. Production now gates
  // the "send now" branch on the live socket being OPEN, not just
  // `connection.connected`, so an online harness must expose an OPEN socket.
  setSocketReadyState(runtimeState, WebSocket.OPEN);
  const sendToServerCalls: Array<unknown> = [];
  const rememberedSharedTabs: Array<{
    tabId?: number;
    videoUrl?: string | null;
  }> = [];
  let notifyAllCalls = 0;

  const controller = createShareController({
    connectionState: runtimeState.connection,
    roomSessionState: runtimeState.room,
    shareState: runtimeState.share,
    log: () => {},
    sendToServer: (message) => {
      sendToServerCalls.push(message);
    },
    connect: async () => {
      runtimeState.connection.connected = true;
    },
    persistState: async () => {},
    notifyAll: () => {
      notifyAllCalls += 1;
    },
    rememberSharedSourceTab: (tabId, videoUrl) => {
      rememberedSharedTabs.push({ tabId, videoUrl });
    },
  });

  return {
    runtimeState,
    controller,
    sendToServerCalls,
    rememberedSharedTabs,
    get notifyAllCalls() {
      return notifyAllCalls;
    },
  };
}

test("background share controller forwards a share without playback when content omits stale snapshot", async () => {
  const selfHarness = installSelfStub();
  const harness = createControllerHarness();
  harness.runtimeState.connection.connected = true;
  harness.runtimeState.room.roomCode = "ROOM01";
  harness.runtimeState.room.memberToken = "member-token-1";
  harness.runtimeState.room.memberId = "member-1";

  try {
    const result = await harness.controller.queueOrSendSharedVideo(
      {
        video: {
          videoId: "BV199W9zEEcH",
          url: "https://www.bilibili.com/video/BV199W9zEEcH",
          title: "New Video",
        },
        playback: null,
      },
      123,
    );

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(harness.rememberedSharedTabs, [
      {
        tabId: 123,
        videoUrl: "https://www.bilibili.com/video/BV199W9zEEcH",
      },
    ]);
    assert.deepEqual(harness.sendToServerCalls, [
      {
        type: "video:share",
        payload: {
          memberToken: "member-token-1",
          video: {
            videoId: "BV199W9zEEcH",
            url: "https://www.bilibili.com/video/BV199W9zEEcH",
            title: "New Video",
          },
        },
      },
    ]);
    assert.equal(harness.notifyAllCalls, 0);
  } finally {
    selfHarness.restore();
  }
});

test("background share controller queues the share for reconnect when the socket is closing", async () => {
  const selfHarness = installSelfStub();
  const harness = createControllerHarness();
  // `connected` lags the socket: the close event has not dispatched yet, so the
  // background still believes it is online while the socket can no longer write.
  harness.runtimeState.connection.connected = true;
  setSocketReadyState(harness.runtimeState, WebSocket.CLOSING);
  harness.runtimeState.room.roomCode = "ROOM01";
  harness.runtimeState.room.memberToken = "member-token-1";
  harness.runtimeState.room.memberId = "member-1";

  try {
    const result = await harness.controller.queueOrSendSharedVideo(
      {
        video: {
          videoId: "BV199W9zEEcH",
          url: "https://www.bilibili.com/video/BV199W9zEEcH",
          title: "New Video",
        },
        playback: null,
      },
      123,
    );

    assert.deepEqual(result, { ok: true });
    // The share must NOT be sent over the dying socket (it would be dropped
    // silently). It is queued instead and the member token is cleared to force a
    // fresh rejoin, after which `flushPendingShare` re-sends it.
    assert.deepEqual(harness.sendToServerCalls, []);
    assert.deepEqual(harness.runtimeState.room.pendingSharedVideo, {
      videoId: "BV199W9zEEcH",
      url: "https://www.bilibili.com/video/BV199W9zEEcH",
      title: "New Video",
    });
    assert.equal(harness.runtimeState.room.memberToken, null);
    // The offline branch reconnects (the harness `connect` stub flips this true).
    assert.equal(harness.runtimeState.connection.connected, true);
  } finally {
    selfHarness.restore();
  }
});

test("background share controller sends create request with protocolVersion when sharing outside a room", async () => {
  const selfHarness = installSelfStub();
  const harness = createControllerHarness();
  harness.runtimeState.connection.connected = true;
  harness.runtimeState.room.displayName = "Alice";

  try {
    const result = await harness.controller.queueOrSendSharedVideo(
      {
        video: {
          videoId: "BV199W9zEEcH",
          url: "https://www.bilibili.com/video/BV199W9zEEcH",
          title: "New Video",
        },
        playback: null,
      },
      123,
    );

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(harness.sendToServerCalls, [
      {
        type: "room:create",
        payload: {
          displayName: "Alice",
          protocolVersion: PROTOCOL_VERSION,
        },
      },
    ]);
    assert.equal(harness.runtimeState.room.pendingCreateRoom, false);
  } finally {
    selfHarness.restore();
  }
});

test("background share controller reports missing member token without queuing a local share", async () => {
  const harness = createControllerHarness();
  harness.runtimeState.connection.connected = true;
  harness.runtimeState.room.roomCode = "ROOM01";
  harness.runtimeState.room.memberToken = null;

  const result = await harness.controller.queueOrSendSharedVideo(
    {
      video: {
        videoId: "BV199W9zEEcH",
        url: "https://www.bilibili.com/video/BV199W9zEEcH",
        title: "New Video",
      },
      playback: null,
    },
    123,
  );

  assert.deepEqual(result, {
    ok: false,
    error: "Member token is missing. Rejoin the room.",
  });
  assert.deepEqual(harness.rememberedSharedTabs, [
    {
      tabId: 123,
      videoUrl: "https://www.bilibili.com/video/BV199W9zEEcH",
    },
  ]);
  assert.deepEqual(harness.sendToServerCalls, []);
  assert.equal(harness.runtimeState.share.pendingLocalShareUrl, null);
  assert.equal(harness.notifyAllCalls, 0);
});
