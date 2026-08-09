import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import type { AdminRole, AdminSession } from "./admin/types.js";
import type { AdminSessionStore } from "./admin-session-store.js";
import { quitWithin, type RedisQuitOutcome } from "./redis-graceful-close.js";

const DEFAULT_ADMIN_SESSION_KEY_PREFIX = "bsp:admin:session:";

/**
 * How long `close` may wait for `QUIT`.
 *
 * This store shares the `close_admin_services` step with the audit store, whose
 * own bounded close can spend 3s, so 1s here keeps the pair inside the step's
 * default 5s budget with room to spare. It used to be unbounded, which meant a
 * hung Redis spent the entire budget here and the step reported a failed
 * shutdown before the audit store's close was even reached (#267).
 */
const CLOSE_QUIT_TIMEOUT_MS = 1_000;

export type RedisAdminSessionStoreMulti = {
  hset: (
    key: string,
    fields: Record<string, string>,
  ) => RedisAdminSessionStoreMulti;
  pexpire: (key: string, ttlMs: number) => RedisAdminSessionStoreMulti;
  exec: () => Promise<unknown>;
};

/**
 * The commands this store issues, named so a test can supply a client whose
 * `quit` never answers — the failure the bounded close exists for, and one no
 * reachable real Redis reproduces on demand.
 */
export type RedisAdminSessionStoreClient = {
  connect: () => Promise<unknown>;
  quit: () => Promise<unknown>;
  /** Tears the socket down without waiting for a reply. Synchronous. */
  disconnect: () => void;
  del: (key: string) => Promise<unknown>;
  hgetall: (key: string) => Promise<Record<string, string>>;
  multi: () => RedisAdminSessionStoreMulti;
};

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
    closeQuitTimeoutMs?: number;
    /**
     * `close` gave up on the graceful path and dropped the socket. Bounded and
     * silent is the trade this area exists to refuse: the overrun used to be
     * visible only because the shutdown step timed out, so a `close` that now
     * returns cleanly owes an operator the line instead.
     */
    onCloseUnfinished?: (info: {
      quitOutcome: RedisQuitOutcome;
      budgetMs: number;
    }) => void;
    redisClient?: RedisAdminSessionStoreClient;
  } = {},
): Promise<AdminSessionStore & { close: () => Promise<void> }> {
  const redis =
    options.redisClient ??
    (new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    }) as RedisAdminSessionStoreClient);
  const closeQuitTimeoutMs =
    options.closeQuitTimeoutMs ?? CLOSE_QUIT_TIMEOUT_MS;
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
      // `QUIT` is an ordinary command on this connection, so an unbounded wait
      // for its reply is an unbounded shutdown step. `quitWithin` drops the
      // socket when the reply does not come (#267).
      const quitOutcome = await quitWithin(redis, closeQuitTimeoutMs);
      if (quitOutcome !== "ok") {
        options.onCloseUnfinished?.({
          quitOutcome,
          budgetMs: closeQuitTimeoutMs,
        });
      }
    },
  };
}
