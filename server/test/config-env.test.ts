import assert from "node:assert/strict";
import test from "node:test";
import {
  loadAdminConfig,
  loadAdminUiConfig,
} from "../src/config/admin-config.js";
import { parseBooleanEnv, parseIntegerEnv } from "../src/config/env.js";
import { loadPersistenceConfig } from "../src/config/persistence-config.js";
import { loadSecurityConfig } from "../src/config/security-config.js";

test("security config reads overrides and keeps defaults for missing values", () => {
  const config = loadSecurityConfig({
    ALLOWED_ORIGINS: "https://a.example, https://b.example ",
    TRUST_PROXY_HEADERS: "true",
    RATE_LIMIT_SYNC_PING_BURST: "5",
  });

  assert.deepEqual(config.allowedOrigins, [
    "https://a.example",
    "https://b.example",
  ]);
  assert.equal(config.trustProxyHeaders, true);
  assert.equal(config.rateLimits.syncPingBurst, 5);
  assert.equal(config.maxMembersPerRoom, 8);
});

test("persistence config validates provider and trims string env values", () => {
  const config = loadPersistenceConfig({
    ROOM_STORE_PROVIDER: "redis",
    REDIS_URL: " redis://cache.internal:6379 ",
    INSTANCE_ID: " node-a ",
  });

  assert.equal(config.provider, "redis");
  assert.equal(config.redisUrl, "redis://cache.internal:6379");
  assert.equal(config.instanceId, "node-a");
});

test("admin config stays disabled until all required secrets are present", () => {
  assert.equal(
    loadAdminConfig({
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD_HASH: "hash",
    }),
    null,
  );
});

test("admin config parses role and session ttl", () => {
  const config = loadAdminConfig({
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD_HASH: "hash",
    ADMIN_SESSION_SECRET: "secret",
    ADMIN_SESSION_STORE_PROVIDER: "redis",
    ADMIN_EVENT_STORE_PROVIDER: "redis",
    ADMIN_AUDIT_STORE_PROVIDER: "redis",
    ADMIN_ROLE: "operator",
    ADMIN_SESSION_TTL_MS: "3600000",
  });

  assert.deepEqual(config, {
    username: "admin",
    passwordHash: "hash",
    sessionSecret: "secret",
    role: "operator",
    sessionTtlMs: 3600000,
    sessionStoreProvider: "redis",
    eventStoreProvider: "redis",
    auditStoreProvider: "redis",
  });
});

test("admin ui config parses demo flag", () => {
  assert.deepEqual(loadAdminUiConfig({ ADMIN_UI_DEMO_ENABLED: "true" }), {
    demoEnabled: true,
  });
});

test("env helpers keep integer and boolean validation semantics", () => {
  assert.throws(
    () => parseBooleanEnv({ FEATURE: "yes" }, "FEATURE", false),
    /must be "true" or "false"/,
  );
  assert.throws(
    () => parseIntegerEnv({ PORT: "87.5" }, "PORT", 8787),
    /must be an integer/,
  );
});
