import assert from "node:assert/strict";
import test from "node:test";
import { createPopupUiStateStore } from "../src/popup/popup-store";

test("popup ui state store exposes stable mutable state and patch semantics", () => {
  const store = createPopupUiStateStore();
  const initialState = store.getState();

  store.patch({
    roomActionPending: true,
    roomCodeDraft: "ROOM01:token-1234567890abcdef",
    localStatusMessage: "busy",
    copyRoomSuccess: true,
  });

  const nextState = store.getState();
  assert.equal(nextState, initialState);
  assert.equal(nextState.roomActionPending, true);
  assert.equal(nextState.roomCodeDraft, "ROOM01:token-1234567890abcdef");
  assert.equal(nextState.localStatusMessage, "busy");
  assert.equal(nextState.copyRoomSuccess, true);
  assert.equal(nextState.copyLogsSuccess, false);
});

test("popup ui state store reset restores runtime defaults", () => {
  const store = createPopupUiStateStore();
  store.patch({
    roomActionPending: true,
    lastKnownRoomCode: "ROOM02",
    copyLogsSuccess: true,
  });

  const resetState = store.reset();
  assert.equal(resetState.roomActionPending, false);
  assert.equal(resetState.lastKnownRoomCode, null);
  assert.equal(resetState.copyLogsSuccess, false);
  assert.equal(resetState.roomCodeDraft, "");
});
