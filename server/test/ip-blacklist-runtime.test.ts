import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import {
  createSyncServer,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
  type SyncServerDependencies,
} from "../src/app.js";

const ALLOWED_ORIGIN = "chrome-extension://allowed-extension";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function adminDependencies(): SyncServerDependencies {
  return {
    adminConfig: {
      username: "admin",
      passwordHash: `sha256:${sha256Hex("secret-123")}`,
      sessionSecret: "session-secret-123",
      sessionTtlMs: 60_000,
      role: "admin",
      sessionStoreProvider: "memory",
      eventStoreProvider: "memory",
      auditStoreProvider: "memory",
    },
    now: () => 0,
    serviceVersion: "0.7.0-test",
  };
}

async function startAdminServer() {
  const server = await createSyncServer(
    {
      ...getDefaultSecurityConfig(),
      allowedOrigins: [ALLOWED_ORIGIN],
    },
    getDefaultPersistenceConfig(),
    adminDependencies(),
  );

  await new Promise<void>((resolve, reject) => {
    server.httpServer.listen(0, "127.0.0.1", () => resolve());
    server.httpServer.once("error", reject);
  });

  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine test server address.");
  }

  return {
    close: server.close,
    httpBaseUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}`,
  };
}

async function requestJson(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
  } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Origin: baseUrl,
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function login(baseUrl: string): Promise<string> {
  const response = await requestJson(baseUrl, "/api/admin/auth/login", {
    method: "POST",
    body: { username: "admin", password: "secret-123" },
  });
  assert.equal(response.status, 200);
  return (response.body.data as { token: string }).token;
}

async function connectClient(wsUrl: string): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl, { origin: ALLOWED_ORIGIN });
  await once(socket, "open");
  return socket;
}

async function expectRejectedUpgrade(wsUrl: string): Promise<number> {
  const socket = new WebSocket(wsUrl, { origin: ALLOWED_ORIGIN });
  const outcome = await Promise.race([
    once(socket, "unexpected-response").then(([, response]) => ({
      kind: "rejected" as const,
      statusCode: response.statusCode ?? 0,
    })),
    once(socket, "open").then(() => ({ kind: "opened" as const })),
  ]);
  if (outcome.kind === "opened") {
    socket.terminate();
    throw new Error("Expected WebSocket upgrade to be rejected.");
  }
  return outcome.statusCode;
}

test("blocking an IP disconnects current sessions and rejects future upgrades", async () => {
  const server = await startAdminServer();

  try {
    const token = await login(server.httpBaseUrl);
    const socket = await connectClient(server.wsUrl);
    const closed = once(socket, "close");

    const blocked = await requestJson(
      server.httpBaseUrl,
      "/api/admin/ip-blocks",
      {
        method: "POST",
        token,
        body: { ip: "127.0.0.1", reason: "abuse" },
      },
    );
    assert.equal(blocked.status, 200);
    assert.equal(
      (blocked.body.data as { disconnectedSessionCount: number })
        .disconnectedSessionCount,
      1,
    );
    await closed;

    assert.equal(await expectRejectedUpgrade(server.wsUrl), 403);
  } finally {
    await server.close();
  }
});
