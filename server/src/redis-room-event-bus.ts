import { Redis } from "ioredis";
import { performance } from "node:perf_hooks";
import type { MetricsCollector } from "./admin/metrics.js";
import type { RoomEventBus, RoomEventBusMessage } from "./room-event-bus.js";

const DEFAULT_ROOM_EVENT_CHANNEL = "bsp:room-events";

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
      parsed.type !== "room_deleted"
    ) {
      return null;
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
    metricsCollector?: Pick<
      MetricsCollector,
      | "observeRedisRoomEventBusPublishDuration"
      | "observeRedisRoomEventBusPublishFailure"
    >;
  } = {},
): Promise<RoomEventBus & { close: () => Promise<void> }> {
  const publishClient = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const subscribeClient = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
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

  await Promise.all([publishClient.connect(), subscribeClient.connect()]);

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

        void Promise.resolve(handler(message)).catch((error: unknown) => {
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
      if (subscribed) {
        await subscribeClient.unsubscribe(channel);
      }
      await Promise.all([publishClient.quit(), subscribeClient.quit()]);
    },
  };
}
