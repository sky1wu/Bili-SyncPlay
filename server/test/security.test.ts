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

async function withMockedNow<T>(
  nowValues: number[],
  run: () => T | Promise<T>,
): Promise<T> {
  const originalNow = Date.now;
  let index = 0;
  Date.now = () => nowValues[Math.min(index++, nowValues.length - 1)] ?? 0;
  try {
    return await run();
  } finally {
    Date.now = originalNow;
  }
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

  config.trustedProxyAddresses = ["127.0.0.1"];
  const trustedSecurity = createSecurityPolicy(config);

  assert.equal(trustedSecurity.getRemoteAddress(directRequest), "203.0.113.10");
});

test("security policy normalizes ipv4-mapped proxy peers before checking trust", () => {
  const config = getDefaultSecurityConfig();
  config.allowedOrigins = ["chrome-extension://allowed-extension"];
  config.trustedProxyAddresses = ["127.0.0.1"];
  const security = createSecurityPolicy(config);
  const request = createRequest({
    origin: "chrome-extension://allowed-extension",
    remoteAddress: "::ffff:127.0.0.1",
    forwardedFor: "203.0.113.10",
  });

  assert.equal(security.getRemoteAddress(request), "203.0.113.10");
});

test("security policy ignores forwarded headers from untrusted socket peers", () => {
  const config = getDefaultSecurityConfig();
  config.allowedOrigins = ["chrome-extension://allowed-extension"];
  config.trustedProxyAddresses = ["198.51.100.1"];
  const security = createSecurityPolicy(config);
  const spoofedRequest = createRequest({
    origin: "chrome-extension://allowed-extension",
    remoteAddress: "127.0.0.1",
    forwardedFor: "203.0.113.10, 127.0.0.1",
  });

  assert.equal(security.getRemoteAddress(spoofedRequest), "127.0.0.1");
});

test("security policy resolves the client address through trusted proxy chains", () => {
  const config = getDefaultSecurityConfig();
  config.allowedOrigins = ["chrome-extension://allowed-extension"];
  config.trustedProxyAddresses = ["127.0.0.1", "198.51.100.7"];
  const security = createSecurityPolicy(config);
  const request = createRequest({
    origin: "chrome-extension://allowed-extension",
    remoteAddress: "127.0.0.1",
    forwardedFor: "203.0.113.10, 198.51.100.7",
  });

  assert.equal(security.getRemoteAddress(request), "203.0.113.10");
});

