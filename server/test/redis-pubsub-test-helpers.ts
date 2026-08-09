import type {
  RedisMessageListener,
  RedisPubSubClient,
} from "../src/redis-pubsub-client.js";

/**
 * Overrides for the commands a bus issues on a pub/sub connection.
 *
 * Rejection is the shape a stalled connection now takes: #271 gave both buses'
 * clients a `commandTimeout`, so `PUBLISH` / `SUBSCRIBE` / `UNSUBSCRIBE` answer
 * with an error instead of never answering at all.
 */
export type FakeRedisPubSubCommands = Partial<
  Pick<RedisPubSubClient, "publish" | "subscribe" | "unsubscribe">
>;

export function createFakeRedisPubSubClient(
  quit: () => Promise<unknown>,
  commands: FakeRedisPubSubCommands = {},
): {
  client: RedisPubSubClient;
  disconnectCalls: () => number;
  /** Deliver a message to every registered listener, as ioredis would. */
  emitMessage: (channel: string, payload: string) => void;
} {
  let disconnectCalls = 0;
  const messageListeners = new Set<RedisMessageListener>();
  return {
    client: {
      connect: async () => undefined,
      quit,
      disconnect: () => {
        disconnectCalls += 1;
      },
      publish: commands.publish ?? (async () => 1),
      subscribe: commands.subscribe ?? (async () => 1),
      unsubscribe: commands.unsubscribe ?? (async () => 1),
      on: (event: string, listener: unknown) => {
        if (event === "message") {
          messageListeners.add(listener as RedisMessageListener);
        }
        return undefined;
      },
      off: (event: "message", listener: RedisMessageListener) => {
        if (event === "message") {
          messageListeners.delete(listener);
        }
        return undefined;
      },
    },
    disconnectCalls: () => disconnectCalls,
    emitMessage: (channel, payload) => {
      for (const listener of [...messageListeners]) {
        listener(channel, payload);
      }
    },
  };
}
