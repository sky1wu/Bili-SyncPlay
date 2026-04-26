import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { WebSocket, type RawData } from "ws";
import { createGlobalAdminServer } from "../src/global-admin-app.js";
import {
  createSyncServer,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
  type SyncServer,
  type SyncServerDependencies,
} from "../src/app.js";

export const MULTI_NODE_ALLOWED_ORIGIN = "chrome-extension://allowed-extension";

type RunningNode = {
  name: string;
  server: SyncServer;
  httpBaseUrl: string;
  wsUrl: string;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function listen(
  server: SyncServer,
): Promise<{ httpBaseUrl: string; wsUrl: string }> {
  await new Promise<void>((resolve, reject) => {
    server.httpServer.listen(0, "127.0.0.1", () => resolve());
    server.httpServer.once("error", reject);
  });

  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine test server address.");
  }

  return {
    httpBaseUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}`,
  };
}

export async function requestJson(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    origin?: string | null;
  } = {},
) {
  const originHeader =
    options.origin === null ? undefined : (options.origin ?? baseUrl);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(originHeader ? { Origin: originHeader } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

export async function connectClient(
  wsUrl: string,
  options: { openTimeoutMs?: number } = {},
): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl, {
    origin: MULTI_NODE_ALLOWED_ORIGIN,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        socket.off("open", handleOpen);
        socket.off("error", handleError);
        socket.off("close", handleClose);
      };

      const handleOpen = () => {
        cleanup();
        resolve();
      };

      const handleError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const handleClose = () => {
        cleanup();
        reject(new Error("WebSocket closed before opening."));
      };

      const terminateOpeningSocket = () => {
        socket.on("error", () => {});
        try {
          socket.terminate();
        } catch {
          // Ignore close-time failures after the connect attempt has timed out.
        }
      };

      socket.once("open", handleOpen);
      socket.once("error", handleError);
      socket.once("close", handleClose);

      if (options.openTimeoutMs !== undefined) {
        timeout = setTimeout(() => {
          cleanup();
          terminateOpeningSocket();
          reject(
            new Error(
              `Timed out opening WebSocket after ${options.openTimeoutMs}ms.`,
            ),
          );
        }, options.openTimeoutMs);
      }
    });
  } catch (error) {
    if (
      socket.readyState !== WebSocket.CLOSING &&
      socket.readyState !== WebSocket.CLOSED
    ) {
      socket.on("error", () => {});
      try {
        socket.terminate();
      } catch {
        // Ignore close-time failures after the connect attempt has failed.
      }
    }
    throw error;
  }

  return socket;
}

export function createMessageCollector(socket: WebSocket) {
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
    async maybeNext(type: string, timeoutMs = 200) {
      try {
        return await this.next(type, timeoutMs);
      } catch {
        return null;
      }
    },
  };
}

export async function closeClient(socket: WebSocket): Promise<void> {
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

export async function waitForCondition(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition.");
}

export async function cleanupRedisNamespace(
  redisUrl: string,
  namespace: string,
): Promise<void> {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  await redis.connect();
  try {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${namespace}*`,
        "COUNT",
        "100",
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  } finally {
    await redis.quit();
  }
}

export async function createMultiNodeTestKit(
  redisUrl: string,
  options: {
    securityConfig?: Partial<ReturnType<typeof getDefaultSecurityConfig>>;
  } = {},
) {
  const namespace = `bsp:test:${Date.now().toString(36)}:${randomUUID().slice(0, 8)}:`;
  const adminConfig = {
    username: "admin",
    passwordHash: `sha256:${sha256Hex("secret-123")}`,
    sessionSecret: `session-secret-${randomUUID()}`,
    sessionTtlMs: 60_000,
    role: "admin" as const,
    sessionStoreProvider: "redis" as const,
    eventStoreProvider: "redis" as const,
    auditStoreProvider: "redis" as const,
  };
  const persistenceConfig = {
    ...getDefaultPersistenceConfig(),
    provider: "redis" as const,
    runtimeStoreProvider: "redis" as const,
    roomEventBusProvider: "redis" as const,
    adminCommandBusProvider: "redis" as const,
    redisUrl,
    redisNamespace: namespace,
    nodeHeartbeatEnabled: true,
    nodeHeartbeatIntervalMs: 200,
    nodeHeartbeatTtlMs: 600,
  };
  const securityConfig = {
    ...getDefaultSecurityConfig(),
    ...options.securityConfig,
    allowedOrigins: [MULTI_NODE_ALLOWED_ORIGIN],
  };
  const runningNodes: RunningNode[] = [];

  async function startRoomNode(
    name: string,
    dependencies: SyncServerDependencies = {},
  ) {
    const server = await createSyncServer(
      securityConfig,
      {
        ...persistenceConfig,
        instanceId: name,
      },
      {
        ...dependencies,
        adminConfig: dependencies.adminConfig ?? adminConfig,
        logEvent: dependencies.logEvent ?? (() => {}),
        serviceVersion: dependencies.serviceVersion ?? `0.9.0-${name}-test`,
        adminUiConfig: dependencies.adminUiConfig ?? {
          enabled: false,
          demoEnabled: false,
        },
      },
    );
    const address = await listen(server);
    const node = {
      name,
      server,
      ...address,
    };
    runningNodes.push(node);
    return node;
  }

  async function startGlobalAdmin(name = "global-admin") {
    const server = await createGlobalAdminServer(
      getDefaultSecurityConfig(),
      {
        ...persistenceConfig,
        instanceId: name,
      },
      {
        adminConfig,
        logEvent: () => {},
        serviceVersion: `0.9.0-${name}-test`,
      },
    );
    const address = await listen(server);
    const node = {
      name,
      server,
      ...address,
    };
    runningNodes.push(node);
    return node;
  }

  return {
    namespace,
    persistenceConfig,
    adminConfig,
    async login(baseUrl: string) {
      const login = await requestJson(baseUrl, "/api/admin/auth/login", {
        method: "POST",
        body: { username: "admin", password: "secret-123" },
      });
      assert.equal(login.status, 200);
      return (login.body.data as { token: string }).token;
    },
    startRoomNode,
    startGlobalAdmin,
    async closeAll() {
      while (runningNodes.length > 0) {
        const node = runningNodes.pop();
        if (node) {
          await node.server.close();
        }
      }
      await cleanupRedisNamespace(redisUrl, namespace);
    },
  };
}
