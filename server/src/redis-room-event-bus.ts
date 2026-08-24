import { performance } from "node:perf_hooks";
import type { MetricsCollector } from "./admin/metrics.js";
import {
  connectWithin,
  createRedisCommandAdmission,
  REDIS_CONNECT_TIMEOUT_MS,
  startWithin,
} from "./redis-command-timeout.js";
import { quitAllWithin, type RedisQuitReport } from "./redis-graceful-close.js";
import {
  createRedisPubSubClientPair,
  type RedisPubSubClientPair,
} from "./redis-pubsub-client.js";
import type { RoomEventBus, RoomEventBusMessage } from "./room-event-bus.js";
import type { LogEvent } from "./types.js";

const DEFAULT_ROOM_EVENT_CHANNEL = "bsp:room-events";

/** Both clients close concurrently inside this facility's default 5s step. */
const CLOSE_QUIT_TIMEOUT_MS = 4_000;
type RoomEventBusClientRole = "publisher" | "subscriber";

function parseMessage(payload: string): RoomEventBusMessage | null {
  try {
    const parsed = JSON.parse(payload) as Partial<RoomEventBusMessage>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.type !== "string" ||
      typeof parsed.roomCode !== "string" ||
      typeof parsed.sourceInstanceId !== "string" ||
      typeof parsed.emittedAt !== "number"
    ) {
      return null;
    }

    if (
      parsed.type !== "room_state_updated" &&
      parsed.type !== "room_member_changed" &&
      parsed.type !== "room_member_joined" &&
      parsed.type !== "room_member_left" &&
      parsed.type !== "room_deleted"
    ) {
      return null;
    }

    if (
      parsed.type === "room_member_joined" ||
      parsed.type === "room_member_left"
    ) {
      if (
        typeof parsed.memberId !== "string" ||
        typeof parsed.displayName !== "string"
      ) {
        return null;
      }
      return {
        type: parsed.type,
        roomCode: parsed.roomCode,
        sourceInstanceId: parsed.sourceInstanceId,
        emittedAt: parsed.emittedAt,
        memberId: parsed.memberId,
        displayName: parsed.displayName,
      };
    }

    return {
      type: parsed.type,
      roomCode: parsed.roomCode,
      sourceInstanceId: parsed.sourceInstanceId,
      emittedAt: parsed.emittedAt,
    };
  } catch {
    return null;
  }
}

