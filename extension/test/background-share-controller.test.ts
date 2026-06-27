import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION } from "@bili-syncplay/protocol";
import { createBackgroundRuntimeState } from "../src/background/runtime-state";
import { createShareController } from "../src/background/share-controller";

// Node < 22 has no global WebSocket; production `isSocketWritable` reads
// `WebSocket.OPEN`. Provide the readyState statics so these unit tests run on
// any Node (CI pins Node 22 via .nvmrc, where it is already present).
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  };
}

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

test("background share controller distinguishes manual and auto pending local shares", async () => {
  const selfHarness = installSelfStub();
  const harness = createControllerHarness();
  harness.runtimeState.connection.connected = true;
  harness.runtimeState.room.roomCode = "ROOM01";
  harness.runtimeState.room.memberToken = "member-token-1";
  harness.runtimeState.room.memberId = "member-1";

  const video = {
    video: {
      videoId: "BV199W9zEEcH",
      url: "https://www.bilibili.com/video/BV199W9zEEcH",
      title: "New Video",
    },
    playback: null,
  };

  try {
    // A manual share leaves a pending marker that blocks a chained auto-share.
    await harness.controller.queueOrSendSharedVideo(video, 123);
    assert.equal(harness.controller.hasActivePendingLocalShare(), true);
    assert.equal(harness.controller.hasActivePendingManualShare(), true);

    // An auto-share's own in-flight marker must NOT count as a manual share, so
    // the next chain step can advance past it.
    await harness.controller.queueOrSendSharedVideo(video, 123, true);
    assert.equal(harness.controller.hasActivePendingLocalShare(), true);
    assert.equal(harness.controller.hasActivePendingManualShare(), false);

    // Clearing the marker resets the auto flag too.
    harness.controller.clearPendingLocalShare("test");
    assert.equal(harness.controller.hasActivePendingLocalShare(), false);
    assert.equal(harness.controller.hasActivePendingManualShare(), false);
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
    // silently). It is queued for the reconnect flush instead.
    assert.deepEqual(harness.sendToServerCalls, []);
    assert.deepEqual(harness.runtimeState.room.pendingSharedVideo, {
      videoId: "BV199W9zEEcH",
      url: "https://www.bilibili.com/video/BV199W9zEEcH",
      title: "New Video",
    });
    // The session is still valid: the member token is KEPT so the rejoin
    // re-attaches as the same member (clearing it would spawn a new memberId /
    // duplicate member). The reconnect flush re-sends the queued share.
    assert.equal(harness.runtimeState.room.memberToken, "member-token-1");
    // The CLOSING branch reconnects (the harness `connect` stub flips this true).
    assert.equal(harness.runtimeState.connection.connected, true);
  } finally {
    selfHarness.restore();
  }
});

test("background share controller keeps the member token for a second share during the reconnect window", async () => {
  const selfHarness = installSelfStub();
  const harness = createControllerHarness();
  // A previous CLOSING-window share already swapped in a CONNECTING replacement
  // socket, which clears `connected`. The session is still valid.
  harness.runtimeState.connection.connected = false;
  setSocketReadyState(harness.runtimeState, WebSocket.CONNECTING);
  harness.runtimeState.room.roomCode = "ROOM01";
  harness.runtimeState.room.memberToken = "member-token-1";
  harness.runtimeState.room.memberId = "member-1";
  harness.runtimeState.room.pendingSharedVideo = {
    videoId: "BVfirst",
    url: "https://www.bilibili.com/video/BVfirst",
    title: "First Video",
  };

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
    // Not sent over the not-yet-OPEN socket; queued for the reconnect flush.
    assert.deepEqual(harness.sendToServerCalls, []);
    // The queued video is replaced with the latest share.
    assert.deepEqual(harness.runtimeState.room.pendingSharedVideo, {
      videoId: "BV199W9zEEcH",
      url: "https://www.bilibili.com/video/BV199W9zEEcH",
      title: "New Video",
    });
    // The member token MUST survive (do not fall through to the offline branch
    // that nulls it, which would spawn a duplicate member on rejoin).
    assert.equal(harness.runtimeState.room.memberToken, "member-token-1");
  } finally {
    selfHarness.restore();
  }
});

test("background share controller replaces a still-queued share when direct-sending a newer one", async () => {
  const selfHarness = installSelfStub();
  const harness = createControllerHarness();
  // The replacement socket opened (connected + writable) but `room:joined` has
  // not returned yet, so a prior CLOSING-window share is still queued for the
  // pending rejoin flush.
  harness.runtimeState.connection.connected = true;
  setSocketReadyState(harness.runtimeState, WebSocket.OPEN);
  harness.runtimeState.room.roomCode = "ROOM01";
  harness.runtimeState.room.memberToken = "member-token-1";
  harness.runtimeState.room.memberId = "member-1";
  harness.runtimeState.room.pendingSharedVideo = {
    videoId: "BVfirst",
    url: "https://www.bilibili.com/video/BVfirst",
    title: "First Video",
  };

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
    // The newer video is sent directly over the OPEN socket.
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
    // The stale queued share MUST be replaced with the latest one; otherwise the
    // post-rejoin flush would re-send the old video and roll back this share.
    assert.deepEqual(harness.runtimeState.room.pendingSharedVideo, {
      videoId: "BV199W9zEEcH",
      url: "https://www.bilibili.com/video/BV199W9zEEcH",
      title: "New Video",
    });
  } finally {
    selfHarness.restore();
  }
});

test("background share controller keeps the member token in the error-before-close window", async () => {
  const selfHarness = installSelfStub();
  const harness = createControllerHarness();
  // The socket `error` handler flipped `connected` false, but the socket lingers
  // in CLOSING until its `close` event dispatches. A manual share here must keep
  // the member token instead of falling through to the offline branch.
  harness.runtimeState.connection.connected = false;
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
    // Not written over the dying socket; queued for the reconnect flush.
    assert.deepEqual(harness.sendToServerCalls, []);
    assert.deepEqual(harness.runtimeState.room.pendingSharedVideo, {
      videoId: "BV199W9zEEcH",
      url: "https://www.bilibili.com/video/BV199W9zEEcH",
      title: "New Video",
    });
    // The member token MUST survive so the rejoin re-attaches as the same member
    // (clearing it would surface a duplicate member with a new memberId).
    assert.equal(harness.runtimeState.room.memberToken, "member-token-1");
    // The reconnect was triggered (the harness `connect` stub flips this true).
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
