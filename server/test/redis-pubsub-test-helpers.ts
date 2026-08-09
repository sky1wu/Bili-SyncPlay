import type { RedisPubSubClient } from "../src/redis-pubsub-client.js";

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
} {
  let disconnectCalls = 0;
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
      on: () => undefined,
      off: () => undefined,
    },
    disconnectCalls: () => disconnectCalls,
  };
}
