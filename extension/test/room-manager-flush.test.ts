import assert from "node:assert/strict";
import test from "node:test";
import type { ClientMessage, SharedVideo } from "@bili-syncplay/protocol";
import { executeFlushPendingShare } from "../src/background/room-manager";

const sampleVideo: SharedVideo = {
  videoId: "BV199W9zEEcH",
  url: "https://www.bilibili.com/video/BV199W9zEEcH",
  title: "Queued Video",
};

function createHarness(overrides?: {
  pendingSharedVideo?: SharedVideo | null;
  pendingLocalShareUrl?: string | null;
  pendingLocalShareGeneration?: number | null;
  socketGeneration?: number;
  connected?: boolean;
}) {
  const sent: ClientMessage[] = [];
  const roomSessionState = {
    pendingSharedVideo:
      overrides?.pendingSharedVideo === undefined
        ? sampleVideo
        : overrides.pendingSharedVideo,
    pendingSharedPlayback: null,
    memberToken: "member-token-1",
    roomCode: "ROOM01",
  };
  const connectionState = {
    connected: overrides?.connected ?? true,
    socketGeneration: overrides?.socketGeneration ?? 2,
  };
  const shareState = {
    pendingLocalShareUrl:
      overrides?.pendingLocalShareUrl === undefined
        ? sampleVideo.url
        : overrides.pendingLocalShareUrl,
    pendingLocalShareGeneration:
      overrides?.pendingLocalShareGeneration === undefined
        ? 1
        : overrides.pendingLocalShareGeneration,
  };
  return { sent, roomSessionState, connectionState, shareState };
}

test("executeFlushPendingShare transfers marker ownership to the live socket", () => {
  const harness = createHarness();

  executeFlushPendingShare({
    roomSessionState: harness.roomSessionState,
    connectionState: harness.connectionState,
    shareState: harness.shareState,
    sendToServer: (message) => harness.sent.push(message),
  });

  // The queued share is re-sent and the queue cleared.
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.roomSessionState.pendingSharedVideo, null);
  // The marker was created on the old socket (generation 1); the re-flush re-sent
  // it on the live socket (generation 2), so ownership moves to generation 2.
  // This stops the old socket's late close from clearing a marker the live socket
  // is still confirming.
  assert.equal(harness.shareState.pendingLocalShareGeneration, 2);
});

test("executeFlushPendingShare leaves the generation untouched when no marker is pending", () => {
  const harness = createHarness({
    pendingLocalShareUrl: null,
    pendingLocalShareGeneration: null,
  });

  executeFlushPendingShare({
    roomSessionState: harness.roomSessionState,
    connectionState: harness.connectionState,
    shareState: harness.shareState,
    sendToServer: (message) => harness.sent.push(message),
  });

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.shareState.pendingLocalShareGeneration, null);
});

test("executeFlushPendingShare does not re-stamp when nothing is queued to flush", () => {
  const harness = createHarness({ pendingSharedVideo: null });

  executeFlushPendingShare({
    roomSessionState: harness.roomSessionState,
    connectionState: harness.connectionState,
    shareState: harness.shareState,
    sendToServer: (message) => harness.sent.push(message),
  });

  // No flush, so no re-send and the marker generation stays as it was.
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.shareState.pendingLocalShareGeneration, 1);
});
