export type AdminCommand =
  | {
      kind: "disconnect_session";
      requestId: string;
      targetInstanceId: string;
      sessionId: string;
      reason?: string;
      requestedAt: number;
    }
  | {
      kind: "kick_member";
      requestId: string;
      targetInstanceId: string;
      roomCode: string;
      memberId: string;
      reason?: string;
      requestedAt: number;
    };

export type AdminCommandKind = AdminCommand["kind"];

/** Runtime list used to pre-seed per-command outcome metrics. */
export const ADMIN_COMMAND_KINDS = [
  "disconnect_session",
  "kick_member",
] as const satisfies readonly AdminCommandKind[];

type _EnsureAllAdminCommandKindsCovered =
  Exclude<AdminCommandKind, (typeof ADMIN_COMMAND_KINDS)[number]> extends never
    ? true
    : never;
const _adminCommandKindsAreExhaustive: _EnsureAllAdminCommandKindsCovered = true;
void _adminCommandKindsAreExhaustive;

type AdminCommandFailureBase = {
  requestId: string;
  targetInstanceId: string;
  executorInstanceId: string;
  code: string;
  message: string;
  completedAt: number;
};

export type AdminCommandFailureResult = AdminCommandFailureBase &
  (
    | {
        status: "not_found" | "stale_target" | "error";
        confirmation?: never;
      }
    | {
        /**
         * The caller stopped waiting, but the command effect may still land.
         *
         * Kept orthogonal to `status` so the Redis result remains readable by
         * older processes during a rolling upgrade: they see the established
         * `error` status and ignore this additive field.
         */
        status: "error";
        confirmation: "unconfirmed";
      }
  );

export type AdminCommandResult =
  | {
      requestId: string;
      targetInstanceId: string;
      executorInstanceId: string;
      status: "ok";
      roomCode?: string | null;
      memberId?: string;
      sessionId?: string;
      completedAt: number;
    }
  | AdminCommandFailureResult;

/**
 * Process-wide cap for requests that own a Redis reply subscription.
 *
 * Exported because callers that fan out commands must stay below the same
 * capacity instead of deterministically refusing the tail of a valid batch.
 */
export const DEFAULT_ADMIN_COMMAND_MAX_ACTIVE_REQUESTS = 256;

/** Default wait for a command reply once its reply subscription is ready. */
export const DEFAULT_ADMIN_COMMAND_REPLY_TIMEOUT_MS = 5_000;

export type AdminCommandBus = {
  request: (
    command: AdminCommand,
    timeoutMs?: number,
  ) => Promise<AdminCommandResult>;
  subscribe: (
    instanceId: string,
    handler: (command: AdminCommand) => Promise<AdminCommandResult>,
  ) => Promise<() => Promise<void>>;
};

export function createNoopAdminCommandBus(): AdminCommandBus {
  return {
    async request(command) {
      return {
        requestId: command.requestId,
        targetInstanceId: command.targetInstanceId,
        executorInstanceId: command.targetInstanceId,
        status: "stale_target",
        code: "command_bus_disabled",
        message: "Admin command bus is disabled.",
        completedAt: Date.now(),
      };
    },
    async subscribe() {
      return async () => {};
    },
  };
}

export function createInMemoryAdminCommandBus(
  now: () => number = Date.now,
): AdminCommandBus {
  const handlers = new Map<
    string,
    (command: AdminCommand) => Promise<AdminCommandResult>
  >();

  return {
    async request(command) {
      const handler = handlers.get(command.targetInstanceId);
      if (!handler) {
        return {
          requestId: command.requestId,
          targetInstanceId: command.targetInstanceId,
          executorInstanceId: command.targetInstanceId,
          status: "stale_target",
          code: "stale_target",
          message: "Target instance is unavailable.",
          completedAt: now(),
        };
      }
      return await handler(command);
    },
    async subscribe(instanceId, handler) {
      handlers.set(instanceId, handler);
      return async () => {
        if (handlers.get(instanceId) === handler) {
          handlers.delete(instanceId);
        }
      };
    },
  };
}
