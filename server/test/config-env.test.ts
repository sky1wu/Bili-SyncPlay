import assert from "node:assert/strict";
import test from "node:test";
import {
  loadAdminConfig,
  loadAdminUiConfig,
} from "../src/config/admin-config.js";
import { parseBooleanEnv, parseIntegerEnv } from "../src/config/env.js";
import { loadPersistenceConfig } from "../src/config/persistence-config.js";
import {
  assertAllowedOriginsStartupPolicy,
  logEffectiveOriginPolicy,
  loadSecurityConfig,
} from "../src/config/security-config.js";
import { loadVoiceConfig } from "../src/config/voice-config.js";

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

test("voice config stays disabled by default", () => {
  assert.deepEqual(loadVoiceConfig({}), {
    enabled: false,
    livekitUrl: undefined,
    apiKey: undefined,
    apiSecret: undefined,
    tokenTtlSeconds: 900,
    maxMembers: 4,
  });
});

test("voice config parses LiveKit settings and caps max members", () => {
  const config = loadVoiceConfig({
    VOICE_ENABLED: "true",
    LIVEKIT_URL: " wss://voice.example.com ",
    LIVEKIT_API_KEY: " livekit-key ",
    LIVEKIT_API_SECRET: " livekit-secret ",
    VOICE_TOKEN_TTL_SECONDS: "600",
    VOICE_MAX_MEMBERS: "8",
  });

  assert.deepEqual(config, {
    enabled: true,
    livekitUrl: "wss://voice.example.com",
    apiKey: "livekit-key",
    apiSecret: "livekit-secret",
    tokenTtlSeconds: 600,
    maxMembers: 4,
  });
});

