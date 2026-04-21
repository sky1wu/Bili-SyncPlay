import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AdminConfig,
  AdminUiConfig,
  LogLevel,
  PersistenceConfig,
  SecurityConfig,
} from "../types.js";
import { loadAdminConfig, loadAdminUiConfig } from "./admin-config.js";
import type { EnvSource } from "./env.js";
import { parseIntegerEnv } from "./env.js";
import { loadPersistenceConfig } from "./persistence-config.js";
import {
  getConfigValue,
  parseConfigEnvFieldValue,
  parseConfigFileFieldValue,
  SERVER_CONFIG_FIELDS,
  SERVER_CONFIG_SCHEMA_TREE,
} from "./runtime-config-schema.js";
import { loadSecurityConfig } from "./security-config.js";

const LOG_LEVEL_FIELD = SERVER_CONFIG_FIELDS.find(
  (field) => field.path[0] === "logLevel",
)!;

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
  redisNamespace?: string;
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
  logLevel?: LogLevel;
  security?: SecurityConfigFile;
  persistence?: PersistenceConfigFile;
  adminUi?: AdminUiConfigFile;
};

export type RuntimeConfig = {
  port: number;
  globalAdminPort: number;
  logLevel: LogLevel;
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

function parseConfigNode(
  node: typeof SERVER_CONFIG_SCHEMA_TREE,
  scope: string,
  value: unknown,
): unknown {
  if (node.field) {
    return parseConfigFileFieldValue(node.field, scope, value);
  }

  if (scope.length === 0) {
    if (!isPlainObject(value)) {
      throw new Error("Config file root must be a JSON object.");
    }
  } else if (value === undefined) {
    return undefined;
  }

  const objectValue =
    scope.length === 0
      ? (value as JsonObject)
      : parseOptionalObject<JsonObject>(scope, value, [
          ...node.children.keys(),
        ]);
  if (objectValue === undefined) {
    return undefined;
  }

  if (scope.length === 0) {
    assertAllowedKeys("", objectValue, [...node.children.keys()]);
  }

  const parsed: JsonObject = {};
  for (const [key, childNode] of node.children) {
    const childScope = scope ? `${scope}.${key}` : key;
    const childValue = parseConfigNode(childNode, childScope, objectValue[key]);
    if (childValue !== undefined) {
      parsed[key] = childValue;
    }
  }

  return parsed;
}

function parseConfigFileShape(raw: unknown): ServerConfigFile {
  return parseConfigNode(
    SERVER_CONFIG_SCHEMA_TREE,
    "",
    raw,
  ) as ServerConfigFile;
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
  for (const field of SERVER_CONFIG_FIELDS) {
    setEnvValue(
      env,
      field.envName,
      getConfigValue(fileConfig as JsonObject, field.path) as
        | string
        | number
        | boolean
        | string[]
        | undefined,
    );
  }

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
    logLevel: parseConfigEnvFieldValue<LogLevel>(
      LOG_LEVEL_FIELD,
      mergedEnv,
      "info",
    ),
    securityConfig: loadSecurityConfig(mergedEnv),
    persistenceConfig: loadPersistenceConfig(mergedEnv),
    adminConfig: loadAdminConfig(env),
    adminUiConfig: loadAdminUiConfig(mergedEnv),
  };
}
