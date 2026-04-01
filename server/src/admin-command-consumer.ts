import type {
  AdminCommand,
  AdminCommandBus,
  AdminCommandResult,
} from "./admin-command-bus.js";
import type { LogEvent, Session } from "./types.js";

export async function createAdminCommandConsumer(options: {
  instanceId: string;
  adminCommandBus: AdminCommandBus;
  getLocalSession: (sessionId: string) => Session | null;
  listLocalSessionsByRoom: (roomCode: string) => Session[];
  blockMemberToken: (
    roomCode: string,
    memberToken: string,
    expiresAt: number,
  ) => void | Promise<void>;
  disconnectSessionSocket: (
    session: Session,
    reason: string,
  ) => void | Promise<void>;
  now?: () => number;
  logEvent?: LogEvent;
}): Promise<{ close: () => Promise<void> }> {
  const now = options.now ?? Date.now;

  function buildErrorResult(
    command: AdminCommand,
    code: string,
    message: string,
  ): AdminCommandResult {
    return {
      requestId: command.requestId,
      targetInstanceId: command.targetInstanceId,
      executorInstanceId: options.instanceId,
      status: "error",
      code,
      message,
      completedAt: now(),
    };
  }

  async function handleCommand(
    command: AdminCommand,
  ): Promise<AdminCommandResult> {
    switch (command.kind) {
      case "disconnect_session": {
        const session = options.getLocalSession(command.sessionId);
        if (!session) {
          return {
            requestId: command.requestId,
            targetInstanceId: command.targetInstanceId,
            executorInstanceId: options.instanceId,
            status: "not_found",
            code: "session_not_found",
            message: "Session not found.",
            completedAt: now(),
          };
        }

        try {
          await options.disconnectSessionSocket(
            session,
            "Admin disconnected session",
          );
        } catch (error) {
          options.logEvent?.("admin_command_executed", {
            commandType: command.kind,
            targetInstanceId: command.targetInstanceId,
            executorInstanceId: options.instanceId,
            sessionId: command.sessionId,
            result: "error",
            error: error instanceof Error ? error.message : "disconnect_failed",
          });
          return buildErrorResult(
            command,
            "disconnect_failed",
            "Failed to disconnect session.",
          );
        }
        options.logEvent?.("admin_command_executed", {
          commandType: command.kind,
          targetInstanceId: command.targetInstanceId,
          executorInstanceId: options.instanceId,
          sessionId: command.sessionId,
          result: "ok",
        });
        return {
          requestId: command.requestId,
          targetInstanceId: command.targetInstanceId,
          executorInstanceId: options.instanceId,
          status: "ok",
          roomCode: session.roomCode,
          sessionId: command.sessionId,
          completedAt: now(),
        };
      }
      case "kick_member": {
        const session = options
          .listLocalSessionsByRoom(command.roomCode)
          .find((entry) => entry.memberId === command.memberId);
        if (!session) {
          return {
            requestId: command.requestId,
            targetInstanceId: command.targetInstanceId,
            executorInstanceId: options.instanceId,
            status: "not_found",
            code: "member_not_found",
            message: "Member not found.",
            completedAt: now(),
          };
        }

        try {
          if (session.memberToken) {
            await options.blockMemberToken(
              command.roomCode,
              session.memberToken,
              now() + 60_000,
            );
          }
        } catch (error) {
          options.logEvent?.("admin_command_executed", {
            commandType: command.kind,
            targetInstanceId: command.targetInstanceId,
            executorInstanceId: options.instanceId,
            roomCode: command.roomCode,
            memberId: command.memberId,
            sessionId: session.id,
            result: "error",
            error: error instanceof Error ? error.message : "block_failed",
          });
          return buildErrorResult(
            command,
            "block_failed",
            "Failed to block member token.",
          );
        }

        try {
          await options.disconnectSessionSocket(session, "Admin kicked member");
        } catch (error) {
          options.logEvent?.("admin_command_executed", {
            commandType: command.kind,
            targetInstanceId: command.targetInstanceId,
            executorInstanceId: options.instanceId,
            roomCode: command.roomCode,
            memberId: command.memberId,
            sessionId: session.id,
            result: "error",
            error: error instanceof Error ? error.message : "disconnect_failed",
            blockApplied: Boolean(session.memberToken),
          });
          return buildErrorResult(
            command,
            "disconnect_failed",
            "Member token was blocked but the session disconnect failed.",
          );
        }
        options.logEvent?.("admin_command_executed", {
          commandType: command.kind,
          targetInstanceId: command.targetInstanceId,
          executorInstanceId: options.instanceId,
          roomCode: command.roomCode,
          memberId: command.memberId,
          sessionId: session.id,
          result: "ok",
        });
        return {
          requestId: command.requestId,
          targetInstanceId: command.targetInstanceId,
          executorInstanceId: options.instanceId,
          status: "ok",
          roomCode: command.roomCode,
          memberId: command.memberId,
          sessionId: session.id,
          completedAt: now(),
        };
      }
    }
  }

  const unsubscribe = await options.adminCommandBus.subscribe(
    options.instanceId,
    handleCommand,
  );

  return {
    async close() {
      await unsubscribe();
    },
  };
}
