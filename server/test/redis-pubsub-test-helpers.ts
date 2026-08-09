import type { RedisPubSubClient } from "../src/redis-pubsub-client.js";

export function createFakeRedisPubSubClient(quit: () => Promise<unknown>): {
  client: RedisPubSubClient;
  disconnectCalls: () => number;
} {
  let disconnectCalls = 0;
  return {
    client: {
      connect: async () => undefined,
      quit,
      disconnect: () => {
        disconnectCalls += 1;
      },
      publish: async () => 1,
      subscribe: async () => 1,
      unsubscribe: async () => 1,
      on: () => undefined,
      off: () => undefined,
    },
    disconnectCalls: () => disconnectCalls,
  };
}
