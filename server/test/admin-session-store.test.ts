import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemoryAdminSessionStore,
  type AuthStore,
} from "../src/admin/auth-store.js";
import { createAdminAuthService } from "../src/admin/auth-service.js";
import type { AdminSession } from "../src/admin/types.js";

test("in-memory admin session store keeps session copies", async () => {
  const store = createInMemoryAdminSessionStore();
  const session: AdminSession = {
    id: "session-1",
    adminId: "admin-1",
    username: "admin",
    role: "admin",
    createdAt: 1,
    expiresAt: 2,
    lastSeenAt: 1,
  };

  await store.save("token-1", session);
  session.username = "mutated";

  const saved = await store.get("token-1");
  assert.ok(saved);
  assert.equal(saved.username, "admin");

  saved.username = "changed";
  const reloaded = await store.get("token-1");
  assert.ok(reloaded);
  assert.equal(reloaded.username, "admin");
});

test("admin auth service authenticates through injected admin session store", async () => {
  const calls: Array<string> = [];
  const store: AuthStore = {
    async save(tokenId, session) {
      calls.push(`save:${tokenId}:${session.username}`);
    },
    async get(tokenId) {
      calls.push(`get:${tokenId}`);
      return {
        id: "session-1",
        adminId: "admin-1",
        username: "admin",
        role: "admin",
        createdAt: 10,
        expiresAt: 1000,
        lastSeenAt: 10,
      };
    },
    async delete(tokenId) {
      calls.push(`delete:${tokenId}`);
    },
  };

  const service = createAdminAuthService(
    {
      username: "admin",
      passwordHash:
        "sha256:300109590f69536a400b77ef698021586bfce6809dd8782da32ade9c45457231",
      sessionSecret: "secret",
      sessionTtlMs: 1000,
      role: "admin",
    },
    store,
    () => 100,
  );

  const login = await service.login("admin", "secret-123");
  assert.equal(login.admin.username, "admin");

  const authenticated = await service.authenticate(login.token);
  assert.ok(authenticated);
  assert.equal(authenticated.lastSeenAt, 100);
  assert.equal(
    calls.some((entry) => entry.startsWith("save:")),
    true,
  );
  assert.equal(
    calls.some((entry) => entry.startsWith("get:")),
    true,
  );
});
