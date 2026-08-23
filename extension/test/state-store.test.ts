import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundStateStore } from "../src/background/state-store";

test("background state store exposes stable mutable state and patch semantics", () => {
  const store = createBackgroundStateStore();
  const initialState = store.getState();

  store.patch({
    connection: {
      connected: true,
      serverUrl: "ws://localhost:9999",
    },
    room: {
      roomCode: "ROOM01",
      pendingJoinRequestSent: true,
    },
    settings: {
      pageShareButtonEnabled: false,
    },
  });

  const nextState = store.getState();
  assert.equal(nextState, initialState);
  assert.equal(nextState.connection.connected, true);
  assert.equal(nextState.connection.serverUrl, "ws://localhost:9999");
  assert.equal(nextState.room.roomCode, "ROOM01");
  assert.equal(nextState.room.pendingJoinRequestSent, true);
  assert.equal(nextState.share.sharedTabId, null);
  assert.equal(nextState.settings.pageShareButtonEnabled, false);
});

test("background state store replace and reset restore runtime defaults", () => {
  const store = createBackgroundStateStore();
  const replaced = store.replace({
    ...store.getState(),
    connection: {
      ...store.getState().connection,
      connected: true,
    },
    room: {
      ...store.getState().room,
      roomCode: "ROOM02",
    },
    settings: {
      ...store.getState().settings,
      pageShareButtonEnabled: false,
    },
  });

  assert.equal(replaced.connection.connected, true);
  assert.equal(replaced.room.roomCode, "ROOM02");
  assert.equal(replaced.settings.pageShareButtonEnabled, false);

  const resetState = store.reset();
  assert.equal(resetState.connection.connected, false);
  assert.equal(resetState.room.roomCode, null);
  assert.equal(resetState.settings.pageShareButtonEnabled, true);
});
