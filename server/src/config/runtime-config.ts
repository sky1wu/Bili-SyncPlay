import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AdminConfig,
  AdminUiConfig,
  PersistenceConfig,
  SecurityConfig,
} from "../types.js";
import { loadAdminConfig, loadAdminUiConfig } from "./admin-config.js";
import type { EnvSource } from "./env.js";
import { parseIntegerEnv } from "./env.js";
import { loadPersistenceConfig } from "./persistence-config.js";
import { loadSecurityConfig } from "./security-config.js";

type JsonObject = Record<string, unknown>;

type SecurityConfigFile = {
  allowedOrigins?: string[];
  allowMissingOriginInDev?: boolean;
  trustedProxyAddresses?: string[];
  maxConnectionsPerIp?: number;
  connectionAttemptsPerMinute?: number;
  maxMembersPerRoom?: number;
  maxMessageBytes?: number;
  invalidMessageCloseThreshold?: number;
  rateLimits?: {
    roomCreatePerMinute?: number;
    roomJoinPerMinute?: number;
    videoSharePer10Seconds?: number;
    playbackUpdatePerSecond?: number;
    playbackUpdateBurst?: number;
    syncRequestPer10Seconds?: number;
    syncPingPerSecond?: number;
    syncPingBurst?: number;
  };
};

type PersistenceConfigFile = {
  provider?: "memory" | "redis";
  runtimeStoreProvider?: "memory" | "redis";
  roomEventBusProvider?: "none" | "memory" | "redis";
  adminCommandBusProvider?: "none" | "memory" | "redis";
  nodeHeartbeatEnabled?: boolean;
  nodeHeartbeatIntervalMs?: number;
  nodeHeartbeatTtlMs?: number;
  emptyRoomTtlMs?: number;
  roomCleanupIntervalMs?: number;
  redisUrl?: string;
  instanceId?: string;
};

type AdminUiConfigFile = {
  demoEnabled?: boolean;
  apiBaseUrl?: string;
  enabled?: boolean;
};

export type ServerConfigFile = {
  port?: number;
  globalAdminPort?: number;
  security?: SecurityConfigFile;
  persistence?: PersistenceConfigFile;
  adminUi?: AdminUiConfigFile;
};

export type RuntimeConfig = {
  port: number;
  globalAdminPort: number;
  securityConfig: SecurityConfig;
  persistenceConfig: PersistenceConfig;
  adminConfig: AdminConfig;
  adminUiConfig: AdminUiConfig;
};

const DEFAULT_CONFIG_FILE = "server.config.json";
const CONFIG_PATH_ENV = "BILI_SYNCPLAY_CONFIG";

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(
  scope: string,
  value: JsonObject,
  allowedKeys: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Unsupported config key "${scope}${key}".`);
    }
  }
}

function assertOptionalNumber(
  scope: string,
  value: unknown,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Config field "${scope}" must be a finite number.`);
  }
  return value;
}

function assertOptionalBoolean(
  scope: string,
  value: unknown,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Config field "${scope}" must be a boolean.`);
  }
  return value;
}

function assertOptionalString(
  scope: string,
  value: unknown,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Config field "${scope}" must be a string.`);
  }
  return value;
}

function assertOptionalStringArray(
  scope: string,
  value: unknown,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`Config field "${scope}" must be an array of strings.`);
  }
  return value;
}

function parseOptionalObject<T extends JsonObject>(
  scope: string,
  value: unknown,
  allowedKeys: readonly string[],
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error(`Config field "${scope}" must be an object.`);
  }
  assertAllowedKeys(`${scope}.`, value, allowedKeys);
  return value as T;
}

