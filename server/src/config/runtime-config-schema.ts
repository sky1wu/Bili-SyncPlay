import type {
  AdminUiConfig,
  PersistenceConfig,
  SecurityConfig,
} from "../types.js";
import type { EnvSource } from "./env.js";
import {
  parseBooleanEnv,
  parseCsvEnv,
  parseIntegerEnv,
  parsePositiveIntegerEnv,
  readTrimmedEnv,
} from "./env.js";

type ConfigValueKind =
  | "integer"
  | "positiveInteger"
  | "boolean"
  | "string"
  | "stringArray"
  | "enum";

export type ConfigField = {
  path: readonly [string, ...string[]];
  envName: string;
  kind: ConfigValueKind;
  enumValues?: readonly string[];
};

type SchemaNode = {
  field?: ConfigField;
  children: Map<string, SchemaNode>;
};

type ConfigObject = Record<string, unknown>;

function createField(
  path: ConfigField["path"],
  envName: string,
  kind: ConfigField["kind"],
  enumValues?: readonly string[],
): ConfigField {
  return { path, envName, kind, enumValues };
}

export const SERVER_CONFIG_FIELDS = [
  createField(["port"], "PORT", "integer"),
  createField(["globalAdminPort"], "GLOBAL_ADMIN_PORT", "integer"),
  createField(["logLevel"], "LOG_LEVEL", "enum", [
    "debug",
    "info",
    "warn",
    "error",
  ]),
  createField(["security", "allowedOrigins"], "ALLOWED_ORIGINS", "stringArray"),
  createField(
    ["security", "allowMissingOriginInDev"],
    "ALLOW_MISSING_ORIGIN_IN_DEV",
    "boolean",
  ),
  createField(
    ["security", "trustedProxyAddresses"],
    "TRUSTED_PROXY_ADDRESSES",
    "stringArray",
  ),
  createField(
    ["security", "maxConnectionsPerIp"],
    "MAX_CONNECTIONS_PER_IP",
    "positiveInteger",
  ),
  createField(
    ["security", "connectionAttemptsPerMinute"],
    "CONNECTION_ATTEMPTS_PER_MINUTE",
    "positiveInteger",
  ),
  createField(
    ["security", "maxMembersPerRoom"],
    "MAX_MEMBERS_PER_ROOM",
    "positiveInteger",
  ),
  createField(
    ["security", "maxMessageBytes"],
    "MAX_MESSAGE_BYTES",
    "positiveInteger",
  ),
  createField(
    ["security", "invalidMessageCloseThreshold"],
    "INVALID_MESSAGE_CLOSE_THRESHOLD",
    "positiveInteger",
  ),
  createField(
    ["security", "rateLimits", "roomCreatePerMinute"],
    "RATE_LIMIT_ROOM_CREATE_PER_MINUTE",
    "positiveInteger",
  ),
  createField(
    ["security", "rateLimits", "roomJoinPerMinute"],
    "RATE_LIMIT_ROOM_JOIN_PER_MINUTE",
    "positiveInteger",
  ),
  createField(
    ["security", "rateLimits", "videoSharePer10Seconds"],
    "RATE_LIMIT_VIDEO_SHARE_PER_10_SECONDS",
    "positiveInteger",
  ),
  createField(
    ["security", "rateLimits", "playbackUpdatePerSecond"],
    "RATE_LIMIT_PLAYBACK_UPDATE_PER_SECOND",
    "positiveInteger",
  ),
  createField(
    ["security", "rateLimits", "playbackUpdateBurst"],
    "RATE_LIMIT_PLAYBACK_UPDATE_BURST",
    "positiveInteger",
  ),
  createField(
    ["security", "rateLimits", "syncRequestPer10Seconds"],
    "RATE_LIMIT_SYNC_REQUEST_PER_10_SECONDS",
    "positiveInteger",
  ),
  createField(
    ["security", "rateLimits", "syncPingPerSecond"],
    "RATE_LIMIT_SYNC_PING_PER_SECOND",
    "positiveInteger",
  ),
  createField(
    ["security", "rateLimits", "syncPingBurst"],
    "RATE_LIMIT_SYNC_PING_BURST",
    "positiveInteger",
  ),
  createField(["persistence", "provider"], "ROOM_STORE_PROVIDER", "enum", [
    "memory",
    "redis",
  ]),
  createField(
    ["persistence", "runtimeStoreProvider"],
    "RUNTIME_STORE_PROVIDER",
    "enum",
    ["memory", "redis"],
  ),
  createField(
    ["persistence", "roomEventBusProvider"],
    "ROOM_EVENT_BUS_PROVIDER",
    "enum",
    ["none", "memory", "redis"],
  ),
  createField(
    ["persistence", "adminCommandBusProvider"],
    "ADMIN_COMMAND_BUS_PROVIDER",
    "enum",
    ["none", "memory", "redis"],
  ),
  createField(
    ["persistence", "nodeHeartbeatEnabled"],
    "NODE_HEARTBEAT_ENABLED",
    "boolean",
  ),
  createField(
    ["persistence", "nodeHeartbeatIntervalMs"],
    "NODE_HEARTBEAT_INTERVAL_MS",
    "positiveInteger",
  ),
  createField(
    ["persistence", "nodeHeartbeatTtlMs"],
    "NODE_HEARTBEAT_TTL_MS",
    "positiveInteger",
  ),
  createField(
    ["persistence", "emptyRoomTtlMs"],
    "EMPTY_ROOM_TTL_MS",
    "positiveInteger",
  ),
  createField(
    ["persistence", "roomCleanupIntervalMs"],
    "ROOM_CLEANUP_INTERVAL_MS",
    "positiveInteger",
  ),
  createField(["persistence", "redisUrl"], "REDIS_URL", "string"),
  createField(["persistence", "redisNamespace"], "REDIS_NAMESPACE", "string"),
  createField(["persistence", "instanceId"], "INSTANCE_ID", "string"),
  createField(["adminUi", "demoEnabled"], "ADMIN_UI_DEMO_ENABLED", "boolean"),
  createField(["adminUi", "apiBaseUrl"], "GLOBAL_ADMIN_API_BASE_URL", "string"),
  createField(["adminUi", "enabled"], "GLOBAL_ADMIN_ENABLED", "boolean"),
] as const satisfies readonly ConfigField[];

