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
  | {
      requestId: string;
      targetInstanceId: string;
      executorInstanceId: string;
      status: "not_found" | "stale_target" | "error";
      code: string;
      message: string;
      completedAt: number;
    };

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
