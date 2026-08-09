import type {
  AdminCommand,
  AdminCommandBus,
  AdminCommandResult,
} from "./admin-command-bus.js";
import { quitAllWithin, type RedisQuitReport } from "./redis-graceful-close.js";
import {
  createRedisPubSubClientPair,
  type RedisPubSubClientPair,
} from "./redis-pubsub-client.js";

const DEFAULT_COMMAND_CHANNEL_PREFIX = "bsp:admin-command:";
const DEFAULT_RESULT_CHANNEL_PREFIX = "bsp:admin-command-result:";

/** Both clients close concurrently inside this facility's default 5s step. */
const CLOSE_QUIT_TIMEOUT_MS = 4_000;
type AdminCommandBusClientRole = "publisher" | "subscriber";

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
    /**
     * Neither the result nor the fallback result could be published.
     *
     * The executor ran the command; only the answer was lost. Reporting it is
     * all that is left to do, and it is what keeps this from being a bounded
     * failure that is also a silent one.
     */
    onResultPublishFailed?: (command: AdminCommand, error: unknown) => void;
    closeQuitTimeoutMs?: number;
    onCloseUnfinished?: (
      info: RedisQuitReport<AdminCommandBusClientRole>,
    ) => void;
    redisClients?: RedisPubSubClientPair;
  } = {},
): Promise<AdminCommandBus & { close: () => Promise<void> }> {
  const commandChannelPrefix =
    options.commandChannelPrefix ?? DEFAULT_COMMAND_CHANNEL_PREFIX;
  const resultChannelPrefix =
    options.resultChannelPrefix ?? DEFAULT_RESULT_CHANNEL_PREFIX;
  const { publisher: publishClient, subscriber: subscribeClient } =
    options.redisClients ??
    // Admissible: no caller here derives a bound from a command's silence. The
    // reply timer is a `setTimeout`, not evidence about the connection (#271).
    createRedisPubSubClientPair(redisUrl, { bound: "command_timeout" });
  const closeQuitTimeoutMs =
    options.closeQuitTimeoutMs ?? CLOSE_QUIT_TIMEOUT_MS;
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
      })
      // The fallback publish runs on the connection whose failure it is
      // reporting, so it is the likeliest of the three to fail — and a
      // rejection out of a `.catch()` handler has nowhere left to go. `void`
      // does not attach a handler, so under Node's default that is an
      // `unhandledRejection` and the process exits: a Redis outage escalated
      // into a crash. Reachable since #271 gave this client a `commandTimeout`;
      // before that the publish hung here instead, which is not the better
      // failure (#271 review). The requester is not stranded either way — its
      // own reply timer answers with `command_timeout`.
      .catch((error: unknown) => {
        options.onResultPublishFailed?.(command, error);
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
      try {
        // INSIDE the try, so the `finally` below covers it. A `SUBSCRIBE` that
        // outlives its `commandTimeout` still reaches Redis and can succeed
        // once the connection recovers — and this channel is named after the
        // requestId, so every failed request that subscribed outside this scope
        // left a subscription behind that nothing would ever remove. A stall
        // with retries would grow that set on both sides without bound (#271
        // review). Unsubscribing a channel that never got subscribed is a
        // no-op, so the cheap direction is the safe one.
        await subscribeClient.subscribe(replyChannel);

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
        // Cleanup, not part of the answer. This `UNSUBSCRIBE` runs on the very
        // connection whose trouble is the likeliest reason we are here, and
        // letting it reject would replace a well-formed result — including the
        // `command_timeout` one produced two lines up — with a Redis error, so
        // the one path that already handles a dead target would start throwing
        // instead. Unreachable before #271 gave this connection a
        // `commandTimeout`; reachable now, which is the point of writing it
        // down rather than discovering it.
        await subscribeClient.unsubscribe(replyChannel).catch(() => undefined);
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
      await quitAllWithin<AdminCommandBusClientRole>(
        [
          { role: "publisher", connection: publishClient },
          { role: "subscriber", connection: subscribeClient },
        ],
        closeQuitTimeoutMs,
        options.onCloseUnfinished,
      );
    },
  };
}
