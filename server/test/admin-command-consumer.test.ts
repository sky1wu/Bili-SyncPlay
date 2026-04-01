import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryAdminCommandBus } from "../src/admin-command-bus.js";
import { createAdminCommandConsumer } from "../src/admin-command-consumer.js";
import type { Session } from "../src/types.js";

function createSession(
  id: string,
  roomCode: string,
  memberId: string,
): Session {
  return {
    id,
    connectionState: "attached",
    socket: {
      readyState: 1,
      OPEN: 1,
      send() {},
      close() {},
      terminate() {},
    } as Session["socket"],
    instanceId: "node-a",
    remoteAddress: "127.0.0.1",
    origin: "chrome-extension://allowed-extension",
    roomCode,
    memberId,
    displayName: memberId,
    memberToken: `token-${memberId}`,
    joinedAt: 1_000,
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

test("admin command consumer disconnects a local session", async () => {
  const bus = createInMemoryAdminCommandBus(() => 2_000);
  const session = createSession("session-a", "ROOM01", "member-a");
  let disconnectedReason = "";

  const consumer = await createAdminCommandConsumer({
    instanceId: "node-a",
    adminCommandBus: bus,
    getLocalSession(sessionId) {
      return sessionId === session.id ? session : null;
    },
    listLocalSessionsByRoom() {
      return [];
    },
    blockMemberToken() {},
    disconnectSessionSocket(_session, reason) {
      disconnectedReason = reason;
    },
    now: () => 2_000,
  });

  try {
    const result = await bus.request({
      kind: "disconnect_session",
      requestId: "req-1",
      targetInstanceId: "node-a",
      sessionId: session.id,
      requestedAt: 1_000,
    });

    assert.equal(result.status, "ok");
    assert.equal(disconnectedReason, "Admin disconnected session");
  } finally {
    await consumer.close();
  }
});

test("admin command consumer blocks token and disconnects a kicked member", async () => {
  const bus = createInMemoryAdminCommandBus(() => 3_000);
  const session = createSession("session-b", "ROOM02", "member-b");
  const blocked: Array<{ roomCode: string; token: string; expiresAt: number }> =
    [];

  const consumer = await createAdminCommandConsumer({
    instanceId: "node-a",
    adminCommandBus: bus,
    getLocalSession() {
      return null;
    },
    listLocalSessionsByRoom(roomCode) {
      return roomCode === "ROOM02" ? [session] : [];
    },
    blockMemberToken(roomCode, token, expiresAt) {
      blocked.push({ roomCode, token, expiresAt });
    },
    disconnectSessionSocket() {},
    now: () => 3_000,
  });

  try {
    const result = await bus.request({
      kind: "kick_member",
      requestId: "req-2",
      targetInstanceId: "node-a",
      roomCode: "ROOM02",
      memberId: "member-b",
      requestedAt: 2_000,
    });

    assert.equal(result.status, "ok");
    assert.deepEqual(blocked, [
      {
        roomCode: "ROOM02",
        token: "token-member-b",
        expiresAt: 63_000,
      },
    ]);
  } finally {
    await consumer.close();
  }
});

test("admin command consumer does not disconnect a member when token blocking fails", async () => {
  const bus = createInMemoryAdminCommandBus(() => 4_000);
  const session = createSession("session-c", "ROOM03", "member-c");
  let disconnected = false;

  const consumer = await createAdminCommandConsumer({
    instanceId: "node-a",
    adminCommandBus: bus,
    getLocalSession() {
      return null;
    },
    listLocalSessionsByRoom(roomCode) {
      return roomCode === "ROOM03" ? [session] : [];
    },
    blockMemberToken() {
      throw new Error("block failed");
    },
    disconnectSessionSocket() {
      disconnected = true;
    },
    now: () => 4_000,
  });

  try {
    const result = await bus.request({
      kind: "kick_member",
      requestId: "req-3",
      targetInstanceId: "node-a",
      roomCode: "ROOM03",
      memberId: "member-c",
      requestedAt: 3_000,
    });

    assert.equal(result.status, "error");
    if (result.status === "ok") {
      throw new Error("Expected kick_member to fail.");
    }
    assert.equal(result.code, "block_failed");
    assert.equal(disconnected, false);
  } finally {
    await consumer.close();
  }
});

test("admin command consumer keeps a kick block when disconnect fails", async () => {
  const bus = createInMemoryAdminCommandBus(() => 5_000);
  const session = createSession("session-d", "ROOM04", "member-d");
  const blocked: string[] = [];

  const consumer = await createAdminCommandConsumer({
    instanceId: "node-a",
    adminCommandBus: bus,
    getLocalSession() {
      return null;
    },
    listLocalSessionsByRoom(roomCode) {
      return roomCode === "ROOM04" ? [session] : [];
    },
    blockMemberToken(_roomCode, token) {
      blocked.push(token);
    },
    disconnectSessionSocket() {
      throw new Error("disconnect failed");
    },
    now: () => 5_000,
  });

  try {
    const result = await bus.request({
      kind: "kick_member",
      requestId: "req-4",
      targetInstanceId: "node-a",
      roomCode: "ROOM04",
      memberId: "member-d",
      requestedAt: 4_000,
    });

    assert.equal(result.status, "error");
    if (result.status === "ok") {
      throw new Error("Expected kick_member to fail.");
    }
    assert.equal(result.code, "disconnect_failed");
    assert.deepEqual(blocked, ["token-member-d"]);
  } finally {
    await consumer.close();
  }
});
