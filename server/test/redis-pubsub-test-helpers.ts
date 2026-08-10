import type {
  RedisMessageListener,
  RedisPubSubClient,
  RedisReadyListener,
} from "../src/redis-pubsub-client.js";

/**
 * Overrides for the commands a bus issues on a pub/sub connection.
 *
 * Rejection is one shape a stalled connection may take: #271 gave the admin
 * command bus a `commandTimeout`, while the caller-bounded room-event bus keeps
 * selected commands pending so its own admission/deadline tests can model the
 * real ioredis queue.
 */
export type FakeRedisPubSubCommands = Partial<
  Pick<RedisPubSubClient, "publish" | "subscribe" | "unsubscribe">
> & {
  disconnect?: (reconnect?: boolean) => void;
};

export function createFakeRedisPubSubClient(
  quit: () => Promise<unknown>,
  commands: FakeRedisPubSubCommands = {},
): {
  client: RedisPubSubClient;
  disconnectCalls: () => number;
  messageListenerCount: () => number;
  /** Deliver a message to every registered listener, as ioredis would. */
  emitMessage: (channel: string, payload: string) => void;
  /** Announce a reconnect reaching ready. */
  emitReady: () => void;
} {
  let disconnectCalls = 0;
  const messageListeners = new Set<RedisMessageListener>();
  const readyListeners = new Set<RedisReadyListener>();
  return {
    client: {
      connect: async () => undefined,
      quit,
      disconnect: (reconnect?: boolean) => {
        disconnectCalls += 1;
        commands.disconnect?.(reconnect);
      },
      publish: commands.publish ?? (async () => 1),
      subscribe: commands.subscribe ?? (async () => 1),
      unsubscribe: commands.unsubscribe ?? (async () => 1),
      on: (event: string, listener: unknown) => {
        if (event === "message") {
          messageListeners.add(listener as RedisMessageListener);
        } else if (event === "ready") {
          readyListeners.add(listener as RedisReadyListener);
        }
        return undefined;
      },
      off: (event: string, listener: unknown) => {
        if (event === "message") {
          messageListeners.delete(listener as RedisMessageListener);
        } else if (event === "ready") {
          readyListeners.delete(listener as RedisReadyListener);
        }
        return undefined;
      },
    },
    disconnectCalls: () => disconnectCalls,
    messageListenerCount: () => messageListeners.size,
    emitMessage: (channel, payload) => {
      for (const listener of [...messageListeners]) {
        listener(channel, payload);
      }
    },
    emitReady: () => {
      for (const listener of [...readyListeners]) {
        listener();
      }
    },
  };
}
