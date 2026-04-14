import assert from "node:assert/strict";
import test from "node:test";
import { isBackgroundPopupStateMessage } from "../src/shared/messages";

const validStateMessage = {
  type: "background:state",
  payload: {
    connected: true,
    roomCode: "ROOM01",
    joinToken: "join-token-123456",
    memberId: "member-1",
    displayName: "Alice",
    roomState: null,
    serverUrl: "ws://localhost:9999",
    error: null,
    pendingCreateRoom: false,
    pendingJoinRoomCode: null,
    retryInMs: null,
    retryAttempt: 0,
    retryAttemptMax: 5,
    clockOffsetMs: null,
    rttMs: null,
    logs: [],
  },
};

test("isBackgroundPopupStateMessage returns true for valid background:state message", () => {
  assert.ok(isBackgroundPopupStateMessage(validStateMessage));
});

test("isBackgroundPopupStateMessage returns false for null", () => {
  assert.equal(isBackgroundPopupStateMessage(null), false);
});

test("isBackgroundPopupStateMessage returns false for undefined", () => {
  assert.equal(isBackgroundPopupStateMessage(undefined), false);
});

test("isBackgroundPopupStateMessage returns false for wrong type field", () => {
  assert.equal(
    isBackgroundPopupStateMessage({ type: "background:popup-connected" }),
    false,
  );
});

test("isBackgroundPopupStateMessage returns false for non-object", () => {
  assert.equal(isBackgroundPopupStateMessage("background:state"), false);
  assert.equal(isBackgroundPopupStateMessage(42), false);
});

test("isBackgroundPopupStateMessage returns false for object without type", () => {
  assert.equal(isBackgroundPopupStateMessage({ payload: {} }), false);
});

test("isBackgroundPopupStateMessage returns false when payload is absent", () => {
  assert.equal(
    isBackgroundPopupStateMessage({ type: "background:state" }),
    false,
  );
});

test("isBackgroundPopupStateMessage returns false when payload is null", () => {
  assert.equal(
    isBackgroundPopupStateMessage({ type: "background:state", payload: null }),
    false,
  );
});

test("isBackgroundPopupStateMessage returns false when payload lacks required fields", () => {
  assert.equal(
    isBackgroundPopupStateMessage({ type: "background:state", payload: {} }),
    false,
  );
  assert.equal(
    isBackgroundPopupStateMessage({
      type: "background:state",
      payload: { connected: true },
    }),
    false,
  );
  assert.equal(
    isBackgroundPopupStateMessage({
      type: "background:state",
      payload: { serverUrl: "ws://localhost" },
    }),
    false,
  );
});
