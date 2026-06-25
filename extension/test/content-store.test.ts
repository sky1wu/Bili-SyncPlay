import assert from "node:assert/strict";
import test from "node:test";
import { createContentStateStore } from "../src/content/content-store";

test("content state store exposes stable mutable state and patch semantics", () => {
  const store = createContentStateStore();
  const initialState = store.getState();

  store.patch({
    activeRoomCode: "ROOM01",
    activeSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    activeSharedByMemberId: "member-1",
    suppressedLocalEndPauseUrl:
      "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    suppressedLocalEndPauseUntil: 1_500,
    hydrationReady: true,
  });

  const nextState = store.getState();
  assert.equal(nextState, initialState);
  assert.equal(nextState.activeRoomCode, "ROOM01");
  assert.equal(
    nextState.activeSharedUrl,
    "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
  );
  assert.equal(nextState.activeSharedByMemberId, "member-1");
  assert.equal(
    nextState.suppressedLocalEndPauseUrl,
    "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
  );
  assert.equal(nextState.suppressedLocalEndPauseUntil, 1_500);
  assert.equal(nextState.hydrationReady, true);
  assert.equal(nextState.pendingRoomStateHydration, true);
});

test("content state store replace and reset restore runtime defaults", () => {
  const store = createContentStateStore();
  const replaced = store.replace({
    ...store.getState(),
    activeRoomCode: "ROOM02",
    hydrationReady: true,
    intendedPlayState: "playing",
  });

  assert.equal(replaced.activeRoomCode, "ROOM02");
  assert.equal(replaced.hydrationReady, true);
  assert.equal(replaced.intendedPlayState, "playing");

  const resetState = store.reset();
  assert.equal(resetState.activeRoomCode, null);
  assert.equal(resetState.activeSharedByMemberId, null);
  assert.equal(resetState.suppressedLocalEndPauseUrl, null);
  assert.equal(resetState.suppressedLocalEndPauseUntil, 0);
  assert.equal(resetState.hydrationReady, false);
  assert.equal(resetState.intendedPlayState, "paused");
});
