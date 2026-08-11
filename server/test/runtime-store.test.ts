import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryRuntimeStore } from "../src/runtime-store.js";
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

test("runtime store tracks room membership and kicked member tokens", async () => {
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
  assert.equal(await store.countClusterActiveRooms(), 1);
  assert.equal(store.getActiveRoomCount(), 1);
  assert.equal(store.getActiveMemberCount(), 1);
  assert.equal(store.findMemberIdByToken("ROOM01", "token-1"), "member-1");

  store.evictMemberToken("ROOM01", "member-1", "token-1", currentTime + 500);
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

test("runtime store never shortens an existing member-token block", () => {
  let currentTime = 1_000;
  const store = createInMemoryRuntimeStore(() => currentTime);

  store.evictMemberToken("ROOMMX", "member-1", "token-1", 2_000);
  store.evictMemberToken("ROOMMX", "member-1", "token-1", 1_500);

  currentTime = 1_750;
  assert.equal(store.isMemberTokenBlocked("ROOMMX", "token-1"), true);
});

test("runtime store tracks node heartbeat state and derives health", async () => {
  let currentTime = 1_000;
  const store = createInMemoryRuntimeStore(() => currentTime);

  await store.heartbeatNode({
    instanceId: "node-a",
    version: "0.9.0",
    startedAt: 100,
    lastHeartbeatAt: currentTime,
    staleAt: currentTime + 200,
    expiresAt: currentTime + 400,
    connectionCount: 3,
    activeRoomCount: 2,
    activeMemberCount: 5,
    health: "ok",
  });

  let statuses = await store.listNodeStatuses("request", currentTime);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]?.health, "ok");

  currentTime += 250;
  statuses = await store.listNodeStatuses("request", currentTime);
  assert.equal(statuses[0]?.health, "stale");

  currentTime += 250;
  statuses = await store.listNodeStatuses("request", currentTime);
  assert.equal(statuses[0]?.health, "offline");
});

test("in-memory runtime store bounds a disconnected identity without waiting for the room to empty", () => {
  let currentTime = 1_000;
  const store = createInMemoryRuntimeStore(() => currentTime, 5_000);
  const host = createSession("session-host");
  const visitor = createSession("session-visitor");

  store.addMember("ROOMIM", "member-host", host, "token-host");
  store.addMember("ROOMIM", "member-visitor", visitor, "token-visitor");

  store.removeMember("ROOMIM", "member-visitor", visitor);
  // Identity outlives the disconnect (#234) — that is the whole point.
  assert.equal(
    store.findMemberIdByToken("ROOMIM", "token-visitor"),
    "member-visitor",
  );

  currentTime += 5_001;
  // ...but it is bounded per identity, so a room that never empties — the host
  // is still here — still releases the people who left it. Hanging retention off
  // the room emptying leaked one token per visitor, forever (#237 review).
  assert.equal(store.findMemberIdByToken("ROOMIM", "token-visitor"), null);
  assert.equal(
    store.findMemberIdByToken("ROOMIM", "token-host"),
    "member-host",
  );
});

test("in-memory runtime store lifts the retention clock when a member reconnects", () => {
  let currentTime = 1_000;
  const store = createInMemoryRuntimeStore(() => currentTime, 5_000);
  const first = createSession("session-first");
  const second = createSession("session-second");

  store.addMember("ROOMIL", "member-back", first, "token-back");
  store.removeMember("ROOMIL", "member-back", first);
  currentTime += 2_000;
  store.addMember("ROOMIL", "member-back", second, "token-back");

  currentTime += 5_001;
  // Lifted, not merely restarted: a member who is back must not lose their
  // identity because of a clock started before they returned.
  assert.equal(
    store.findMemberIdByToken("ROOMIL", "token-back"),
    "member-back",
  );
});
