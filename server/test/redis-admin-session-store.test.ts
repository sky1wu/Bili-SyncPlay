import assert from "node:assert/strict";
import test from "node:test";
import {
  AdminSessionStoreUnavailableError,
  createAdminSessionTokenId,
  createRedisAdminSessionStore,
  type RedisAdminSessionStoreClient,
  type RedisAdminSessionStoreMulti,
} from "../src/redis-admin-session-store.js";
import { createAdminAuthService } from "../src/admin/auth-service.js";
import type { AdminSession } from "../src/admin/types.js";

const REDIS_URL = process.env.REDIS_URL;

function createKeyPrefix() {
  return `bsp:test:admin-session:${Date.now()}:${Math.random().toString(16).slice(2)}:`;
}

test("redis admin session store persists, reads, and deletes sessions", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const store = await createRedisAdminSessionStore(REDIS_URL, {
    keyPrefix: createKeyPrefix(),
    now: () => 100,
  });
  const session: AdminSession = {
    id: "session-1",
    adminId: "admin-1",
    username: "admin",
    role: "admin",
    createdAt: 100,
    expiresAt: 10_000,
    lastSeenAt: 100,
  };

  try {
    await store.save("token-1", session);
    const saved = await store.get("token-1");
    assert.deepEqual(saved, session);

    session.username = "changed";
    const reloaded = await store.get("token-1");
    assert.equal(reloaded?.username, "admin");

    await store.delete("token-1");
    assert.equal(await store.get("token-1"), null);
  } finally {
    await store.close();
  }
});

test("admin auth service shares redis-backed sessions across store instances", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const keyPrefix = createKeyPrefix();
  const sessionSecret = "session-secret";
  const storeA = await createRedisAdminSessionStore(REDIS_URL, {
    keyPrefix,
    now: () => 1_000,
  });
  const storeB = await createRedisAdminSessionStore(REDIS_URL, {
    keyPrefix,
    now: () => 1_100,
  });

  const config = {
    username: "admin",
    passwordHash:
      "sha256:300109590f69536a400b77ef698021586bfce6809dd8782da32ade9c45457231",
    sessionSecret,
    sessionTtlMs: 10_000,
    role: "admin" as const,
  };

  const authA = createAdminAuthService(config, storeA, () => 1_000);
  const authB = createAdminAuthService(config, storeB, () => 1_100);

  try {
    const login = await authA.login("admin", "secret-123");
    const tokenId = createAdminSessionTokenId(sessionSecret, login.token);
    assert.ok(await storeA.get(tokenId));

    const authenticated = await authB.authenticate(login.token);
    assert.ok(authenticated);
    assert.equal(authenticated.username, "admin");
    assert.equal(authenticated.lastSeenAt, 1_100);

    await authB.logout(login.token);
    assert.equal(await authA.authenticate(login.token), null);
  } finally {
    await storeA.close();
    await storeB.close();
  }
});

function createFakeSessionRedis(
  quit: () => Promise<unknown>,
  commands: Partial<
    Pick<RedisAdminSessionStoreClient, "del" | "hgetall"> & {
      exec: () => Promise<unknown>;
    }
  > = {},
): {
  client: RedisAdminSessionStoreClient;
  disconnectCalls: () => number;
} {
  let disconnectCalls = 0;
  const multi: RedisAdminSessionStoreMulti = {
    hset: () => multi,
    pexpire: () => multi,
    exec: commands.exec ?? (async () => []),
  };
  return {
    client: {
      connect: async () => undefined,
      quit,
      disconnect: () => {
        disconnectCalls += 1;
      },
      del: commands.del ?? (async () => 1),
      hgetall: commands.hgetall ?? (async () => ({})),
      multi: () => multi,
    },
    disconnectCalls: () => disconnectCalls,
  };
}

test("close gives up on a Redis that never answers QUIT, and says so", async () => {
  const redis = createFakeSessionRedis(() => new Promise(() => undefined));
  const unfinished: Array<{ quitOutcome: string; budgetMs: number }> = [];
  const store = await createRedisAdminSessionStore("redis://unused", {
    redisClient: redis.client,
    closeQuitTimeoutMs: 20,
    onCloseUnfinished: (info) => {
      unfinished.push(info);
    },
  });

  // Unbounded, this never returns. It runs FIRST inside `close_admin_services`,
  // so it used to spend the step's whole 5s budget before the audit store's
  // close was even reached — a guaranteed failed shutdown step whenever Redis
  // was hung, and the reason bounding only the audit store would not have
  // fixed the step (#267).
  const startedAt = Date.now();
  await store.close();
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(redis.disconnectCalls(), 1);
  // Bounded is not the same as quiet: without this line the overrun would be
  // invisible, because it no longer times the step out.
  assert.deepEqual(unfinished, [{ quitOutcome: "timed_out", budgetMs: 20 }]);
});

test("an ordinary close stays graceful and stays quiet", async () => {
  const redis = createFakeSessionRedis(async () => "OK");
  let unfinishedCalls = 0;
  const store = await createRedisAdminSessionStore("redis://unused", {
    redisClient: redis.client,
    closeQuitTimeoutMs: 500,
    onCloseUnfinished: () => {
      unfinishedCalls += 1;
    },
  });

  await store.close();

  // A degraded line on every clean shutdown would mean nothing on the one
  // shutdown where it matters.
  assert.equal(unfinishedCalls, 0);
  assert.equal(redis.disconnectCalls(), 0);
});

