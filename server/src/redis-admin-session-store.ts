import { createHash } from "node:crypto";
import type { AdminRole, AdminSession } from "./admin/types.js";
import type { AdminSessionStore } from "./admin-session-store.js";
import {
  createBoundedRedisClient,
  createRedisCommandAdmission,
  createStalledConnectionGuard,
  DEFAULT_REDIS_COMMAND_ADMISSION_LIMIT,
  RedisCommandAdmissionError,
} from "./redis-command-timeout.js";
import { quitWithin, type RedisQuitOutcome } from "./redis-graceful-close.js";
import type { RedisConnectionReporting } from "./redis-connection-error.js";

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
  /**
   * Tears the socket down without waiting for a reply. Synchronous.
   *
   * `disconnect(true)` keeps ioredis's retry strategy, which is what makes it a
   * reset rather than a retirement; the shutdown path calls it with no argument.
   */
  disconnect: (reconnect?: boolean) => void;
  on?: (event: "ready", listener: () => void) => unknown;
  off?: (event: "ready", listener: () => void) => unknown;
  del: (key: string) => Promise<unknown>;
  hgetall: (key: string) => Promise<Record<string, string>>;
  multi: () => RedisAdminSessionStoreMulti;
};

/** Which command failed, which is also all an unauthenticated caller may learn. */
export type AdminSessionStoreOperation = "save" | "get" | "delete";

/**
 * The session store's Redis connection did not answer.
 *
 * A dependency failure, not a bug and not an authentication failure, and the
 * router owes it a 503 for both reasons: retrying once Redis recovers is right,
 * and a 401 would log an operator out over a Redis blip. Carries no detail in
 * its message on purpose — `authenticate` runs before any credential is
 * accepted, so this message is reachable by an unauthenticated caller, and the
 * underlying error goes to `onCommandFailed` instead (#271).
 */
export class AdminSessionStoreUnavailableError extends Error {
  readonly operation: AdminSessionStoreOperation;

  constructor(operation: AdminSessionStoreOperation) {
    super("Admin session store is unavailable.");
    this.name = "AdminSessionStoreUnavailableError";
    this.operation = operation;
  }
}

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
    /**
     * A command failed or admission refused it, with the detail the HTTP
     * response deliberately omits.
     *
     * The whole point of giving this connection a `commandTimeout` was to stop
     * a stalled Redis hanging every admin request; answering it with a bare 503
     * and no server-side trace would just move the silence (#271).
     */
    onCommandFailed?: (info: {
      operation: AdminSessionStoreOperation;
      error: unknown;
    }) => void;
    /** Injectable so a test does not have to spend three real failures. */
    stallDropThreshold?: number;
    /** Hard cap before another Redis command may be submitted. */
    maxPendingCommands?: number;
    /**
     * The socket was dropped after repeated failures, and ioredis is
     * reconnecting. One line per reset, which is at most one per
     * `stallDropThreshold` failures.
     */
    onConnectionDropped?: (info: { consecutiveFailures: number }) => void;
    /**
     * Who this store's own connection reports socket failures to, and as
     * which node.
     *
     * Only read when this store opens its own connection; an injected
     * client carries whatever listener its creator attached (#280).
     */
    connection?: RedisConnectionReporting;
    redisClient?: RedisAdminSessionStoreClient;
  } = {},
): Promise<AdminSessionStore & { close: () => Promise<void> }> {
  const redis =
    options.redisClient ??
    // The FIRST command of every authenticated admin request, and until #271 an
    // unbounded one: a Redis that stopped answering hung every request at
    // `authenticate`, before any route ran, and nothing else would ever answer
    // it — Node's `requestTimeout` bounds RECEIVING a request, not producing its
    // response (measured, #277 review). Nothing here is large — one `HGETALL` of a handful of
    // fields — so the backstop cannot be tripped by a legitimately slow read the
    // way an admin console query might be.
    (createBoundedRedisClient(
      redisUrl,
      { bound: "command_timeout" },
      { component: "admin_session_store", ...options.connection },
    ) as RedisAdminSessionStoreClient);
  const closeQuitTimeoutMs =
    options.closeQuitTimeoutMs ?? CLOSE_QUIT_TIMEOUT_MS;
  const keyPrefix = options.keyPrefix ?? DEFAULT_ADMIN_SESSION_KEY_PREFIX;
  const now = options.now ?? Date.now;
  const maxPendingCommands =
    options.maxPendingCommands ?? DEFAULT_REDIS_COMMAND_ADMISSION_LIMIT;
  const admission = createRedisCommandAdmission(maxPendingCommands);
  /**
   * Admission bounds the first timeout window. A timed-out promise releases its
   * slot while the command can still remain in ioredis, but after at most the
   * guard threshold that generation is reset without replay. Together the real
   * queue is bounded by admission plus `threshold - 1` (#271 review).
   */
  const guard = createStalledConnectionGuard(redis, {
    threshold: options.stallDropThreshold,
    onDropped: options.onConnectionDropped,
  });

  await redis.connect();

  /**
   * Wrap ONLY the Redis call, never the parsing around it: a defect in this
   * module has to keep reading as a 500, and folding it into the dependency's
   * diagnosis is how a bug hides behind an outage.
   */
  async function guarded<T>(
    operation: AdminSessionStoreOperation,
    call: () => Promise<T>,
  ): Promise<T> {
    const attempt = guard.beginAttempt();
    if (!attempt) {
      options.onCommandFailed?.({
        operation,
        error: new Error("Redis connection is reconnecting."),
      });
      throw new AdminSessionStoreUnavailableError(operation);
    }
    try {
      const result = await admission.run(call);
      attempt.recordSuccess();
      return result;
    } catch (error) {
      if (!(error instanceof RedisCommandAdmissionError)) {
        attempt.recordFailure();
      }
      options.onCommandFailed?.({ operation, error });
      throw new AdminSessionStoreUnavailableError(operation);
    }
  }

  return {
    async save(tokenId, session) {
      const ttlMs = session.expiresAt - now();
      const key = sessionKey(keyPrefix, tokenId);

      if (ttlMs <= 0) {
        await guarded("save", () => redis.del(key));
        return;
      }

      await guarded("save", () =>
        redis
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
          .exec(),
      );
    },
    async get(tokenId) {
      const raw = await guarded("get", () =>
        redis.hgetall(sessionKey(keyPrefix, tokenId)),
      );
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
        // The ANSWER is already settled: this session is expired, so the caller is
        // unauthenticated. The delete is housekeeping on top of it, and letting
        // its failure throw would turn a determined 401 into a 503 — a cleanup
        // rejection thrown over a real result, which is the same mistake as the
        // command bus's `finally` (#271 review). Reported, not swallowed: the
        // key keeps its own TTL, so the residue is bounded, but a connection
        // that cannot delete is still worth a line.
        try {
          await guarded("delete", () =>
            redis.del(sessionKey(keyPrefix, tokenId)),
          );
        } catch {
          // The expired-session answer was determined before this cleanup.
        }
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
      await guarded("delete", () => redis.del(sessionKey(keyPrefix, tokenId)));
    },
    async close() {
      guard.close();
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
