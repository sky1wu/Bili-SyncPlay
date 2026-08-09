import { createBoundedRedisClient } from "./redis-command-timeout.js";
import type { ClosableRedisConnection } from "./redis-graceful-close.js";

export type RedisMessageListener = (channel: string, payload: string) => void;

/** The Redis surface shared by both pub/sub-backed buses. */
export type RedisPubSubClient = ClosableRedisConnection & {
  connect: () => Promise<unknown>;
  publish: (channel: string, payload: string) => Promise<unknown>;
  subscribe: (...channels: string[]) => Promise<unknown>;
  unsubscribe: (...channels: string[]) => Promise<unknown>;
  on: {
    (event: "message", listener: RedisMessageListener): unknown;
    (event: "error", listener: (error: unknown) => void): unknown;
  };
  off: (event: "message", listener: RedisMessageListener) => unknown;
};

export type RedisPubSubClientPair = {
  publisher: RedisPubSubClient;
  subscriber: RedisPubSubClient;
};

/** Keep the two buses' ioredis connection policy in one place. */
export function createRedisPubSubClientPair(
  redisUrl: string,
): RedisPubSubClientPair {
  // Four connections — both buses' publisher and subscriber — and none of them
  // had any bound before #271. Every command here is request/response and
  // small: `PUBLISH` on the room broadcast path, `SUBSCRIBE` / `UNSUBSCRIBE`
  // around a request or a consumer's lifetime. Neither bus has a caller-side
  // deadline on those: the admin command bus times out the REPLY it waits for,
  // which is a different promise from the `SUBSCRIBE` that precedes it and the
  // `UNSUBSCRIBE` in its `finally`.
  const createClient = () =>
    createBoundedRedisClient(redisUrl, {
      bound: "command_timeout",
    }) as RedisPubSubClient;
  return {
    publisher: createClient(),
    subscriber: createClient(),
  };
}
