import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryAdminCommandBus } from "../src/admin-command-bus.js";
import { createAdminCommandConsumer } from "../src/admin-command-consumer.js";
import { createMirroredRuntimeStore } from "../src/mirrored-runtime-store.js";
import {
  createInMemoryRuntimeStore,
  type RuntimeStore,
} from "../src/runtime-store.js";
import { settleWithin } from "../src/retry-pacer.js";
import type { AttachedSession, Session } from "../src/types.js";

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
    } as unknown as AttachedSession["socket"],
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
    evictMemberToken() {},
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
  const revoked: Array<{ roomCode: string; memberId: string }> = [];
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
    evictMemberToken(roomCode, memberId, token, blockedUntil) {
      blocked.push({ roomCode, token, expiresAt: blockedUntil });
      revoked.push({ roomCode, memberId });
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
    // The block only holds them out for its TTL. Since #234 the disconnect below
    // no longer revokes identity, so the kick has to do it explicitly — without
    // this the member would come back as themselves once the block lapsed.
    assert.deepEqual(revoked, [{ roomCode: "ROOM02", memberId: "member-b" }]);
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
    evictMemberToken() {
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
    evictMemberToken(_roomCode, _memberId, token) {
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
    assert.equal(result.code, "disconnect_failed");
    assert.deepEqual(blocked, ["token-member-d"]);
  } finally {
    await consumer.close();
  }
});

test("admin command consumer fails the kick when revoking the token does not land", async () => {
  const bus = createInMemoryAdminCommandBus(() => 6_000);
  const session = createSession("session-e", "ROOM05", "member-e");
  let disconnected = false;

  const consumer = await createAdminCommandConsumer({
    instanceId: "node-a",
    adminCommandBus: bus,
    getLocalSession() {
      return null;
    },
    listLocalSessionsByRoom(roomCode) {
      return roomCode === "ROOM05" ? [session] : [];
    },
    // The store reports the eviction failed. Reporting the kick as done here
    // would claim an eviction while the old token still resolved everywhere.
    async evictMemberToken() {
      throw new Error("evict failed");
    },
    disconnectSessionSocket() {
      disconnected = true;
    },
    now: () => 6_000,
  });

  try {
    const result = await bus.request({
      kind: "kick_member",
      requestId: "req-5",
      targetInstanceId: "node-a",
      roomCode: "ROOM05",
      memberId: "member-e",
      requestedAt: 5_000,
    });

    assert.notEqual(result.status, "ok");
    assert.equal(disconnected, false);
  } finally {
    await consumer.close();
  }
});

