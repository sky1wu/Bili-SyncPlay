import { getDefaultSecurityConfig, type SecurityConfig } from "../app.js";
import type { EnvSource } from "./env.js";
import {
  parseBooleanEnv,
  parseCsvEnv,
  parsePositiveIntegerEnv,
} from "./env.js";

export function loadSecurityConfig(
  env: EnvSource = process.env,
): SecurityConfig {
  const defaults = getDefaultSecurityConfig();

  return {
    ...defaults,
    allowedOrigins: parseCsvEnv(
      env,
      "ALLOWED_ORIGINS",
      defaults.allowedOrigins,
    ),
    allowMissingOriginInDev: parseBooleanEnv(
      env,
      "ALLOW_MISSING_ORIGIN_IN_DEV",
      defaults.allowMissingOriginInDev,
    ),
    trustedProxyAddresses: parseCsvEnv(
      env,
      "TRUSTED_PROXY_ADDRESSES",
      defaults.trustedProxyAddresses,
    ),
    maxConnectionsPerIp: parsePositiveIntegerEnv(
      env,
      "MAX_CONNECTIONS_PER_IP",
      defaults.maxConnectionsPerIp,
    ),
    connectionAttemptsPerMinute: parsePositiveIntegerEnv(
      env,
      "CONNECTION_ATTEMPTS_PER_MINUTE",
      defaults.connectionAttemptsPerMinute,
    ),
    maxMembersPerRoom: parsePositiveIntegerEnv(
      env,
      "MAX_MEMBERS_PER_ROOM",
      defaults.maxMembersPerRoom,
    ),
    maxMessageBytes: parsePositiveIntegerEnv(
      env,
      "MAX_MESSAGE_BYTES",
      defaults.maxMessageBytes,
    ),
    invalidMessageCloseThreshold: parsePositiveIntegerEnv(
      env,
      "INVALID_MESSAGE_CLOSE_THRESHOLD",
      defaults.invalidMessageCloseThreshold,
    ),
    rateLimits: {
      roomCreatePerMinute: parsePositiveIntegerEnv(
        env,
        "RATE_LIMIT_ROOM_CREATE_PER_MINUTE",
        defaults.rateLimits.roomCreatePerMinute,
      ),
      roomJoinPerMinute: parsePositiveIntegerEnv(
        env,
        "RATE_LIMIT_ROOM_JOIN_PER_MINUTE",
        defaults.rateLimits.roomJoinPerMinute,
      ),
      videoSharePer10Seconds: parsePositiveIntegerEnv(
        env,
        "RATE_LIMIT_VIDEO_SHARE_PER_10_SECONDS",
        defaults.rateLimits.videoSharePer10Seconds,
      ),
      playbackUpdatePerSecond: parsePositiveIntegerEnv(
        env,
        "RATE_LIMIT_PLAYBACK_UPDATE_PER_SECOND",
        defaults.rateLimits.playbackUpdatePerSecond,
      ),
      playbackUpdateBurst: parsePositiveIntegerEnv(
        env,
        "RATE_LIMIT_PLAYBACK_UPDATE_BURST",
        defaults.rateLimits.playbackUpdateBurst,
      ),
      syncRequestPer10Seconds: parsePositiveIntegerEnv(
        env,
        "RATE_LIMIT_SYNC_REQUEST_PER_10_SECONDS",
        defaults.rateLimits.syncRequestPer10Seconds,
      ),
      syncPingPerSecond: parsePositiveIntegerEnv(
        env,
        "RATE_LIMIT_SYNC_PING_PER_SECOND",
        defaults.rateLimits.syncPingPerSecond,
      ),
      syncPingBurst: parsePositiveIntegerEnv(
        env,
        "RATE_LIMIT_SYNC_PING_BURST",
        defaults.rateLimits.syncPingBurst,
      ),
    },
  };
}
