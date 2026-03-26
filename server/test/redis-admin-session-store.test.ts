import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdminSessionTokenId,
  createRedisAdminSessionStore,
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