function parseConfigFileShape(raw: unknown): ServerConfigFile {
  if (!isPlainObject(raw)) {
    throw new Error("Config file root must be a JSON object.");
  }

  assertAllowedKeys("", raw, [
    "port",
    "globalAdminPort",
    "security",
    "persistence",
    "adminUi",
  ]);

  const security = parseOptionalObject<JsonObject>("security", raw.security, [
    "allowedOrigins",
    "allowMissingOriginInDev",
    "trustedProxyAddresses",
    "maxConnectionsPerIp",
    "connectionAttemptsPerMinute",
    "maxMembersPerRoom",
    "maxMessageBytes",
    "invalidMessageCloseThreshold",
    "rateLimits",
  ]);
  const securityRateLimits = parseOptionalObject<JsonObject>(
    "security.rateLimits",
    security?.rateLimits,
    [
      "roomCreatePerMinute",
      "roomJoinPerMinute",
      "videoSharePer10Seconds",
      "playbackUpdatePerSecond",
      "playbackUpdateBurst",
      "syncRequestPer10Seconds",
      "syncPingPerSecond",
      "syncPingBurst",
    ],
  );
  const persistence = parseOptionalObject<JsonObject>(
    "persistence",
    raw.persistence,
    [
      "provider",
      "runtimeStoreProvider",
      "roomEventBusProvider",
      "adminCommandBusProvider",
      "nodeHeartbeatEnabled",
      "nodeHeartbeatIntervalMs",
      "nodeHeartbeatTtlMs",
      "emptyRoomTtlMs",
      "roomCleanupIntervalMs",
      "redisUrl",
      "instanceId",
    ],
  );
  const adminUi = parseOptionalObject<JsonObject>("adminUi", raw.adminUi, [
    "demoEnabled",
    "apiBaseUrl",
    "enabled",
  ]);

  return {
    port: assertOptionalNumber("port", raw.port),
    globalAdminPort: assertOptionalNumber(
      "globalAdminPort",
      raw.globalAdminPort,
    ),
    security: security
      ? {
          allowedOrigins: assertOptionalStringArray(
            "security.allowedOrigins",
            security.allowedOrigins,
          ),
          allowMissingOriginInDev: assertOptionalBoolean(
            "security.allowMissingOriginInDev",
            security.allowMissingOriginInDev,
          ),
          trustedProxyAddresses: assertOptionalStringArray(
            "security.trustedProxyAddresses",
            security.trustedProxyAddresses,
          ),
          maxConnectionsPerIp: assertOptionalNumber(
            "security.maxConnectionsPerIp",
            security.maxConnectionsPerIp,
          ),
          connectionAttemptsPerMinute: assertOptionalNumber(
            "security.connectionAttemptsPerMinute",
            security.connectionAttemptsPerMinute,
          ),
          maxMembersPerRoom: assertOptionalNumber(
            "security.maxMembersPerRoom",
            security.maxMembersPerRoom,
          ),
          maxMessageBytes: assertOptionalNumber(
            "security.maxMessageBytes",
            security.maxMessageBytes,
          ),
          invalidMessageCloseThreshold: assertOptionalNumber(
            "security.invalidMessageCloseThreshold",
            security.invalidMessageCloseThreshold,
          ),
          rateLimits: securityRateLimits
            ? {
                roomCreatePerMinute: assertOptionalNumber(
                  "security.rateLimits.roomCreatePerMinute",
                  securityRateLimits.roomCreatePerMinute,
                ),
                roomJoinPerMinute: assertOptionalNumber(
                  "security.rateLimits.roomJoinPerMinute",
                  securityRateLimits.roomJoinPerMinute,
                ),
                videoSharePer10Seconds: assertOptionalNumber(
                  "security.rateLimits.videoSharePer10Seconds",
                  securityRateLimits.videoSharePer10Seconds,
                ),
                playbackUpdatePerSecond: assertOptionalNumber(
                  "security.rateLimits.playbackUpdatePerSecond",
                  securityRateLimits.playbackUpdatePerSecond,
                ),
                playbackUpdateBurst: assertOptionalNumber(
                  "security.rateLimits.playbackUpdateBurst",
                  securityRateLimits.playbackUpdateBurst,
                ),
                syncRequestPer10Seconds: assertOptionalNumber(
                  "security.rateLimits.syncRequestPer10Seconds",
                  securityRateLimits.syncRequestPer10Seconds,
                ),
                syncPingPerSecond: assertOptionalNumber(
                  "security.rateLimits.syncPingPerSecond",
                  securityRateLimits.syncPingPerSecond,
                ),
                syncPingBurst: assertOptionalNumber(
                  "security.rateLimits.syncPingBurst",
                  securityRateLimits.syncPingBurst,
                ),
              }
            : undefined,
        }
      : undefined,
    persistence: persistence
      ? {
          provider: assertOptionalString(
            "persistence.provider",
            persistence.provider,
          ) as PersistenceConfigFile["provider"],
          runtimeStoreProvider: assertOptionalString(
            "persistence.runtimeStoreProvider",
            persistence.runtimeStoreProvider,
          ) as PersistenceConfigFile["runtimeStoreProvider"],
          roomEventBusProvider: assertOptionalString(
            "persistence.roomEventBusProvider",
            persistence.roomEventBusProvider,
          ) as PersistenceConfigFile["roomEventBusProvider"],
          adminCommandBusProvider: assertOptionalString(
            "persistence.adminCommandBusProvider",
            persistence.adminCommandBusProvider,
          ) as PersistenceConfigFile["adminCommandBusProvider"],
          nodeHeartbeatEnabled: assertOptionalBoolean(
            "persistence.nodeHeartbeatEnabled",
            persistence.nodeHeartbeatEnabled,
          ),
          nodeHeartbeatIntervalMs: assertOptionalNumber(
            "persistence.nodeHeartbeatIntervalMs",
            persistence.nodeHeartbeatIntervalMs,
          ),
          nodeHeartbeatTtlMs: assertOptionalNumber(
            "persistence.nodeHeartbeatTtlMs",
            persistence.nodeHeartbeatTtlMs,
          ),
          emptyRoomTtlMs: assertOptionalNumber(
            "persistence.emptyRoomTtlMs",
            persistence.emptyRoomTtlMs,
          ),
          roomCleanupIntervalMs: assertOptionalNumber(
            "persistence.roomCleanupIntervalMs",
            persistence.roomCleanupIntervalMs,
          ),
          redisUrl: assertOptionalString(
            "persistence.redisUrl",
            persistence.redisUrl,
          ),
          instanceId: assertOptionalString(
            "persistence.instanceId",
            persistence.instanceId,
          ),
        }
      : undefined,
    adminUi: adminUi
      ? {
          demoEnabled: assertOptionalBoolean(
            "adminUi.demoEnabled",
            adminUi.demoEnabled,
          ),
          apiBaseUrl: assertOptionalString(
            "adminUi.apiBaseUrl",
            adminUi.apiBaseUrl,
          ),
          enabled: assertOptionalBoolean("adminUi.enabled", adminUi.enabled),
        }
      : undefined,
  };
}

