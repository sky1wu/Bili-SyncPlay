import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, type RawData } from "ws";
import { createGlobalAdminServer } from "../src/global-admin-app.js";
import {
  createSyncServer,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
} from "../src/app.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const ALLOWED_ORIGIN = "chrome-extension://allowed-extension";

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

test("global admin server starts without websocket runtime and serves admin endpoints", async () => {
  const server = await createGlobalAdminServer(
    getDefaultSecurityConfig(),
    getDefaultPersistenceConfig(),
    {
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
      serviceVersion: "0.7.0-global-admin-test",
    },
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
    const adminHtml = await fetch(`${baseUrl}/admin`);
    assert.equal(adminHtml.status, 200);
    assert.equal(
      adminHtml.headers.get("content-type")?.includes("text/html"),
      true,
    );

    const login = await requestJson(baseUrl, "/api/admin/auth/login", {
      method: "POST",
      body: { username: "admin", password: "secret-123" },
    });
    assert.equal(login.status, 200);
    const token = (login.body.data as { token: string }).token;
    assert.ok(token);

    const overview = await requestJson(baseUrl, "/api/admin/overview", {
      token,
    });
    assert.equal(overview.status, 200);
    assert.equal(
      (overview.body.data as { service: { name: string } }).service.name,
      "bili-syncplay-global-admin",
    );

    const health = await requestJson(baseUrl, "/healthz");
    assert.equal(health.status, 200);
    assert.equal((health.body.data as { status: string }).status, "healthy");
  } finally {
    await server.close();
  }
});

async function connectClient(wsUrl: string): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl, { origin: ALLOWED_ORIGIN });
  await once(socket, "open");
  return socket;
}

function createMessageCollector(socket: WebSocket) {
  const queuedMessages: Array<Record<string, unknown>> = [];
  socket.on("message", (raw: RawData) => {
    queuedMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
  });

  return {
    async next(type: string, timeoutMs = 2_000) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const index = queuedMessages.findIndex(
          (message) => message.type === type,
        );
        if (index >= 0) {
          return queuedMessages.splice(index, 1)[0] as Record<string, unknown>;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for message type ${type}`);
    },
  };
}

test("global admin server queries and closes rooms through shared cluster state", async (t) => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const persistenceConfig = {
    ...getDefaultPersistenceConfig(),
    provider: "redis" as const,
    runtimeStoreProvider: "redis" as const,
    roomEventBusProvider: "redis" as const,
    adminCommandBusProvider: "redis" as const,
    redisUrl,
    nodeHeartbeatEnabled: true,
    nodeHeartbeatIntervalMs: 2_000,
    nodeHeartbeatTtlMs: 6_000,
  };
  const adminConfig = {
    username: "admin",
    passwordHash: `sha256:${sha256Hex("secret-123")}`,
    sessionSecret: "session-secret-123",
    sessionTtlMs: 60_000,
    role: "admin" as const,
    sessionStoreProvider: "redis" as const,
    eventStoreProvider: "redis" as const,
    auditStoreProvider: "redis" as const,
  };

  const roomNode = await createSyncServer(
    {
      ...getDefaultSecurityConfig(),
      allowedOrigins: [ALLOWED_ORIGIN],
    },
    persistenceConfig,
    {
      adminConfig,
      serviceVersion: "0.7.0-room-node-test",
    },
  );
  const globalAdmin = await createGlobalAdminServer(
    getDefaultSecurityConfig(),
    persistenceConfig,
    {
      adminConfig,
      serviceVersion: "0.7.0-global-admin-test",
    },
  );

  await new Promise<void>((resolve, reject) => {
    roomNode.httpServer.listen(0, "127.0.0.1", () => resolve());
    roomNode.httpServer.once("error", reject);
  });
  await new Promise<void>((resolve, reject) => {
    globalAdmin.httpServer.listen(0, "127.0.0.1", () => resolve());
    globalAdmin.httpServer.once("error", reject);
  });

  const roomNodeAddress = roomNode.httpServer.address();
  const globalAdminAddress = globalAdmin.httpServer.address();
  if (
    !roomNodeAddress ||
    typeof roomNodeAddress === "string" ||
    !globalAdminAddress ||
    typeof globalAdminAddress === "string"
  ) {
    throw new Error("Failed to determine test server address.");
  }

  const roomNodeWsUrl = `ws://127.0.0.1:${roomNodeAddress.port}`;
  const globalAdminBaseUrl = `http://127.0.0.1:${globalAdminAddress.port}`;

  try {
    const token = (
      (
        await requestJson(globalAdminBaseUrl, "/api/admin/auth/login", {
          method: "POST",
          body: { username: "admin", password: "secret-123" },
        })
      ).body.data as { token: string }
    ).token;

    const socket = await connectClient(roomNodeWsUrl);
    const collector = createMessageCollector(socket);
    try {
      socket.send(
        JSON.stringify({
          type: "room:create",
          payload: { displayName: "Alice" },
        }),
      );
      const created = await collector.next("room:created");
      await collector.next("room:state");
      const roomCode = (created.payload as { roomCode: string }).roomCode;

      const rooms = await requestJson(
        globalAdminBaseUrl,
        "/api/admin/rooms?status=active&page=1&pageSize=10",
        { token },
      );
      assert.equal(rooms.status, 200);
      assert.equal(
        (rooms.body.data as { items: Array<{ roomCode: string }> }).items.some(
          (item) => item.roomCode === roomCode,
        ),
        true,
      );

      const closeRoom = await requestJson(
        globalAdminBaseUrl,
        `/api/admin/rooms/${roomCode}/close`,
        {
          method: "POST",
          token,
          body: { reason: "close from global admin" },
        },
      );
      assert.equal(closeRoom.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const roomDetail = await requestJson(
        globalAdminBaseUrl,
        `/api/admin/rooms/${roomCode}`,
        { token },
      );
      assert.equal(roomDetail.status, 404);
    } finally {
      socket.terminate();
    }
  } finally {
    await roomNode.close();
    await globalAdmin.close();
  }
});
