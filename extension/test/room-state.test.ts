import test from "node:test";
import assert from "node:assert/strict";
import type { RoomState } from "@bili-syncplay/protocol";
import { decideIncomingRoomState, isSharedVideoChange } from "../src/background/room-state";

function createRoomState(sharedUrl: string | null): RoomState {
  return {
    roomCode: "ROOM01",
    sharedVideo: sharedUrl
      ? {
          videoId: "BV1xx411c7mD",
          url: sharedUrl,
          title: "Test Video"
        }
      : null,
    playback: null,
    members: []
  };
}

test("ignores stale room state while waiting for local share confirmation", () => {
  const decision = decideIncomingRoomState({
    currentRoomState: createRoomState("https://www.bilibili.com/video/BV1A?p=1"),
    nextState: createRoomState("https://www.bilibili.com/video/BV1A?p=1"),
    normalizedPendingLocalShareUrl: "https://www.bilibili.com/video/BV1B?p=1",
    normalizedIncomingSharedUrl: "https://www.bilibili.com/video/BV1A?p=1"
  });

  assert.deepEqual(decision, { kind: "ignore-stale" });
});

test("applies matching room state and confirms pending local share", () => {
  const decision = decideIncomingRoomState({
    currentRoomState: createRoomState("https://www.bilibili.com/video/BV1A?p=1"),
    nextState: createRoomState("https://www.bilibili.com/video/BV1B?p=1"),
    normalizedPendingLocalShareUrl: "https://www.bilibili.com/video/BV1B?p=1",
    normalizedIncomingSharedUrl: "https://www.bilibili.com/video/BV1B?p=1"
  });

  assert.deepEqual(decision, {
    kind: "apply",
    previousSharedUrl: "https://www.bilibili.com/video/BV1A?p=1",
    confirmedPendingLocalShare: true
  });
});

test("does not misclassify a legal new room state as stale when no local share is pending", () => {
  const nextState = createRoomState("https://www.bilibili.com/video/BV1C?p=1");
  const decision = decideIncomingRoomState({
    currentRoomState: createRoomState("https://www.bilibili.com/video/BV1A?p=1"),
    nextState,
    normalizedPendingLocalShareUrl: null,
    normalizedIncomingSharedUrl: "https://www.bilibili.com/video/BV1C?p=1"
  });

  assert.equal(decision.kind, "apply");
  assert.equal(decision.confirmedPendingLocalShare, false);
  assert.equal(isSharedVideoChange(decision.previousSharedUrl, nextState), true);
});