async function readServerConfigFile(
  env: EnvSource,
  cwd: string,
): Promise<ServerConfigFile> {
  const configuredPath = env[CONFIG_PATH_ENV]?.trim();
  const absolutePath = resolve(cwd, configuredPath || DEFAULT_CONFIG_FILE);

  try {
    const fileContent = await readFile(absolutePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(fileContent) as unknown;
    } catch (error) {
      throw new Error(
        `Failed to parse JSON config file at ${absolutePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return parseConfigFileShape(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(
      `Failed to load config file at ${absolutePath}: ${String(error)}`,
    );
  }
}

function setEnvValue(
  env: EnvSource,
  name: string,
  value: string | number | boolean | string[] | undefined,
): void {
  if (value === undefined) {
    return;
  }
  env[name] = Array.isArray(value) ? value.join(",") : String(value);
}

export function configFileToEnv(fileConfig: ServerConfigFile): EnvSource {
  const env: EnvSource = {};

  setEnvValue(env, "PORT", fileConfig.port);
  setEnvValue(env, "GLOBAL_ADMIN_PORT", fileConfig.globalAdminPort);
  setEnvValue(env, "ALLOWED_ORIGINS", fileConfig.security?.allowedOrigins);
  setEnvValue(
    env,
    "ALLOW_MISSING_ORIGIN_IN_DEV",
    fileConfig.security?.allowMissingOriginInDev,
  );
  setEnvValue(
    env,
    "TRUSTED_PROXY_ADDRESSES",
    fileConfig.security?.trustedProxyAddresses,
  );
  setEnvValue(
    env,
    "MAX_CONNECTIONS_PER_IP",
    fileConfig.security?.maxConnectionsPerIp,
  );
  setEnvValue(
    env,
    "CONNECTION_ATTEMPTS_PER_MINUTE",
    fileConfig.security?.connectionAttemptsPerMinute,
  );
  setEnvValue(
    env,
    "MAX_MEMBERS_PER_ROOM",
    fileConfig.security?.maxMembersPerRoom,
  );
  setEnvValue(env, "MAX_MESSAGE_BYTES", fileConfig.security?.maxMessageBytes);
  setEnvValue(
    env,
    "INVALID_MESSAGE_CLOSE_THRESHOLD",
    fileConfig.security?.invalidMessageCloseThreshold,
  );
  setEnvValue(
    env,
    "RATE_LIMIT_ROOM_CREATE_PER_MINUTE",
    fileConfig.security?.rateLimits?.roomCreatePerMinute,
  );
  setEnvValue(
    env,
    "RATE_LIMIT_ROOM_JOIN_PER_MINUTE",
    fileConfig.security?.rateLimits?.roomJoinPerMinute,
  );
  setEnvValue(
    env,
    "RATE_LIMIT_VIDEO_SHARE_PER_10_SECONDS",
    fileConfig.security?.rateLimits?.videoSharePer10Seconds,
  );
  setEnvValue(
    env,
    "RATE_LIMIT_PLAYBACK_UPDATE_PER_SECOND",
    fileConfig.security?.rateLimits?.playbackUpdatePerSecond,
  );
  setEnvValue(
    env,
    "RATE_LIMIT_PLAYBACK_UPDATE_BURST",
    fileConfig.security?.rateLimits?.playbackUpdateBurst,
  );
  setEnvValue(
    env,
    "RATE_LIMIT_SYNC_REQUEST_PER_10_SECONDS",
    fileConfig.security?.rateLimits?.syncRequestPer10Seconds,
  );
  setEnvValue(
    env,
    "RATE_LIMIT_SYNC_PING_PER_SECOND",
    fileConfig.security?.rateLimits?.syncPingPerSecond,
  );
  setEnvValue(
    env,
    "RATE_LIMIT_SYNC_PING_BURST",
    fileConfig.security?.rateLimits?.syncPingBurst,
  );
  setEnvValue(env, "ROOM_STORE_PROVIDER", fileConfig.persistence?.provider);
  setEnvValue(
    env,
    "RUNTIME_STORE_PROVIDER",
    fileConfig.persistence?.runtimeStoreProvider,
  );
  setEnvValue(
    env,
    "ROOM_EVENT_BUS_PROVIDER",
    fileConfig.persistence?.roomEventBusProvider,
  );
  setEnvValue(
    env,
    "ADMIN_COMMAND_BUS_PROVIDER",
    fileConfig.persistence?.adminCommandBusProvider,
  );
  setEnvValue(
    env,
    "NODE_HEARTBEAT_ENABLED",
    fileConfig.persistence?.nodeHeartbeatEnabled,
  );
  setEnvValue(
    env,
    "NODE_HEARTBEAT_INTERVAL_MS",
    fileConfig.persistence?.nodeHeartbeatIntervalMs,
  );
  setEnvValue(
    env,
    "NODE_HEARTBEAT_TTL_MS",
    fileConfig.persistence?.nodeHeartbeatTtlMs,
  );
  setEnvValue(env, "EMPTY_ROOM_TTL_MS", fileConfig.persistence?.emptyRoomTtlMs);
  setEnvValue(
    env,
    "ROOM_CLEANUP_INTERVAL_MS",
    fileConfig.persistence?.roomCleanupIntervalMs,
  );
  setEnvValue(env, "REDIS_URL", fileConfig.persistence?.redisUrl);
  setEnvValue(env, "INSTANCE_ID", fileConfig.persistence?.instanceId);
  setEnvValue(env, "ADMIN_UI_DEMO_ENABLED", fileConfig.adminUi?.demoEnabled);
  setEnvValue(env, "GLOBAL_ADMIN_API_BASE_URL", fileConfig.adminUi?.apiBaseUrl);
  setEnvValue(env, "GLOBAL_ADMIN_ENABLED", fileConfig.adminUi?.enabled);

  return env;
}

export async function loadRuntimeConfig(
  env: EnvSource = process.env,
  options: { cwd?: string } = {},
): Promise<RuntimeConfig> {
  const cwd = options.cwd ?? process.cwd();
  const fileConfig = await readServerConfigFile(env, cwd);
  const mergedEnv = {
    ...configFileToEnv(fileConfig),
    ...env,
  };

  return {
    port: parseIntegerEnv(mergedEnv, "PORT", 8787),
    globalAdminPort: parseIntegerEnv(
      mergedEnv,
      "GLOBAL_ADMIN_PORT",
      parseIntegerEnv(mergedEnv, "PORT", 8788),
    ),
    securityConfig: loadSecurityConfig(mergedEnv),
    persistenceConfig: loadPersistenceConfig(mergedEnv),
    adminConfig: loadAdminConfig(env),
    adminUiConfig: loadAdminUiConfig(mergedEnv),
  };
}
