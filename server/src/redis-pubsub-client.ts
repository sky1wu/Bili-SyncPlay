import {
  createBoundedRedisClient,
  type RedisCommandBound,
} from "./redis-command-timeout.js";
import type { ClosableRedisConnection } from "./redis-graceful-close.js";

export type RedisMessageListener = (channel: string, payload: string) => void;
export type RedisReadyListener = () => void;

/** The Redis surface shared by both pub/sub-backed buses. */
export type RedisPubSubClient = Omit<ClosableRedisConnection, "disconnect"> & {
  disconnect: (reconnect?: boolean) => void;
  connect: () => Promise<unknown>;
  publish: (channel: string, payload: string) => Promise<unknown>;
  subscribe: (...channels: string[]) => Promise<unknown>;
  unsubscribe: (...channels: string[]) => Promise<unknown>;
  on: {
    (event: "message", listener: RedisMessageListener): unknown;
    (event: "error", listener: (error: unknown) => void): unknown;
    (event: "ready", listener: RedisReadyListener): unknown;
  };
  off: {
    (event: "message", listener: RedisMessageListener): unknown;
    (event: "ready", listener: RedisReadyListener): unknown;
  };
};

export type RedisPubSubClientPair = {
  publisher: RedisPubSubClient;
  subscriber: RedisPubSubClient;
};

/**
 * Keep the two buses' ioredis connection policy in one place.
 *
 * The two buses do NOT get the same answer, which is why this takes a bound
 * rather than choosing one (#271):
 *
 * - The **admin command bus** may take the backstop. Nothing on it derives a
 *   bound from a command's silence — `request` times out the REPLY on a
 *   `setTimeout`, which is a different promise from the `SUBSCRIBE` before it
 *   and the `UNSUBSCRIBE` after.
 * - The **room event bus** may not. Its publisher admission and
 *   `pending-resync-queue` both hold state until the REAL publish answers. A
 *   backstop would settle that promise and turn the bound into one publish per
 *   timeout, for as long as the bus stays hung — the exact defect #242 wrote
 *   that loop to fix. Its separate subscriber connection instead bounds the
 *   initial `SUBSCRIBE` with `startWithin`, so startup does not inherit the
 *   publisher's deliberate wait.
 */
export function createRedisPubSubClientPair(
  redisUrl: string,
  bound: RedisCommandBound,
): RedisPubSubClientPair {
  const createClient = () =>
    createBoundedRedisClient(redisUrl, bound) as RedisPubSubClient;
  return {
    publisher: createClient(),
    subscriber: createClient(),
  };
}
