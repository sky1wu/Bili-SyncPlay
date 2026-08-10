import {
  DEFAULT_ADMIN_COMMAND_MAX_ACTIVE_REQUESTS,
  type AdminCommand,
  type AdminCommandBus,
  type AdminCommandResult,
} from "./admin-command-bus.js";
import { quitAllWithin, type RedisQuitReport } from "./redis-graceful-close.js";
import {
  createRedisCommandAdmission,
  createStalledConnectionGuard,
  DEFAULT_REDIS_COMMAND_ADMISSION_LIMIT,
  RedisCommandAdmissionError,
} from "./redis-command-timeout.js";
import {
  createRedisPubSubClientPair,
  type RedisPubSubClientPair,
} from "./redis-pubsub-client.js";
import { createRetryPacer } from "./retry-pacer.js";

const DEFAULT_COMMAND_CHANNEL_PREFIX = "bsp:admin-command:";
const DEFAULT_RESULT_CHANNEL_PREFIX = "bsp:admin-command-result:";

/** Both clients close concurrently inside this facility's default 5s step. */
const CLOSE_QUIT_TIMEOUT_MS = 4_000;
const SUBSCRIPTION_RESTORE_INITIAL_RETRY_DELAY_MS = 250;
const SUBSCRIPTION_RESTORE_MAX_RETRY_DELAY_MS = 30_000;
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
    /**
     * A command this bus issued on its OWN connection failed — the reply
     * channel `SUBSCRIBE`, the command `PUBLISH`, or the cleanup.
     *
     * Separate from {@link onResultPublishFailed}, which is the executor side.
     */
    onBusCommandFailed?: (info: {
      operation: "subscribe" | "publish" | "unsubscribe" | "publish_result";
      error: unknown;
    }) => void;
    /**
     * Injectable so a publisher test does not have to spend three failures.
     * One subscription-state failure marks its generation for reset: the
     * server-side effect is unknown until a fresh connection rebuilds the
     * desired set. Reset waits only for already-active replies.
     */
    stallDropThreshold?: number;
    /** Bounds reply subscriptions and request closures within one timeout. */
    maxActiveRequests?: number;
    /** Bounds commands awaiting an answer on either Redis connection. */
    maxPendingCommandsPerConnection?: number;
    /** Injectable so restore-backoff tests do not wait in wall-clock time. */
    subscriptionRestoreSleep?: (delayMs: number) => Promise<void>;
    /** The bus dropped a socket and ioredis is reconnecting. */
    onConnectionDropped?: (info: {
      role: AdminCommandBusClientRole;
      consecutiveFailures: number;
    }) => void;
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
  const maxActiveRequests =
    options.maxActiveRequests ?? DEFAULT_ADMIN_COMMAND_MAX_ACTIVE_REQUESTS;
  const maxPendingCommandsPerConnection =
    options.maxPendingCommandsPerConnection ??
    DEFAULT_REDIS_COMMAND_ADMISSION_LIMIT;
  const publisherAdmission = createRedisCommandAdmission(
    maxPendingCommandsPerConnection,
  );
  const subscriberAdmission = createRedisCommandAdmission(
    maxPendingCommandsPerConnection,
  );
  const handlers = new Map<
    string,
    (command: AdminCommand) => Promise<AdminCommandResult>
  >();
  const activeReplyChannels = new Set<string>();
  let closing = false;
  let subscriberGeneration = 0;
  let subscriberResetOwed = false;
  let subscriberResetInProgress = false;
  let subscriberResetFailures = 0;
  let subscriberRestoring = false;
  let subscriptionRestoreFailures = 0;
  const subscriptionRestorePacer = createRetryPacer({
    initialDelayMs: SUBSCRIPTION_RESTORE_INITIAL_RETRY_DELAY_MS,
    maxDelayMs: SUBSCRIPTION_RESTORE_MAX_RETRY_DELAY_MS,
    sleep: options.subscriptionRestoreSleep,
  });
  // Per-connection command admission bounds the first timeout window, and the
  // active-reply cap also bounds result subscriptions and request closures.
  // The centralized client policy disables replay, so reset retires the small
  // timed-out tail instead of carrying it across reconnects (#271 review).
  const publisherGuard = createStalledConnectionGuard(publishClient, {
    threshold: options.stallDropThreshold,
    onDropped: ({ consecutiveFailures }) =>
      options.onConnectionDropped?.({
        role: "publisher",
        consecutiveFailures,
      }),
  });

  /**
   * Run one of this bus's OWN commands, reporting and counting it.
   *
   * The result of a failure is never a bare rejection out of `request`: the
   * admin router has no branch for one, so it would answer a Redis outage with
   * an undiagnosed 500 — the outcome the whole bounded-but-not-silent rule
   * exists to refuse (#271 review).
   */
  async function runBusCommand<T>(
    operation: "subscribe" | "publish" | "unsubscribe" | "publish_result",
    call: () => Promise<T>,
  ): Promise<T> {
    const attempt = publisherGuard.beginAttempt();
    if (!attempt) {
      throw new Error("Redis publisher is reconnecting.");
    }
    try {
      const result = await publisherAdmission.run(call);
      attempt.recordSuccess();
      return result;
    } catch (error) {
      if (!(error instanceof RedisCommandAdmissionError)) {
        attempt.recordFailure();
        options.onBusCommandFailed?.({ operation, error });
      }
      throw error;
    }
  }

  function maybeResetSubscriber(): void {
    if (
      closing ||
      subscriberResetInProgress ||
      !subscriberResetOwed ||
      activeReplyChannels.size > 0
    ) {
      return;
    }
    // Keep `subscriberResetOwed` set until the next ready event. New requests
    // must not publish while this generation's subscription state is unknown.
    subscriberResetInProgress = true;
    const resetGeneration = subscriberGeneration;
    try {
      subscribeClient.disconnect(true);
    } catch {
      subscriberResetFailures += 1;
      void subscriptionRestorePacer
        .wait(subscriptionRestorePacer.delayFor(subscriberResetFailures))
        .then(() => {
          if (
            closing ||
            subscriptionRestorePacer.stopped() ||
            resetGeneration !== subscriberGeneration ||
            !subscriberResetOwed
          ) {
            return;
          }
          // Keep the failed drop single-flight while waiting. Old state-command
          // failures can otherwise start parallel reset trails, and a ready
          // event can make this retry stale before its backoff expires.
          subscriberResetInProgress = false;
          maybeResetSubscriber();
        });
      return;
    }
    subscriberResetFailures = 0;
    options.onConnectionDropped?.({
      role: "subscriber",
      consecutiveFailures: 1,
    });
  }

  function markSubscriberStateUnknown(submittedGeneration: number): void {
    // A timeout from a command submitted on an old socket can land after a new
    // connection is already healthy. It describes that old generation and must
    // never be allowed to tear down the new one.
    if (
      closing ||
      submittedGeneration !== subscriberGeneration ||
      subscriberResetInProgress
    ) {
      return;
    }
    subscriberResetOwed = true;
    maybeResetSubscriber();
  }

  async function runSubscriptionStateCommand<T>(
    operation: "subscribe" | "unsubscribe",
    call: () => Promise<T>,
    beforeReset?: () => void,
  ): Promise<T> {
    const submittedGeneration = subscriberGeneration;
    try {
      return await subscriberAdmission.run(call);
    } catch (error) {
      // Admission refuses before the command reaches ioredis. A refused
      // SUBSCRIBE changes nothing (durable restore retries below), while a
      // refused cleanup UNSUBSCRIBE still owes reconciliation because its
      // caller already removed that channel from desired state.
      if (error instanceof RedisCommandAdmissionError) {
        if (operation === "unsubscribe") {
          // The caller removes the channel from desired state before cleanup.
          // A refused UNSUBSCRIBE therefore leaves a known stale subscription
          // on Redis even though this command itself was never submitted. Keep
          // the reset trail that reconciles that mismatch.
          beforeReset?.();
          markSubscriberStateUnknown(submittedGeneration);
        }
        throw error;
      }
      beforeReset?.();
      markSubscriberStateUnknown(submittedGeneration);
      options.onBusCommandFailed?.({ operation, error });
      throw error;
    }
  }

  async function attemptRestoreDesiredSubscriptions(
    restoreGeneration: number,
  ): Promise<void> {
    if (subscriptionRestoreFailures > 0) {
      await subscriptionRestorePacer.wait(
        subscriptionRestorePacer.delayFor(subscriptionRestoreFailures),
      );
    }
    if (
      closing ||
      subscriptionRestorePacer.stopped() ||
      restoreGeneration !== subscriberGeneration
    ) {
      return;
    }
    const channels = Array.from(
      new Set([
        ...[...handlers.keys()].map((instanceId) =>
          commandChannel(commandChannelPrefix, instanceId),
        ),
        ...activeReplyChannels,
      ]),
    );
    if (channels.length === 0) {
      subscriberRestoring = false;
      subscriptionRestoreFailures = 0;
      return;
    }
    // Backstopped clients disable ioredis's indiscriminate auto-resubscribe:
    // it cannot tell active one-shot result channels from channels whose
    // cleanup timed out. These registries own the desired set.
    try {
      await runSubscriptionStateCommand(
        "subscribe",
        () => subscribeClient.subscribe(...channels),
        () => {
          if (restoreGeneration === subscriberGeneration) {
            subscriptionRestoreFailures += 1;
          }
        },
      );
    } catch (error) {
      if (
        error instanceof RedisCommandAdmissionError &&
        !closing &&
        restoreGeneration === subscriberGeneration
      ) {
        // No command reached Redis, so the connection remains healthy. Preserve
        // the restore barrier and retry after the command occupying admission
        // has had time to finish instead of manufacturing a reconnect.
        subscriptionRestoreFailures += 1;
        void attemptRestoreDesiredSubscriptions(restoreGeneration);
      }
      return;
    }
    if (restoreGeneration === subscriberGeneration) {
      subscriptionRestoreFailures = 0;
      subscriberRestoring = false;
    }
  }

  const restoreDesiredSubscriptions = () => {
    subscriberGeneration += 1;
    const restoreGeneration = subscriberGeneration;
    subscriberResetInProgress = false;
    subscriberResetFailures = 0;
    subscriberResetOwed = false;
    if (closing) {
      return;
    }
    if (handlers.size === 0 && activeReplyChannels.size === 0) {
      subscriberRestoring = false;
      subscriptionRestoreFailures = 0;
      return;
    }
    subscriberRestoring = true;
    void attemptRestoreDesiredSubscriptions(restoreGeneration);
  };
  subscribeClient.on("ready", restoreDesiredSubscriptions);

  function busUnavailable(
    command: AdminCommand,
    error: unknown,
  ): AdminCommandResult {
    return {
      requestId: command.requestId,
      targetInstanceId: command.targetInstanceId,
      executorInstanceId: command.targetInstanceId,
      status: "error",
      code: "command_bus_unavailable",
      message: `Admin command bus could not reach Redis: ${
        error instanceof Error ? error.message : String(error)
      }`,
      completedAt: Date.now(),
    };
  }

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
        await runBusCommand("publish_result", () =>
          publishClient.publish(
            resultChannel(resultChannelPrefix, command.requestId),
            JSON.stringify(result),
          ),
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
        await runBusCommand("publish_result", () =>
          publishClient.publish(
            resultChannel(resultChannelPrefix, command.requestId),
            JSON.stringify(fallback),
          ),
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
      if (
        subscriberRestoring ||
        subscriberResetOwed ||
        subscriberResetInProgress
      ) {
        return busUnavailable(
          command,
          new Error("Redis subscriber state is being restored."),
        );
      }
      if (activeReplyChannels.size >= maxActiveRequests) {
        return busUnavailable(
          command,
          new Error(
            `Admin command bus admission reached ${maxActiveRequests} active requests.`,
          ),
        );
      }
      const replyChannel = resultChannel(
        resultChannelPrefix,
        command.requestId,
      );
      if (activeReplyChannels.has(replyChannel)) {
        return {
          requestId: command.requestId,
          targetInstanceId: command.targetInstanceId,
          executorInstanceId: command.targetInstanceId,
          status: "error",
          code: "duplicate_request_id",
          message: `Admin command requestId ${command.requestId} is already in flight.`,
          completedAt: Date.now(),
        };
      }
      activeReplyChannels.add(replyChannel);
      const requestSubscriberGeneration = subscriberGeneration;
      let stopWaitingForReply: (() => void) | undefined;
      let replySubscriptionMayExist = false;
      try {
        // INSIDE the try, so the `finally` below covers it. A `SUBSCRIBE` that
        // outlives its `commandTimeout` still reaches Redis and can succeed
        // once the connection recovers — and this channel is named after the
        // requestId, so every failed request that subscribed outside this scope
        // left a subscription behind that nothing would ever remove. A stall
        // with retries would grow that set on both sides without bound (#271
        // review). Unsubscribing a channel that never got subscribed is a
        // no-op, so the cheap direction is the safe one.
        await runSubscriptionStateCommand("subscribe", () => {
          // Admission invokes this callback only after granting a slot. From
          // this point a rejection may still have reached Redis, so cleanup is
          // owed even when the SUBSCRIBE promise rejects.
          replySubscriptionMayExist = true;
          return subscribeClient.subscribe(replyChannel);
        });
        if (
          requestSubscriberGeneration !== subscriberGeneration ||
          subscriberRestoring ||
          subscriberResetOwed ||
          subscriberResetInProgress
        ) {
          throw new Error(
            "Redis subscriber changed before the reply channel was ready.",
          );
        }

        const responsePromise = new Promise<AdminCommandResult>((resolve) => {
          let settled = false;
          const finish = (result: AdminCommandResult) => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timeout);
            subscribeClient.off("message", onReply);
            resolve(result);
          };
          const timeout = setTimeout(() => {
            finish({
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
            finish(result);
          };

          stopWaitingForReply = () => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timeout);
            subscribeClient.off("message", onReply);
          };
          subscribeClient.on("message", onReply);
        });

        await runBusCommand("publish", () =>
          publishClient.publish(
            commandChannel(commandChannelPrefix, command.targetInstanceId),
            JSON.stringify(command),
          ),
        );

        return await responsePromise;
      } catch (error) {
        // A `status: "error"` result, not a rejection: `action-service` maps it
        // to a retryable 503 with this code and message, so an operator sees
        // "the bus could not reach Redis" instead of `internal_error` (#271
        // review).
        return busUnavailable(command, error);
      } finally {
        // A publish failure happens after the reply listener is installed. It
        // answers immediately with `command_bus_unavailable`, so leaving this
        // timer and closure alive until `timeoutMs` would let sequential retries
        // bypass the active-request cap.
        stopWaitingForReply?.();
        // Remove the channel from desired state before attempting the fallible
        // Redis cleanup. If UNSUBSCRIBE fails, the generation is marked for
        // reset; already-active replies finish before that reset, and `ready`
        // restores durable channels without resurrecting this completed one.
        activeReplyChannels.delete(replyChannel);
        maybeResetSubscriber();
        if (
          replySubscriptionMayExist &&
          !closing &&
          !subscriberResetOwed &&
          !subscriberResetInProgress
        ) {
          // Cleanup, not part of the answer. This `UNSUBSCRIBE` runs on the very
          // connection whose trouble is the likeliest reason we are here, and
          // letting it reject would replace a well-formed result — including
          // the `command_timeout` one produced two lines up — with a Redis
          // error, so the one path that already handles a dead target would
          // start throwing instead. Unreachable before #271 gave this
          // connection a `commandTimeout`; reachable now, which is the point of
          // writing it down rather than discovering it.
          await runSubscriptionStateCommand("unsubscribe", () =>
            subscribeClient.unsubscribe(replyChannel),
          ).catch(() => undefined);
        }
      }
    },
    async subscribe(instanceId, handler) {
      if (closing) {
        throw new Error("Admin command bus is closed.");
      }
      if (
        subscriberRestoring ||
        subscriberResetOwed ||
        subscriberResetInProgress
      ) {
        throw new Error("Redis subscriber state is being restored.");
      }
      if (handlers.has(instanceId)) {
        throw new Error(
          `Admin command handler for ${instanceId} is already registered.`,
        );
      }
      const channel = commandChannel(commandChannelPrefix, instanceId);
      const registrationGeneration = subscriberGeneration;
      // Register the desired durable state before asking Redis to subscribe.
      // ioredis can dispatch a message that follows the SUBSCRIBE ACK in the
      // same socket read before this promise's continuation runs; registering
      // afterwards silently drops that first command.
      handlers.set(instanceId, handler);
      try {
        await runSubscriptionStateCommand("subscribe", () =>
          subscribeClient.subscribe(channel),
        );
      } catch (error) {
        if (handlers.get(instanceId) === handler) {
          handlers.delete(instanceId);
        }
        maybeResetSubscriber();
        throw error;
      }
      if (
        closing ||
        registrationGeneration !== subscriberGeneration ||
        subscriberRestoring ||
        subscriberResetOwed ||
        subscriberResetInProgress
      ) {
        // `close()` clears the registry and closes the connection. Do not let a
        // subscription that was already awaiting its ACK resurrect a handler
        // after that lifecycle boundary. A generation change likewise means
        // the acknowledged operation no longer proves the current socket's
        // state.
        if (handlers.get(instanceId) === handler) {
          handlers.delete(instanceId);
        }
        if (!closing) {
          markSubscriberStateUnknown(subscriberGeneration);
        }
        throw new Error(
          closing
            ? "Admin command bus is closed."
            : "Redis subscriber changed before the command channel was ready.",
        );
      }
      return async () => {
        if (handlers.get(instanceId) !== handler) {
          return;
        }
        handlers.delete(instanceId);
        if (closing) {
          return;
        }
        if (subscriberResetOwed || subscriberResetInProgress) {
          maybeResetSubscriber();
          return;
        }
        await runSubscriptionStateCommand("unsubscribe", () =>
          subscribeClient.unsubscribe(channel),
        );
      };
    },
    async close() {
      closing = true;
      publisherGuard.close();
      subscriptionRestorePacer.stop();
      handlers.clear();
      activeReplyChannels.clear();
      subscribeClient.off("ready", restoreDesiredSubscriptions);
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
