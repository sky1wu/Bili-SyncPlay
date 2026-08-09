import assert from "node:assert/strict";
import test from "node:test";
import {
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

function createFakeSessionRedis(quit: () => Promise<unknown>): {
  client: RedisAdminSessionStoreClient;
  disconnectCalls: () => number;
} {
  let disconnectCalls = 0;
  const multi: RedisAdminSessionStoreMulti = {
    hset: () => multi,
    pexpire: () => multi,
    exec: async () => [],
  };
  return {
    client: {
      connect: async () => undefined,
      quit,
      disconnect: () => {
        disconnectCalls += 1;
      },
      del: async () => 1,
      hgetall: async () => ({}),
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