test("a command the connection never answers becomes an unavailable-store error", async () => {
  // What `commandTimeout` produces once the connection stops replying: an
  // ordinary rejected command, on the path that runs before any route (#271).
  // Modelled as the rejection, not as the hang, because the timer lives in
  // ioredis and what this store owns is the answer it turns that into.
  const stall = new Error("Command timed out");
  const redis = createFakeSessionRedis(async () => "OK", {
    hgetall: async () => {
      throw stall;
    },
  });
  const reported: Array<{ operation: string; error: unknown }> = [];
  const store = await createRedisAdminSessionStore("redis://unused", {
    redisClient: redis.client,
    onCommandFailed: (info) => {
      reported.push(info);
    },
  });

  const failure = await store.get("token-id").then(
    () => null,
    (error: unknown) => error,
  );

  assert.ok(failure instanceof AdminSessionStoreUnavailableError);
  assert.equal(failure.operation, "get");
  // Reachable by an unauthenticated caller, so it carries no Redis detail. The
  // detail goes to the operator instead — bounded is not the same as silent.
  assert.equal(failure.message, "Admin session store is unavailable.");
  assert.deepEqual(reported, [{ operation: "get", error: stall }]);
});

test("a write that never lands is reported as a save, not as a lost session", async () => {
  const redis = createFakeSessionRedis(async () => "OK", {
    exec: async () => {
      throw new Error("Command timed out");
    },
  });
  const reported: string[] = [];
  const store = await createRedisAdminSessionStore("redis://unused", {
    redisClient: redis.client,
    onCommandFailed: ({ operation }) => {
      reported.push(operation);
    },
  });

  await assert.rejects(
    store.save("token-id", {
      id: "session-1",
      adminId: "admin-1",
      username: "admin",
      role: "admin",
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      lastSeenAt: 1,
    } satisfies AdminSession),
    AdminSessionStoreUnavailableError,
  );
  assert.deepEqual(reported, ["save"]);
});

test("an unreadable session stays a null, not a dependency outage", async () => {
  // The discriminating half: only the Redis CALL is wrapped, never the parsing
  // around it. A hash this store cannot interpret is a missing session — the
  // same answer as an absent key — and folding it into the outage diagnosis
  // would answer 503 to a caller holding a token that is simply no good, and
  // would hide a defect in this module behind Redis.
  const redis = createFakeSessionRedis(async () => "OK", {
    hgetall: async () => ({ id: "session-1", role: "sorcerer" }),
  });
  let reportedCalls = 0;
  const store = await createRedisAdminSessionStore("redis://unused", {
    redisClient: redis.client,
    onCommandFailed: () => {
      reportedCalls += 1;
    },
  });

  assert.equal(await store.get("token-id"), null);
  assert.equal(reportedCalls, 0);
});

test("a cleanup that fails does not turn an expired session into an outage", async () => {
  // `HGETALL` already answered, and it said the session is expired — so the
  // caller is unauthenticated and that answer is settled. The `DEL` after it is
  // housekeeping; letting it throw would turn a determined 401 into a 503, the
  // same "cleanup rejection thrown over a real result" the command bus's
  // `finally` had (#271 review). The key keeps its own TTL, so the residue is
  // bounded — but the failure is still reported.
  const reported: string[] = [];
  const redis = createFakeSessionRedis(async () => "OK", {
    hgetall: async () => ({
      id: "session-1",
      adminId: "admin-1",
      username: "admin",
      role: "admin",
      createdAt: "1",
      expiresAt: "2",
      lastSeenAt: "1",
    }),
    del: async () => {
      throw new Error("Command timed out");
    },
  });
  const store = await createRedisAdminSessionStore("redis://unused", {
    redisClient: redis.client,
    now: () => 1_000,
    onCommandFailed: ({ operation }) => {
      reported.push(operation);
    },
  });

  assert.equal(await store.get("token-id"), null);
  assert.deepEqual(reported, ["delete"]);
});

test("a connection that keeps failing is reset rather than left queueing", async () => {
  // The backstop answers the caller and leaves the command in ioredis's queue,
  // and this store has no admission or depth limit — so an unauthenticated
  // caller retrying every five seconds adds one queued command per retry. Only
  // closing the socket empties that queue (#271 review).
  const drops: Array<{ consecutiveFailures: number }> = [];
  const redis = createFakeSessionRedis(async () => "OK", {
    hgetall: async () => {
      throw new Error("Command timed out");
    },
  });
  const store = await createRedisAdminSessionStore("redis://unused", {
    redisClient: redis.client,
    stallDropThreshold: 2,
    onConnectionDropped: (info) => drops.push(info),
  });

  await assert.rejects(store.get("a"), AdminSessionStoreUnavailableError);
  assert.deepEqual(drops, []);
  await assert.rejects(store.get("b"), AdminSessionStoreUnavailableError);
  assert.deepEqual(drops, [{ consecutiveFailures: 2 }]);
  assert.equal(redis.disconnectCalls(), 1);
});
