import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapBackground, type BootstrapMutableState } from "../src/background/bootstrap";
import { DEFAULT_SERVER_URL } from "../src/background/runtime-state";
import { INVALID_SERVER_URL_MESSAGE } from "../src/background/server-url";
import type { PersistedBackgroundSnapshot } from "../src/background/storage-manager";
import type { DebugLogEntry } from "../src/shared/messages";

function createState(): BootstrapMutableState {
  return {
    roomCode: null,
    joinToken: null,
    memberToken: null,
    memberId: null,
    displayName: null,
    roomState: null,
    serverUrl: DEFAULT_SERVER_URL,
    lastError: null,
    sharedTabId: null
  };
}

function createPersistedSnapshot(overrides: Partial<PersistedBackgroundSnapshot> = {}): PersistedBackgroundSnapshot {
  return {
    roomCode: null,
    joinToken: null,
    memberToken: null,
    memberId: null,
    displayName: null,
    roomState: null,
    serverUrl: null,
    ...overrides
  };
}

test("bootstrap skips auto reconnect when persisted serverUrl is invalid", async () => {
  const state = createState();
  const logs: Array<{ scope: DebugLogEntry["scope"]; message: string }> = [];
  let connectCalls = 0;
  let tabRemovedListener: ((tabId: number) => void) | null = null;

  await bootstrapBackground({
    state,
    loadPersistedBackgroundSnapshot: async () =>
      createPersistedSnapshot({
        roomCode: "ROOM01",
        joinToken: "join-token",
        serverUrl: "http://localhost:8787"
      }),
    connect: () => {
      connectCalls += 1;
    },
    log: (scope, message) => {
      logs.push({ scope, message });
    },
    broadcastPopupState: () => {
      throw new Error("broadcastPopupState should not run during bootstrap for this case.");
    },
    addTabRemovedListener: (listener) => {
      tabRemovedListener = listener;
    }
  });

  assert.equal(connectCalls, 0);
  assert.equal(state.roomCode, "ROOM01");
  assert.equal(state.joinToken, "join-token");
  assert.equal(state.serverUrl, "http://localhost:8787");
  assert.equal(state.lastError, INVALID_SERVER_URL_MESSAGE);
  assert.equal(typeof tabRemovedListener, "function");
  assert.equal(
    logs.some((entry) => entry.scope === "background" && entry.message.includes("Skipped reconnect because persisted server URL is invalid")),
    true
  );
});

test("bootstrap reconnects when persisted serverUrl is valid", async () => {
  const state = createState();
  let connectCalls = 0;

  await bootstrapBackground({
    state,
    loadPersistedBackgroundSnapshot: async () =>
      createPersistedSnapshot({
        roomCode: "ROOM01",
        joinToken: "join-token",
        serverUrl: "ws://localhost:8787"
      }),
    connect: () => {
      connectCalls += 1;
    },
    log: () => {},
    broadcastPopupState: () => {},
    addTabRemovedListener: () => {}
  });

  assert.equal(connectCalls, 1);
  assert.equal(state.serverUrl, "ws://localhost:8787");
  assert.equal(state.lastError, null);
});
