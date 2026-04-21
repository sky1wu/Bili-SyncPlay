import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHttpRequestHandler } from "../src/bootstrap/http-handler.js";
import { createSecurityPolicy } from "../src/security.js";

function createRequest(args: {
  url: string;
  method?: string;
  origin?: string | null;
}) {
  return {
    url: args.url,
    method: args.method ?? "GET",
    headers: args.origin ? { origin: args.origin } : {},
    socket: {
      remoteAddress: "127.0.0.1",
    },
  } as IncomingMessage;
}

function createResponse() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(statusCode: number, headers: Record<string, string>) {
      this.statusCode = statusCode;
      this.headers = headers;
      return this;
    },
    end(body?: string) {
      this.body = body ?? "";
      return this;
    },
  } as unknown as ServerResponse & {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  };
}

function createHandler(adminHandled = false) {
  const adminCalls: Array<{ url?: string; method?: string }> = [];
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async (request, response) => {
        adminCalls.push({
          url: request.url,
          method: request.method,
        });
        if (!adminHandled) {
          return false;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, admin: true }));
        return true;
      },
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 8,
      trustedProxyAddresses: [],
      rateLimits: {
        roomCreatePerMinute: 5,
        roomJoinPerMinute: 10,
        videoSharePerMinute: 20,
        playbackUpdatePerSecond: 30,
        profileUpdatePerMinute: 20,
        syncPingPerMinute: 30,
        syncPingBurst: 5,
      },
    }),
  });

  return { handler, adminCalls };
}

test("http handler reflects allowed origin on connection-check preflight", () => {
  const { handler, adminCalls } = createHandler();

  const preflightResponse = createResponse();
  handler(
    createRequest({
      url: "/api/connection-check",
      method: "OPTIONS",
      origin: "chrome-extension://allowed",
    }),
    preflightResponse,
  );
  assert.equal(preflightResponse.statusCode, 204);
  assert.equal(
    preflightResponse.headers["access-control-allow-origin"],
    "chrome-extension://allowed",
  );
  assert.equal(preflightResponse.headers["vary"], "origin");
  assert.equal(adminCalls.length, 0);
});

test("http handler reports websocketAllowed without leaking reason or CORS to disallowed origins", () => {
  const { handler, adminCalls } = createHandler();

  const allowedResponse = createResponse();
  handler(
    createRequest({
      url: "/api/connection-check",
      method: "GET",
      origin: "chrome-extension://allowed",
    }),
    allowedResponse,
  );
  assert.equal(allowedResponse.statusCode, 200);
  assert.equal(
    allowedResponse.headers["access-control-allow-origin"],
    "chrome-extension://allowed",
  );
  assert.equal(allowedResponse.headers["vary"], "origin");
  assert.deepEqual(JSON.parse(allowedResponse.body), {
    ok: true,
    data: {
      websocketAllowed: true,
    },
  });

  const deniedResponse = createResponse();
  handler(
    createRequest({
      url: "/api/connection-check",
      method: "GET",
      origin: "chrome-extension://denied",
    }),
    deniedResponse,
  );
  assert.equal(deniedResponse.statusCode, 200);
  assert.equal(
    deniedResponse.headers["access-control-allow-origin"],
    undefined,
  );
  assert.equal(deniedResponse.headers["vary"], "origin");
  assert.deepEqual(JSON.parse(deniedResponse.body), {
    ok: true,
    data: {
      websocketAllowed: false,
    },
  });
  assert.equal(adminCalls.length, 0);
});

test("http handler omits CORS headers when origin is missing", () => {
  const { handler } = createHandler();

  const response = createResponse();
  handler(
    createRequest({
      url: "/api/connection-check",
      method: "GET",
    }),
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(response.headers["vary"], "origin");
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    data: {
      websocketAllowed: false,
    },
  });
});

test("http handler returns 404 for /metrics when metrics are routed to a dedicated port", async () => {
  const adminCalls: Array<{ url?: string }> = [];
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async (request) => {
        adminCalls.push({ url: request.url });
        return false;
      },
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 8,
      trustedProxyAddresses: [],
      rateLimits: {
        roomCreatePerMinute: 5,
        roomJoinPerMinute: 10,
        videoSharePerMinute: 20,
        playbackUpdatePerSecond: 30,
        profileUpdatePerMinute: 20,
        syncPingPerMinute: 30,
        syncPingBurst: 5,
      },
    }),
    metricsEnabled: false,
  });

  const response = createResponse();
  await handler(createRequest({ url: "/metrics" }), response);

  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    error: {
      code: "not_found",
      message: "Not found.",
    },
  });
  assert.equal(adminCalls.length, 0);
});

test("http handler preserves admin router responses without falling through to root payload", async () => {
  const { handler, adminCalls } = createHandler(true);
  const response = createResponse();

  handler(
    createRequest({
      url: "/api/admin/me",
      method: "GET",
      origin: "chrome-extension://allowed",
    }),
    response,
  );

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(adminCalls.length, 1);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    admin: true,
  });
});

test("http handler returns a stable 500 payload when downstream routing throws", async () => {
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async () => {
        throw new Error("boom");
      },
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 8,
      trustedProxyAddresses: [],
      rateLimits: {
        roomCreatePerMinute: 5,
        roomJoinPerMinute: 10,
        videoSharePerMinute: 20,
        playbackUpdatePerSecond: 30,
        profileUpdatePerMinute: 20,
        syncPingPerMinute: 30,
        syncPingBurst: 5,
      },
    }),
  });
  const response = createResponse();

  await handler(
    createRequest({
      url: "/api/admin/me",
      method: "GET",
      origin: "chrome-extension://allowed",
    }),
    response,
  );

  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    error: {
      code: "internal_error",
      message: "Internal server error.",
    },
  });
});
