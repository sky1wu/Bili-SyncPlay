import assert from "node:assert/strict";
import test from "node:test";
import { createMirroredRuntimeStore } from "../src/mirrored-runtime-store.js";
import {
  createInMemoryRuntimeStore,
  type RuntimeStore,
} from "../src/runtime-store.js";
import type { AttachedSession, Session } from "../src/types.js";

function createSession(id: string): Session {
  return {
    id,
    connectionState: "attached",
    socket: {
      readyState: 1,
      OPEN: 1,
      send() {},
      close() {},
      terminate() {},
    } as unknown as AttachedSession["socket"],
    instanceId: "test-node",
    remoteAddress: null,
    origin: null,
    roomCode: null,
    memberId: null,
    memberToken: null,
    displayName: id,
    joinedAt: null,
    invalidMessageCount: 0,
    rateLimitState: {
      roomCreate: { windowStart: 0, count: 0 },
      roomJoin: { windowStart: 0, count: 0 },
      videoShare: { windowStart: 0, count: 0 },
      playbackUpdate: { tokens: 0, lastRefillAt: 0 },
      syncRequest: { windowStart: 0, count: 0 },
      syncPing: { tokens: 0, lastRefillAt: 0 },
    },
  };
}

test("mirrored runtime store leaves the local mirror untouched when the shared revoke fails", async () => {
  const local = createInMemoryRuntimeStore();
  const shared = createInMemoryRuntimeStore();
  const failing: RuntimeStore = {
    ...shared,
    revokeMemberToken: async () => {
      throw new Error("shared store unavailable");
    },
  };
  const store = createMirroredRuntimeStore(local, failing);
  const session = createSession("session-mirror");

  store.addMember("ROOMMR", "member-mirror", session, "token-mirror");

  await assert.rejects(
    Promise.resolve(store.revokeMemberToken("ROOMMR", "member-mirror")),
    /shared store unavailable/,
  );

  // Durable-first: a rejection must change nothing. Mirroring first left the
  // kick's caller with a failure while this node had already dropped the token,
  // so the member stayed connected holding one nothing would accept.
  assert.equal(
    local.findMemberIdByToken("ROOMMR", "token-mirror"),
    "member-mirror",
  );
});

test("mirrored runtime store applies the local revoke once the shared one lands", async () => {
  const local = createInMemoryRuntimeStore();
  const shared = createInMemoryRuntimeStore();
  const store = createMirroredRuntimeStore(local, shared);
  const session = createSession("session-mirror-ok");

  store.addMember("ROOMMK", "member-mirror-ok", session, "token-mirror-ok");
  await store.revokeMemberToken("ROOMMK", "member-mirror-ok");

  // Control for the test above: the reordering must not stop the mirror from
  // being updated on the success path.
  assert.equal(local.findMemberIdByToken("ROOMMK", "token-mirror-ok"), null);
  assert.equal(shared.findMemberIdByToken("ROOMMK", "token-mirror-ok"), null);
});

test("mirrored runtime store keeps room generations out of the local mirror", async () => {
  const local = createInMemoryRuntimeStore();
  const shared = createInMemoryRuntimeStore();
  const store = createMirroredRuntimeStore(local, shared);

  await store.markRoomGeneration("ROOMMG", "generation-1");

  // Mirroring it locally leaked: the node that CREATES a room writes the
  // generation, but the node that tears it down clears it — rarely the same one,
  // and nothing expires generations. Every node accumulated entries for rooms it
  // merely happened to create.
  assert.equal(local.getRoomGeneration("ROOMMG"), null);
  assert.equal(shared.getRoomGeneration("ROOMMG"), "generation-1");
  // Reads go to the shared view, so nothing is lost by not keeping a copy.
  assert.equal(await store.getRoomGeneration("ROOMMG"), "generation-1");
});

test("mirrored teardown clears the local mirror whenever the shared one applied", async () => {
  const local = createInMemoryRuntimeStore();
  const shared = createInMemoryRuntimeStore();
  const store = createMirroredRuntimeStore(local, shared);

  store.addMember("ROOMTD", "member-td", createSession("session-td"), "tok-td");
  await store.markRoomGeneration("ROOMTD", "generation-td");

  assert.equal(await store.deleteRoom("ROOMTD", "generation-td"), true);

  // The generation only exists in the shared store, so handing the expected
  // value to the local delete too compared it against a local `null` that never
  // matches: an ordinary room could never clear its local mirror at all.
  assert.equal(local.getRoom("ROOMTD"), null);
  assert.equal(shared.getRoom("ROOMTD"), null);
});

test("mirrored teardown leaves the local mirror alone when the shared one declines", async () => {
  const local = createInMemoryRuntimeStore();
  const shared = createInMemoryRuntimeStore();
  const store = createMirroredRuntimeStore(local, shared);

  store.addMember("ROOMTS", "member-ts", createSession("session-ts"), "tok-ts");
  await store.markRoomGeneration("ROOMTS", "generation-live");

  // A teardown scheduled before the room was stamped still expects `null`.
  assert.equal(await store.deleteRoom("ROOMTS", null), false);

  // Local generations are always `null`, so `null` matched there unconditionally
  // and the stale teardown wiped this node's view of a room the shared store had
  // just declined to delete.
  assert.notEqual(local.getRoom("ROOMTS"), null);
  assert.notEqual(shared.getRoom("ROOMTS"), null);
});
