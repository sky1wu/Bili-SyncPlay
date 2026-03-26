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
