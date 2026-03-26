import type { GlobalAuditStore } from "./global-audit-store.js";
import type { AdminSession } from "./types.js";
import {
  MEMBER_NOT_FOUND_MESSAGE,
  ROOM_ACTIVE_MESSAGE,
  ROOM_NOT_FOUND_MESSAGE,
  ROOM_VERSION_CONFLICT_MESSAGE,
  SESSION_NOT_FOUND_MESSAGE,
} from "../messages.js";
import type { LogEvent, PersistedRoom, Session } from "../types.js";
import type { RoomStore, RoomUpdateResult } from "../room-store.js";
import type { RuntimeStore } from "../runtime-store.js";

const KICK_REJOIN_BLOCK_MS = 60_000;

export class AdminActionError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createAdminActionService(options: {
  instanceId: string;
  roomStore: RoomStore;
  runtimeStore: RuntimeStore;
  auditLogService: GlobalAuditStore;
  getRoomStateByCode: (roomCode: string) => Promise<unknown | null>;
  broadcastRoomState: (roomCode: string) => Promise<void>;
  disconnectSessionSocket: (session: Session, reason: string) => void;
  blockMemberToken: (
    roomCode: string,
    memberToken: string,
    expiresAt: number,
  ) => void;
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
  ): void {
    void Promise.resolve(
      options.auditLogService.append({
        actor,
        action,
        targetType,
        targetId,
        request,
        result,
        reason,
        instanceId: options.instanceId,
      }),
    ).catch((error: unknown) => {
      console.error("Failed to append audit log", error);
    });
  }

  return {
    async closeRoom(actor: AdminSession, roomCode: string, reason?: string) {
      await getRoomOrThrow(roomCode);
      const sessions = options.runtimeStore.listSessionsByRoom(roomCode);

      for (const session of sessions) {
        options.disconnectSessionSocket(session, "Admin closed room");
      }
      await options.roomStore.deleteRoom(roomCode);
      options.logEvent("admin_room_closed", {
        roomCode,
        sessionCount: sessions.length,
        result: "ok",
        actor: actor.username,
      });
      writeAudit(actor, "close_room", "room", roomCode, { reason }, "ok");
      return {
        roomCode,
        disconnectedSessionCount: sessions.length,
      };
    },

    async expireRoom(actor: AdminSession, roomCode: string, reason?: string) {
      const sessions = options.runtimeStore.listSessionsByRoom(roomCode);
      if (sessions.length > 0) {
        throw new AdminActionError(409, "room_active", ROOM_ACTIVE_MESSAGE);
      }

      await getRoomOrThrow(roomCode);
      await options.roomStore.deleteRoom(roomCode);

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
      await options.broadcastRoomState(roomCode);
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
      const session = options.runtimeStore
        .listSessionsByRoom(roomCode)
        .find((entry) => entry.memberId === memberId);
      if (!session) {
        throw new AdminActionError(
          404,
          "member_not_found",
          MEMBER_NOT_FOUND_MESSAGE,
        );
      }
      if (session.memberToken) {
        options.blockMemberToken(
          roomCode,
          session.memberToken,
          now() + KICK_REJOIN_BLOCK_MS,
        );
      }
      options.disconnectSessionSocket(session, "Admin kicked member");
      options.logEvent("admin_member_kicked", {
        roomCode,
        memberId,
        sessionId: session.id,
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
      );
      return {
        roomCode,
        memberId,
        sessionId: session.id,
      };
    },

    async disconnectSession(
      actor: AdminSession,
      sessionId: string,
      reason?: string,
    ) {
      const session = options.runtimeStore.getSession(sessionId);
      if (!session) {
        throw new AdminActionError(
          404,
          "session_not_found",
          SESSION_NOT_FOUND_MESSAGE,
        );
      }
      options.disconnectSessionSocket(session, "Admin disconnected session");
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
      );
      return {
        sessionId,
        roomCode: session.roomCode,
      };
    },
  };
}
