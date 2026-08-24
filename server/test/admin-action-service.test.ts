import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_COMMAND_FANOUT_CONCURRENCY,
  AdminActionError,
  createAdminActionService,
} from "../src/admin/action-service.js";
import { createAuditLogService } from "../src/admin/audit-log.js";
import type { AdminSession } from "../src/admin/types.js";
import type { RoomStore } from "../src/room-store.js";
import type { AttachedSession, PersistedRoom, Session } from "../src/types.js";

const ACTOR: AdminSession = {
  id: "admin-session",
  adminId: "admin-1",
  username: "admin",
  role: "admin",
  createdAt: 1,
  expiresAt: 2,
  lastSeenAt: 1,
};

function createSession(overrides: Partial<AttachedSession> = {}): Session {
  return {
    id: "session-1",
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
  deleteRoom?: RoomStore["deleteRoom"];
  getRoom?: (roomCode: string) => Promise<PersistedRoom | null>;
  onGetRoom?: () => void;
  onListSessionsByRoom?: () => void;
  deleteRuntimeRoom?: (roomCode: string) => void;
  publishRoomDeleted?: (roomCode: string) => Promise<void>;
  auditLogService?: ReturnType<typeof createAuditLogService>;
  updateRoom?: RoomStore["updateRoom"];
  publishRoomStateUpdate?: () => Promise<void>;
  roomVideoClearConfirmTimeoutMs?: number;
  maxFanoutConcurrency?: number;
  logEvent?: (name: string, data?: Record<string, unknown>) => void;
  roomDeleteConfirmTimeoutMs?: number;
  closeBudgetMs?: number;
}) {
  const auditLogService = options.auditLogService ?? createAuditLogService();
  return createAdminActionService({
    instanceId: "instance-1",
    roomStore: {
      getRoom: async (roomCode: string) => {
        options.onGetRoom?.();
        return options.getRoom
          ? await options.getRoom(roomCode)
          : createRoom(roomCode);
      },
      updateRoom:
        options.updateRoom ??
        (async () => {
          throw new Error("updateRoom should not be called in this test");
        }),
      deleteRoom: options.deleteRoom ?? (async () => "deleted"),
      deleteExpiredRoom: async () => {
        throw new Error("deleteExpiredRoom should not be called in this test");
      },
      listRooms: async () => [],
      countRooms: async () => 0,
      isReady: async () => true,
      deleteExpiredRooms: async () => ({
        deletedRoomCodes: [],
        orphanedIndexCodes: [],
      }),
      createRoom: async () => {
        throw new Error("createRoom should not be called in this test");
      },
    },
    runtimeStore: {
      listSessionsByRoom: () => options.sessionsByRoom ?? [],
      getSession: () => options.session ?? null,
    },
    teardownRoomRuntime: async (roomCode) => {
      options.deleteRuntimeRoom?.(roomCode);
    },
    listClusterSessions: async () => (options.session ? [options.session] : []),
    listClusterSessionsByRoom: async () => {
      options.onListSessionsByRoom?.();
      return options.sessionsByRoom ?? [];
    },
    requestAdminCommand: options.requestAdminCommand,
    auditLogService,
    getRoomStateByCode: async () => null,
    publishRoomStateUpdate: options.publishRoomStateUpdate ?? (async () => {}),
    roomVideoClearConfirmTimeoutMs: options.roomVideoClearConfirmTimeoutMs,
    publishRoomDeleted: options.publishRoomDeleted ?? (async () => {}),
    logEvent: (name, data) => options.logEvent?.(name, data),
    now: () => 10_000,
    maxFanoutConcurrency: options.maxFanoutConcurrency,
    roomDeleteConfirmTimeoutMs: options.roomDeleteConfirmTimeoutMs,
    closeBudgetMs: options.closeBudgetMs,
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

test("admin action service audits a video clear it could not confirm", async () => {
  // The action's SUCCESS owes two things nobody else repeats — the audit record
  // AND the `room_state_updated` broadcast — so its write keeps running past
  // this wait rather than having its outcome discarded. An unconfirmed action
  // is never audited as `ok`, but it IS audited: "unknown" is an outcome
  // (#267, #277 review).
  const auditLogService = createAuditLogService();
  let published = 0;
  const service = createService({
    auditLogService,
    requestAdminCommand: async () => {
      throw new Error("no command should be issued for a video clear");
    },
    // Never answers: the wait ends, the effect does not.
    updateRoom: () => new Promise(() => undefined),
    publishRoomStateUpdate: async () => {
      published += 1;
    },
    roomVideoClearConfirmTimeoutMs: 20,
  });

  await assert.rejects(
    () => service.clearRoomVideo(ACTOR, "ROOM01", "cleanup"),
    (error: unknown) => {
      assert.ok(error instanceof AdminActionError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "room_video_clear_unconfirmed");
      return true;
    },
  );

  const auditLogs = await auditLogService.query({
    action: "clear_room_video",
    page: 1,
    pageSize: 10,
  });
  assert.equal(auditLogs.total, 1);
  assert.equal(auditLogs.items[0]?.result, "rejected");
  assert.equal(auditLogs.items[0]?.reason, "room_video_clear_unconfirmed");
  // The broadcast is owed to the effect, not to this waiter — and the effect
  // has not landed, so nobody has been told anything yet.
  assert.equal(published, 0);
});

test("a video clear that lands late still broadcasts the new state", async () => {
  // The half a 503 cannot express. The write keeps running past the wait, and
  // a cleared video nobody was told about leaves every connected client showing
  // and syncing the old one (#277 review).
  const auditLogService = createAuditLogService();
  let published = 0;
  let releaseWrite: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const service = createService({
    auditLogService,
    requestAdminCommand: async () => {
      throw new Error("no command should be issued for a video clear");
    },
    updateRoom: async (code, expected, patch) => {
      await held;
      return {
        ok: true,
        room: { ...createRoom(code), ...patch, version: 1 },
      };
    },
    publishRoomStateUpdate: async () => {
      published += 1;
    },
    roomVideoClearConfirmTimeoutMs: 20,
  });

  await assert.rejects(() =>
    service.clearRoomVideo(ACTOR, "ROOM01", "cleanup"),
  );
  assert.equal(published, 0);

  releaseWrite?.();
  await service.close();

  assert.equal(published, 1, "a late clear never told anybody");
});

test("admin action service audits an unconfirmed kick that may still land", async () => {
  const session = createSession();
  const auditLogService = createAuditLogService();
  const service = createService({
    sessionsByRoom: [session],
    auditLogService,
    requestAdminCommand: async () => ({
      requestId: "req-unconfirmed-kick",
      targetInstanceId: "node-a",
      executorInstanceId: "node-a",
      status: "error",
      confirmation: "unconfirmed",
      code: "block_unconfirmed",
      message: "Member eviction was not confirmed before the deadline.",
      completedAt: 10_002,
    }),
  });

  await assert.rejects(
    () => service.kickMember(ACTOR, "ROOM01", "member-1", "remove"),
    (error: unknown) => {
      assert.ok(error instanceof AdminActionError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "block_unconfirmed");
      return true;
    },
  );

  const auditLogs = await auditLogService.query({
    action: "kick_member",
    page: 1,
    pageSize: 10,
  });
  assert.equal(auditLogs.total, 1);
  assert.equal(auditLogs.items[0]?.actor.adminId, ACTOR.adminId);
  assert.equal(auditLogs.items[0]?.result, "rejected");
  assert.equal(auditLogs.items[0]?.reason, "block_unconfirmed");
  assert.equal(auditLogs.items[0]?.commandRequestId, "req-unconfirmed-kick");
  assert.equal(auditLogs.items[0]?.commandStatus, "error");
  assert.equal(auditLogs.items[0]?.commandConfirmation, "unconfirmed");
  assert.equal(auditLogs.items[0]?.commandCode, "block_unconfirmed");
});

test("admin action service audits any typed unconfirmed kick result", async () => {
  const session = createSession();
  const auditLogService = createAuditLogService();
  const service = createService({
    sessionsByRoom: [session],
    auditLogService,
    requestAdminCommand: async () => ({
      requestId: "req-publish-unconfirmed-kick",
      targetInstanceId: "node-a",
      executorInstanceId: "node-a",
      status: "error",
      confirmation: "unconfirmed",
      code: "command_publish_unconfirmed",
      message: "The admin command publish was not confirmed.",
      completedAt: 10_002,
    }),
  });

  await assert.rejects(
    () => service.kickMember(ACTOR, "ROOM01", "member-1", "remove"),
    (error: unknown) => {
      assert.ok(error instanceof AdminActionError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "command_publish_unconfirmed");
      return true;
    },
  );

  const auditLogs = await auditLogService.query({
    action: "kick_member",
    page: 1,
    pageSize: 10,
  });
  assert.equal(auditLogs.total, 1);
  assert.equal(auditLogs.items[0]?.actor.adminId, ACTOR.adminId);
  assert.equal(auditLogs.items[0]?.result, "rejected");
  assert.equal(auditLogs.items[0]?.reason, "command_publish_unconfirmed");
  assert.equal(
    auditLogs.items[0]?.commandRequestId,
    "req-publish-unconfirmed-kick",
  );
  assert.equal(auditLogs.items[0]?.commandStatus, "error");
  assert.equal(auditLogs.items[0]?.commandConfirmation, "unconfirmed");
  assert.equal(auditLogs.items[0]?.commandCode, "command_publish_unconfirmed");
});

test("admin action service audits an unconfirmed direct disconnect", async () => {
  const session = createSession();
  const auditLogService = createAuditLogService();
  const service = createService({
    session,
    auditLogService,
    requestAdminCommand: async () => ({
      requestId: "req-unconfirmed-disconnect",
      targetInstanceId: "node-a",
      executorInstanceId: "node-a",
      status: "error",
      confirmation: "unconfirmed",
      code: "command_timeout",
      message: "Timed out waiting for the target instance.",
      completedAt: 10_002,
    }),
  });

  await assert.rejects(
    () => service.disconnectSession(ACTOR, session.id, "cleanup"),
    (error: unknown) => {
      assert.ok(error instanceof AdminActionError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "command_timeout");
      return true;
    },
  );

  const auditLogs = await auditLogService.query({
    action: "disconnect_session",
    page: 1,
    pageSize: 10,
  });
  assert.equal(auditLogs.total, 1);
  assert.equal(auditLogs.items[0]?.actor.adminId, ACTOR.adminId);
  assert.equal(auditLogs.items[0]?.result, "rejected");
  assert.equal(auditLogs.items[0]?.reason, "command_timeout");
  assert.equal(
    auditLogs.items[0]?.commandRequestId,
    "req-unconfirmed-disconnect",
  );
  assert.equal(auditLogs.items[0]?.commandStatus, "error");
  assert.equal(auditLogs.items[0]?.commandConfirmation, "unconfirmed");
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

test("admin action service maps command bus unavailability to 503", async () => {
  const session = createSession();
  const service = createService({
    session,
    requestAdminCommand: async () => ({
      requestId: "req-unavailable",
      targetInstanceId: "node-a",
      executorInstanceId: "node-a",
      status: "error",
      code: "command_bus_unavailable",
      message: "Admin command bus could not reach Redis.",
      completedAt: 10_003,
    }),
  });

  await assert.rejects(
    () => service.disconnectSession(ACTOR, session.id, "cleanup"),
    (error: unknown) => {
      assert.ok(error instanceof AdminActionError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "command_bus_unavailable");
      return true;
    },
  );
});

test("concurrent admin commands receive distinct request ids", async () => {
  const session = createSession();
  const requestIds: string[] = [];
  const service = createService({
    session,
    requestAdminCommand: async (command) => {
      requestIds.push(command.requestId);
      return {
        requestId: command.requestId,
        targetInstanceId: command.targetInstanceId,
        executorInstanceId: "node-a",
        status: "ok",
        roomCode: session.roomCode,
        sessionId: session.id,
        completedAt: 10_004,
      };
    },
  });

  await Promise.all([
    service.disconnectSession(ACTOR, session.id, "first"),
    service.disconnectSession(ACTOR, session.id, "second"),
  ]);

  assert.equal(requestIds.length, 2);
  assert.notEqual(requestIds[0], requestIds[1]);
});

test("admin action service leaves a recycled room code alone when its close is superseded", async () => {
  let deletedRuntimeRoom = false;
  let publishedDeleted = false;
  const service = createService({
    sessionsByRoom: [],
    requestAdminCommand: async () => {
      throw new Error("no sessions to disconnect");
    },
    // The room this action read is gone and a different room now holds the
    // code. Both steps below are addressed BY CODE, so running them would tear
    // down and evict the successor's members.
    deleteRoom: async () => "superseded",
    deleteRuntimeRoom: () => {
      deletedRuntimeRoom = true;
    },
    publishRoomDeleted: async () => {
      publishedDeleted = true;
    },
  });

  const result = await service.closeRoom(ACTOR, "ROOM01", "shutdown");

  assert.equal(result.roomCode, "ROOM01");
  assert.equal(deletedRuntimeRoom, false);
  assert.equal(publishedDeleted, false);
});

test("a capped room deletion still completes its follow-ups when the command lands", async () => {
  const published: string[] = [];
  let torndown = false;
  let releaseDelete!: () => void;
  let markPublishStarted!: () => void;
  let releasePublish!: () => void;
  const deleteLanded = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  const publishStarted = new Promise<void>((resolve) => {
    markPublishStarted = resolve;
  });
  const publishLanded = new Promise<void>((resolve) => {
    releasePublish = resolve;
  });
  const service = createService({
    sessionsByRoom: [],
    requestAdminCommand: async () => {
      throw new Error("closeRoom has no sessions to disconnect");
    },
    // Slower than the deadline below: the action stops waiting, the command
    // does not stop running.
    deleteRoom: async () => {
      await deleteLanded;
      return "deleted";
    },
    deleteRuntimeRoom: () => {
      torndown = true;
    },
    publishRoomDeleted: async (roomCode) => {
      published.push(roomCode);
      markPublishStarted();
      await publishLanded;
    },
    roomDeleteConfirmTimeoutMs: 20,
    closeBudgetMs: 1_000,
  });

  const closing = service.closeRoom(ACTOR, "ROOM01", "shutdown");
  await assert.rejects(closing, (error: unknown) => {
    assert.ok(error instanceof AdminActionError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, "room_delete_unconfirmed");
    return true;
  });

  // Answered, and NOT acted upon: the record may still be there, so nothing
  // addressed by code may run yet.
  assert.equal(torndown, false);
  assert.deepEqual(published, []);

  // Shutdown drains the effect owner before closing its stores or event bus.
  // Releasing only the delete is not enough: close waits through every
  // follow-up in the same chain, including the one-shot publish.
  let serviceClosed = false;
  const closingService = service.close().then(() => {
    serviceClosed = true;
  });
  releaseDelete();
  await publishStarted;
  assert.equal(serviceClosed, false);
  assert.equal(torndown, true);
  assert.deepEqual(published, ["ROOM01"]);
  releasePublish();
  await closingService;
  assert.equal(serviceClosed, true);
});

test("admin action service reports deletion effects left at shutdown", async () => {
  let releaseDelete!: () => void;
  const deleteLanded = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  const events: string[] = [];
  const service = createService({
    sessionsByRoom: [],
    requestAdminCommand: async () => {
      throw new Error("closeRoom has no sessions to disconnect");
    },
    deleteRoom: async () => {
      await deleteLanded;
      return "deleted";
    },
    roomDeleteConfirmTimeoutMs: 5,
    closeBudgetMs: 5,
    logEvent: (event) => events.push(event),
  });

  await assert.rejects(
    () => service.closeRoom(ACTOR, "ROOM01", "shutdown"),
    (error: unknown) =>
      error instanceof AdminActionError &&
      error.code === "room_delete_unconfirmed",
  );
  await service.close();

  assert.ok(events.includes("admin_action_service_close_unfinished"));
  releaseDelete();
  await new Promise((resolve) => setImmediate(resolve));
});

test("admin action shutdown gates admission and drains accepted deletion handlers", async () => {
  let markRoomReadStarted!: () => void;
  let releaseRoomRead!: () => void;
  const roomReadStarted = new Promise<void>((resolve) => {
    markRoomReadStarted = resolve;
  });
  const roomReadLanded = new Promise<void>((resolve) => {
    releaseRoomRead = resolve;
  });
  const deleted: string[] = [];
  const service = createService({
    sessionsByRoom: [],
    requestAdminCommand: async () => {
      throw new Error("closeRoom has no sessions to disconnect");
    },
    getRoom: async (roomCode) => {
      markRoomReadStarted();
      await roomReadLanded;
      return createRoom(roomCode);
    },
    deleteRoom: async (room) => {
      deleted.push(room.code);
      return "deleted";
    },
    closeBudgetMs: 1_000,
  });

  // Accepted before close, but still before the deletion pacer when shutdown
  // starts. The handler owner must keep the later-created delete in the drain.
  const action = service.closeRoom(ACTOR, "ROOM01", "shutdown");
  await roomReadStarted;
  let serviceClosed = false;
  const closingService = service.close().then(() => {
    serviceClosed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serviceClosed, false);

  releaseRoomRead();
  await Promise.all([action, closingService]);
  assert.deepEqual(deleted, ["ROOM01"]);

  await assert.rejects(
    () => service.expireRoom(ACTOR, "ROOM02", "shutdown"),
    (error: unknown) =>
      error instanceof AdminActionError &&
      error.code === "admin_action_service_closed",
  );
});

test("admin action shutdown reports accepted deletion handlers left behind", async () => {
  let markRoomReadStarted!: () => void;
  let releaseRoomRead!: () => void;
  const roomReadStarted = new Promise<void>((resolve) => {
    markRoomReadStarted = resolve;
  });
  const roomReadLanded = new Promise<void>((resolve) => {
    releaseRoomRead = resolve;
  });
  const reports: Record<string, unknown>[] = [];
  const service = createService({
    sessionsByRoom: [],
    requestAdminCommand: async () => {
      throw new Error("closeRoom has no sessions to disconnect");
    },
    getRoom: async (roomCode) => {
      markRoomReadStarted();
      await roomReadLanded;
      return createRoom(roomCode);
    },
    closeBudgetMs: 5,
    logEvent: (event, data) => {
      if (event === "admin_action_service_close_unfinished" && data) {
        reports.push(data);
      }
    },
  });

  const action = service.closeRoom(ACTOR, "ROOM01", "shutdown");
  await roomReadStarted;
  await service.close();

  assert.equal(reports[0]?.pendingHandlers, 1);
  assert.equal(reports[0]?.pendingRoomDeletions, 0);
  releaseRoomRead();
  await action;
});

test("a capped room deletion that turns out superseded runs nothing by code", async () => {
  const published: string[] = [];
  let torndown = false;
  let releaseDelete!: () => void;
  const deleteLanded = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  const service = createService({
    sessionsByRoom: [],
    requestAdminCommand: async () => {
      throw new Error("expireRoom issues no commands");
    },
    deleteRoom: async () => {
      await deleteLanded;
      return "superseded";
    },
    deleteRuntimeRoom: () => {
      torndown = true;
    },
    publishRoomDeleted: async (roomCode) => {
      published.push(roomCode);
    },
    roomDeleteConfirmTimeoutMs: 20,
  });

  await assert.rejects(
    () => service.expireRoom(ACTOR, "ROOM01", "cleanup"),
    (error: unknown) =>
      error instanceof AdminActionError &&
      error.code === "room_delete_unconfirmed",
  );

  releaseDelete();
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The code belongs to a different room by now, and both steps are addressed
  // by code.
  assert.equal(torndown, false);
  assert.deepEqual(published, []);
});

test("admin action service pins the room it expires before judging it empty", async () => {
  const order: string[] = [];
  const service = createService({
    sessionsByRoom: [],
    requestAdminCommand: async () => {
      throw new Error("expireRoom issues no commands");
    },
    onGetRoom: () => order.push("read_room"),
    onListSessionsByRoom: () => order.push("list_sessions"),
    deleteRoom: async () => {
      order.push("delete");
      return "deleted";
    },
  });

  await service.expireRoom(ACTOR, "ROOM01", "cleanup");

  // Both questions are asked BY CODE. Asking "is it empty?" first let the
  // verdict describe the room that was leaving and the delete describe the one
  // that took its code.
  assert.deepEqual(order, ["read_room", "list_sessions", "delete"]);
});

test("admin action service leaves a recycled room code alone when its expire is superseded", async () => {
  let deletedRuntimeRoom = false;
  const service = createService({
    sessionsByRoom: [],
    requestAdminCommand: async () => {
      throw new Error("expireRoom issues no commands");
    },
    deleteRoom: async () => "superseded",
    deleteRuntimeRoom: () => {
      deletedRuntimeRoom = true;
    },
  });

  const result = await service.expireRoom(ACTOR, "ROOM01", "cleanup");

  assert.equal(result.roomCode, "ROOM01");
  assert.equal(deletedRuntimeRoom, false);
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
      return "deleted";
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

test("admin closeRoom stays within its shared fan-out budget", async () => {
  const sessions = Array.from(
    { length: ADMIN_COMMAND_FANOUT_CONCURRENCY * 2 + 1 },
    (_, index) =>
      createSession({
        id: `session-${index}`,
        memberId: `member-${index}`,
      }),
  );
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const service = createService({
    sessionsByRoom: sessions,
    requestAdminCommand: async (command) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return {
        requestId: command.requestId,
        targetInstanceId: command.targetInstanceId,
        executorInstanceId: command.targetInstanceId,
        status: "ok",
        roomCode: null,
        sessionId:
          command.kind === "disconnect_session" ? command.sessionId : undefined,
        completedAt: 10_004,
      };
    },
  });

  const result = await service.closeRoom(ACTOR, "ROOM01", "shutdown");

  assert.equal(result.disconnectedSessionCount, sessions.length);
  assert.equal(calls, sessions.length);
  assert.equal(maxInFlight, ADMIN_COMMAND_FANOUT_CONCURRENCY);
});

test("concurrent closeRoom calls share one fan-out budget without blocking single actions", async () => {
  const sessions = Array.from({ length: 3 }, (_, index) =>
    createSession({
      id: `room-session-${index}`,
      memberId: `room-member-${index}`,
    }),
  );
  const directSession = createSession({
    id: "direct-session",
    memberId: "direct-member",
  });
  let releaseFanout = (): void => {};
  const fanoutBlocked = new Promise<void>((resolve) => {
    releaseFanout = resolve;
  });
  let markFanoutCapacityReached = (): void => {};
  const fanoutCapacityReached = new Promise<void>((resolve) => {
    markFanoutCapacityReached = resolve;
  });
  let markDirectCommandStarted = (): void => {};
  const directCommandStarted = new Promise<void>((resolve) => {
    markDirectCommandStarted = resolve;
  });
  let fanoutInFlight = 0;
  let maxFanoutInFlight = 0;
  const service = createService({
    session: directSession,
    sessionsByRoom: sessions,
    maxFanoutConcurrency: 2,
    requestAdminCommand: async (command) => {
      if (command.requestId.startsWith("close-room:")) {
        fanoutInFlight += 1;
        maxFanoutInFlight = Math.max(maxFanoutInFlight, fanoutInFlight);
        if (fanoutInFlight === 2) {
          markFanoutCapacityReached();
        }
        await fanoutBlocked;
        fanoutInFlight -= 1;
      } else {
        markDirectCommandStarted();
      }
      return {
        requestId: command.requestId,
        targetInstanceId: command.targetInstanceId,
        executorInstanceId: command.targetInstanceId,
        status: "ok",
        roomCode: null,
        sessionId:
          command.kind === "disconnect_session" ? command.sessionId : undefined,
        completedAt: 10_004,
      };
    },
  });
  const closeCalls = [
    service.closeRoom(ACTOR, "ROOM01", "shutdown"),
    service.closeRoom(ACTOR, "ROOM02", "shutdown"),
    service.closeRoom(ACTOR, "ROOM03", "shutdown"),
  ];

  try {
    await fanoutCapacityReached;
    const directCall = service.disconnectSession(
      ACTOR,
      directSession.id,
      "cleanup",
    );
    await Promise.race([
      directCommandStarted,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("Single admin command was blocked by fan-out.")),
          100,
        ),
      ),
    ]);

    assert.equal(maxFanoutInFlight, 2);
    await directCall;
  } finally {
    releaseFanout();
    await Promise.allSettled(closeCalls);
  }

  assert.equal(maxFanoutInFlight, 2);
  assert.deepEqual(await Promise.all(closeCalls), [
    { roomCode: "ROOM01", disconnectedSessionCount: sessions.length },
    { roomCode: "ROOM02", disconnectedSessionCount: sessions.length },
    { roomCode: "ROOM03", disconnectedSessionCount: sessions.length },
  ]);
});

test("admin closeRoom maps command bus unavailability to 503", async () => {
  const session = createSession();
  const service = createService({
    sessionsByRoom: [session],
    requestAdminCommand: async () => ({
      requestId: "req-close-unavailable",
      targetInstanceId: "node-a",
      executorInstanceId: "node-a",
      status: "error",
      code: "command_bus_unavailable",
      message: "Admin command bus could not reach Redis.",
      completedAt: 10_004,
    }),
  });

  await assert.rejects(
    () => service.closeRoom(ACTOR, "ROOM01", "shutdown"),
    (error: unknown) => {
      assert.ok(error instanceof AdminActionError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.details?.commandFailureCount, 1);
      return true;
    },
  );
});

test("admin closeRoom keeps the 503 code aligned for mixed command failures", async () => {
  const firstSession = createSession({ id: "session-1" });
  const secondSession = createSession({
    id: "session-2",
    memberId: "member-2",
  });
  const service = createService({
    sessionsByRoom: [firstSession, secondSession],
    requestAdminCommand: async (command) =>
      command.kind === "disconnect_session" && command.sessionId === "session-1"
        ? {
            requestId: "req-close-executor-error",
            targetInstanceId: "node-a",
            executorInstanceId: "node-a",
            status: "error",
            code: "socket_close_failed",
            message: "Failed to close socket.",
            completedAt: 10_004,
          }
        : {
            requestId: "req-close-unavailable",
            targetInstanceId: "node-a",
            executorInstanceId: "node-a",
            status: "error",
            code: "command_bus_unavailable",
            message: "Admin command bus could not reach Redis.",
            completedAt: 10_004,
          },
  });

  await assert.rejects(
    () => service.closeRoom(ACTOR, "ROOM01", "shutdown"),
    (error: unknown) => {
      assert.ok(error instanceof AdminActionError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "command_bus_unavailable");
      assert.equal(error.details?.commandFailureCount, 2);
      return true;
    },
  );
});

test("admin expireRoom tears down the room's runtime state", async () => {
  const runtimeDeletes: string[] = [];
  const service = createService({
    requestAdminCommand: async () => {
      throw new Error("no command expected");
    },
    deleteRuntimeRoom: (roomCode) => {
      runtimeDeletes.push(roomCode);
    },
  });

  await service.expireRoom(
    { username: "admin" } as Parameters<typeof service.expireRoom>[0],
    "ROOMXP",
  );

  // `closeRoom` has always done this; `expireRoom` did not, so an expired room
  // left its runtime keys behind — including the tokens of members who had
  // disconnected but whose identity is deliberately retained (#234) — and a
  // recycled room code would inherit them.
  assert.deepEqual(runtimeDeletes, ["ROOMXP"]);
});
