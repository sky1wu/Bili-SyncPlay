import test from "node:test";
import assert from "node:assert/strict";
import type { RoomState } from "@bili-syncplay/protocol";
import {
  clearPendingLocalShareState,
  createPendingLocalShareExpiry,
  decideIncomingRoomState,
  getActivePendingLocalShareUrl,
  isSharedVideoChange,
  preparePendingLocalShareCleanup,
  preparePendingLocalShareCleanupForRoomLifecycle,
  shouldClearPendingLocalShareOnServerUrlChange,
} from "../src/background/room-state";

function createRoomState(sharedUrl: string | null): RoomState {
  return {
    roomCode: "ROOM01",
    sharedVideo: sharedUrl
      ? {
          videoId: "BV1xx411c7mD",
          url: sharedUrl,
          title: "Test Video",
        }
      : null,
    playback: null,
    members: [],
  };
}

test("ignores stale room state while waiting for local share confirmation", () => {
  const decision = decideIncomingRoomState({
    currentRoomState: createRoomState(
      "https://www.bilibili.com/video/BV1A?p=1",
    ),
    normalizedPendingLocalShareUrl: "https://www.bilibili.com/video/BV1B?p=1",
    normalizedIncomingSharedUrl: "https://www.bilibili.com/video/BV1A?p=1",
  });

  assert.deepEqual(decision, { kind: "ignore-stale" });
});

test("applies matching room state and confirms pending local share", () => {
  const decision = decideIncomingRoomState({
    currentRoomState: createRoomState(
      "https://www.bilibili.com/video/BV1A?p=1",
    ),
    normalizedPendingLocalShareUrl: "https://www.bilibili.com/video/BV1B?p=1",
    normalizedIncomingSharedUrl: "https://www.bilibili.com/video/BV1B?p=1",
  });

  assert.deepEqual(decision, {
    kind: "apply",
    previousSharedUrl: "https://www.bilibili.com/video/BV1A?p=1",
    confirmedPendingLocalShare: true,
  });
});

test("does not misclassify a legal new room state as stale when no local share is pending", () => {
  const nextState = createRoomState("https://www.bilibili.com/video/BV1C?p=1");
  const decision = decideIncomingRoomState({
    currentRoomState: createRoomState(
      "https://www.bilibili.com/video/BV1A?p=1",
    ),
    normalizedPendingLocalShareUrl: null,
    normalizedIncomingSharedUrl: "https://www.bilibili.com/video/BV1C?p=1",
  });

  assert.equal(decision.kind, "apply");
  assert.equal(decision.confirmedPendingLocalShare, false);
  assert.equal(
    isSharedVideoChange(decision.previousSharedUrl, nextState),
    true,
  );
});

test("expires pending local share when confirmation does not arrive in time", () => {
  const now = 1_000;
  const pendingLocalShareExpiresAt = createPendingLocalShareExpiry(now, 5_000);
  const activePendingLocalShareUrl = getActivePendingLocalShareUrl({
    pendingLocalShareUrl: "https://www.bilibili.com/video/BV1B?p=1",
    pendingLocalShareExpiresAt,
    now: now + 5_001,
  });

  assert.equal(activePendingLocalShareUrl, null);

  const decision = decideIncomingRoomState({
    currentRoomState: createRoomState(
      "https://www.bilibili.com/video/BV1A?p=1",
    ),
    normalizedPendingLocalShareUrl: activePendingLocalShareUrl,
    normalizedIncomingSharedUrl: "https://www.bilibili.com/video/BV1C?p=1",
  });

  assert.equal(decision.kind, "apply");
  assert.equal(decision.confirmedPendingLocalShare, false);
});

test("clears pending local share when server URL changes without an active socket", () => {
  assert.equal(
    shouldClearPendingLocalShareOnServerUrlChange({
      currentServerUrl: "ws://localhost:8787",
      nextServerUrl: "ws://localhost:8788",
      pendingLocalShareUrl: "https://www.bilibili.com/video/BV1B?p=1",
    }),
    true,
  );
});

test("clears pending local share url, expiry, and timer through the shared cleanup state", () => {
  assert.deepEqual(clearPendingLocalShareState(), {
    pendingLocalShareUrl: null,
    pendingLocalShareExpiresAt: null,
    pendingLocalShareTimer: null,
  });
});

test("shared cleanup plan requests timer cancellation and clears all pending local share fields", () => {
  const cleanup = preparePendingLocalShareCleanup({
    pendingLocalShareUrl: "https://www.bilibili.com/video/BV1B?p=1",
    pendingLocalShareExpiresAt: 1234,
    pendingLocalShareTimer: 99,
  });

  assert.equal(cleanup.hadPendingLocalShare, true);
  assert.equal(cleanup.shouldCancelTimer, true);
  assert.deepEqual(cleanup.nextState, {
    pendingLocalShareUrl: null,
    pendingLocalShareExpiresAt: null,
    pendingLocalShareTimer: null,
  });
});

test("create room cleanup plan clears pending local share and cancels the old timer", () => {
  const cleanup = preparePendingLocalShareCleanupForRoomLifecycle(
    "create-room",
    {
      pendingLocalShareUrl: "https://www.bilibili.com/video/BV1B?p=1",
      pendingLocalShareExpiresAt: 1234,
      pendingLocalShareTimer: 99,
    },
  );

  assert.equal(cleanup.hadPendingLocalShare, true);
  assert.equal(cleanup.shouldCancelTimer, true);
  assert.deepEqual(cleanup.nextState, clearPendingLocalShareState());
});

test("join room cleanup plan clears pending local share and cancels the old timer", () => {
  const cleanup = preparePendingLocalShareCleanupForRoomLifecycle("join-room", {
    pendingLocalShareUrl: "https://www.bilibili.com/video/BV1B?p=1",
    pendingLocalShareExpiresAt: 1234,
    pendingLocalShareTimer: 99,
  });

  assert.equal(cleanup.hadPendingLocalShare, true);
  assert.equal(cleanup.shouldCancelTimer, true);
  assert.deepEqual(cleanup.nextState, clearPendingLocalShareState());
});

test("leave room cleanup plan clears pending local share and cancels the old timer", () => {
  const cleanup = preparePendingLocalShareCleanupForRoomLifecycle(
    "leave-room",
    {
      pendingLocalShareUrl: "https://www.bilibili.com/video/BV1B?p=1",
      pendingLocalShareExpiresAt: 1234,
      pendingLocalShareTimer: 99,
    },
  );

  assert.equal(cleanup.hadPendingLocalShare, true);
  assert.equal(cleanup.shouldCancelTimer, true);
  assert.deepEqual(cleanup.nextState, clearPendingLocalShareState());
});

test("room lifecycle cleanup plan does not request timer cancellation when no timer exists", () => {
  const cleanup = preparePendingLocalShareCleanupForRoomLifecycle(
    "leave-room",
    {
      pendingLocalShareUrl: "https://www.bilibili.com/video/BV1B?p=1",
      pendingLocalShareExpiresAt: 1234,
      pendingLocalShareTimer: null,
    },
  );

  assert.equal(cleanup.hadPendingLocalShare, true);
  assert.equal(cleanup.shouldCancelTimer, false);
  assert.deepEqual(cleanup.nextState, clearPendingLocalShareState());
});
