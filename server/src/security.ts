import type { IncomingMessage } from "node:http";
import {
  consumeFixedWindow,
  createWindowCounter,
  WINDOW_MINUTE_MS,
} from "./rate-limit.js";
import type { SecurityConfig, UpgradeDecision } from "./types.js";

export function createSecurityPolicy(config: SecurityConfig): {
  evaluateUpgrade: (request: IncomingMessage) => UpgradeDecision;
  incrementConnectionCount: (remoteAddress: string | null) => void;
  decrementConnectionCount: (remoteAddress: string | null) => void;
  getRemoteAddress: (request: IncomingMessage) => string | null;
  isOriginAllowed: (
    origin: string | null,
  ) => { ok: true } | { ok: false; reason: string };
} {
  const ipAttemptWindows = new Map<
    string,
    ReturnType<typeof createWindowCounter>
  >();
  const ipConnectionCounts = new Map<string, number>();

  function getRemoteAddress(request: IncomingMessage): string | null {
    const forwarded = request.headers["x-forwarded-for"];
    if (
      config.trustProxyHeaders &&
      typeof forwarded === "string" &&
      forwarded.trim()
    ) {
      const parts = forwarded.split(",");
      return parts[parts.length - 1]?.trim() ?? null;
    }
    return request.socket.remoteAddress ?? null;
  }

  function isOriginAllowed(
    origin: string | null,
  ): { ok: true } | { ok: false; reason: string } {
    if (!origin) {
      if (config.allowMissingOriginInDev) {
        return { ok: true };
      }
      return { ok: false, reason: "origin_missing" };
    }

    if (config.allowedOrigins.includes(origin)) {
      return { ok: true };
    }

    return { ok: false, reason: "origin_not_allowed" };
  }

  function incrementConnectionCount(remoteAddress: string | null): void {
    if (!remoteAddress) {
      return;
    }
    ipConnectionCounts.set(
      remoteAddress,
      (ipConnectionCounts.get(remoteAddress) ?? 0) + 1,
    );
  }

  function decrementConnectionCount(remoteAddress: string | null): void {
    if (!remoteAddress) {
      return;
    }
    const nextValue = (ipConnectionCounts.get(remoteAddress) ?? 1) - 1;
    if (nextValue <= 0) {
      ipConnectionCounts.delete(remoteAddress);
      return;
    }
    ipConnectionCounts.set(remoteAddress, nextValue);
  }

  function evaluateUpgrade(request: IncomingMessage): UpgradeDecision {
    const originHeader = request.headers.origin;
    const origin = typeof originHeader === "string" ? originHeader : null;
    const remoteAddress = getRemoteAddress(request);
    const context = { remoteAddress, origin };
    const ipKey = remoteAddress ?? "unknown";
    const attemptWindow = ipAttemptWindows.get(ipKey) ?? createWindowCounter();
    ipAttemptWindows.set(ipKey, attemptWindow);
    if (
      !consumeFixedWindow(
        attemptWindow,
        config.connectionAttemptsPerMinute,
        WINDOW_MINUTE_MS,
        Date.now(),
      )
    ) {
      return {
        ok: false,
        statusCode: 429,
        statusText: "Too Many Requests",
        context,
        reason: "connection_attempt_rate_limited",
      };
    }

    const originCheck = isOriginAllowed(origin);
    if (!originCheck.ok) {
      return {
        ok: false,
        statusCode: 403,
        statusText: "Forbidden",
        context,
        reason: originCheck.reason,
      };
    }

    if ((ipConnectionCounts.get(ipKey) ?? 0) >= config.maxConnectionsPerIp) {
      return {
        ok: false,
        statusCode: 429,
        statusText: "Too Many Requests",
        context,
        reason: "connection_count_limited",
      };
    }

    return { ok: true, context };
  }

  return {
    evaluateUpgrade,
    incrementConnectionCount,
    decrementConnectionCount,
    getRemoteAddress,
    isOriginAllowed,
  };
}