test("admin command consumer reports an unconfirmed kick while its late effect still converges", async () => {
  const currentTime = 7_000;
  const bus = createInMemoryAdminCommandBus(() => currentTime);
  const session = createSession("session-f", "ROOM06", "member-f");
  const local = createInMemoryRuntimeStore(() => currentTime);
  const sharedState = createInMemoryRuntimeStore(() => currentTime);
  let releaseSharedEviction!: () => void;
  const sharedEvictionGate = new Promise<void>((resolve) => {
    releaseSharedEviction = resolve;
  });
  const delayedShared: RuntimeStore = {
    ...sharedState,
    async evictMemberToken(...args) {
      await sharedEvictionGate;
      sharedState.evictMemberToken(...args);
    },
  };
  const mirrored = createMirroredRuntimeStore(local, delayedShared);
  mirrored.addMember("ROOM06", "member-f", session, "token-member-f");
  let realEviction: Promise<void> | undefined;
  let disconnected = false;
  let signalDisconnected!: () => void;
  const disconnectedSignal = new Promise<void>((resolve) => {
    signalDisconnected = resolve;
  });
  const terminalResults: unknown[] = [];

  const consumer = await createAdminCommandConsumer({
    instanceId: "node-a",
    adminCommandBus: bus,
    getLocalSession() {
      return null;
    },
    listLocalSessionsByRoom(roomCode) {
      return roomCode === "ROOM06" ? [session] : [];
    },
    evictMemberToken(...args) {
      realEviction = Promise.resolve(mirrored.evictMemberToken(...args));
      return realEviction;
    },
    disconnectSessionSocket() {
      disconnected = true;
      signalDisconnected();
    },
    memberEvictionConfirmTimeoutMs: 20,
    now: () => currentTime,
    logEvent(event, data) {
      if (event === "admin_command_executed") {
        terminalResults.push(data.result);
      }
    },
  });

  try {
    const request = bus.request({
      kind: "kick_member",
      requestId: "req-6",
      targetInstanceId: "node-a",
      roomCode: "ROOM06",
      memberId: "member-f",
      requestedAt: currentTime - 1_000,
    });

    assert.equal(
      await settleWithin(request, 200),
      true,
      "the executor must stop waiting before the durable effect settles",
    );
    const result = await request;
    assert.equal(result.status, "error");
    assert.equal(result.confirmation, "unconfirmed");
    assert.equal(result.code, "block_unconfirmed");
    assert.equal(disconnected, false);
    assert.deepEqual(terminalResults, []);
    assert.equal(
      local.findMemberIdByToken("ROOM06", "token-member-f"),
      "member-f",
    );
    assert.equal(
      sharedState.findMemberIdByToken("ROOM06", "token-member-f"),
      "member-f",
    );

    releaseSharedEviction();
    await realEviction;
    assert.equal(
      await settleWithin(disconnectedSignal, 200),
      true,
      "the late eviction must still disconnect the socket and trigger cleanup",
    );

    assert.equal(
      local.isMemberTokenBlocked("ROOM06", "token-member-f", currentTime),
      true,
    );
    assert.equal(
      sharedState.isMemberTokenBlocked("ROOM06", "token-member-f", currentTime),
      true,
    );
    assert.equal(local.findMemberIdByToken("ROOM06", "token-member-f"), null);
    assert.equal(
      sharedState.findMemberIdByToken("ROOM06", "token-member-f"),
      null,
    );
    assert.equal(disconnected, true);
    assert.deepEqual(terminalResults, ["ok"]);
  } finally {
    releaseSharedEviction();
    await realEviction?.catch(() => undefined);
    await consumer.close();
  }
});

test("admin command consumer reports a disconnect that fails after an unconfirmed eviction", async () => {
  const currentTime = 8_000;
  const bus = createInMemoryAdminCommandBus(() => currentTime);
  const session = createSession("session-g", "ROOM07", "member-g");
  let releaseEviction!: () => void;
  const evictionGate = new Promise<void>((resolve) => {
    releaseEviction = resolve;
  });
  let signalLateDisconnectFailure!: () => void;
  const lateDisconnectFailure = new Promise<void>((resolve) => {
    signalLateDisconnectFailure = resolve;
  });
  const loggedFailures: Record<string, unknown>[] = [];

  const consumer = await createAdminCommandConsumer({
    instanceId: "node-a",
    adminCommandBus: bus,
    getLocalSession() {
      return null;
    },
    listLocalSessionsByRoom(roomCode) {
      return roomCode === "ROOM07" ? [session] : [];
    },
    async evictMemberToken() {
      await evictionGate;
    },
    disconnectSessionSocket() {
      throw new Error("late disconnect failed");
    },
    memberEvictionConfirmTimeoutMs: 20,
    now: () => currentTime,
    logEvent(event, data) {
      if (
        event === "admin_command_executed" &&
        data.code === "disconnect_failed"
      ) {
        loggedFailures.push(data);
        signalLateDisconnectFailure();
      }
    },
  });

  try {
    const result = await bus.request({
      kind: "kick_member",
      requestId: "req-7",
      targetInstanceId: "node-a",
      roomCode: "ROOM07",
      memberId: "member-g",
      requestedAt: currentTime - 1_000,
    });

    assert.equal(result.status, "error");
    assert.equal(result.confirmation, "unconfirmed");
    assert.equal(result.code, "block_unconfirmed");

    releaseEviction();
    assert.equal(
      await settleWithin(lateDisconnectFailure, 200),
      true,
      "a disconnect failure after the cap must remain observable",
    );
    assert.equal(loggedFailures.length, 1);
    assert.equal(loggedFailures[0]?.commandRequestId, "req-7");
    assert.equal(loggedFailures[0]?.blockApplied, true);
    assert.equal(loggedFailures[0]?.error, "late disconnect failed");
  } finally {
    releaseEviction();
    await consumer.close();
  }
});
