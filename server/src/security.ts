import type { IncomingMessage } from "node:http";
import {
  consumeFixedWindow,
  createWindowCounter,
  WINDOW_MINUTE_MS,
} from "./rate-limit.js";
import type { SecurityConfig, UpgradeDecision } from "./types.js";

type AttemptWindowEntry = {
  counter: ReturnType<typeof createWindowCounter>;
  lastSeenAt: number;
};

const ATTEMPT_WINDOW_TTL_MS = 10 * WINDOW_MINUTE_MS;
const ATTEMPT_WINDOW_SWEEP_INTERVAL = 64;

export function createSecurityPolicy(config: SecurityConfig): {
  evaluateUpgrade: (request: IncomingMessage) => UpgradeDecision;
  incrementConnectionCount: (remoteAddress: string | null) => void;
  decrementConnectionCount: (remoteAddress: string | null) => void;
  getRemoteAddress: (request: IncomingMessage) => string | null;
  isOriginAllowed: (
    origin: string | null,
  ) => { ok: true } | { ok: false; reason: string };
} {
  const ipAttemptWindows = new Map<string, AttemptWindowEntry>();
  const ipConnectionCounts = new Map<string, number>();
  let evaluateCount = 0;

  function getTrustedForwardedAddress(forwarded: string): string | null {
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length === 0) {
      return null;
    }
    // With only a boolean trust flag available, the safest boundary we can
    // honor is the hop immediately upstream of the connected proxy.
    return parts.at(-1) ?? null;
  }

  function getRemoteAddress(request: IncomingMessage): string | null {
    const forwarded = request.headers["x-forwarded-for"];
    if (
      config.trustProxyHeaders &&
      typeof forwarded === "string" &&
      forwarded.trim()
    ) {
      return getTrustedForwardedAddress(forwarded);
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

  function getAttemptWindow(ipKey: string, currentTime: number) {
    const existing = ipAttemptWindows.get(ipKey);
    if (existing) {
      existing.lastSeenAt = currentTime;
      return existing.counter;
    }

    const entry: AttemptWindowEntry = {
      counter: createWindowCounter(currentTime),
      lastSeenAt: currentTime,
    };
    ipAttemptWindows.set(ipKey, entry);
    return entry.counter;
  }

  function maybeSweepAttemptWindows(currentTime: number): void {
    evaluateCount += 1;
    if (evaluateCount % ATTEMPT_WINDOW_SWEEP_INTERVAL !== 0) {
      return;
    }

    for (const [ipKey, entry] of ipAttemptWindows) {
      if (
        currentTime - entry.lastSeenAt >= ATTEMPT_WINDOW_TTL_MS &&
        (ipConnectionCounts.get(ipKey) ?? 0) <= 0
      ) {
        ipAttemptWindows.delete(ipKey);
      }
    }
  }

  function evaluateUpgrade(request: IncomingMessage): UpgradeDecision {
    const currentTime = Date.now();
    const originHeader = request.headers.origin;
    const origin = typeof originHeader === "string" ? originHeader : null;
    const remoteAddress = getRemoteAddress(request);
    const context = { remoteAddress, origin };
    const ipKey = remoteAddress ?? "unknown";
    const attemptWindow = getAttemptWindow(ipKey, currentTime);
    maybeSweepAttemptWindows(currentTime);
    if (
      !consumeFixedWindow(
        attemptWindow,
        config.connectionAttemptsPerMinute,
        WINDOW_MINUTE_MS,
        currentTime,
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