test("voice config rejects non-WebSocket LiveKit URLs", () => {
  assert.throws(
    () => loadVoiceConfig({ LIVEKIT_URL: "https://voice.example.com" }),
    /LIVEKIT_URL must use ws:\/\/ or wss:\/\//,
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

test("security config rejects origins without a scheme", () => {
  assert.throws(
    () => loadSecurityConfig({ ALLOWED_ORIGINS: "bilibili.com" }),
    /not a valid absolute URL/,
  );
});

test("security config rejects origins with unsupported schemes", () => {
  assert.throws(
    () => loadSecurityConfig({ ALLOWED_ORIGINS: "ftp://bilibili.com" }),
    /unsupported scheme "ftp"/,
  );
});

test("security config rejects wildcard origins", () => {
  assert.throws(
    () => loadSecurityConfig({ ALLOWED_ORIGINS: "https://*.bilibili.com" }),
    /wildcard, which is not supported/,
  );
});

test("security config accepts chrome-extension origins", () => {
  const config = loadSecurityConfig({
    ALLOWED_ORIGINS: "chrome-extension://abcdefghijklmnop",
  });
  assert.deepEqual(config.allowedOrigins, [
    "chrome-extension://abcdefghijklmnop",
  ]);
});

test("security config accepts moz-extension origins (Firefox)", () => {
  const config = loadSecurityConfig({
    ALLOWED_ORIGINS: "moz-extension://12345678-90ab-cdef-1234-567890abcdef",
  });
  assert.deepEqual(config.allowedOrigins, [
    "moz-extension://12345678-90ab-cdef-1234-567890abcdef",
  ]);
});

test("security config rejects moz-extension origins with a path", () => {
  assert.throws(
    () =>
      loadSecurityConfig({
        ALLOWED_ORIGINS: "moz-extension://uuid-value/popup.html",
      }),
    /must be a bare origin/,
  );
});

test("security config rejects origins that include a path", () => {
  assert.throws(
    () => loadSecurityConfig({ ALLOWED_ORIGINS: "https://a.example/app" }),
    /must be a bare origin/,
  );
});

test("security config rejects origins with a trailing slash", () => {
  assert.throws(
    () => loadSecurityConfig({ ALLOWED_ORIGINS: "https://a.example/" }),
    /must be a bare origin/,
  );
});

test("security config rejects origins with a query string or fragment", () => {
  assert.throws(
    () => loadSecurityConfig({ ALLOWED_ORIGINS: "https://a.example?x=1" }),
    /must be a bare origin/,
  );
  assert.throws(
    () => loadSecurityConfig({ ALLOWED_ORIGINS: "https://a.example#frag" }),
    /must be a bare origin/,
  );
});

test("security config rejects origins with userinfo", () => {
  assert.throws(
    () =>
      loadSecurityConfig({
        ALLOWED_ORIGINS: "https://user:pass@a.example",
      }),
    /must be a bare origin/,
  );
});

test("security config rejects chrome-extension origins with a path", () => {
  assert.throws(
    () =>
      loadSecurityConfig({
        ALLOWED_ORIGINS: "chrome-extension://abcdef/popup.html",
      }),
    /must be a bare origin/,
  );
});

test("security config rejects origins with a mixed-case host", () => {
  assert.throws(
    () => loadSecurityConfig({ ALLOWED_ORIGINS: "https://A.Example" }),
    /must be a bare origin/,
  );
});

test("startup policy rejects empty origins outside of dev override", () => {
  const config = loadSecurityConfig({});
  assert.deepEqual(config.allowedOrigins, []);
  assert.equal(config.allowMissingOriginInDev, false);
  assert.throws(
    () => assertAllowedOriginsStartupPolicy(config),
    /ALLOWED_ORIGINS is empty/,
  );
});

test("startup policy allows empty origins when dev override is enabled", () => {
  const config = loadSecurityConfig({ ALLOW_MISSING_ORIGIN_IN_DEV: "true" });
  assert.doesNotThrow(() => assertAllowedOriginsStartupPolicy(config));
});

test("startup policy allows empty origins when any-origin dev override is enabled", () => {
  const config = loadSecurityConfig({ ALLOW_ANY_ORIGIN_IN_DEV: "true" });
  assert.deepEqual(config.allowedOrigins, []);
  assert.equal(config.allowMissingOriginInDev, false);
  assert.equal(config.allowAnyOriginInDev, true);
  assert.doesNotThrow(() => assertAllowedOriginsStartupPolicy(config));
});

test("logEffectiveOriginPolicy prints final origins and dev override once", () => {
  const entries: string[] = [];
  const log = (message: string): void => {
    entries.push(message);
  };

  logEffectiveOriginPolicy(
    {
      allowedOrigins: ["https://a.example", "https://b.example"],
      allowMissingOriginInDev: false,
      allowAnyFirefoxExtensionOrigin: false,
      allowAnyOriginInDev: false,
    } as ReturnType<typeof loadSecurityConfig>,
    log,
  );
  logEffectiveOriginPolicy(
    {
      allowedOrigins: [],
      allowMissingOriginInDev: true,
      allowAnyFirefoxExtensionOrigin: true,
      allowAnyOriginInDev: true,
    } as ReturnType<typeof loadSecurityConfig>,
    log,
  );

  assert.deepEqual(entries, [
    "[security] ALLOWED_ORIGINS=https://a.example, https://b.example; ALLOW_MISSING_ORIGIN_IN_DEV=false; ALLOW_ANY_FIREFOX_EXTENSION_ORIGIN=false; ALLOW_ANY_ORIGIN_IN_DEV=false",
    "[security] ALLOWED_ORIGINS=<none>; ALLOW_MISSING_ORIGIN_IN_DEV=true; ALLOW_ANY_FIREFOX_EXTENSION_ORIGIN=true; ALLOW_ANY_ORIGIN_IN_DEV=true",
  ]);
});

test("security config parses ALLOW_ANY_FIREFOX_EXTENSION_ORIGIN", () => {
  assert.equal(loadSecurityConfig({}).allowAnyFirefoxExtensionOrigin, false);
  assert.equal(
    loadSecurityConfig({ ALLOW_ANY_FIREFOX_EXTENSION_ORIGIN: "true" })
      .allowAnyFirefoxExtensionOrigin,
    true,
  );
});

test("security config parses ALLOW_ANY_ORIGIN_IN_DEV", () => {
  assert.equal(loadSecurityConfig({}).allowAnyOriginInDev, false);
  assert.equal(
    loadSecurityConfig({ ALLOW_ANY_ORIGIN_IN_DEV: "true" }).allowAnyOriginInDev,
    true,
  );
});

test("startup policy allows empty origins when any-firefox-extension is enabled", () => {
  const config = loadSecurityConfig({
    ALLOW_ANY_FIREFOX_EXTENSION_ORIGIN: "true",
  });
  assert.deepEqual(config.allowedOrigins, []);
  assert.equal(config.allowMissingOriginInDev, false);
  assert.doesNotThrow(() => assertAllowedOriginsStartupPolicy(config));
});
