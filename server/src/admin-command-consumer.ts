import {
  DEFAULT_ADMIN_COMMAND_REPLY_TIMEOUT_MS,
  type AdminCommand,
  type AdminCommandBus,
  type AdminCommandFailureResult,
  type AdminCommandResult,
} from "./admin-command-bus.js";
import { createRetryPacer } from "./retry-pacer.js";
import type { LogEvent, Session } from "./types.js";

/**
 * Leave the command bus one second to publish the executor's answer before its
 * own reply deadline expires.
 */
export const DEFAULT_MEMBER_EVICTION_CONFIRM_TIMEOUT_MS =
  DEFAULT_ADMIN_COMMAND_REPLY_TIMEOUT_MS - 1_000;

class MemberEvictionUnconfirmedError extends Error {
  constructor(timeoutMs: number) {
    super(`Member eviction was not confirmed within ${timeoutMs}ms.`);
    this.name = "MemberEvictionUnconfirmedError";
  }
}

type KickEffectFailureCode = "block_failed" | "disconnect_failed";

class KickEffectFailure extends Error {
  constructor(
    readonly code: KickEffectFailureCode,
    readonly responseMessage: string,
    readonly originalError: unknown,
    readonly blockApplied: boolean,
  ) {
    super(originalError instanceof Error ? originalError.message : code);
    this.name = "KickEffectFailure";
  }
}

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
  /**
   * Bounds only this command handler's wait. The full eviction effect keeps
   * running so a late durable success can still update every local mirror,
   * disconnect the socket, and trigger normal leave cleanup.
   */
  memberEvictionConfirmTimeoutMs?: number;
  now?: () => number;
  logEvent?: LogEvent;
}): Promise<{ close: () => Promise<void> }> {
  const now = options.now ?? Date.now;
  const memberEvictionConfirmTimeoutMs =
    options.memberEvictionConfirmTimeoutMs ??
    DEFAULT_MEMBER_EVICTION_CONFIRM_TIMEOUT_MS;
  const memberEvictionPacer = createRetryPacer({
    initialDelayMs: memberEvictionConfirmTimeoutMs,
    maxDelayMs: memberEvictionConfirmTimeoutMs,
  });

  function buildFailureResult(
    command: AdminCommand,
    status: AdminCommandFailureResult["status"],
    code: string,
    message: string,
    confirmation?: "unconfirmed",
  ): AdminCommandResult {
    const base = {
      requestId: command.requestId,
      targetInstanceId: command.targetInstanceId,
      executorInstanceId: options.instanceId,
      code,
      message,
      completedAt: now(),
    };
    if (confirmation === "unconfirmed") {
      return { ...base, status: "error", confirmation };
    }
    return { ...base, status };
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
          return buildFailureResult(
            command,
            "error",
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

        const memberToken = session.memberToken;
        const runKickEffect = async (): Promise<void> => {
          if (memberToken) {
            try {
              await options.evictMemberToken(
                command.roomCode,
                command.memberId,
                memberToken,
                now() + 60_000,
              );
            } catch (error) {
              throw new KickEffectFailure(
                "block_failed",
                "Failed to block member token.",
                error,
                false,
              );
            }
          }

          try {
            await options.disconnectSessionSocket(
              session,
              "Admin kicked member",
            );
          } catch (error) {
            throw new KickEffectFailure(
              "disconnect_failed",
              memberToken
                ? "Member token was blocked but the session disconnect failed."
                : "Failed to disconnect member session.",
              error,
              Boolean(memberToken),
            );
          }
        };

        // Terminal reporting belongs to the real effect, not to the caller
        // waiting for it. This continuation therefore runs for both immediate
        // and late outcomes after the confirmation cap has answered.
        const kickEffect = Promise.resolve()
          .then(runKickEffect)
          .then(
            () => {
              options.logEvent?.("admin_command_executed", {
                commandType: command.kind,
                commandRequestId: command.requestId,
                targetInstanceId: command.targetInstanceId,
                executorInstanceId: options.instanceId,
                roomCode: command.roomCode,
                memberId: command.memberId,
                sessionId: session.id,
                result: "ok",
              });
            },
            (error: unknown) => {
              const failure =
                error instanceof KickEffectFailure
                  ? error
                  : new KickEffectFailure(
                      "block_failed",
                      "Failed to block member token.",
                      error,
                      false,
                    );
              options.logEvent?.("admin_command_executed", {
                commandType: command.kind,
                commandRequestId: command.requestId,
                targetInstanceId: command.targetInstanceId,
                executorInstanceId: options.instanceId,
                roomCode: command.roomCode,
                memberId: command.memberId,
                sessionId: session.id,
                result: "error",
                code: failure.code,
                error:
                  failure.originalError instanceof Error
                    ? failure.originalError.message
                    : failure.code,
                blockApplied: failure.blockApplied,
              });
              throw failure;
            },
          );

        try {
          if (memberToken) {
            await memberEvictionPacer.capAttempt(
              kickEffect,
              memberEvictionConfirmTimeoutMs,
              () =>
                new MemberEvictionUnconfirmedError(
                  memberEvictionConfirmTimeoutMs,
                ),
            );
          } else {
            await kickEffect;
          }
        } catch (error) {
          if (error instanceof KickEffectFailure) {
            return buildFailureResult(
              command,
              "error",
              error.code,
              error.responseMessage,
            );
          }
          if (!(error instanceof MemberEvictionUnconfirmedError)) {
            throw error;
          }
          options.logEvent?.("admin_command_confirmation_timed_out", {
            commandType: command.kind,
            commandRequestId: command.requestId,
            targetInstanceId: command.targetInstanceId,
            executorInstanceId: options.instanceId,
            roomCode: command.roomCode,
            memberId: command.memberId,
            sessionId: session.id,
            result: "timeout",
            confirmation: "unconfirmed",
            error: error.message,
          });
          return buildFailureResult(
            command,
            "error",
            "block_unconfirmed",
            "Member eviction was not confirmed before the deadline.",
            "unconfirmed",
          );
        }
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
