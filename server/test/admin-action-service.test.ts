import assert from "node:assert/strict";
import test from "node:test";
import {
  AdminActionError,
  createAdminActionService,
} from "../src/admin/action-service.js";
import { createAuditLogService } from "../src/admin/audit-log.js";
import type { AdminSession } from "../src/admin/types.js";
import type { PersistedRoom, Session } from "../src/types.js";

const ACTOR: AdminSession = {
  id: "admin-session",
  adminId: "admin-1",
  username: "admin",
  role: "admin",
  createdAt: 1,
  expiresAt: 2,
  lastSeenAt: 1,
};

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
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
    roomCode: "ROOM01",
    memberId: "member-1",
    displayName: "Alice",
    memberToken: "token-1",
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
    ...overrides,
  };
}

function createRoom(code = "ROOM01"): PersistedRoom {
  return {
    code,
    joinToken: "join-token",
    createdAt: 1_000,
    sharedVideo: null,
    playback: null,
    version: 1,
    lastActiveAt: 1_000,
    expiresAt: null,
  };
}

function createService(options: {
  session?: Session | null;
  sessionsByRoom?: Session[];
  requestAdminCommand: Parameters<
    typeof createAdminActionService
  >[0]["requestAdminCommand"];
  deleteRoom?: (roomCode: string) => Promise<void>;
  deleteRuntimeRoom?: (roomCode: string) => void;
  publishRoomDeleted?: (roomCode: string) => Promise<void>;
  auditLogService?: ReturnType<typeof createAuditLogService>;
}) {
  const auditLogService = options.auditLogService ?? createAuditLogService();
  return createAdminActionService({
    instanceId: "instance-1",
    roomStore: {
      getRoom: async (roomCode: string) => createRoom(roomCode),
      updateRoom: async () => {
        throw new Error("updateRoom should not be called in this test");
      },
      deleteRoom: options.deleteRoom ?? (async () => {}),
      listRooms: async () => ({ items: [], total: 0 }),
      isReady: async () => true,
      close: async () => {},
      createRoom: async () => {
        throw new Error("createRoom should not be called in this test");
      },
    },
    runtimeStore: {
      listSessionsByRoom: () => options.sessionsByRoom ?? [],
      getSession: () => options.session ?? null,
      deleteRoom: options.deleteRuntimeRoom ?? (() => {}),
    },
    listClusterSessions: async () => (options.session ? [options.session] : []),
    listClusterSessionsByRoom: async () => options.sessionsByRoom ?? [],
    requestAdminCommand: options.requestAdminCommand,
    auditLogService,
    getRoomStateByCode: async () => null,
    publishRoomStateUpdate: async () => {},
    publishRoomDeleted: options.publishRoomDeleted ?? (async () => {}),
    logEvent: () => {},
    now: () => 10_000,
  });
}

test("admin action service maps not_found command results to 404", async () => {
  const session = createSession();
  const service = createService({
    session,
    requestAdminCommand: async () => ({
      requestId: "req-1",
      targetInstanceId: "node-a",
      executorInstanceId: "node-a",
      status: "not_found",
      code: "session_not_found",
      message: "Session not found.",
      completedAt: 10_001,
    }),
  });

  await assert.rejects(
    () => service.disconnectSession(ACTOR, session.id, "cleanup"),
    (error: unknown) => {
      assert.ok(error instanceof AdminActionError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "session_not_found");
      assert.equal(error.message, "Session not found.");
      return true;
    },
  );
});

test("admin action service maps stale_target command results to 409", async () => {
  const session = createSession();
  const service = createService({
    sessionsByRoom: [session],
    requestAdminCommand: async () => ({
      requestId: "req-2",
      targetInstanceId: "node-a",
      executorInstanceId: "node-a",
      status: "stale_target",
      code: "stale_target",
      message: "Target instance is unavailable.",
      completedAt: 10_002,
    }),
  });

  await assert.rejects(
    () => service.kickMember(ACTOR, "ROOM01", "member-1", "remove"),
    (error: unknown) => {
      assert.ok(error instanceof AdminActionError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "stale_target");
      assert.equal(error.message, "Target instance is unavailable.");
      return true;
    },
  );
});

test("admin action service maps error command results to 502", async () => {
  const session = createSession();
  const service = createService({
    session,
    requestAdminCommand: async () => ({
      requestId: "req-3",
      targetInstanceId: "node-a",
      executorInstanceId: "node-a",
      status: "error",
      code: "socket_close_failed",
      message: "Failed to close socket.",
      completedAt: 10_003,
    }),
  });

  await assert.rejects(
    () => service.disconnectSession(ACTOR, session.id, "cleanup"),
    (error: unknown) => {
      assert.ok(error instanceof AdminActionError);
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, "socket_close_failed");
      assert.equal(error.message, "Failed to close socket.");
      return true;
    },
  );
});

test("admin action service keeps room state when closeRoom cannot disconnect every session", async () => {
  let deletedPersistedRoom = false;
  let deletedRuntimeRoom = false;
  let publishedDeleted = false;
  const session = createSession();
  const auditLogService = createAuditLogService();
  const service = createService({
    sessionsByRoom: [session],
    requestAdminCommand: async () => ({
      requestId: "req-close-1",
      targetInstanceId: "node-a",
      executorInstanceId: "node-a",
      status: "stale_target",
      code: "stale_target",
      message: "Target instance is unavailable.",
      completedAt: 10_004,
    }),
    deleteRoom: async () => {
      deletedPersistedRoom = true;
    },
    deleteRuntimeRoom: () => {
      deletedRuntimeRoom = true;
    },
    publishRoomDeleted: async () => {
      publishedDeleted = true;
    },
    auditLogService,
  });

  await assert.rejects(
    () => service.closeRoom(ACTOR, "ROOM01", "shutdown"),
    (error: unknown) => {
      assert.ok(error instanceof AdminActionError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "stale_target");
      assert.equal(error.details?.commandFailureCount, 1);
      return true;
    },
  );

  assert.equal(deletedPersistedRoom, false);
  assert.equal(deletedRuntimeRoom, false);
  assert.equal(publishedDeleted, false);

  const auditLogs = await auditLogService.query({
    action: "close_room",
    page: 1,
    pageSize: 10,
  });
  assert.equal(auditLogs.total, 1);
  assert.equal(auditLogs.items[0]?.result, "rejected");
  assert.equal(auditLogs.items[0]?.reason, "command_failed");
});
