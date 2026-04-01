import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config/runtime-config.js";

async function withTempDir(
  run: (tempDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "bili-syncplay-config-"));
  try {
    await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("runtime config falls back to defaults and env when config file is missing", async () => {
  await withTempDir(async (tempDir) => {
    const config = await loadRuntimeConfig(
      {
        PORT: "9001",
        GLOBAL_ADMIN_ENABLED: "false",
      },
      { cwd: tempDir },
    );

    assert.equal(config.port, 9001);
    assert.equal(config.globalAdminPort, 9001);
    assert.equal(config.persistenceConfig.provider, "memory");
    assert.equal(config.adminUiConfig.enabled, false);
    assert.equal(config.adminConfig, null);
  });
});

test("runtime config maps JSON file values through existing loaders", async () => {
  await withTempDir(async (tempDir) => {
    await writeFile(
      join(tempDir, "server.config.json"),
      JSON.stringify({
        port: 8789,
        globalAdminPort: 9797,
        security: {
          allowedOrigins: ["https://a.example", "https://b.example"],
          trustedProxyAddresses: ["127.0.0.1", "198.51.100.7"],
          rateLimits: {
            syncPingBurst: 5,
          },
        },
        persistence: {
          provider: "redis",
          runtimeStoreProvider: "redis",
          roomEventBusProvider: "redis",
          adminCommandBusProvider: "redis",
          nodeHeartbeatEnabled: true,
          nodeHeartbeatIntervalMs: 5000,
          nodeHeartbeatTtlMs: 15000,
          redisUrl: "redis://cache.internal:6379",
          instanceId: "room-node-a",
        },
        adminUi: {
          demoEnabled: true,
          apiBaseUrl: "https://admin.example.com",
          enabled: false,
        },
      }),
      "utf8",
    );

    const config = await loadRuntimeConfig({}, { cwd: tempDir });

    assert.equal(config.port, 8789);
    assert.equal(config.globalAdminPort, 9797);
    assert.deepEqual(config.securityConfig.allowedOrigins, [
      "https://a.example",
      "https://b.example",
    ]);
    assert.deepEqual(config.securityConfig.trustedProxyAddresses, [
      "127.0.0.1",
      "198.51.100.7",
    ]);
    assert.equal(config.securityConfig.rateLimits.syncPingBurst, 5);
    assert.equal(config.persistenceConfig.provider, "redis");
    assert.equal(config.persistenceConfig.runtimeStoreProvider, "redis");
    assert.equal(config.persistenceConfig.roomEventBusProvider, "redis");
    assert.equal(config.persistenceConfig.adminCommandBusProvider, "redis");
    assert.equal(config.persistenceConfig.nodeHeartbeatEnabled, true);
    assert.equal(config.persistenceConfig.nodeHeartbeatIntervalMs, 5000);
    assert.equal(config.persistenceConfig.nodeHeartbeatTtlMs, 15000);
    assert.equal(
      config.persistenceConfig.redisUrl,
      "redis://cache.internal:6379",
    );
    assert.equal(config.persistenceConfig.instanceId, "room-node-a");
    assert.deepEqual(config.adminUiConfig, {
      demoEnabled: true,
      apiBaseUrl: "https://admin.example.com",
      enabled: false,
    });
  });
});

test("environment variables override config file values", async () => {
  await withTempDir(async (tempDir) => {
    await writeFile(
      join(tempDir, "server.config.json"),
      JSON.stringify({
        port: 8789,
        security: {
          trustedProxyAddresses: ["10.0.0.10"],
        },
        persistence: {
          provider: "memory",
          instanceId: "room-node-a",
        },
      }),
      "utf8",
    );

    const config = await loadRuntimeConfig(
      {
        PORT: "9002",
        TRUSTED_PROXY_ADDRESSES: "127.0.0.1, 127.0.0.2",
        ROOM_STORE_PROVIDER: "redis",
        INSTANCE_ID: "room-node-b",
      },
      { cwd: tempDir },
    );

    assert.equal(config.port, 9002);
    assert.deepEqual(config.securityConfig.trustedProxyAddresses, [
      "127.0.0.1",
      "127.0.0.2",
    ]);
    assert.equal(config.persistenceConfig.provider, "redis");
    assert.equal(config.persistenceConfig.instanceId, "room-node-b");
  });
});

test("runtime config ignores file values for sensitive admin secrets", async () => {
  await withTempDir(async (tempDir) => {
    await writeFile(
      join(tempDir, "server.config.json"),
      JSON.stringify({
        port: 8789,
      }),
      "utf8",
    );

    const config = await loadRuntimeConfig(
      {
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD_HASH: "hash",
        ADMIN_SESSION_SECRET: "secret",
      },
      { cwd: tempDir },
    );

    assert.deepEqual(config.adminConfig, {
      username: "admin",
      passwordHash: "hash",
      sessionSecret: "secret",
      sessionTtlMs: 12 * 60 * 60 * 1000,
      role: "admin",
      sessionStoreProvider: "memory",
      eventStoreProvider: "memory",
      auditStoreProvider: "memory",
    });
  });
});

test("runtime config rejects unsupported admin config in file", async () => {
  await withTempDir(async (tempDir) => {
    await writeFile(
      join(tempDir, "server.config.json"),
      JSON.stringify({
        admin: {
          username: "admin",
        },
      }),
      "utf8",
    );

    await assert.rejects(
      () => loadRuntimeConfig({}, { cwd: tempDir }),
      /Unsupported config key "admin"/,
    );
  });
});

test("runtime config reports invalid JSON config files", async () => {
  await withTempDir(async (tempDir) => {
    await writeFile(join(tempDir, "server.config.json"), "{invalid", "utf8");

    await assert.rejects(
      () => loadRuntimeConfig({}, { cwd: tempDir }),
      /Failed to parse JSON config file/,
    );
  });
});

test("runtime config reports invalid config field types", async () => {
  await withTempDir(async (tempDir) => {
    await writeFile(
      join(tempDir, "server.config.json"),
      JSON.stringify({
        security: {
          allowedOrigins: "https://a.example",
        },
      }),
      "utf8",
    );

    await assert.rejects(
      () => loadRuntimeConfig({}, { cwd: tempDir }),
      /security\.allowedOrigins/,
    );
  });
});

test("runtime config resolves explicit config file path from env", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = join(tempDir, "custom-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        globalAdminPort: 9123,
      }),
      "utf8",
    );

    const config = await loadRuntimeConfig(
      {
        BILI_SYNCPLAY_CONFIG: "custom-config.json",
      },
      { cwd: tempDir },
    );

    assert.equal(config.port, 8787);
    assert.equal(config.globalAdminPort, 9123);
  });
});
