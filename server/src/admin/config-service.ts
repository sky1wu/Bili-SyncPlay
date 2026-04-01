import type {
  AdminConfig,
  PersistenceConfig,
  SecurityConfig,
} from "../types.js";

export function createAdminConfigService(options: {
  adminConfig: AdminConfig;
  persistenceConfig: PersistenceConfig;
  securityConfig: SecurityConfig;
}) {
  return {
    getSummary() {
      return {
        instanceId: options.persistenceConfig.instanceId,
        persistence: {
          provider: options.persistenceConfig.provider,
          emptyRoomTtlMs: options.persistenceConfig.emptyRoomTtlMs,
          roomCleanupIntervalMs:
            options.persistenceConfig.roomCleanupIntervalMs,
          redisConfigured: options.persistenceConfig.provider === "redis",
        },
        security: {
          allowedOrigins: options.securityConfig.allowedOrigins,
          allowMissingOriginInDev:
            options.securityConfig.allowMissingOriginInDev,
          trustedProxyAddresses: options.securityConfig.trustedProxyAddresses,
          maxConnectionsPerIp: options.securityConfig.maxConnectionsPerIp,
          connectionAttemptsPerMinute:
            options.securityConfig.connectionAttemptsPerMinute,
          maxMembersPerRoom: options.securityConfig.maxMembersPerRoom,
          maxMessageBytes: options.securityConfig.maxMessageBytes,
          invalidMessageCloseThreshold:
            options.securityConfig.invalidMessageCloseThreshold,
          rateLimits: options.securityConfig.rateLimits,
        },
        admin: options.adminConfig
          ? {
              configured: true,
              username: options.adminConfig.username,
              role: options.adminConfig.role,
              sessionTtlMs: options.adminConfig.sessionTtlMs,
            }
          : {
              configured: false,
            },
      };
    },
  };
}
