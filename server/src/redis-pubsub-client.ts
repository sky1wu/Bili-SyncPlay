import { Redis } from "ioredis";
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
  const createClient = () =>
    new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    }) as RedisPubSubClient;
  return {
    publisher: createClient(),
    subscriber: createClient(),
  };
}