export const SECURITY_CONFIG_FIELDS = SERVER_CONFIG_FIELDS.filter(
  (field) => field.path[0] === "security",
);
export const PERSISTENCE_CONFIG_FIELDS = SERVER_CONFIG_FIELDS.filter(
  (field) => field.path[0] === "persistence",
);
export const ADMIN_UI_CONFIG_FIELDS = SERVER_CONFIG_FIELDS.filter(
  (field) => field.path[0] === "adminUi",
);

export const PERSISTENCE_PROVIDER_FIELD = PERSISTENCE_CONFIG_FIELDS.find(
  (field) => field.path[1] === "provider",
)!;
export const PERSISTENCE_RUNTIME_STORE_PROVIDER_FIELD =
  PERSISTENCE_CONFIG_FIELDS.find(
    (field) => field.path[1] === "runtimeStoreProvider",
  )!;
export const PERSISTENCE_ROOM_EVENT_BUS_PROVIDER_FIELD =
  PERSISTENCE_CONFIG_FIELDS.find(
    (field) => field.path[1] === "roomEventBusProvider",
  )!;
export const PERSISTENCE_ADMIN_COMMAND_BUS_PROVIDER_FIELD =
  PERSISTENCE_CONFIG_FIELDS.find(
    (field) => field.path[1] === "adminCommandBusProvider",
  )!;

function createSchemaTree(fields: readonly ConfigField[]): SchemaNode {
  const root: SchemaNode = { children: new Map() };

  for (const field of fields) {
    let node = root;
    for (const segment of field.path) {
      const child = node.children.get(segment) ?? { children: new Map() };
      node.children.set(segment, child);
      node = child;
    }
    node.field = field;
  }

  return root;
}

export const SERVER_CONFIG_SCHEMA_TREE = createSchemaTree(SERVER_CONFIG_FIELDS);

