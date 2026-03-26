import type { AdminRole } from "../admin/types.js";
import { type AdminConfig, type AdminUiConfig } from "../app.js";
import type { EnvSource } from "./env.js";
import {
  parseBooleanEnv,
  parsePositiveIntegerEnv,
  readTrimmedEnv,
} from "./env.js";

function parseAdminSessionStoreProvider(
  value: string | undefined,
): "memory" | "redis" {
  if (value === undefined || value === "") {
    return "memory";
  }
  if (value === "memory" || value === "redis") {
    return value;
  }
  throw new Error(
    'Environment variable ADMIN_SESSION_STORE_PROVIDER must be "memory" or "redis".',
  );
}

function parseAdminRole(value: string | undefined): AdminRole {
  return value === "viewer" || value === "operator" || value === "admin"
    ? value
    : "admin";
}

export function loadAdminConfig(env: EnvSource = process.env): AdminConfig {
  const username = readTrimmedEnv(env, "ADMIN_USERNAME");
  const passwordHash = readTrimmedEnv(env, "ADMIN_PASSWORD_HASH");
  const sessionSecret = readTrimmedEnv(env, "ADMIN_SESSION_SECRET");

  if (!username || !passwordHash || !sessionSecret) {
    return null;
  }

  return {
    username,
    passwordHash,
    sessionSecret,
    sessionTtlMs: parsePositiveIntegerEnv(
      env,
      "ADMIN_SESSION_TTL_MS",
      12 * 60 * 60 * 1000,
    ),
    role: parseAdminRole(readTrimmedEnv(env, "ADMIN_ROLE")),
    sessionStoreProvider: parseAdminSessionStoreProvider(
      readTrimmedEnv(env, "ADMIN_SESSION_STORE_PROVIDER"),
    ),
  };
}

export function loadAdminUiConfig(env: EnvSource = process.env): AdminUiConfig {
  return {
    demoEnabled: parseBooleanEnv(env, "ADMIN_UI_DEMO_ENABLED", false),
  };
}
