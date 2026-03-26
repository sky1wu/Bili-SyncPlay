import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import type { AdminRole, AdminSession } from "./admin/types.js";
import type { AdminSessionStore } from "./admin-session-store.js";

const DEFAULT_ADMIN_SESSION_KEY_PREFIX = "bsp:admin:session:";

function sessionKey(prefix: string, tokenId: string): string {
  return `${prefix}${tokenId}`;
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRole(value: string | undefined): AdminRole | null {
  return value === "viewer" || value === "operator" || value === "admin"
    ? value
    : null;
}

function hashTokenId(sessionSecret: string, token: string): string {
  return createHash("sha256")
    .update(sessionSecret)
    .update(":")
    .update(token)
    .digest("hex");
}

function cloneSession(session: AdminSession): AdminSession {
  return { ...session };
}

export function createAdminSessionTokenId(
  sessionSecret: string,
  token: string,
): string {
  return hashTokenId(sessionSecret, token);
}

export async function createRedisAdminSessionStore(
  redisUrl: string,
  options: {
    keyPrefix?: string;
    now?: () => number;
  } = {},
): Promise<AdminSessionStore & { close: () => Promise<void> }> {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const keyPrefix = options.keyPrefix ?? DEFAULT_ADMIN_SESSION_KEY_PREFIX;
  const now = options.now ?? Date.now;

  await redis.connect();

  return {
    async save(tokenId, session) {
      const ttlMs = session.expiresAt - now();
      const key = sessionKey(keyPrefix, tokenId);

      if (ttlMs <= 0) {
        await redis.del(key);
        return;
      }

      await redis
        .multi()
        .hset(key, {
          id: session.id,
          adminId: session.adminId,
          username: session.username,
          role: session.role,
          createdAt: String(session.createdAt),
          expiresAt: String(session.expiresAt),
          lastSeenAt: String(session.lastSeenAt),
        })
        .pexpire(key, ttlMs)
        .exec();
    },
    async get(tokenId) {
      const raw = await redis.hgetall(sessionKey(keyPrefix, tokenId));
      if (Object.keys(raw).length === 0) {
        return null;
      }

      const createdAt = parseTimestamp(raw.createdAt);
      const expiresAt = parseTimestamp(raw.expiresAt);
      const lastSeenAt = parseTimestamp(raw.lastSeenAt);
      const role = parseRole(raw.role);
      if (
        !raw.id ||
        !raw.adminId ||
        !raw.username ||
        createdAt === null ||
        expiresAt === null ||
        lastSeenAt === null ||
        role === null
      ) {
        return null;
      }

      if (expiresAt <= now()) {
        await redis.del(sessionKey(keyPrefix, tokenId));
        return null;
      }

      return cloneSession({
        id: raw.id,
        adminId: raw.adminId,
        username: raw.username,
        role,
        createdAt,
        expiresAt,
        lastSeenAt,
      });
    },
    async delete(tokenId) {
      await redis.del(sessionKey(keyPrefix, tokenId));
    },
    async close() {
      await redis.quit();
    },
  };
}
