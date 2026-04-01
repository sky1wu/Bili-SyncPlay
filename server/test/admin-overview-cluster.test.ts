import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, type RawData } from "ws";
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

async function startAdminServerWithPersistence(
  persistenceConfig: ReturnType<typeof getDefaultPersistenceConfig>,
  dependencies: SyncServerDependencies = {},
) {
  const resolvedDependencies: SyncServerDependencies = {
    ...dependencies,
    adminConfig: dependencies.adminConfig ?? {
      username: "admin",
      passwordHash: `sha256:${sha256Hex("secret-123")}`,
      sessionSecret: "session-secret-123",
      sessionTtlMs: 60_000,
      role: "admin",
      sessionStoreProvider: "memory",
      eventStoreProvider: "memory",
      auditStoreProvider: "memory",
    },
    serviceVersion: dependencies.serviceVersion ?? "0.7.0-test",
  };

  const server = await createSyncServer(
    {
      ...getDefaultSecurityConfig(),
      allowedOrigins: [ALLOWED_ORIGIN],
    },
    persistenceConfig,
    resolvedDependencies,
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

async function closeClient(socket: WebSocket): Promise<void> {
  if (
    socket.readyState === WebSocket.CLOSING ||
    socket.readyState === WebSocket.CLOSED
  ) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 250);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.close();
  });
}

test("redis-backed overview aggregates cluster runtime and node status across instances", async (t) => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const persistenceConfig = {
    ...getDefaultPersistenceConfig(),
    provider: "redis" as const,
    runtimeStoreProvider: "redis" as const,
    nodeHeartbeatEnabled: true,
    nodeHeartbeatIntervalMs: 50,
    nodeHeartbeatTtlMs: 200,
    redisNamespace: `overview-cluster-${Date.now().toString(36)}`,
    redisUrl,
  };
  const instanceIdA = `node-a-${Date.now().toString(36)}`;
  const instanceIdB = `node-b-${Date.now().toString(36)}`;
  const serverA = await startAdminServerWithPersistence({
    ...persistenceConfig,
    instanceId: instanceIdA,
  });
  const serverB = await startAdminServerWithPersistence({
    ...persistenceConfig,
    instanceId: instanceIdB,
  });

  try {
    const token = await login(serverA.httpBaseUrl);
    let baselineOverview:
      | {
          runtime: {
            connectionCount: number;
            activeRoomCount: number;
            activeMemberCount: number;
          };
          nodes: {
            total: number;
            online: number;
            items: Array<{ instanceId: string; health: string }>;
          };
        }
      | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const overview = await requestJson(
        serverA.httpBaseUrl,
        "/api/admin/overview",
        { token },
      );
      assert.equal(overview.status, 200);
      baselineOverview = overview.body.data as {
        runtime: {
          connectionCount: number;
          activeRoomCount: number;
          activeMemberCount: number;
        };
        nodes: {
          total: number;
          online: number;
          items: Array<{ instanceId: string; health: string }>;
        };
      };
      if (
        baselineOverview.nodes.items.some(
          (item) => item.instanceId === instanceIdA && item.health === "ok",
        ) &&
        baselineOverview.nodes.items.some(
          (item) => item.instanceId === instanceIdB && item.health === "ok",
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(baselineOverview);

    const owner = await connectClient(serverA.wsUrl);
    const ownerCollector = createMessageCollector(owner);
    const joiner = await connectClient(serverB.wsUrl);
    const joinerCollector = createMessageCollector(joiner);

    try {
      owner.send(
        JSON.stringify({
          type: "room:create",
          payload: { displayName: "Alice" },
        }),
      );
      const created = await ownerCollector.next("room:created");
      await ownerCollector.next("room:state");
      const payload = created.payload as {
        roomCode: string;
        joinToken: string;
      };

      joiner.send(
        JSON.stringify({
          type: "room:join",
          payload: {
            roomCode: payload.roomCode,
            joinToken: payload.joinToken,
            displayName: "Bob",
          },
        }),
      );
      await joinerCollector.next("room:joined");

      let overviewData:
        | {
            runtime: {
              connectionCount: number;
              activeRoomCount: number;
              activeMemberCount: number;
            };
            nodes: {
              total: number;
              online: number;
              items: Array<{ instanceId: string; health: string }>;
            };
          }
        | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const overview = await requestJson(
          serverA.httpBaseUrl,
          "/api/admin/overview",
          { token },
        );
        assert.equal(overview.status, 200);
        overviewData = overview.body.data as {
          runtime: {
            connectionCount: number;
            activeRoomCount: number;
            activeMemberCount: number;
          };
          nodes: {
            total: number;
            online: number;
            items: Array<{ instanceId: string; health: string }>;
          };
        };
        if (
          overviewData.runtime.connectionCount ===
            baselineOverview.runtime.connectionCount + 2 &&
          overviewData.runtime.activeRoomCount ===
            baselineOverview.runtime.activeRoomCount + 1 &&
          overviewData.runtime.activeMemberCount ===
            baselineOverview.runtime.activeMemberCount + 2 &&
          overviewData.nodes.items.some(
            (item) => item.instanceId === instanceIdA && item.health === "ok",
          ) &&
          overviewData.nodes.items.some(
            (item) => item.instanceId === instanceIdB && item.health === "ok",
          )
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      assert.ok(overviewData);
      assert.equal(
        overviewData.runtime.connectionCount,
        baselineOverview.runtime.connectionCount + 2,
      );
      assert.equal(
        overviewData.runtime.activeRoomCount,
        baselineOverview.runtime.activeRoomCount + 1,
      );
      assert.equal(
        overviewData.runtime.activeMemberCount,
        baselineOverview.runtime.activeMemberCount + 2,
      );
      assert.equal(
        overviewData.nodes.items.some(
          (item) => item.instanceId === instanceIdA && item.health === "ok",
        ),
        true,
      );
      assert.equal(
        overviewData.nodes.items.some(
          (item) => item.instanceId === instanceIdB && item.health === "ok",
        ),
        true,
      );
    } finally {
      await closeClient(owner);
      await closeClient(joiner);
    }
  } finally {
    await serverA.close();
    await serverB.close();
  }
});