export async function createRedisRoomEventBus(
  redisUrl: string,
  options: {
    channel?: string;
    onInvalidMessage?: (payload: string) => void;
    onHandlerError?: (message: RoomEventBusMessage, error: unknown) => void;
    /** Commands admitted here keep their slot until the real Redis reply. */
    maxPendingPublishCommands?: number;
    /** Bounds the first SUBSCRIBE that bootstrap waits for. */
    subscriptionTimeoutMs?: number;
    closeQuitTimeoutMs?: number;
    onCloseUnfinished?: (info: RedisQuitReport<RoomEventBusClientRole>) => void;
    /**
     * Where this store's own connection reports socket-level failures.
     *
     * Only used when this store opens its own connection; an injected
     * client carries whatever listener its creator attached (#280).
     */
    logEvent?: LogEvent;
    redisClients?: RedisPubSubClientPair;
    metricsCollector?: Pick<
      MetricsCollector,
      | "observeRedisRoomEventBusPublishDuration"
      | "observeRedisRoomEventBusPublishFailure"
    >;
  } = {},
): Promise<RoomEventBus & { close: () => Promise<void> }> {
  const { publisher: publishClient, subscriber: subscribeClient } =
    options.redisClients ??
    // Exempt: the publisher's admission holds a slot until the REAL Redis reply,
    // which preserves `pending-resync-queue`'s use of silence as evidence. The
    // subscriber's startup SUBSCRIBE has its own `startWithin` deadline. A
    // connection backstop would instead settle the publisher and turn "one
    // publish, retried when it answers" into one publish per timeout (#242,
    // #271 review).
    createRedisPubSubClientPair(
      redisUrl,
      {
        bound: "caller",
        boundedBy:
          "room-event publish admission tracks real replies; startWithin bounds the initial SUBSCRIBE",
      },
      { component: "room_event_bus", logEvent: options.logEvent },
    );
  const closeQuitTimeoutMs =
    options.closeQuitTimeoutMs ?? CLOSE_QUIT_TIMEOUT_MS;
  const channel = options.channel ?? DEFAULT_ROOM_EVENT_CHANNEL;
  const publishAdmission = createRedisCommandAdmission(
    options.maxPendingPublishCommands,
  );
  const subscriptionTimeoutMs =
    options.subscriptionTimeoutMs ?? REDIS_CONNECT_TIMEOUT_MS;
  const subscribers = new Map<
    (message: RoomEventBusMessage) => Promise<void> | void,
    (incomingChannel: string, payload: string) => void
  >();
  let subscribed = false;
  let subscriptionOperation: Promise<void> | null = null;
  let closing = false;

  // The exemption is about commands; the handshake is not one of them and has
  // no bound of its own without a `commandTimeout` (#271 review).
  await Promise.all([
    connectWithin(publishClient),
    connectWithin(subscribeClient),
  ]);

  /**
   * Drives the connection's subscription to the desired state, then reports
   * whether the caller's intent was met.
   *
   * A close that lands while a command is awaiting its ACK is the opposite
   * answer for the two intents, which is why this takes one:
   *
   * - `subscribe` did NOT happen — `close` clears `subscribed` and refuses to
   *   let a late SUBSCRIBE set it, so the caller must not be told it has a
   *   subscription. It throws.
   * - `unsubscribe` DID happen. `close` removes every listener, clears
   *   `subscribers`, and resets `subscribed` itself, so "stop delivering to me"
   *   is already true by the time the loop notices `closing`. Reporting that as
   *   a failure rejects a promise for work that completed — and consumers'
   *   fire-and-forget unsubscribes turn it into an unhandled rejection.
   */
  async function reconcileSubscription(
    intent: "subscribe" | "unsubscribe",
  ): Promise<void> {
    while (!closing) {
      let operation = subscriptionOperation;
      if (!operation) {
        const subscriptionDesired = subscribers.size > 0;
        if (subscriptionDesired === subscribed) {
          return;
        }
        operation = subscriptionDesired
          ? startWithin(
              subscribeClient,
              "room event bus SUBSCRIBE",
              () => subscribeClient.subscribe(channel),
              subscriptionTimeoutMs,
            ).then(() => {
              if (!closing) {
                subscribed = true;
              }
            })
          : subscribeClient.unsubscribe(channel).then(() => {
              subscribed = false;
            });
        subscriptionOperation = operation;
      }
      try {
        await operation;
      } catch (error) {
        // `close` can settle an in-flight command by REJECTION, not just by
        // flipping `closing`: `quitAllWithin` falls back to `disconnect()`,
        // which fails everything still on the socket. For an unsubscribe that
        // is still success — the listener is off, `subscribers` is cleared, and
        // the connection is gone, so nothing can be delivered — and rejecting
        // it here would revive exactly the unhandled rejection this intent
        // exists to prevent. A failure that arrives BEFORE the close is a real
        // one and stays the caller's answer.
        if (closing && intent === "unsubscribe") {
          return;
        }
        throw error;
      } finally {
        if (subscriptionOperation === operation) {
          subscriptionOperation = null;
        }
      }
      // Desired state may have changed while the command was awaiting its ACK.
      // Re-read both sides before allowing the caller to observe completion.
    }
    if (intent === "unsubscribe") {
      return;
    }
    throw new Error("Room event bus closed while changing its subscription.");
  }

  async function removeSubscriber(
    handler: (message: RoomEventBusMessage) => Promise<void> | void,
    listener: (incomingChannel: string, payload: string) => void,
  ): Promise<void> {
    if (subscribers.get(handler) !== listener) {
      return;
    }
    subscribers.delete(handler);
    subscribeClient.off("message", listener);
    await reconcileSubscription("unsubscribe");
  }

  return {
    async publish(message) {
      if (closing) {
        return;
      }

      const startedAt = performance.now();
      try {
        await publishAdmission.run(() =>
          publishClient.publish(channel, JSON.stringify(message)),
        );
      } catch (error) {
        options.metricsCollector?.observeRedisRoomEventBusPublishFailure();
        throw error;
      } finally {
        options.metricsCollector?.observeRedisRoomEventBusPublishDuration(
          performance.now() - startedAt,
        );
      }
    },
    async subscribe(handler) {
      if (closing) {
        return async () => {};
      }
      if (subscribers.has(handler)) {
        throw new Error("Room event handler is already subscribed.");
      }

      const listener = (incomingChannel: string, payload: string) => {
        if (incomingChannel !== channel) {
          return;
        }

        const message = parseMessage(payload);
        if (!message) {
          options.onInvalidMessage?.(payload);
          return;
        }

        // Promise.resolve(handler(...)) would let a synchronous throw escape
        // the ioredis "message" listener as an uncaught exception; .then()
        // defers the call so sync and async failures both reach the callback.
        void Promise.resolve()
          .then(() => handler(message))
          .catch((error: unknown) => {
            options.onHandlerError?.(message, error);
          });
      };

      // Install the desired handler before SUBSCRIBE. ioredis can dispatch a
      // message that follows the ACK in the same socket read before the awaited
      // continuation runs; registering afterwards silently loses that first
      // room event.
      subscribers.set(handler, listener);
      subscribeClient.on("message", listener);
      try {
        await reconcileSubscription("subscribe");
      } catch (error) {
        if (subscribers.get(handler) === listener) {
          subscribers.delete(handler);
          subscribeClient.off("message", listener);
        }
        throw error;
      }

      return () => removeSubscriber(handler, listener);
    },
    async close() {
      closing = true;
      for (const listener of subscribers.values()) {
        subscribeClient.off("message", listener);
      }
      subscribers.clear();
      // Reset with the desired set and serialized operation it belongs to.
      // `reconcileSubscription` exits on `closing`, so no late operation may
      // make this closed bus observable as subscribed again (#270 review).
      subscribed = false;
      // `QUIT` ends subscriber mode too. Do not queue another `UNSUBSCRIBE`
      // here: an earlier consumer unsubscribe can already be stuck on this
      // socket, and awaiting a second one would make the bounded QUIT and its
      // forced-disconnect fallback unreachable (#270 review).
      await quitAllWithin<RoomEventBusClientRole>(
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
