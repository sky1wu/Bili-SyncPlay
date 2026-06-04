import { Redis } from "ioredis";
import {
  type IpBlockAddResult,
  type IpBlockRecord,
  type IpBlockStore,
} from "./ip-block-store.js";
import { normalizeIpAddress } from "../ip-address.js";

type RedisLike = Pick<
  Redis,
  "connect" | "quit" | "hget" | "hset" | "hdel" | "hgetall"
>;

export async function createRedisIpBlockStore(
  redisUrl: string,
  options: {
    keyPrefix: string;
    redisClient?: RedisLike;
  },
): Promise<IpBlockStore & { close: () => Promise<void> }> {
  const redis =
    options.redisClient ??
    new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  const ownsRedis = !options.redisClient;
  const key = `${options.keyPrefix}records`;
  if (ownsRedis) {
    await redis.connect();
  }

  function encode(record: IpBlockRecord): string {
    return JSON.stringify(record);
  }

  function decode(value: string | null): IpBlockRecord | null {
    if (!value) {
      return null;
    }
    try {
      const parsed = JSON.parse(value) as IpBlockRecord;
      return parsed.ip && typeof parsed.createdAt === "number" ? parsed : null;
    } catch {
      return null;
    }
  }

  async function get(ip: string): Promise<IpBlockRecord | null> {
    const normalizedIp = normalizeIpAddress(ip);
    if (!normalizedIp) {
      return null;
    }
    return decode(await redis.hget(key, normalizedIp));
  }

  return {
    async add(record): Promise<IpBlockAddResult> {
      const normalizedIp = normalizeIpAddress(record.ip);
      if (!normalizedIp) {
        throw new Error("invalid_ip");
      }
      const existing = await get(normalizedIp);
      if (existing) {
        return { record: existing, created: false };
      }
      const saved = { ...record, ip: normalizedIp };
      await redis.hset(key, normalizedIp, encode(saved));
      return { record: saved, created: true };
    },
    async list() {
      const raw = await redis.hgetall(key);
      return Object.values(raw)
        .map(decode)
        .filter((record): record is IpBlockRecord => record !== null)
        .sort((left, right) => left.createdAt - right.createdAt);
    },
    get,
    async has(ip) {
      return (await get(ip)) !== null;
    },
    async delete(ip) {
      const normalizedIp = normalizeIpAddress(ip);
      if (!normalizedIp) {
        return false;
      }
      return (await redis.hdel(key, normalizedIp)) > 0;
    },
    async close() {
      if (ownsRedis) {
        await redis.quit();
      }
    },
  };
}