test("security policy falls back to socket.remoteAddress when forwarded headers are malformed", () => {
  const config = getDefaultSecurityConfig();
  config.allowedOrigins = ["chrome-extension://allowed-extension"];
  config.trustedProxyAddresses = ["127.0.0.1"];
  const security = createSecurityPolicy(config);
  const blankEntryRequest = createRequest({
    origin: "chrome-extension://allowed-extension",
    remoteAddress: "127.0.0.1",
    forwardedFor: "198.51.100.7, ",
  });
  const invalidEntryRequest = createRequest({
    origin: "chrome-extension://allowed-extension",
    remoteAddress: "127.0.0.1",
    forwardedFor: "unknown",
  });

  assert.equal(security.getRemoteAddress(blankEntryRequest), "127.0.0.1");
  assert.equal(security.getRemoteAddress(invalidEntryRequest), "127.0.0.1");
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

test("security policy lazily removes stale attempt windows after the TTL elapses", async () => {
  await withMockedNow(
    [
      0,
      ...Array.from({ length: 62 }, (_, index) => (index + 1) * 1_000),
      11 * 60_000,
    ],
    () => {
      const config = getDefaultSecurityConfig();
      config.allowedOrigins = ["chrome-extension://allowed-extension"];
      config.connectionAttemptsPerMinute = 1;
      const security = createSecurityPolicy(config);

      const staleRequest = createRequest({
        origin: "chrome-extension://allowed-extension",
        remoteAddress: "198.51.100.10",
      });

      const firstDecision = security.evaluateUpgrade(staleRequest);
      assert.equal(firstDecision.ok, true);

      for (let index = 0; index < 62; index += 1) {
        const decision = security.evaluateUpgrade(
          createRequest({
            origin: "chrome-extension://allowed-extension",
            remoteAddress: `198.51.100.${index + 20}`,
          }),
        );
        assert.equal(decision.ok, true);
      }

      const recycledDecision = security.evaluateUpgrade(staleRequest);
      assert.equal(recycledDecision.ok, true);
    },
  );
});

test("allowAnyFirefoxExtensionOrigin off: moz-extension still exact-match only", () => {
  const config = getDefaultSecurityConfig();
  config.allowedOrigins = ["chrome-extension://allowed-extension"];
  const security = createSecurityPolicy(config);

  assert.deepEqual(
    security.isOriginAllowed(
      "moz-extension://2b83faf4-40af-4e98-a9aa-e63c93821add",
    ),
    { ok: false, reason: "origin_not_allowed" },
  );
});

test("allowAnyFirefoxExtensionOrigin on: any well-formed moz-extension origin allowed", () => {
  const config = getDefaultSecurityConfig();
  config.allowedOrigins = ["chrome-extension://allowed-extension"];
  config.allowAnyFirefoxExtensionOrigin = true;
  const security = createSecurityPolicy(config);

  assert.deepEqual(
    security.isOriginAllowed(
      "moz-extension://2b83faf4-40af-4e98-a9aa-e63c93821add",
    ),
    { ok: true },
  );
  // 不同安装 = 不同 UUID，同样放行（无需逐一枚举）
  assert.deepEqual(
    security.isOriginAllowed(
      "moz-extension://ffffffff-0000-1111-2222-333344445555",
    ),
    { ok: true },
  );
  // 配置的精确 origin 仍然有效
  assert.deepEqual(
    security.isOriginAllowed("chrome-extension://allowed-extension"),
    { ok: true },
  );
});

test("allowAnyFirefoxExtensionOrigin on: malformed moz-extension still rejected", () => {
  const config = getDefaultSecurityConfig();
  config.allowedOrigins = ["chrome-extension://allowed-extension"];
  config.allowAnyFirefoxExtensionOrigin = true;
  const security = createSecurityPolicy(config);

  for (const bad of [
    // 非裸 origin
    "moz-extension://2b83faf4-40af-4e98-a9aa-e63c93821add/popup.html", // 带路径
    "moz-extension://2b83faf4-40af-4e98-a9aa-e63c93821add/", // 尾斜杠
    "moz-extension://user@2b83faf4-40af-4e98-a9aa-e63c93821add", // userinfo
    "moz-extension://2b83faf4-40af-4e98-a9aa-e63c93821add?x=1", // 查询串
    "moz-extension://*", // 通配
    // 裸 origin 但 host 不是 Firefox UUID —— 真实 Firefox 永不产生，
    // 须与文档「moz-extension://<uuid>」一致地拒绝
    "moz-extension://not-a-uuid",
    "moz-extension://foo:99",
    "moz-extension://2B83FAF4-40AF-4E98-A9AA-E63C93821ADD", // 大写非 Firefox 形态
    "moz-extension://2b83faf4-40af-4e98-a9aa-e63c93821ad", // 末段位数不足
    "moz-extension://2b83faf440af4e98a9aae63c93821add", // 缺连字符
  ]) {
    assert.deepEqual(
      security.isOriginAllowed(bad),
      { ok: false, reason: "origin_not_allowed" },
      `expected ${bad} to be rejected`,
    );
  }
});

test("allowAnyFirefoxExtensionOrigin on: non-extension origins still gated", () => {
  const config = getDefaultSecurityConfig();
  config.allowedOrigins = ["chrome-extension://allowed-extension"];
  config.allowAnyFirefoxExtensionOrigin = true;
  const security = createSecurityPolicy(config);

  // 网页源永远是 http(s)://，开关不放行它们——Origin 防护未被削弱
  assert.deepEqual(security.isOriginAllowed("https://evil.test"), {
    ok: false,
    reason: "origin_not_allowed",
  });
  // 未列出的 chrome-extension 仍精确匹配
  assert.deepEqual(
    security.isOriginAllowed("chrome-extension://some-other-extension"),
    { ok: false, reason: "origin_not_allowed" },
  );
  // 缺失 origin 仍走原有 missing 逻辑（与本开关正交）
  assert.deepEqual(security.isOriginAllowed(null), {
    ok: false,
    reason: "origin_missing",
  });
});

test("allowAnyOriginInDev on: skips origin checks for explicit and missing origins", () => {
  const config = getDefaultSecurityConfig();
  config.allowedOrigins = [];
  config.allowAnyOriginInDev = true;
  const security = createSecurityPolicy(config);

  assert.deepEqual(
    security.isOriginAllowed("chrome-extension://some-extension"),
    { ok: true },
  );
  assert.deepEqual(security.isOriginAllowed("https://web.example"), {
    ok: true,
  });
  assert.deepEqual(security.isOriginAllowed(null), { ok: true });
});
