import { Redis } from "ioredis";
import type {
  AdminCommand,
  AdminCommandBus,
  AdminCommandResult,
} from "./admin-command-bus.js";

const DEFAULT_COMMAND_CHANNEL_PREFIX = "bsp:admin-command:";
const DEFAULT_RESULT_CHANNEL_PREFIX = "bsp:admin-command-result:";

function commandChannel(prefix: string, instanceId: string): string {
  return `${prefix}${instanceId}`;
}

function resultChannel(prefix: string, requestId: string): string {
  return `${prefix}${requestId}`;
}

function parseCommand(payload: string): AdminCommand | null {
  try {
    const parsed = JSON.parse(payload) as Partial<AdminCommand>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.kind !== "string" ||
      typeof parsed.requestId !== "string" ||
      typeof parsed.targetInstanceId !== "string" ||
      typeof parsed.requestedAt !== "number"
    ) {
      return null;
    }

    if (
      parsed.kind === "disconnect_session" &&
      typeof parsed.sessionId === "string"
    ) {
      return {
        kind: parsed.kind,
        requestId: parsed.requestId,
        targetInstanceId: parsed.targetInstanceId,
        sessionId: parsed.sessionId,
        reason: parsed.reason,
        requestedAt: parsed.requestedAt,
      };
    }

    if (
      parsed.kind === "kick_member" &&
      typeof parsed.roomCode === "string" &&
      typeof parsed.memberId === "string"
    ) {
      return {
        kind: parsed.kind,
        requestId: parsed.requestId,
        targetInstanceId: parsed.targetInstanceId,
        roomCode: parsed.roomCode,
        memberId: parsed.memberId,
        reason: parsed.reason,
        requestedAt: parsed.requestedAt,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function parseResult(payload: string): AdminCommandResult | null {
  try {
    const parsed = JSON.parse(payload) as Partial<AdminCommandResult>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.requestId !== "string" ||
      typeof parsed.targetInstanceId !== "string" ||
      typeof parsed.executorInstanceId !== "string" ||
      typeof parsed.status !== "string" ||
      typeof parsed.completedAt !== "number"
    ) {
      return null;
    }

    if (parsed.status === "ok") {
      return {
        requestId: parsed.requestId,
        targetInstanceId: parsed.targetInstanceId,
        executorInstanceId: parsed.executorInstanceId,
        status: "ok",
        roomCode: typeof parsed.roomCode === "string" ? parsed.roomCode : null,
        memberId:
          typeof parsed.memberId === "string" ? parsed.memberId : undefined,
        sessionId:
          typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
        completedAt: parsed.completedAt,
      };
    }

    if (
      (parsed.status === "not_found" ||
        parsed.status === "stale_target" ||
        parsed.status === "error") &&
      typeof parsed.code === "string" &&
      typeof parsed.message === "string"
    ) {
      return {
        requestId: parsed.requestId,
        targetInstanceId: parsed.targetInstanceId,
        executorInstanceId: parsed.executorInstanceId,
        status: parsed.status,
        code: parsed.code,
        message: parsed.message,
        completedAt: parsed.completedAt,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export async function createRedisAdminCommandBus(
  redisUrl: string,
  options: {
    commandChannelPrefix?: string;
    resultChannelPrefix?: string;
    onInvalidMessage?: (kind: "command" | "result", payload: string) => void;
  } = {},
): Promise<AdminCommandBus & { close: () => Promise<void> }> {
  const commandChannelPrefix =
    options.commandChannelPrefix ?? DEFAULT_COMMAND_CHANNEL_PREFIX;
  const resultChannelPrefix =
    options.resultChannelPrefix ?? DEFAULT_RESULT_CHANNEL_PREFIX;
  const publishClient = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const subscribeClient = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const handlers = new Map<
    string,
    (command: AdminCommand) => Promise<AdminCommandResult>
  >();
  let closing = false;

  await Promise.all([publishClient.connect(), subscribeClient.connect()]);

  subscribeClient.on("message", (channel, payload) => {
    const instanceId = channel.startsWith(commandChannelPrefix)
      ? channel.slice(commandChannelPrefix.length)
      : null;
    if (!instanceId) {
      return;
    }
    const handler = handlers.get(instanceId);
    if (!handler) {
      return;
    }

    const command = parseCommand(payload);
    if (!command) {
      options.onInvalidMessage?.("command", payload);
      return;
    }

    void handler(command)
      .then(async (result) => {
        await publishClient.publish(
          resultChannel(resultChannelPrefix, command.requestId),
          JSON.stringify(result),
        );
      })
      .catch(async (error) => {
        const fallback: AdminCommandResult = {
          requestId: command.requestId,
          targetInstanceId: command.targetInstanceId,
          executorInstanceId: instanceId,
          status: "error",
          code: "command_execution_failed",
          message: error instanceof Error ? error.message : String(error),
          completedAt: Date.now(),
        };
        await publishClient.publish(
          resultChannel(resultChannelPrefix, command.requestId),
          JSON.stringify(fallback),
        );
      });
  });

  return {
    async request(command, timeoutMs = 5_000) {
      if (closing) {
        return {
          requestId: command.requestId,
          targetInstanceId: command.targetInstanceId,
          executorInstanceId: command.targetInstanceId,
          status: "stale_target",
          code: "command_bus_closed",
          message: "Admin command bus is closed.",
          completedAt: Date.now(),
        };
      }

      const replyChannel = resultChannel(
        resultChannelPrefix,
        command.requestId,
      );
      await subscribeClient.subscribe(replyChannel);

      try {
        const responsePromise = new Promise<AdminCommandResult>((resolve) => {
          const timeout = setTimeout(() => {
            subscribeClient.off("message", onReply);
            resolve({
              requestId: command.requestId,
              targetInstanceId: command.targetInstanceId,
              executorInstanceId: command.targetInstanceId,
              status: "stale_target",
              code: "command_timeout",
              message: "Timed out waiting for the target instance.",
              completedAt: Date.now(),
            });
          }, timeoutMs);

          const onReply = (channel: string, payload: string) => {
            if (channel !== replyChannel) {
              return;
            }
            const result = parseResult(payload);
            if (!result) {
              options.onInvalidMessage?.("result", payload);
              return;
            }
            clearTimeout(timeout);
            subscribeClient.off("message", onReply);
            resolve(result);
          };

          subscribeClient.on("message", onReply);
        });

        await publishClient.publish(
          commandChannel(commandChannelPrefix, command.targetInstanceId),
          JSON.stringify(command),
        );

        return await responsePromise;
      } finally {
        await subscribeClient.unsubscribe(replyChannel);
      }
    },
    async subscribe(instanceId, handler) {
      handlers.set(instanceId, handler);
      const channel = commandChannel(commandChannelPrefix, instanceId);
      await subscribeClient.subscribe(channel);
      return async () => {
        if (handlers.get(instanceId) === handler) {
          handlers.delete(instanceId);
        }
        await subscribeClient.unsubscribe(channel);
      };
    },
    async close() {
      closing = true;
      handlers.clear();
      await Promise.all([publishClient.quit(), subscribeClient.quit()]);
    },
  };
}
