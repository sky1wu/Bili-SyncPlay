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
  /**
   * Blocks the token AND ends the identity as one commit.
   *
   * Both halves are needed — the block only holds them out for its TTL, and
   * without the revoke they would come back as the same member once it lapsed —
   * but they must not be two writes. When the block landed and the revoke then
   * failed there was nothing to roll the block back with: the admin was told the
   * kick failed while the member kept working until their next reconnect, which
   * was then refused with `member_kicked` (#237 review).
   */
  evictMemberToken: (
    roomCode: string,
    memberId: string,
    memberToken: string,
    blockedUntil: number,
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
            await options.evictMemberToken(
              command.roomCode,
              command.memberId,
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
