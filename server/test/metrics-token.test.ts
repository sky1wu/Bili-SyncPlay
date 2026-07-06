import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createSyncServer,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
} from "../src/app.js";
import { createMetricsRequestHandler } from "../src/bootstrap/metrics-handler.js";
import { isMetricsRequestAuthorized } from "../src/metrics-auth.js";

const ALLOWED_ORIGIN = "chrome-extension://allowed-extension";

test("metrics auth allows every request when no token is configured", () => {
  assert.equal(isMetricsRequestAuthorized({ headers: {} }, undefined), true);
  assert.equal(isMetricsRequestAuthorized({ headers: {} }, ""), true);
});

test("metrics auth requires a matching bearer token when configured", () => {
  const token = "scrape-token-1";
  assert.equal(
    isMetricsRequestAuthorized(
      { headers: { authorization: `Bearer ${token}` } },
      token,
    ),
    true,
  );
  assert.equal(
    isMetricsRequestAuthorized(
      { headers: { authorization: `bearer ${token}` } },
      token,
    ),
    true,
  );
  assert.equal(isMetricsRequestAuthorized({ headers: {} }, token), false);
  assert.equal(
    isMetricsRequestAuthorized(
      { headers: { authorization: "Bearer wrong-token" } },
      token,
    ),
    false,
  );
  // Length mismatch must not throw (timingSafeEqual compares digests).
  assert.equal(
    isMetricsRequestAuthorized(
      { headers: { authorization: "Bearer x" } },
      token,
    ),
    false,
  );
  assert.equal(
    isMetricsRequestAuthorized({ headers: { authorization: token } }, token),
    false,
  );
});

function createFakeResponse() {
  const state = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
  };
  const response = {
    writeHead(statusCode: number, headers?: Record<string, string>) {
      state.statusCode = statusCode;
      state.headers = headers ?? {};
      return response;
    },
    end(body?: string) {
      state.body = body ?? "";
    },
  };
  return { response: response as unknown as ServerResponse, state };
}

test("dedicated metrics port handler enforces the configured token", async () => {
  const handler = createMetricsRequestHandler({
    getMetrics: () => "metric_line 1\n",
    metricsToken: "scrape-token-1",
  });

  const unauthorized = createFakeResponse();
  await handler(
    { url: "/metrics", method: "GET", headers: {} } as IncomingMessage,
    unauthorized.response,
  );
  assert.equal(unauthorized.state.statusCode, 401);
  assert.equal(
    unauthorized.state.headers["www-authenticate"],
    'Bearer realm="metrics"',
  );

  const authorized = createFakeResponse();
  await handler(
    {
      url: "/metrics",
      method: "GET",
      headers: { authorization: "Bearer scrape-token-1" },
    } as IncomingMessage,
    authorized.response,
  );
  assert.equal(authorized.state.statusCode, 200);
  assert.equal(authorized.state.body, "metric_line 1\n");
});

test("main-port /metrics enforces the token while health probes stay open", async () => {
  const server = await createSyncServer(
    {
      ...getDefaultSecurityConfig(),
      allowedOrigins: [ALLOWED_ORIGIN],
      metricsToken: "scrape-token-1",
    },
    getDefaultPersistenceConfig(),
    { serviceVersion: "0.0.0-test" },
  );

  await new Promise<void>((resolve, reject) => {
    server.httpServer.listen(0, "127.0.0.1", () => resolve());
    server.httpServer.once("error", reject);
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine test server address.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const missingToken = await fetch(`${baseUrl}/metrics`);
    assert.equal(missingToken.status, 401);
    assert.equal(
      missingToken.headers.get("www-authenticate"),
      'Bearer realm="metrics"',
    );

    const wrongToken = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(wrongToken.status, 401);

    const authorized = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: "Bearer scrape-token-1" },
    });
    assert.equal(authorized.status, 200);
    const body = await authorized.text();
    assert.equal(body.includes("bili_syncplay_connections"), true);

    // LB probes must keep working without credentials.
    const healthz = await fetch(`${baseUrl}/healthz`);
    assert.equal(healthz.status, 200);
    const readyz = await fetch(`${baseUrl}/readyz`);
    assert.equal(readyz.status, 200);
  } finally {
    await server.close();
  }
});

test("main-port /metrics stays open when no token is configured", async () => {
  const server = await createSyncServer(
    {
      ...getDefaultSecurityConfig(),
      allowedOrigins: [ALLOWED_ORIGIN],
    },
    getDefaultPersistenceConfig(),
    { serviceVersion: "0.0.0-test" },
  );

  await new Promise<void>((resolve, reject) => {
    server.httpServer.listen(0, "127.0.0.1", () => resolve());
    server.httpServer.once("error", reject);
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine test server address.");
  }

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes("bili_syncplay_connections"), true);
  } finally {
    await server.close();
  }
});
