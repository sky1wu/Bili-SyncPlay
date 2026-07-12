import assert from "node:assert/strict";
import test from "node:test";
import {
  getReconnectDelayMs,
  shouldReconnect,
} from "../src/background/socket-manager";

test("reconnect backoff grows and caps at thirty seconds", () => {
  assert.equal(getReconnectDelayMs(1), 1000);
  assert.equal(getReconnectDelayMs(2), 2000);
  assert.equal(getReconnectDelayMs(5), 16000);
  assert.equal(getReconnectDelayMs(6), 30000);
  assert.equal(getReconnectDelayMs(50), 30000);
});

test("reconnect scheduling requires an active room or pending create and has no attempt cap", () => {
  assert.equal(
    shouldReconnect({
      connected: false,
      reconnectTimer: null,
      roomCode: "ROOM01",
      pendingCreateRoom: false,
    }),
    true,
  );

  assert.equal(
    shouldReconnect({
      connected: false,
      reconnectTimer: null,
      roomCode: null,
      pendingCreateRoom: false,
    }),
    false,
  );

  assert.equal(
    shouldReconnect({
      connected: true,
      reconnectTimer: null,
      roomCode: "ROOM01",
      pendingCreateRoom: false,
    }),
    false,
  );

  assert.equal(
    shouldReconnect({
      connected: false,
      reconnectTimer: 42,
      roomCode: "ROOM01",
      pendingCreateRoom: false,
    }),
    false,
  );
});
