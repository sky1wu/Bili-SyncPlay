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
    TRUSTED_PROXY_ADDRESSES: "127.0.0.1, 198.51.100.7 ",
    RATE_LIMIT_SYNC_PING_BURST: "5",
  });

  assert.deepEqual(config.allowedOrigins, [
    "https://a.example",
    "https://b.example",
  ]);
  assert.deepEqual(config.trustedProxyAddresses, ["127.0.0.1", "198.51.100.7"]);
  assert.equal(config.rateLimits.syncPingBurst, 5);
  assert.equal(config.maxMembersPerRoom, 8);
});

test("persistence config validates provider and trims string env values", () => {
  const config = loadPersistenceConfig({
    ROOM_STORE_PROVIDER: "redis",
    RUNTIME_STORE_PROVIDER: "redis",
    ROOM_EVENT_BUS_PROVIDER: "redis",
    ADMIN_COMMAND_BUS_PROVIDER: "redis",
    NODE_HEARTBEAT_ENABLED: "true",
    NODE_HEARTBEAT_INTERVAL_MS: "5000",
    NODE_HEARTBEAT_TTL_MS: "15000",
    REDIS_URL: " redis://cache.internal:6379 ",
    INSTANCE_ID: " node-a ",
  });

  assert.equal(config.provider, "redis");
  assert.equal(config.runtimeStoreProvider, "redis");
  assert.equal(config.roomEventBusProvider, "redis");
  assert.equal(config.adminCommandBusProvider, "redis");
  assert.equal(config.nodeHeartbeatEnabled, true);
  assert.equal(config.nodeHeartbeatIntervalMs, 5000);
  assert.equal(config.nodeHeartbeatTtlMs, 15000);
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
  assert.deepEqual(
    loadAdminUiConfig({
      ADMIN_UI_DEMO_ENABLED: "true",
      GLOBAL_ADMIN_API_BASE_URL: " https://admin.example.com ",
      GLOBAL_ADMIN_ENABLED: "false",
    }),
    {
      demoEnabled: true,
      apiBaseUrl: "https://admin.example.com",
      enabled: false,
    },
  );
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