export function getConfigValue(
  source: ConfigObject | undefined,
  path: readonly string[],
): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as ConfigObject)[segment];
  }
  return current;
}

export function setConfigValue(
  target: ConfigObject,
  path: readonly string[],
  value: unknown,
): void {
  let current = target;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as ConfigObject;
  }
  current[path[path.length - 1]!] = value;
}

function assertFiniteNumber(scope: string, value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Config field "${scope}" must be a finite number.`);
  }
  return value;
}

function assertBoolean(scope: string, value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Config field "${scope}" must be a boolean.`);
  }
  return value;
}

function assertString(scope: string, value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Config field "${scope}" must be a string.`);
  }
  return value;
}

function assertStringArray(
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

export function parseConfigFileFieldValue(
  field: ConfigField,
  scope: string,
  value: unknown,
): unknown {
  switch (field.kind) {
    case "integer":
    case "positiveInteger":
      return assertFiniteNumber(scope, value);
    case "boolean":
      return assertBoolean(scope, value);
    case "string":
    case "enum":
      return assertString(scope, value);
    case "stringArray":
      return assertStringArray(scope, value);
  }
}

export function parseConfigEnvFieldValue<T>(
  field: ConfigField,
  env: EnvSource,
  fallback: T,
): T {
  switch (field.kind) {
    case "integer":
      return parseIntegerEnv(env, field.envName, fallback as number) as T;
    case "positiveInteger":
      return parsePositiveIntegerEnv(
        env,
        field.envName,
        fallback as number,
      ) as T;
    case "boolean":
      return parseBooleanEnv(env, field.envName, fallback as boolean) as T;
    case "stringArray":
      return parseCsvEnv(env, field.envName, fallback as string[]) as T;
    case "string":
      return (readTrimmedEnv(env, field.envName) ?? fallback) as T;
    case "enum": {
      const rawValue = env[field.envName];
      if (rawValue === undefined || rawValue === "") {
        return fallback;
      }
      if (field.enumValues?.includes(rawValue)) {
        return rawValue as T;
      }
      throw new Error(
        `Environment variable ${field.envName} must be one of ${field.enumValues
          ?.map((value) => `"${value}"`)
          .join(", ")}.`,
      );
    }
  }
}

export function loadSectionConfigFromEnv<T extends ConfigObject>(
  env: EnvSource,
  defaults: T,
  fields: readonly ConfigField[],
  fallbackOverrides: Partial<Record<string, unknown>> = {},
): T {
  const config: ConfigObject = {};

  for (const field of fields) {
    const localPath = field.path.slice(1);
    const fieldKey = field.path.join(".");
    const fallback =
      fieldKey in fallbackOverrides
        ? fallbackOverrides[fieldKey]
        : getConfigValue(defaults, localPath);

    setConfigValue(
      config,
      localPath,
      parseConfigEnvFieldValue(field, env, fallback),
    );
  }

  return config as T;
}

export function getSectionFields(
  sectionName: "security" | "persistence" | "adminUi",
): readonly ConfigField[] {
  switch (sectionName) {
    case "security":
      return SECURITY_CONFIG_FIELDS;
    case "persistence":
      return PERSISTENCE_CONFIG_FIELDS;
    case "adminUi":
      return ADMIN_UI_CONFIG_FIELDS;
  }
}

export function getDefaultConfigSampleValue(field: ConfigField): unknown {
  switch (field.kind) {
    case "integer":
      return field.path[0] === "port" ? 9001 : 9002;
    case "positiveInteger":
      return 7;
    case "boolean":
      return true;
    case "string":
      return `${field.envName.toLowerCase()}-sample`;
    case "stringArray":
      return [
        `https://${field.envName.toLowerCase()}-a.example`,
        `https://${field.envName.toLowerCase()}-b.example`,
      ];
    case "enum":
      return field.enumValues?.[field.enumValues.length - 1];
  }
}

export type SecurityConfigShape = SecurityConfig;
export type PersistenceConfigShape = PersistenceConfig;
export type AdminUiConfigShape = AdminUiConfig;
