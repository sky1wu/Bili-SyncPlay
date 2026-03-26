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

test("redis-backed room queries expose cluster-wide members and node attribution", async (t) => {
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
    redisUrl,
  };
  const instanceIdA = `room-query-a-${Date.now().toString(36)}`;
  const instanceIdB = `room-query-b-${Date.now().toString(36)}`;
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

      let roomsData:
        | {
            items: Array<{
              roomCode: string;
              memberCount: number;
              isActive: boolean;
              instanceIds?: string[];
            }>;
          }
        | undefined;
      let detailData:
        | {
            room: { memberCount: number; instanceIds?: string[] };
            members: Array<{
              displayName: string;
              instanceId?: string;
            }>;
          }
        | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const rooms = await requestJson(
          serverA.httpBaseUrl,
          "/api/admin/rooms?status=active&page=1&pageSize=10",
          { token },
        );
        assert.equal(rooms.status, 200);
        roomsData = rooms.body.data as typeof roomsData;

        const detail = await requestJson(
          serverA.httpBaseUrl,
          `/api/admin/rooms/${payload.roomCode}`,
          { token },
        );
        assert.equal(detail.status, 200);
        detailData = detail.body.data as typeof detailData;

        const roomItem = roomsData?.items.find(
          (item) => item.roomCode === payload.roomCode,
        );
        if (
          roomItem?.memberCount === 2 &&
          detailData?.room.memberCount === 2 &&
          detailData.members.length === 2
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      const roomItem = roomsData?.items.find(
        (item) => item.roomCode === payload.roomCode,
      );
      assert.ok(roomItem);
      assert.equal(roomItem.memberCount, 2);
      assert.equal(roomItem.isActive, true);
      assert.deepEqual(roomItem.instanceIds, [instanceIdA, instanceIdB]);

      assert.ok(detailData);
      assert.equal(detailData.room.memberCount, 2);
      assert.deepEqual(detailData.room.instanceIds, [instanceIdA, instanceIdB]);
      assert.deepEqual(
        detailData.members
          .map((member) => ({
            displayName: member.displayName,
            instanceId: member.instanceId,
          }))
          .sort((left, right) =>
            left.displayName.localeCompare(right.displayName),
          ),
        [
          { displayName: "Alice", instanceId: instanceIdA },
          { displayName: "Bob", instanceId: instanceIdB },
        ],
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
