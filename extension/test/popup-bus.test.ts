import assert from "node:assert/strict";
import test from "node:test";
import { createPopupStateSnapshot } from "../src/background/popup-bus";
import { createBackgroundRuntimeState } from "../src/background/runtime-state";

test("popup snapshot includes connection, room, retry, clock, and logs state", () => {
  const state = createBackgroundRuntimeState();
  state.connection.connected = true;
  state.connection.serverUrl = "ws://localhost:9999";
  state.connection.lastError = "boom";
  state.connection.reconnectAttempt = 2;
  state.room.roomCode = "ROOM01";
  state.room.joinToken = "join-token";
  state.room.memberId = "member-1";
  state.room.displayName = "Alice";
  state.room.pendingCreateRoom = true;
  state.room.pendingJoinRoomCode = "ROOM02";
  state.clock.clockOffsetMs = 120;
  state.clock.rttMs = 45;
  state.diagnostics.logs = [{ at: 1, scope: "background", message: "hello" }];

  const snapshot = createPopupStateSnapshot({
    state,
    retryInMs: 3000,
    retryAttemptMax: 5,
  });

  assert.equal(snapshot.type, "background:state");
  assert.equal(snapshot.payload.connected, true);
  assert.equal(snapshot.payload.serverUrl, "ws://localhost:9999");
  assert.equal(snapshot.payload.roomCode, "ROOM01");
  assert.equal(snapshot.payload.displayName, "Alice");
  assert.equal(snapshot.payload.retryInMs, 3000);
  assert.equal(snapshot.payload.retryAttempt, 2);
  assert.equal(snapshot.payload.retryAttemptMax, 5);
  assert.equal(snapshot.payload.clockOffsetMs, 120);
  assert.equal(snapshot.payload.rttMs, 45);
  assert.equal(snapshot.payload.voice.status, "idle");
  assert.deepEqual(snapshot.payload.logs, [
    { at: 1, scope: "background", message: "hello" },
  ]);
});
