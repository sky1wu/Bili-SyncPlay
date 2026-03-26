import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryRuntimeStore } from "../src/runtime-store.js";
import type { Session } from "../src/types.js";

function createSession(id: string): Session {
  return {
    id,
    socket: {
      readyState: 1,
      OPEN: 1,
      send() {},
      close() {},
      terminate() {},
    } as Session["socket"],
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

test("runtime store tracks room membership and kicked member tokens", () => {
  let currentTime = 1_000;
  const store = createInMemoryRuntimeStore(() => currentTime);
  const session = createSession("session-1");

  store.registerSession(session);
  store.markSessionJoinedRoom(session.id, "ROOM01");
  store.addMember("ROOM01", "member-1", session, "token-1");

  assert.equal(store.getSession(session.id), session);
  assert.deepEqual(
    store.listSessionsByRoom("ROOM01").map((entry) => entry.id),
    ["session-1"],
  );
  assert.equal(store.getActiveRoomCount(), 1);
  assert.equal(store.getActiveMemberCount(), 1);
  assert.equal(store.findMemberIdByToken("ROOM01", "token-1"), "member-1");

  store.blockMemberToken("ROOM01", "token-1", currentTime + 500);
  assert.equal(store.isMemberTokenBlocked("ROOM01", "token-1"), true);

  currentTime += 600;
  assert.equal(store.isMemberTokenBlocked("ROOM01", "token-1"), false);

  const removal = store.removeMember("ROOM01", "member-1", session);
  assert.equal(removal.roomEmpty, true);

  store.markSessionLeftRoom(session.id, "ROOM01");
  store.unregisterSession(session.id);
  assert.equal(store.getConnectionCount(), 0);
  assert.equal(store.getActiveRoomCount(), 0);
});
