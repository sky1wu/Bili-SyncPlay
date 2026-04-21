import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getConfigValue,
  getDefaultConfigSampleValue,
  SERVER_CONFIG_FIELDS,
  setConfigValue,
} from "../src/config/runtime-config-schema.js";
import {
  configFileToEnv,
  type RuntimeConfig,
  loadRuntimeConfig,
  type ServerConfigFile,
} from "../src/config/runtime-config.js";

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

function buildConfigSample(): ServerConfigFile {
  const config: Record<string, unknown> = {};
  for (const field of SERVER_CONFIG_FIELDS) {
    setConfigValue(config, field.path, getDefaultConfigSampleValue(field));
  }
  return config as ServerConfigFile;
}

function readRuntimeValue(
  config: RuntimeConfig,
  path: readonly [string, ...string[]],
): unknown {
  switch (path[0]) {
    case "port":
    case "globalAdminPort":
    case "logLevel":
      return getConfigValue(config as Record<string, unknown>, path);
    case "security":
      return getConfigValue(
        config.securityConfig as Record<string, unknown>,
        path.slice(1),
      );
    case "persistence":
      return getConfigValue(
        config.persistenceConfig as Record<string, unknown>,
        path.slice(1),
      );
    case "adminUi":
      return getConfigValue(
        config.adminUiConfig as Record<string, unknown>,
        path.slice(1),
      );
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
    assert.equal(config.logLevel, "info");
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
          redisNamespace: "myapp",
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
    assert.equal(config.persistenceConfig.redisNamespace, "myapp");
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
          redisNamespace: "file-ns",
        },
      }),
      "utf8",
    );

    const config = await loadRuntimeConfig(
      {
        PORT: "9002",
        TRUSTED_PROXY_ADDRESSES: "127.0.0.1, 127.0.0.2",
        ROOM_STORE_PROVIDER: "redis",
        REDIS_NAMESPACE: "env-ns",
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
    assert.equal(config.persistenceConfig.redisNamespace, "env-ns");
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

test("redisNamespace is loaded from config file and passable through env override", async () => {
  await withTempDir(async (tempDir) => {
    await writeFile(
      join(tempDir, "server.config.json"),
      JSON.stringify({
        persistence: {
          redisNamespace: "from-file",
        },
      }),
      "utf8",
    );

    const configFromFile = await loadRuntimeConfig({}, { cwd: tempDir });
    assert.equal(configFromFile.persistenceConfig.redisNamespace, "from-file");

    const configFromEnv = await loadRuntimeConfig(
      { REDIS_NAMESPACE: "from-env" },
      { cwd: tempDir },
    );
    assert.equal(configFromEnv.persistenceConfig.redisNamespace, "from-env");
  });
});

test("runtime config loads logLevel from env and config file", async () => {
  await withTempDir(async (tempDir) => {
    const envConfig = await loadRuntimeConfig(
      { LOG_LEVEL: "warn" },
      { cwd: tempDir },
    );
    assert.equal(envConfig.logLevel, "warn");

    await writeFile(
      join(tempDir, "server.config.json"),
      JSON.stringify({ logLevel: "debug" }),
      "utf8",
    );
    const fileConfig = await loadRuntimeConfig({}, { cwd: tempDir });
    assert.equal(fileConfig.logLevel, "debug");

    const envOverride = await loadRuntimeConfig(
      { LOG_LEVEL: "error" },
      { cwd: tempDir },
    );
    assert.equal(envOverride.logLevel, "error");
  });
});

test("runtime config rejects invalid LOG_LEVEL values", async () => {
  await withTempDir(async (tempDir) => {
    await assert.rejects(
      () => loadRuntimeConfig({ LOG_LEVEL: "verbose" }, { cwd: tempDir }),
      /LOG_LEVEL/,
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

test("runtime config schema keeps file mapping and loaders in sync", async () => {
  await withTempDir(async (tempDir) => {
    const sampleConfig = buildConfigSample();
    const configEnv = configFileToEnv(sampleConfig);

    for (const field of SERVER_CONFIG_FIELDS) {
      assert.ok(
        configEnv[field.envName] !== undefined,
        `missing env mapping for ${field.path.join(".")}`,
      );
    }

    await writeFile(
      join(tempDir, "server.config.json"),
      JSON.stringify(sampleConfig),
      "utf8",
    );

    const runtimeConfig = await loadRuntimeConfig({}, { cwd: tempDir });
    for (const field of SERVER_CONFIG_FIELDS) {
      assert.deepEqual(
        readRuntimeValue(runtimeConfig, field.path),
        getConfigValue(sampleConfig as Record<string, unknown>, field.path),
        `runtime config drifted at ${field.path.join(".")}`,
      );
    }
  });
});
