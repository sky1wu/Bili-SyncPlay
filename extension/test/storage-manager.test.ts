import assert from "node:assert/strict";
import test from "node:test";
import {
  loadPersistedBackgroundSnapshot,
  persistBackgroundProfile,
  persistBackgroundState,
} from "../src/background/storage-manager";
import { createBackgroundRuntimeState } from "../src/background/runtime-state";

function createStorageArea<T>(
  bucket: Record<string, T | undefined>,
  options: { failSet?: boolean } = {},
) {
  return {
    async get<K extends string>(key: K): Promise<Record<K, T | undefined>> {
      return { [key]: bucket[key] } as Record<K, T | undefined>;
    },
    async set(values: Record<string, T>): Promise<void> {
      if (options.failSet) {
        throw new Error("set failed");
      }
      Object.assign(bucket, values);
    },
  };
}

function installChromeStorage(
  options: {
    session?: { failSet?: boolean };
    local?: { failSet?: boolean };
  } = {},
) {
  const sessionBucket: Record<string, unknown> = {};
  const localBucket: Record<string, unknown> = {};

  globalThis.chrome = {
    storage: {
      session: createStorageArea(sessionBucket, options.session),
      local: createStorageArea(localBucket, options.local),
    },
  } as typeof chrome;

  return { sessionBucket, localBucket };
}

test("loadPersistedBackgroundSnapshot combines session room state and local profile state", async () => {
  const { sessionBucket, localBucket } = installChromeStorage();
  sessionBucket["bili-syncplay-session"] = {
    roomCode: "ROOM01",
    joinToken: "join-token-1",
    memberToken: "member-token-1",
    memberId: "member-1",
    roomState: {
      roomCode: "ROOM01",
      ownerMemberId: "member-1",
      members: [],
      sharedVideo: null,
      playback: null,
      updatedAt: Date.now(),
    },
  };
  localBucket["bili-syncplay-profile"] = {
    displayName: "Alice",
    serverUrl: "ws://localhost:8787",
  };

  const snapshot = await loadPersistedBackgroundSnapshot();

  assert.equal(snapshot.roomCode, "ROOM01");
  assert.equal(snapshot.joinToken, "join-token-1");
  assert.equal(snapshot.memberToken, "member-token-1");
  assert.equal(snapshot.memberId, "member-1");
  assert.equal(snapshot.displayName, "Alice");
  assert.equal(snapshot.serverUrl, "ws://localhost:8787");
  assert.equal(snapshot.roomState?.roomCode, "ROOM01");
});

test("persistBackgroundState only writes session storage", async () => {
  const { sessionBucket, localBucket } = installChromeStorage();
  localBucket["bili-syncplay-profile"] = {
    displayName: "Alice",
    serverUrl: "ws://localhost:8787",
  };

  const state = createBackgroundRuntimeState();
  state.room.roomCode = "ROOM02";
  state.room.joinToken = "join-token-2";
  state.room.memberToken = "member-token-2";
  state.room.memberId = "member-2";

  await persistBackgroundState(state);

  assert.deepEqual(localBucket["bili-syncplay-profile"], {
    displayName: "Alice",
    serverUrl: "ws://localhost:8787",
  });
  assert.deepEqual(sessionBucket["bili-syncplay-session"], {
    roomCode: "ROOM02",
    joinToken: "join-token-2",
    memberToken: "member-token-2",
    memberId: "member-2",
    roomState: null,
  });
});

test("persistBackgroundProfile only writes local storage", async () => {
  const { sessionBucket, localBucket } = installChromeStorage();
  sessionBucket["bili-syncplay-session"] = {
    roomCode: "ROOM03",
    joinToken: "join-token-3",
    memberToken: "member-token-3",
    memberId: "member-3",
    roomState: null,
  };

  const state = createBackgroundRuntimeState();
  state.room.displayName = "Bob";
  state.connection.serverUrl = "wss://sync.example.com";

  await persistBackgroundProfile(state);

  assert.deepEqual(sessionBucket["bili-syncplay-session"], {
    roomCode: "ROOM03",
    joinToken: "join-token-3",
    memberToken: "member-token-3",
    memberId: "member-3",
    roomState: null,
  });
  assert.deepEqual(localBucket["bili-syncplay-profile"], {
    displayName: "Bob",
    serverUrl: "wss://sync.example.com",
  });
});

test("persistBackgroundState failure does not mutate local profile storage", async () => {
  const { localBucket } = installChromeStorage({
    session: { failSet: true },
  });
  localBucket["bili-syncplay-profile"] = {
    displayName: "Carol",
    serverUrl: "ws://localhost:9000",
  };

  const state = createBackgroundRuntimeState();
  state.room.roomCode = "ROOM04";
  state.room.joinToken = "join-token-4";

  await assert.rejects(() => persistBackgroundState(state), /set failed/);
  assert.deepEqual(localBucket["bili-syncplay-profile"], {
    displayName: "Carol",
    serverUrl: "ws://localhost:9000",
  });
});
