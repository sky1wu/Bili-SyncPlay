import { randomUUID } from "node:crypto";
import type {
  AdminCommandBus,
  AdminCommandResult,
} from "../admin-command-bus.js";
import type { GlobalAuditStore } from "./global-audit-store.js";
import type { AdminSession } from "./types.js";
import {
  MEMBER_NOT_FOUND_MESSAGE,
  ROOM_ACTIVE_MESSAGE,
  ROOM_NOT_FOUND_MESSAGE,
  ROOM_VERSION_CONFLICT_MESSAGE,
  SESSION_NOT_FOUND_MESSAGE,
} from "../messages.js";
import type { LogEvent, PersistedRoom } from "../types.js";
import type { RoomStore, RoomUpdateResult } from "../room-store.js";
import type { RuntimeStore } from "../runtime-store.js";

export class AdminActionError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function createAdminActionService(options: {
  instanceId: string;
  roomStore: RoomStore;
  runtimeStore: Pick<RuntimeStore, "listSessionsByRoom" | "getSession">;
  /**
   * Tears down a deleted room's runtime state, guarded and retried.
   *
   * Not `runtimeStore.deleteRoom`: both paths below delete the persisted room
   * first and irrecoverably, so a teardown that fails has no way back — the code
   * would never reach the reaper again. The room service owns the retry ledger
   * and the generation check, so it has to be the one entry point (#237 review).
   */
  teardownRoomRuntime: (roomCode: string) => Promise<void>;
  listClusterSessions: () => Promise<
    Awaited<ReturnType<RuntimeStore["listClusterSessions"]>>
  >;
  listClusterSessionsByRoom: (
    roomCode: string,
  ) => Promise<Awaited<ReturnType<RuntimeStore["listClusterSessionsByRoom"]>>>;
  requestAdminCommand: AdminCommandBus["request"];
  auditLogService: GlobalAuditStore;
  getRoomStateByCode: (roomCode: string) => Promise<unknown | null>;
  publishRoomStateUpdate: (roomCode: string) => Promise<void>;
  publishRoomDeleted: (roomCode: string) => Promise<void>;
  logEvent: LogEvent;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;

  async function getRoomOrThrow(roomCode: string): Promise<PersistedRoom> {
    const room = await options.roomStore.getRoom(roomCode);
    if (!room) {
      throw new AdminActionError(404, "room_not_found", ROOM_NOT_FOUND_MESSAGE);
    }
    return room;
  }

  async function updateRoomWithRetry(
    roomCode: string,
    action: (room: PersistedRoom) => Promise<RoomUpdateResult>,
  ): Promise<PersistedRoom> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const room = await getRoomOrThrow(roomCode);
      const result = await action(room);
      if (result.ok) {
        return result.room;
      }
      if (result.reason === "not_found") {
        throw new AdminActionError(
          404,
          "room_not_found",
          ROOM_NOT_FOUND_MESSAGE,
        );
      }
    }
    throw new AdminActionError(
      409,
      "room_version_conflict",
      ROOM_VERSION_CONFLICT_MESSAGE,
    );
  }

  function writeAudit(
    actor: AdminSession,
    action: string,
    targetType: "room" | "session" | "member",
    targetId: string,
    request: Record<string, unknown>,
    result: "ok" | "rejected" | "error",
    reason?: string,
    commandDetails?: {
      targetInstanceId?: string;
      commandResult?: AdminCommandResult;
    },
  ): void {
    // .then() defers the append call so a synchronous throw is routed to
    // .catch() instead of escaping into the admin action call site.
    void Promise.resolve()
      .then(() =>
        options.auditLogService.append({
          actor,
          action,
          targetType,
          targetId,
          request,
          result,
          reason,
          instanceId: options.instanceId,
          targetInstanceId: commandDetails?.targetInstanceId,
          executorInstanceId: commandDetails?.commandResult?.executorInstanceId,
          commandRequestId: commandDetails?.commandResult?.requestId,
          commandStatus: commandDetails?.commandResult?.status,
          commandCode:
            commandDetails?.commandResult?.status === "ok"
              ? undefined
              : commandDetails?.commandResult?.code,
        }),
      )
      .catch((error: unknown) => {
        options.logEvent("admin_audit_log_append_failed", {
          actor: actor.username,
          action,
          targetType,
          targetId,
          result: "error",
          instanceId: options.instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function throwCommandFailure(
    result: Exclude<AdminCommandResult, { status: "ok" }>,
  ): never {
    const statusCode = commandFailureStatusCode(result);
    throw new AdminActionError(statusCode, result.code, result.message);
  }

  function commandFailureStatusCode(
    result: Exclude<AdminCommandResult, { status: "ok" }>,
  ): number {
    if (result.status === "not_found") {
      return 404;
    }
    if (result.status === "stale_target") {
      return 409;
    }
    // An executor error is a bad upstream result; failure to reach the command
    // bus is this service's Redis dependency being unavailable and is retryable.
    return result.code === "command_bus_unavailable" ? 503 : 502;
  }

  return {
    async closeRoom(actor: AdminSession, roomCode: string, reason?: string) {
      await getRoomOrThrow(roomCode);
      const sessions = await options.listClusterSessionsByRoom(roomCode);
      const disconnectResults = await Promise.all(
        sessions.map(async (session) => {
          const targetInstanceId = session.instanceId ?? options.instanceId;
          const result = await options.requestAdminCommand({
            kind: "disconnect_session",
            requestId: `close-room:${roomCode}:${session.id}:${randomUUID()}`,
            targetInstanceId,
            sessionId: session.id,
            reason,
            requestedAt: now(),
          });
          return { session, targetInstanceId, result };
        }),
      );
      const failedCommands = disconnectResults.filter(
        (
          entry,
        ): entry is {
          session: (typeof disconnectResults)[number]["session"];
          targetInstanceId: string;
          result: Exclude<AdminCommandResult, { status: "ok" }>;
        } => entry.result.status !== "ok",
      );
      if (failedCommands.length > 0) {
        const commandFailureCount = failedCommands.length;
        const failureCodes = Array.from(
          new Set(failedCommands.map(({ result }) => result.code)),
        ).sort();
        const failedSessions = failedCommands.map(
          ({ session, result, targetInstanceId }) => ({
            sessionId: session.id,
            roomCode: session.roomCode,
            memberId: session.memberId,
            targetInstanceId,
            commandStatus: result.status,
            commandCode: result.code,
            message: result.message,
          }),
        );

        options.logEvent("admin_room_close_rejected", {
          roomCode,
          sessionCount: sessions.length,
          disconnectedSessionCount: sessions.length - commandFailureCount,
          commandFailureCount,
          failureCodes,
          result: "rejected",
          actor: actor.username,
        });
        writeAudit(
          actor,
          "close_room",
          "room",
          roomCode,
          {
            reason,
            commandFailureCount,
            failureCodes,
            failedSessions,
          },
          "rejected",
          "command_failed",
        );
        const representativeFailure =
          failedCommands.find(
            ({ result }) => commandFailureStatusCode(result) === 503,
          ) ??
          failedCommands.find(({ result }) => result.status === "error") ??
          failedCommands.find(({ result }) => result.status === "not_found") ??
          failedCommands[0]!;
        throw new AdminActionError(
          commandFailureStatusCode(representativeFailure.result),
          representativeFailure.result.code,
          "Failed to close room because one or more member sessions could not be disconnected.",
          {
            roomCode,
            commandFailureCount,
            failedSessions,
          },
        );
      }

      await options.roomStore.deleteRoom(roomCode);
      await options.teardownRoomRuntime(roomCode);
      await options.publishRoomDeleted(roomCode);
      const disconnectedSessionCount = disconnectResults.filter(
        ({ result }) => result.status === "ok",
      ).length;

      options.logEvent("admin_room_closed", {
        roomCode,
        sessionCount: sessions.length,
        disconnectedSessionCount,
        commandFailureCount: 0,
        result: "ok",
        actor: actor.username,
      });
      writeAudit(actor, "close_room", "room", roomCode, { reason }, "ok");
      return {
        roomCode,
        disconnectedSessionCount,
      };
    },

    async expireRoom(actor: AdminSession, roomCode: string, reason?: string) {
      const sessions = await options.listClusterSessionsByRoom(roomCode);
      if (sessions.length > 0) {
        throw new AdminActionError(409, "room_active", ROOM_ACTIVE_MESSAGE);
      }

      await getRoomOrThrow(roomCode);
      await options.roomStore.deleteRoom(roomCode);
      // Same teardown `closeRoom` above performs. Without it an expired room
      // left its runtime keys behind — including the tokens of members who had
      // disconnected but whose identity is deliberately retained (#234) — and a
      // recycled room code would inherit them (#237 review).
      await options.teardownRoomRuntime(roomCode);

      options.logEvent("admin_room_expired", {
        roomCode,
        activeSessionCount: 0,
        result: "ok",
        actor: actor.username,
      });
      writeAudit(actor, "expire_room", "room", roomCode, { reason }, "ok");
      return {
        roomCode,
        activeSessionCount: 0,
      };
    },

    async clearRoomVideo(
      actor: AdminSession,
      roomCode: string,
      reason?: string,
    ) {
      await updateRoomWithRetry(
        roomCode,
        async (room) =>
          await options.roomStore.updateRoom(room.code, room.version, {
            sharedVideo: null,
            playback: null,
            expiresAt: null,
            lastActiveAt: now(),
          }),
      );
      await options.publishRoomStateUpdate(roomCode);
      options.logEvent("admin_room_video_cleared", {
        roomCode,
        result: "ok",
        actor: actor.username,
      });
      writeAudit(actor, "clear_room_video", "room", roomCode, { reason }, "ok");
      return {
        roomCode,
        roomState: await options.getRoomStateByCode(roomCode),
      };
    },

    async kickMember(
      actor: AdminSession,
      roomCode: string,
      memberId: string,
      reason?: string,
    ) {
      await getRoomOrThrow(roomCode);
      const session = (await options.listClusterSessionsByRoom(roomCode)).find(
        (entry) => entry.memberId === memberId,
      );
      if (!session) {
        throw new AdminActionError(
          404,
          "member_not_found",
          MEMBER_NOT_FOUND_MESSAGE,
        );
      }

      const targetInstanceId = session.instanceId ?? options.instanceId;
      const commandResult = await options.requestAdminCommand({
        kind: "kick_member",
        requestId: `kick-member:${memberId}:${randomUUID()}`,
        targetInstanceId,
        roomCode,
        memberId,
        reason,
        requestedAt: now(),
      });
      if (commandResult.status !== "ok") {
        throwCommandFailure(commandResult);
      }

      options.logEvent("admin_member_kicked", {
        roomCode,
        memberId,
        sessionId: commandResult.sessionId ?? session.id,
        result: "ok",
        actor: actor.username,
      });
      writeAudit(
        actor,
        "kick_member",
        "member",
        memberId,
        { roomCode, reason },
        "ok",
        undefined,
        { targetInstanceId, commandResult },
      );
      return {
        roomCode,
        memberId,
        sessionId: commandResult.sessionId ?? session.id,
      };
    },

    async disconnectSession(
      actor: AdminSession,
      sessionId: string,
      reason?: string,
    ) {
      const session =
        (await options.listClusterSessions()).find(
          (entry) => entry.id === sessionId,
        ) ?? options.runtimeStore.getSession(sessionId);
      if (!session) {
        throw new AdminActionError(
          404,
          "session_not_found",
          SESSION_NOT_FOUND_MESSAGE,
        );
      }
      const targetInstanceId = session.instanceId ?? options.instanceId;
      const commandResult = await options.requestAdminCommand({
        kind: "disconnect_session",
        requestId: `disconnect-session:${sessionId}:${randomUUID()}`,
        targetInstanceId,
        sessionId,
        reason,
        requestedAt: now(),
      });
      if (commandResult.status !== "ok") {
        throwCommandFailure(commandResult);
      }

      options.logEvent("admin_session_disconnected", {
        sessionId,
        roomCode: session.roomCode,
        result: "ok",
        actor: actor.username,
      });
      writeAudit(
        actor,
        "disconnect_session",
        "session",
        sessionId,
        { reason },
        "ok",
        undefined,
        { targetInstanceId, commandResult },
      );
      return {
        sessionId,
        roomCode: commandResult.roomCode ?? session.roomCode,
      };
    },
  };
}
