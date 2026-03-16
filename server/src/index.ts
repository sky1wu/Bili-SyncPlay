import {
  createSyncServer,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
  type AdminConfig,
  type AdminUiConfig,
  type PersistenceConfig,
  type SecurityConfig
} from "./app.js";

const port = parseIntegerEnv("PORT", 8787);
const securityConfig = loadSecurityConfig();
const persistenceConfig = loadPersistenceConfig();
const adminConfig = loadAdminConfig();
const adminUiConfig = loadAdminUiConfig();

const { httpServer } = await createSyncServer(securityConfig, persistenceConfig, {
  adminConfig,
  adminUiConfig
});
httpServer.listen(port, () => {
  console.log(`Bili-SyncPlay server listening on http://localhost:${port}`);
});

function loadSecurityConfig(): SecurityConfig {
  const defaults = getDefaultSecurityConfig();

  return {
    ...defaults,
    allowedOrigins: parseCsvEnv("ALLOWED_ORIGINS", defaults.allowedOrigins),
    allowMissingOriginInDev: parseBooleanEnv("ALLOW_MISSING_ORIGIN_IN_DEV", defaults.allowMissingOriginInDev),
    trustProxyHeaders: parseBooleanEnv("TRUST_PROXY_HEADERS", defaults.trustProxyHeaders),
    maxConnectionsPerIp: parsePositiveIntegerEnv("MAX_CONNECTIONS_PER_IP", defaults.maxConnectionsPerIp),
    connectionAttemptsPerMinute: parsePositiveIntegerEnv(
      "CONNECTION_ATTEMPTS_PER_MINUTE",
      defaults.connectionAttemptsPerMinute
    ),
    maxMembersPerRoom: parsePositiveIntegerEnv("MAX_MEMBERS_PER_ROOM", defaults.maxMembersPerRoom),
    maxMessageBytes: parsePositiveIntegerEnv("MAX_MESSAGE_BYTES", defaults.maxMessageBytes),
    invalidMessageCloseThreshold: parsePositiveIntegerEnv(
      "INVALID_MESSAGE_CLOSE_THRESHOLD",
      defaults.invalidMessageCloseThreshold
    ),
    rateLimits: {
      roomCreatePerMinute: parsePositiveIntegerEnv(
        "RATE_LIMIT_ROOM_CREATE_PER_MINUTE",
        defaults.rateLimits.roomCreatePerMinute
      ),
      roomJoinPerMinute: parsePositiveIntegerEnv("RATE_LIMIT_ROOM_JOIN_PER_MINUTE", defaults.rateLimits.roomJoinPerMinute),
      videoSharePer10Seconds: parsePositiveIntegerEnv(
        "RATE_LIMIT_VIDEO_SHARE_PER_10_SECONDS",
        defaults.rateLimits.videoSharePer10Seconds
      ),
      playbackUpdatePerSecond: parsePositiveIntegerEnv(
        "RATE_LIMIT_PLAYBACK_UPDATE_PER_SECOND",
        defaults.rateLimits.playbackUpdatePerSecond
      ),
      playbackUpdateBurst: parsePositiveIntegerEnv(
        "RATE_LIMIT_PLAYBACK_UPDATE_BURST",
        defaults.rateLimits.playbackUpdateBurst
      ),
      syncRequestPer10Seconds: parsePositiveIntegerEnv(
        "RATE_LIMIT_SYNC_REQUEST_PER_10_SECONDS",
        defaults.rateLimits.syncRequestPer10Seconds
      ),
      syncPingPerSecond: parsePositiveIntegerEnv("RATE_LIMIT_SYNC_PING_PER_SECOND", defaults.rateLimits.syncPingPerSecond),
      syncPingBurst: parsePositiveIntegerEnv("RATE_LIMIT_SYNC_PING_BURST", defaults.rateLimits.syncPingBurst)
    }
  };
}

function loadPersistenceConfig(): PersistenceConfig {
  const defaults = getDefaultPersistenceConfig();
  const provider = parseProviderEnv("ROOM_STORE_PROVIDER", defaults.provider);

  return {
    provider,
    emptyRoomTtlMs: parsePositiveIntegerEnv("EMPTY_ROOM_TTL_MS", defaults.emptyRoomTtlMs),
    roomCleanupIntervalMs: parsePositiveIntegerEnv("ROOM_CLEANUP_INTERVAL_MS", defaults.roomCleanupIntervalMs),
    redisUrl: process.env.REDIS_URL?.trim() || defaults.redisUrl,
    instanceId: process.env.INSTANCE_ID?.trim() || defaults.instanceId
  };
}

function loadAdminConfig(): AdminConfig {
  const username = process.env.ADMIN_USERNAME?.trim();
  const passwordHash = process.env.ADMIN_PASSWORD_HASH?.trim();
  const sessionSecret = process.env.ADMIN_SESSION_SECRET?.trim();

  if (!username || !passwordHash || !sessionSecret) {
    return null;
  }

  const role = process.env.ADMIN_ROLE?.trim();
  return {
    username,
    passwordHash,
    sessionSecret,
    sessionTtlMs: parsePositiveIntegerEnv("ADMIN_SESSION_TTL_MS", 12 * 60 * 60 * 1000),
    role: role === "viewer" || role === "operator" || role === "admin" ? role : "admin"
  };
}

function loadAdminUiConfig(): AdminUiConfig {
  return {
    demoEnabled: parseBooleanEnv("ADMIN_UI_DEMO_ENABLED", false)
  };
}

function parseProviderEnv(name: string, fallback: PersistenceConfig["provider"]): PersistenceConfig["provider"] {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }
  if (rawValue === "memory" || rawValue === "redis") {
    return rawValue;
  }
  throw new Error(`Environment variable ${name} must be "memory" or "redis".`);
}

function parseCsvEnv(name: string, fallback: string[]): string[] {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  return rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return fallback;
  }

  if (rawValue === "true") {
    return true;
  }
  if (rawValue === "false") {
    return false;
  }

  throw new Error(`Environment variable ${name} must be "true" or "false".`);
}

function parseIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return fallback;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue)) {
    throw new Error(`Environment variable ${name} must be an integer.`);
  }
  return parsedValue;
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const parsedValue = parseIntegerEnv(name, fallback);
  if (parsedValue <= 0) {
    throw new Error(`Environment variable ${name} must be greater than 0.`);
  }
  return parsedValue;
}
