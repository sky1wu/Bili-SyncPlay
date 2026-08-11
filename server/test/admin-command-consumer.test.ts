import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemoryAdminCommandBus,
  type AdminCommand,
  type AdminCommandBus,
} from "../src/admin-command-bus.js";
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

test("admin command consumer close waits for an eviction that outlived confirmation", async () => {
  const currentTime = 9_000;
  const bus = createInMemoryAdminCommandBus(() => currentTime);
  const session = createSession("session-h", "ROOM08", "member-h");
  let releaseEviction!: () => void;
  const evictionGate = new Promise<void>((resolve) => {
    releaseEviction = resolve;
  });
  let disconnected = false;

  const consumer = await createAdminCommandConsumer({
    instanceId: "node-a",
    adminCommandBus: bus,
    getLocalSession() {
      return null;
    },
    listLocalSessionsByRoom(roomCode) {
      return roomCode === "ROOM08" ? [session] : [];
    },
    async evictMemberToken() {
      await evictionGate;
    },
    disconnectSessionSocket() {
      disconnected = true;
    },
    memberEvictionConfirmTimeoutMs: 10,
    closeBudgetMs: 200,
    now: () => currentTime,
  });

  try {
    const result = await bus.request({
      kind: "kick_member",
      requestId: "req-8",
      targetInstanceId: "node-a",
      roomCode: "ROOM08",
      memberId: "member-h",
      requestedAt: currentTime - 1_000,
    });
    assert.equal(result.status, "error");
    assert.equal(result.confirmation, "unconfirmed");

    const closing = consumer.close();
    assert.equal(
      await settleWithin(closing, 20),
      false,
      "close must still own the eviction after its caller stopped waiting",
    );
    releaseEviction();
    assert.equal(await settleWithin(closing, 200), true);
    await closing;
    assert.equal(disconnected, true);
  } finally {
    releaseEviction();
    await consumer.close();
  }
});

test("admin command consumer close bounds and reports an unanswered effect", async () => {
  const currentTime = 10_000;
  const bus = createInMemoryAdminCommandBus(() => currentTime);
  const session = createSession("session-i", "ROOM09", "member-i");
  let releaseEviction!: () => void;
  const evictionGate = new Promise<void>((resolve) => {
    releaseEviction = resolve;
  });
  let signalDisconnected!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    signalDisconnected = resolve;
  });
  const closeReports: Record<string, unknown>[] = [];

  const consumer = await createAdminCommandConsumer({
    instanceId: "node-a",
    adminCommandBus: bus,
    getLocalSession() {
      return null;
    },
    listLocalSessionsByRoom(roomCode) {
      return roomCode === "ROOM09" ? [session] : [];
    },
    async evictMemberToken() {
      await evictionGate;
    },
    disconnectSessionSocket() {
      signalDisconnected();
    },
    memberEvictionConfirmTimeoutMs: 10,
    closeBudgetMs: 20,
    now: () => currentTime,
    logEvent(event, data) {
      if (event === "admin_command_consumer_close_unfinished") {
        closeReports.push(data);
      }
    },
  });

  try {
    const result = await bus.request({
      kind: "kick_member",
      requestId: "req-9",
      targetInstanceId: "node-a",
      roomCode: "ROOM09",
      memberId: "member-i",
      requestedAt: currentTime - 1_000,
    });
    assert.equal(result.status, "error");
    assert.equal(result.confirmation, "unconfirmed");

    const closing = consumer.close();
    assert.equal(
      await settleWithin(closing, 100),
      true,
      "the component close must stay inside its own budget",
    );
    await closing;
    assert.deepEqual(closeReports, [
      {
        instanceId: "node-a",
        pendingHandlers: 0,
        pendingMemberEvictions: 1,
        unsubscribePending: false,
        budgetMs: 20,
        result: "timeout",
      },
    ]);

    releaseEviction();
    assert.equal(await settleWithin(disconnected, 200), true);
  } finally {
    releaseEviction();
    await consumer.close();
  }
});

