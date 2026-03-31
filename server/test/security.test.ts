import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { createSecurityPolicy } from "../src/security.js";
import { getDefaultSecurityConfig } from "../src/app.js";

function createRequest(
  options: {
    origin?: string;
    remoteAddress?: string | null;
    forwardedFor?: string;
  } = {},
): IncomingMessage {
  return {
    headers: {
      ...(options.origin !== undefined ? { origin: options.origin } : {}),
      ...(options.forwardedFor !== undefined
        ? { "x-forwarded-for": options.forwardedFor }
        : {}),
    },
    socket: {
      remoteAddress: options.remoteAddress ?? "127.0.0.1",
    },
  } as IncomingMessage;
}

test("security policy allows configured origins and rejects missing origins by default", () => {
  const config = getDefaultSecurityConfig();
  config.allowedOrigins = ["chrome-extension://allowed-extension"];
  const security = createSecurityPolicy(config);

  assert.deepEqual(
    security.isOriginAllowed("chrome-extension://allowed-extension"),
    { ok: true },
  );
  assert.deepEqual(security.isOriginAllowed(null), {
    ok: false,
    reason: "origin_missing",
  });
});

test("security policy respects trusted proxy headers when enabled", () => {
  const config = getDefaultSecurityConfig();
  config.allowedOrigins = ["chrome-extension://allowed-extension"];
  const security = createSecurityPolicy(config);
  const directRequest = createRequest({
    origin: "chrome-extension://allowed-extension",
    remoteAddress: "127.0.0.1",
    forwardedFor: "203.0.113.10",
  });

  assert.equal(security.getRemoteAddress(directRequest), "127.0.0.1");

  config.trustProxyHeaders = true;
  const trustedSecurity = createSecurityPolicy(config);

  assert.equal(trustedSecurity.getRemoteAddress(directRequest), "203.0.113.10");
});

test("security policy uses the last IP from x-forwarded-for to prevent spoofing", () => {
  const config = getDefaultSecurityConfig();
  config.allowedOrigins = ["chrome-extension://allowed-extension"];
  config.trustProxyHeaders = true;
  const security = createSecurityPolicy(config);
  const spoofedRequest = createRequest({
    origin: "chrome-extension://allowed-extension",
    remoteAddress: "127.0.0.1",
    forwardedFor: "fake-ip, real-client-ip",
  });

  assert.equal(security.getRemoteAddress(spoofedRequest), "real-client-ip");
});

test("security policy rejects upgrades when connection count exceeds the configured maximum", () => {
  const config = getDefaultSecurityConfig();
  config.allowedOrigins = ["chrome-extension://allowed-extension"];
  config.maxConnectionsPerIp = 1;
  const security = createSecurityPolicy(config);
  const request = createRequest({
    origin: "chrome-extension://allowed-extension",
  });

  const firstDecision = security.evaluateUpgrade(request);
  assert.equal(firstDecision.ok, true);
  security.incrementConnectionCount("127.0.0.1");

  const secondDecision = security.evaluateUpgrade(request);
  assert.equal(secondDecision.ok, false);
  if (secondDecision.ok) {
    throw new Error("Expected upgrade to be rejected.");
  }
  assert.equal(secondDecision.reason, "connection_count_limited");
});

test("security policy rate limits repeated invalid origins before origin rejection", () => {
  const config = getDefaultSecurityConfig();
  config.allowedOrigins = ["chrome-extension://allowed-extension"];
  config.connectionAttemptsPerMinute = 2;
  const security = createSecurityPolicy(config);
  const request = createRequest({ origin: "https://malicious.example" });

  const firstDecision = security.evaluateUpgrade(request);
  assert.equal(firstDecision.ok, false);
  if (firstDecision.ok) {
    throw new Error("Expected invalid origin to be rejected.");
  }
  assert.equal(firstDecision.reason, "origin_not_allowed");

  const secondDecision = security.evaluateUpgrade(request);
  assert.equal(secondDecision.ok, false);
  if (secondDecision.ok) {
    throw new Error("Expected invalid origin to be rejected.");
  }
  assert.equal(secondDecision.reason, "origin_not_allowed");

  const thirdDecision = security.evaluateUpgrade(request);
  assert.equal(thirdDecision.ok, false);
  if (thirdDecision.ok) {
    throw new Error("Expected invalid origin to be rate limited.");
  }
  assert.equal(thirdDecision.reason, "connection_attempt_rate_limited");
});

test("security policy counts missing origin requests toward the attempt window", () => {
  const config = getDefaultSecurityConfig();
  config.allowedOrigins = ["chrome-extension://allowed-extension"];
  config.connectionAttemptsPerMinute = 1;
  const security = createSecurityPolicy(config);
  const request = createRequest({ origin: undefined });

  const firstDecision = security.evaluateUpgrade(request);
  assert.equal(firstDecision.ok, false);
  if (firstDecision.ok) {
    throw new Error("Expected missing origin to be rejected.");
  }
  assert.equal(firstDecision.reason, "origin_missing");

  const secondDecision = security.evaluateUpgrade(request);
  assert.equal(secondDecision.ok, false);
  if (secondDecision.ok) {
    throw new Error("Expected missing origin to be rate limited.");
  }
  assert.equal(secondDecision.reason, "connection_attempt_rate_limited");
});
