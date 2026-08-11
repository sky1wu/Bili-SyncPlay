import {
  DEFAULT_ADMIN_COMMAND_REPLY_TIMEOUT_MS,
  type AdminCommand,
  type AdminCommandBus,
  type AdminCommandFailureResult,
  type AdminCommandResult,
} from "./admin-command-bus.js";
import { createRetryPacer, settleWithin } from "./retry-pacer.js";
import type { LogEvent, Session } from "./types.js";

/**
 * Leave the command bus one second to publish the executor's answer before its
 * own reply deadline expires.
 */
export const DEFAULT_MEMBER_EVICTION_CONFIRM_TIMEOUT_MS =
  DEFAULT_ADMIN_COMMAND_REPLY_TIMEOUT_MS - 1_000;

/**
 * Total budget for removing the subscription and settling effects owned by the
 * consumer. Kept inside the enclosing shutdown step's default five seconds so
 * an unanswered dependency is reported as a degraded close here rather than
 * timing out the whole step.
 */
export const DEFAULT_ADMIN_COMMAND_CONSUMER_CLOSE_BUDGET_MS = 4_000;

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
   *
   * This must remain below every production request's command-bus reply
   * deadline. `AdminCommandBus.request` accepts a shorter override for tests and
   * special callers, but such a caller deliberately gives up before it can
   * receive this consumer's typed `confirmation=unconfirmed` result.
   */
  memberEvictionConfirmTimeoutMs?: number;
  /** Shared by unsubscribe and every command effect already in flight. */
  closeBudgetMs?: number;
  now?: () => number;
  logEvent?: LogEvent;
}): Promise<{ close: () => Promise<void> }> {
  const now = options.now ?? Date.now;
  const memberEvictionConfirmTimeoutMs =
    options.memberEvictionConfirmTimeoutMs ??
    DEFAULT_MEMBER_EVICTION_CONFIRM_TIMEOUT_MS;
  const closeBudgetMs =
    options.closeBudgetMs ?? DEFAULT_ADMIN_COMMAND_CONSUMER_CLOSE_BUDGET_MS;
  const memberEvictionPacer = createRetryPacer({
    initialDelayMs: memberEvictionConfirmTimeoutMs,
    maxDelayMs: memberEvictionConfirmTimeoutMs,
  });
  const commandHandlerPacer = createRetryPacer({
    initialDelayMs: closeBudgetMs,
    maxDelayMs: closeBudgetMs,
  });
  let closing = false;

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

  function dispatchCommand(command: AdminCommand): Promise<AdminCommandResult> {
    if (closing) {
      return Promise.resolve(
        buildFailureResult(
          command,
          "stale_target",
          "command_consumer_closed",
          "Target instance is shutting down.",
        ),
      );
    }

    // Track every handler, not only the eviction that can outlive its
    // confirmation cap. This gives the consumer one lifecycle boundary for
    // direct disconnects, tokenless kicks, and capped eviction handlers alike.
    return commandHandlerPacer.trackCall(handleCommand(command));
  }

  const unsubscribe = await options.adminCommandBus.subscribe(
    options.instanceId,
    dispatchCommand,
  );
  let closePromise: Promise<void> | null = null;

  async function closeConsumer(): Promise<void> {
    const deadline = performance.now() + closeBudgetMs;
    const remainingBudgetMs = (): number =>
      Math.max(deadline - performance.now(), 0);
    let unsubscribeSettled = false;
    let unsubscribeFailed = false;
    let unsubscribeError: unknown;
    const unsubscribing = Promise.resolve()
      .then(unsubscribe)
      .then(
        () => {
          unsubscribeSettled = true;
        },
        (error: unknown) => {
          unsubscribeSettled = true;
          unsubscribeFailed = true;
          unsubscribeError = error;
        },
      );

    const settleAcceptedEffects = async (): Promise<void> => {
      // Drain handlers first: an accepted handler owns any late eviction it
      // creates. Taking both pacer snapshots at once would let such an eviction
      // appear just after the member-eviction snapshot and escape this close.
      await commandHandlerPacer.settleTracked(remainingBudgetMs());
      const remaining = remainingBudgetMs();
      if (remaining > 0) {
        await memberEvictionPacer.settleTracked(remaining);
      }
    };

    // Unsubscribe and effect draining share ONE absolute deadline. Making
    // either phase sequential with a fresh timeout would move the overrun
    // outside this component's shutdown step.
    const closeWork = Promise.all([
      unsubscribing,
      settleAcceptedEffects(),
    ]).then(() => undefined);
    const settled = await settleWithin(closeWork, remainingBudgetMs());
    const pendingHandlers = commandHandlerPacer.trackedCount();
    const pendingMemberEvictions = memberEvictionPacer.trackedCount();
    if (
      !settled ||
      !unsubscribeSettled ||
      pendingHandlers > 0 ||
      pendingMemberEvictions > 0
    ) {
      options.logEvent?.("admin_command_consumer_close_unfinished", {
        instanceId: options.instanceId,
        pendingHandlers,
        pendingMemberEvictions,
        unsubscribePending: !unsubscribeSettled,
        budgetMs: closeBudgetMs,
        result: "timeout",
      });
    }
    if (unsubscribeFailed) {
      throw unsubscribeError;
    }
  }

  return {
    close() {
      if (!closePromise) {
        // Close the gate before unsubscribe reaches its first await. A Redis
        // message listener may already have captured `dispatchCommand`; that
        // queued handler must not create a new effect after the drain snapshot.
        closing = true;
        closePromise = closeConsumer();
      }
      return closePromise;
    },
  };
}