test("admin command consumer close shares its budget with unsubscribe", async () => {
  let releaseUnsubscribe!: () => void;
  const unsubscribeGate = new Promise<void>((resolve) => {
    releaseUnsubscribe = resolve;
  });
  const closeReports: Record<string, unknown>[] = [];
  const bus: AdminCommandBus = {
    async request(command) {
      return {
        requestId: command.requestId,
        targetInstanceId: command.targetInstanceId,
        executorInstanceId: command.targetInstanceId,
        status: "stale_target",
        code: "unused",
        message: "Unused in this test.",
        completedAt: 0,
      };
    },
    async subscribe() {
      return async () => {
        await unsubscribeGate;
      };
    },
  };

  const consumer = await createAdminCommandConsumer({
    instanceId: "node-a",
    adminCommandBus: bus,
    getLocalSession() {
      return null;
    },
    listLocalSessionsByRoom() {
      return [];
    },
    evictMemberToken() {},
    disconnectSessionSocket() {},
    closeBudgetMs: 20,
    now: () => 13_000,
    logEvent(event, data) {
      if (event === "admin_command_consumer_close_unfinished") {
        closeReports.push(data);
      }
    },
  });

  try {
    const closing = consumer.close();
    assert.equal(
      await settleWithin(closing, 100),
      true,
      "unsubscribe must not receive a second shutdown budget",
    );
    await closing;
    assert.deepEqual(closeReports, [
      {
        instanceId: "node-a",
        pendingHandlers: 0,
        pendingMemberEvictions: 0,
        unsubscribePending: true,
        budgetMs: 20,
        result: "timeout",
      },
    ]);
  } finally {
    releaseUnsubscribe();
    await consumer.close();
  }
});

test("admin command consumer close also owns direct disconnect handlers", async () => {
  const currentTime = 11_000;
  const bus = createInMemoryAdminCommandBus(() => currentTime);
  const session = createSession("session-j", "ROOM10", "member-j");
  let signalDisconnectStarted!: () => void;
  const disconnectStarted = new Promise<void>((resolve) => {
    signalDisconnectStarted = resolve;
  });
  let releaseDisconnect!: () => void;
  const disconnectGate = new Promise<void>((resolve) => {
    releaseDisconnect = resolve;
  });

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
    async disconnectSessionSocket() {
      signalDisconnectStarted();
      await disconnectGate;
    },
    closeBudgetMs: 200,
    now: () => currentTime,
  });

  try {
    const request = bus.request({
      kind: "disconnect_session",
      requestId: "req-10",
      targetInstanceId: "node-a",
      sessionId: session.id,
      requestedAt: currentTime - 1_000,
    });
    await disconnectStarted;

    const closing = consumer.close();
    assert.equal(
      await settleWithin(closing, 20),
      false,
      "close must wait for every accepted handler, not only member eviction",
    );
    releaseDisconnect();
    assert.equal(await settleWithin(closing, 200), true);
    assert.equal((await request).status, "ok");
  } finally {
    releaseDisconnect();
    await consumer.close();
  }
});

test("admin command consumer close refuses a captured handler before it starts", async () => {
  const currentTime = 12_000;
  const session = createSession("session-k", "ROOM11", "member-k");
  let dispatch!: Parameters<AdminCommandBus["subscribe"]>[1];
  const bus: AdminCommandBus = {
    async request(command) {
      return await dispatch(command);
    },
    async subscribe(_instanceId, handler) {
      dispatch = handler;
      return async () => {};
    },
  };
  let evictions = 0;
  let disconnects = 0;

  const consumer = await createAdminCommandConsumer({
    instanceId: "node-a",
    adminCommandBus: bus,
    getLocalSession() {
      return null;
    },
    listLocalSessionsByRoom(roomCode) {
      return roomCode === "ROOM11" ? [session] : [];
    },
    evictMemberToken() {
      evictions += 1;
    },
    disconnectSessionSocket() {
      disconnects += 1;
    },
    memberEvictionConfirmTimeoutMs: 10,
    closeBudgetMs: 50,
    now: () => currentTime,
  });
  const command: AdminCommand = {
    kind: "kick_member",
    requestId: "req-11",
    targetInstanceId: "node-a",
    roomCode: "ROOM11",
    memberId: "member-k",
    requestedAt: currentTime - 1_000,
  };

  const capturedHandler = dispatch;
  const queued = Promise.resolve().then(() => capturedHandler(command));
  const closing = consumer.close();
  const result = await queued;
  await closing;

  assert.equal(result.status, "stale_target");
  assert.equal(result.code, "command_consumer_closed");
  assert.equal(evictions, 0);
  assert.equal(disconnects, 0);
});
