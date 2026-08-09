import { performance } from "node:perf_hooks";
import type { MetricsCollector } from "./admin/metrics.js";
import { connectWithin } from "./redis-command-timeout.js";
import { quitAllWithin, type RedisQuitReport } from "./redis-graceful-close.js";
import {
  createRedisPubSubClientPair,
  type RedisPubSubClientPair,
} from "./redis-pubsub-client.js";
import type { RoomEventBus, RoomEventBusMessage } from "./room-event-bus.js";

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
    onConnectionError?: (
      role: "publisher" | "subscriber",
      error: unknown,
    ) => void;
    onInvalidMessage?: (payload: string) => void;
    onHandlerError?: (message: RoomEventBusMessage, error: unknown) => void;
    closeQuitTimeoutMs?: number;
    onCloseUnfinished?: (info: RedisQuitReport<RoomEventBusClientRole>) => void;
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
    // Exempt: `pending-resync-queue` keeps at most one publish per room out at
    // a time, and it learns that the previous one is still out there only by
    // its silence. A backstop would settle it and turn "one publish, retried
    // when it answers" into one publish per retry (#242, #271).
    createRedisPubSubClientPair(redisUrl, {
      bound: "caller",
      boundedBy:
        "pending-resync-queue's capAttempt and its in-flight wait; the room event consumer's own handling",
    });
  const closeQuitTimeoutMs =
    options.closeQuitTimeoutMs ?? CLOSE_QUIT_TIMEOUT_MS;
  const channel = options.channel ?? DEFAULT_ROOM_EVENT_CHANNEL;
  const subscribers = new Map<
    (message: RoomEventBusMessage) => Promise<void> | void,
    (incomingChannel: string, payload: string) => void
  >();
  let subscribed = false;
  let closing = false;

  publishClient.on("error", (error) => {
    options.onConnectionError?.("publisher", error);
  });
  subscribeClient.on("error", (error) => {
    options.onConnectionError?.("subscriber", error);
  });

  // The exemption is about commands; the handshake is not one of them and has
  // no bound of its own without a `commandTimeout` (#271 review).
  await Promise.all([
    connectWithin(publishClient),
    connectWithin(subscribeClient),
  ]);

  async function ensureSubscription(): Promise<void> {
    if (!subscribed) {
      await subscribeClient.subscribe(channel);
      subscribed = true;
    }
  }

  async function releaseSubscription(): Promise<void> {
    if (subscribed && subscribers.size === 0) {
      await subscribeClient.unsubscribe(channel);
      subscribed = false;
    }
  }

  return {
    async publish(message) {
      if (closing) {
        return;
      }

      const startedAt = performance.now();
      try {
        await publishClient.publish(channel, JSON.stringify(message));
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

      await ensureSubscription();

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

      subscribers.set(handler, listener);
      subscribeClient.on("message", listener);

      return async () => {
        const activeListener = subscribers.get(handler);
        if (!activeListener) {
          return;
        }

        subscribers.delete(handler);
        subscribeClient.off("message", activeListener);
        await releaseSubscription();
      };
    },
    async close() {
      closing = true;
      for (const listener of subscribers.values()) {
        subscribeClient.off("message", listener);
      }
      subscribers.clear();
      // Reset with the set it belongs to. `releaseSubscription`'s precondition
      // is `subscribed && subscribers.size === 0`, so leaving this true makes
      // that condition permanently satisfied — harmless only for as long as the
      // `closing` guard happens to cover every caller, which is exactly the
      // kind of "no state left behind" cleanup this repo asks to grep for
      // (#270 review).
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
