import { getDefaultSecurityConfig, type SecurityConfig } from "../app.js";
import { checkBareOrigin } from "../origin.js";
import type { EnvSource } from "./env.js";
import {
  loadSectionConfigFromEnv,
  SECURITY_CONFIG_FIELDS,
} from "./runtime-config-schema.js";

const SUPPORTED_ORIGIN_PROTOCOLS: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "chrome-extension:",
  "moz-extension:",
]);

const SUPPORTED_SCHEME_LIST = [...SUPPORTED_ORIGIN_PROTOCOLS]
  .map((protocol) => protocol.replace(/:$/, ""))
  .join(", ");

export class SecurityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityConfigError";
  }
}

export function validateAllowedOriginValues(origins: readonly string[]): void {
  for (const origin of origins) {
    // 与运行期 Firefox 放行复用同一份裸 origin 规则（origin.ts），
    // 这里仅把失败原因映射回面向运维的具体报错文案。
    const result = checkBareOrigin(origin, SUPPORTED_ORIGIN_PROTOCOLS);
    if (result.ok) {
      continue;
    }
    switch (result.reason) {
      case "empty":
        throw new SecurityConfigError(
          `ALLOWED_ORIGINS contains an empty or non-string entry.`,
        );
      case "wildcard":
        throw new SecurityConfigError(
          `ALLOWED_ORIGINS entry "${origin}" uses a wildcard, which is not supported.`,
        );
      case "invalid_url":
        throw new SecurityConfigError(
          `ALLOWED_ORIGINS entry "${origin}" is not a valid absolute URL.`,
        );
      case "unsupported_scheme":
        throw new SecurityConfigError(
          `ALLOWED_ORIGINS entry "${origin}" uses unsupported scheme "${result.scheme.replace(/:$/, "")}"; expected one of ${SUPPORTED_SCHEME_LIST}.`,
        );
      case "no_host":
        throw new SecurityConfigError(
          `ALLOWED_ORIGINS entry "${origin}" must include a host.`,
        );
      case "not_bare":
        throw new SecurityConfigError(
          `ALLOWED_ORIGINS entry "${origin}" must be a bare origin like "${result.canonical}" — no path, query, fragment, userinfo, trailing slash, or mixed-case host (HTTP Origin headers are exact-matched).`,
        );
    }
  }
}

export function assertAllowedOriginsStartupPolicy(
  config: SecurityConfig,
): void {
  if (
    config.allowedOrigins.length === 0 &&
    !config.allowMissingOriginInDev &&
    !config.allowAnyFirefoxExtensionOrigin &&
    !config.allowAnyOriginInDev
  ) {
    throw new SecurityConfigError(
      "ALLOWED_ORIGINS is empty; set ALLOW_ANY_ORIGIN_IN_DEV=true to disable Origin checks in development, set ALLOW_MISSING_ORIGIN_IN_DEV=true to allow missing Origin headers in development, set ALLOW_ANY_FIREFOX_EXTENSION_ORIGIN=true to accept any Firefox extension origin, or configure ALLOWED_ORIGINS for production.",
    );
  }
}

export type OriginPolicyLogger = (message: string) => void;

export function logEffectiveOriginPolicy(
  config: SecurityConfig,
  log: OriginPolicyLogger = (message) => {
    console.log(message);
  },
): void {
  const origins =
    config.allowedOrigins.length === 0
      ? "<none>"
      : config.allowedOrigins.join(", ");
  log(
    `[security] ALLOWED_ORIGINS=${origins}; ALLOW_MISSING_ORIGIN_IN_DEV=${String(config.allowMissingOriginInDev)}; ALLOW_ANY_FIREFOX_EXTENSION_ORIGIN=${String(config.allowAnyFirefoxExtensionOrigin)}; ALLOW_ANY_ORIGIN_IN_DEV=${String(config.allowAnyOriginInDev)}`,
  );
}

export function loadSecurityConfig(
  env: EnvSource = process.env,
): SecurityConfig {
  const config = loadSectionConfigFromEnv(
    env,
    getDefaultSecurityConfig(),
    SECURITY_CONFIG_FIELDS,
  );
  validateAllowedOriginValues(config.allowedOrigins);
  return config;
}
