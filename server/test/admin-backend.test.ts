import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { WebSocket, type RawData } from "ws";
import {
  createSyncServer,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
  type SyncServerDependencies,
} from "../src/app.js";
import type { AdminRole } from "../src/admin/types.js";

const ALLOWED_ORIGIN = "chrome-extension://allowed-extension";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function startAdminServer(dependencies: SyncServerDependencies = {}) {
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
  };
  if (resolvedDependencies.serviceVersion === undefined) {
    resolvedDependencies.serviceVersion = "0.7.0-test";
  }

  const server = await createSyncServer(
    {
      ...getDefaultSecurityConfig(),
      allowedOrigins: [ALLOWED_ORIGIN],
    },
    getDefaultPersistenceConfig(),
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
  };
  if (resolvedDependencies.serviceVersion === undefined) {
    resolvedDependencies.serviceVersion = "0.7.0-test";
  }

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

async function requestText(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    token?: string;
  } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.token
      ? { Authorization: `Bearer ${options.token}` }
      : undefined,
  });

  return {
    status: response.status,
    body: await response.text(),
  };
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
  socket.terminate();
}

async function login(
  baseUrl: string,
  username = "admin",
  password = "secret-123",
): Promise<string> {
  const response = await requestJson(baseUrl, "/api/admin/auth/login", {
    method: "POST",
    body: { username, password },
  });
  assert.equal(response.status, 200);
  return (response.body.data as { token: string }).token;
}

function adminDependencies(role: AdminRole = "admin"): SyncServerDependencies {
  return {
    adminConfig: {
      username: "admin",
      passwordHash: `sha256:${sha256Hex("secret-123")}`,
      sessionSecret: "session-secret-123",
      sessionTtlMs: 60_000,
      role,
      sessionStoreProvider: "memory",
      eventStoreProvider: "memory",
      auditStoreProvider: "memory",
    },
    serviceVersion: "0.7.0-test",
  };
}

test("admin endpoints support auth, overview, rooms, and events without breaking root health routes", async () => {
  const server = await startAdminServer();

  try {
    const adminHtml = await fetch(`${server.httpBaseUrl}/admin`);
    assert.equal(adminHtml.status, 200);
    assert.equal(
      adminHtml.headers.get("content-type")?.includes("text/html"),
      true,
    );
    assert.equal((await adminHtml.text()).includes("/admin/app.js"), true);

    const adminAsset = await fetch(`${server.httpBaseUrl}/admin/app.js`);
    assert.equal(adminAsset.status, 200);
    assert.equal(
      adminAsset.headers.get("content-type")?.includes("text/javascript"),
      true,
    );

    const root = await requestJson(server.httpBaseUrl, "/");
    assert.equal(root.status, 200);
    assert.equal(root.body.ok, true);

    const connectionCheck = await fetch(
      `${server.httpBaseUrl}/api/connection-check`,
      {
        headers: {
          Origin: ALLOWED_ORIGIN,
        },
      },
    );
    assert.equal(connectionCheck.status, 200);
    assert.equal(
      connectionCheck.headers.get("access-control-allow-origin"),
      "*",
    );
    assert.deepEqual(await connectionCheck.json(), {
      ok: true,
      data: {
        websocketAllowed: true,
        reason: null,
      },
    });

    const health = await requestJson(server.httpBaseUrl, "/healthz");
    assert.equal(health.status, 200);
    assert.equal((health.body.data as { status: string }).status, "healthy");

    const ready = await requestJson(server.httpBaseUrl, "/readyz");
    assert.equal(ready.status, 200);
    assert.equal((ready.body.data as { status: string }).status, "ready");

    const unauthorized = await requestJson(server.httpBaseUrl, "/api/admin/me");
    assert.equal(unauthorized.status, 401);

    const login = await requestJson(
      server.httpBaseUrl,
      "/api/admin/auth/login",
      {
        method: "POST",
        body: { username: "admin", password: "secret-123" },
      },
    );
    assert.equal(login.status, 200);
    const token = (login.body.data as { token: string }).token;
    assert.ok(token);

    const me = await requestJson(server.httpBaseUrl, "/api/admin/me", {
      token,
    });
    assert.equal(me.status, 200);
    assert.equal((me.body.data as { username: string }).username, "admin");

    const socket = await connectClient(server.wsUrl);
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

      const overview = await requestJson(
        server.httpBaseUrl,
        "/api/admin/overview",
        { token },
      );
      assert.equal(overview.status, 200);
      const overviewData = overview.body.data as {
        service: { instanceId: string };
        runtime: {
          connectionCount: number;
          activeRoomCount: number;
          activeMemberCount: number;
        };
        rooms: { totalNonExpired: number };
      };
      assert.equal(overviewData.service.instanceId, "instance-1");
      assert.equal(overviewData.runtime.connectionCount, 1);
      assert.equal(overviewData.runtime.activeRoomCount, 1);
      assert.equal(overviewData.runtime.activeMemberCount, 1);
      assert.equal(overviewData.rooms.totalNonExpired, 1);

      const rooms = await requestJson(
        server.httpBaseUrl,
        "/api/admin/rooms?status=active&page=1&pageSize=10",
        { token },
      );
      assert.equal(rooms.status, 200);
      const roomItems = (
        rooms.body.data as {
          items: Array<{
            roomCode: string;
            memberCount: number;
            isActive: boolean;
          }>;
        }
      ).items;
      assert.equal(roomItems.length, 1);
      assert.equal(roomItems[0]?.roomCode, roomCode);
      assert.equal(roomItems[0]?.memberCount, 1);
      assert.equal(roomItems[0]?.isActive, true);

      const detail = await requestJson(
        server.httpBaseUrl,
        `/api/admin/rooms/${roomCode}`,
        { token },
      );
      assert.equal(detail.status, 200);
      const detailData = detail.body.data as {
        instanceId: string;
        room: { instanceId: string };
        members: Array<{ displayName: string }>;
        recentEvents: Array<{ event: string }>;
      };
      assert.equal(detailData.instanceId, "instance-1");
      assert.equal(detailData.room.instanceId, "instance-1");
      assert.equal(detailData.members[0]?.displayName, "Alice");
      assert.equal(
        detailData.recentEvents.some((event) => event.event === "room_created"),
        true,
      );

      const events = await requestJson(
        server.httpBaseUrl,
        `/api/admin/events?event=room_created&roomCode=${roomCode}`,
        { token },
      );
      assert.equal(events.status, 200);
      const eventItems = (
        events.body.data as {
          items: Array<{ event: string; roomCode: string }>;
        }
      ).items;
      assert.equal(eventItems.length, 1);
      assert.equal(eventItems[0]?.event, "room_created");
      assert.equal(eventItems[0]?.roomCode, roomCode);
    } finally {
      await closeClient(socket);
    }

    const logout = await requestJson(
      server.httpBaseUrl,
      "/api/admin/auth/logout",
      {
        method: "POST",
        token,
      },
    );
    assert.equal(logout.status, 200);

    const meAfterLogout = await requestJson(
      server.httpBaseUrl,
      "/api/admin/me",
      { token },
    );
    assert.equal(meAfterLogout.status, 401);
  } finally {
    await server.close();
  }
});

test("admin overview falls back to server package version", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };

  const server = await createSyncServer(
    {
      ...getDefaultSecurityConfig(),
      allowedOrigins: [ALLOWED_ORIGIN],
    },
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
    const token = await login(baseUrl);
    const overview = await requestJson(baseUrl, "/api/admin/overview", {
      token,
    });

    assert.equal(overview.status, 200);
    assert.equal(
      (overview.body.data as { service: { version: string } }).service.version,
      packageJson.version,
    );
  } finally {
    await server.close();
  }
});

test("admin demo mode stays disabled by default and only enables when explicitly configured", async () => {
  const defaultServer = await startAdminServer();

  try {
    const defaultHtml = await requestText(
      defaultServer.httpBaseUrl,
      "/admin/login?demo=1",
    );
    assert.equal(defaultHtml.status, 200);
    assert.equal(defaultHtml.body.includes('"demoEnabled":false'), true);
  } finally {
    await defaultServer.close();
  }

  const enabledServer = await startAdminServer({
    adminUiConfig: {
      demoEnabled: true,
    },
  });

  try {
    const enabledHtml = await requestText(
      enabledServer.httpBaseUrl,
      "/admin/login?demo=1",
    );
    assert.equal(enabledHtml.status, 200);
    assert.equal(enabledHtml.body.includes('"demoEnabled":true'), true);
  } finally {
    await enabledServer.close();
  }
});

test("admin login rejects invalid credentials", async () => {
  const server = await startAdminServer();

  try {
    const login = await requestJson(
      server.httpBaseUrl,
      "/api/admin/auth/login",
      {
        method: "POST",
        body: { username: "admin", password: "wrong-password" },
      },
    );
    assert.equal(login.status, 401);
    assert.equal(login.body.ok, false);
  } finally {
    await server.close();
  }
});

test("redis-backed admin sessions authenticate across server instances and logout globally", async (t) => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const persistenceConfig = {
    ...getDefaultPersistenceConfig(),
    redisUrl,
  };
  const sharedAdminConfig = {
    username: "admin",
    passwordHash: `sha256:${sha256Hex("secret-123")}`,
    sessionSecret: "session-secret-123",
    sessionTtlMs: 60_000,
    role: "admin" as const,
    sessionStoreProvider: "redis" as const,
    eventStoreProvider: "memory" as const,
    auditStoreProvider: "memory" as const,
  };
  const serverA = await startAdminServerWithPersistence(persistenceConfig, {
    adminConfig: sharedAdminConfig,
  });
  const serverB = await startAdminServerWithPersistence(persistenceConfig, {
    adminConfig: sharedAdminConfig,
  });

  try {
    const token = await login(serverA.httpBaseUrl);
    const meOnB = await requestJson(serverB.httpBaseUrl, "/api/admin/me", {
      token,
    });
    assert.equal(meOnB.status, 200);
    assert.equal((meOnB.body.data as { username: string }).username, "admin");

    const logoutOnB = await requestJson(
      serverB.httpBaseUrl,
      "/api/admin/auth/logout",
      {
        method: "POST",
        token,
      },
    );
    assert.equal(logoutOnB.status, 200);

    const meOnAAfterLogout = await requestJson(
      serverA.httpBaseUrl,
      "/api/admin/me",
      { token },
    );
    assert.equal(meOnAAfterLogout.status, 401);
  } finally {
    await serverA.close();
    await serverB.close();
  }
});

test("viewer cannot call admin action endpoints", async () => {
  const server = await startAdminServer(adminDependencies("viewer"));

  try {
    const token = await login(server.httpBaseUrl);
    const response = await requestJson(
      server.httpBaseUrl,
      "/api/admin/rooms/ROOM01/close",
      {
        method: "POST",
        token,
        body: { reason: "not allowed" },
      },
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.ok, false);
  } finally {
    await server.close();
  }
});

test("redis-backed admin events and audit logs are queryable across server instances", async (t) => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const persistenceConfig = {
    ...getDefaultPersistenceConfig(),
    redisUrl,
  };
  const sharedAdminConfig = {
    username: "admin",
    passwordHash: `sha256:${sha256Hex("secret-123")}`,
    sessionSecret: "session-secret-123",
    sessionTtlMs: 60_000,
    role: "operator" as const,
    sessionStoreProvider: "redis" as const,
    eventStoreProvider: "redis" as const,
    auditStoreProvider: "redis" as const,
  };
  const serverA = await startAdminServerWithPersistence(persistenceConfig, {
    adminConfig: sharedAdminConfig,
  });
  const serverB = await startAdminServerWithPersistence(persistenceConfig, {
    adminConfig: sharedAdminConfig,
  });

  try {
    const tokenA = await login(serverA.httpBaseUrl);
    const tokenB = await login(serverB.httpBaseUrl);

    const socket = await connectClient(serverA.wsUrl);
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
      const memberToken = (created.payload as { memberToken: string })
        .memberToken;

      socket.send(
        JSON.stringify({
          type: "video:share",
          payload: {
            memberToken,
            video: {
              videoId: "BV1xx411c7mD",
              url: "https://www.bilibili.com/video/BV1xx411c7mD",
              title: "Video",
            },
          },
        }),
      );
      await collector.next("room:state");

      const clearVideo = await requestJson(
        serverA.httpBaseUrl,
        `/api/admin/rooms/${roomCode}/clear-video`,
        {
          method: "POST",
          token: tokenA,
          body: { reason: "shared audit verification" },
        },
      );
      assert.equal(clearVideo.status, 200);
      await collector.next("room:state");

      const eventsOnB = await requestJson(
        serverB.httpBaseUrl,
        `/api/admin/events?event=room_created&roomCode=${roomCode}`,
        { token: tokenB },
      );
      assert.equal(eventsOnB.status, 200);
      const eventItems = (
        eventsOnB.body.data as {
          items: Array<{ event: string; roomCode: string }>;
        }
      ).items;
      assert.equal(eventItems.some((item) => item.event === "room_created"), true);

      const auditOnB = await requestJson(
        serverB.httpBaseUrl,
        "/api/admin/audit-logs?action=clear_room_video&page=1&pageSize=10",
        { token: tokenB },
      );
      assert.equal(auditOnB.status, 200);
      const auditItems = (
        auditOnB.body.data as {
          items: Array<{ action: string; targetId: string; instanceId: string }>;
        }
      ).items;
      assert.equal(
        auditItems.some(
          (item) =>
            item.action === "clear_room_video" &&
            item.targetId === roomCode &&
            item.instanceId === "instance-1",
        ),
        true,
      );
    } finally {
      await closeClient(socket);
    }
  } finally {
    await serverA.close();
    await serverB.close();
  }
});

test("operator can execute admin actions and query audit logs", async () => {
  const server = await startAdminServer(adminDependencies("operator"));

  try {
    const token = await login(server.httpBaseUrl);
    const owner = await connectClient(server.wsUrl);
    const ownerCollector = createMessageCollector(owner);
    try {
      owner.send(
        JSON.stringify({
          type: "room:create",
          payload: { displayName: "Alice" },
        }),
      );
      const created = await ownerCollector.next("room:created");
      await ownerCollector.next("room:state");
      const roomCode = (created.payload as { roomCode: string }).roomCode;
      const memberToken = (created.payload as { memberToken: string })
        .memberToken;

      owner.send(
        JSON.stringify({
          type: "video:share",
          payload: {
            memberToken,
            video: {
              videoId: "BV1xx411c7mD",
              url: "https://www.bilibili.com/video/BV1xx411c7mD",
              title: "Video",
            },
          },
        }),
      );
      await ownerCollector.next("room:state");

      const clearVideo = await requestJson(
        server.httpBaseUrl,
        `/api/admin/rooms/${roomCode}/clear-video`,
        {
          method: "POST",
          token,
          body: { reason: "reset room" },
        },
      );
      assert.equal(clearVideo.status, 200);
      const clearedState = await ownerCollector.next("room:state");
      assert.equal(
        (clearedState.payload as { sharedVideo: unknown | null }).sharedVideo,
        null,
      );
      assert.equal(
        (clearedState.payload as { playback: unknown | null }).playback,
        null,
      );

      const joiner = await connectClient(server.wsUrl);
      const joinerCollector = createMessageCollector(joiner);
      let kickedMemberToken = "";
      try {
        joiner.send(
          JSON.stringify({
            type: "room:join",
            payload: {
              roomCode,
              joinToken: (created.payload as { joinToken: string }).joinToken,
              displayName: "Bob",
            },
          }),
        );
        const joined = await joinerCollector.next("room:joined");
        kickedMemberToken = (joined.payload as { memberToken: string })
          .memberToken;
        await joinerCollector.next("room:state");
        await ownerCollector.next("room:state");

        const kick = await requestJson(
          server.httpBaseUrl,
          `/api/admin/rooms/${roomCode}/members/${(joined.payload as { memberId: string }).memberId}/kick`,
          {
            method: "POST",
            token,
            body: { reason: "remove member" },
          },
        );
        assert.equal(kick.status, 200);
        await once(joiner, "close");
      } finally {
        await closeClient(joiner);
      }

      const reconnectingJoiner = await connectClient(server.wsUrl);
      const reconnectCollector = createMessageCollector(reconnectingJoiner);
      try {
        reconnectingJoiner.send(
          JSON.stringify({
            type: "room:join",
            payload: {
              roomCode,
              joinToken: (created.payload as { joinToken: string }).joinToken,
              memberToken: kickedMemberToken,
              displayName: "Bob",
            },
          }),
        );
        const kickedError = await reconnectCollector.next("error");
        assert.deepEqual(kickedError.payload, {
          code: "join_token_invalid",
          message:
            "You were removed from the room by an admin. Rejoin the room.",
        });
      } finally {
        await closeClient(reconnectingJoiner);
      }

      const detail = await requestJson(
        server.httpBaseUrl,
        `/api/admin/rooms/${roomCode}`,
        { token },
      );
      assert.equal(detail.status, 200);
      const ownerSessionId = (
        detail.body.data as {
          members: Array<{ sessionId: string; displayName: string }>;
        }
      ).members.find((member) => member.displayName === "Alice")?.sessionId;
      assert.ok(ownerSessionId);

      const disconnect = await requestJson(
        server.httpBaseUrl,
        `/api/admin/sessions/${ownerSessionId}/disconnect`,
        {
          method: "POST",
          token,
          body: { reason: "disconnect owner" },
        },
      );
      assert.equal(disconnect.status, 200);
      await once(owner, "close");

      const expire = await requestJson(
        server.httpBaseUrl,
        `/api/admin/rooms/${roomCode}/expire`,
        {
          method: "POST",
          token,
          body: { reason: "cleanup idle room" },
        },
      );
      assert.equal(expire.status, 200);

      const missingRoom = await requestJson(
        server.httpBaseUrl,
        `/api/admin/rooms/${roomCode}`,
        { token },
      );
      assert.equal(missingRoom.status, 404);

      const auditLogs = await requestJson(
        server.httpBaseUrl,
        "/api/admin/audit-logs?page=1&pageSize=10",
        { token },
      );
      assert.equal(auditLogs.status, 200);
      const actions = (
        auditLogs.body.data as {
          items: Array<{ action: string; instanceId: string }>;
        }
      ).items.map((item) => item.action);
      assert.equal(actions.includes("clear_room_video"), true);
      assert.equal(actions.includes("kick_member"), true);
      assert.equal(actions.includes("disconnect_session"), true);
      assert.equal(actions.includes("expire_room"), true);
      assert.equal(
        (
          auditLogs.body.data as { items: Array<{ instanceId: string }> }
        ).items.every((item) => item.instanceId === "instance-1"),
        true,
      );

      const filteredAuditLogs = await requestJson(
        server.httpBaseUrl,
        "/api/admin/audit-logs?action=kick_member&page=1&pageSize=10",
        { token },
      );
      assert.equal(filteredAuditLogs.status, 200);
      const filteredItems = (
        filteredAuditLogs.body.data as { items: Array<{ action: string }> }
      ).items;
      assert.equal(filteredItems.length, 1);
      assert.equal(filteredItems[0]?.action, "kick_member");
    } finally {
      await closeClient(owner);
    }
  } finally {
    await server.close();
  }
});

test("expire room rejects active rooms and only deletes idle rooms", async () => {
  const server = await startAdminServer(adminDependencies("operator"));

  try {
    const token = await login(server.httpBaseUrl);
    const owner = await connectClient(server.wsUrl);
    const collector = createMessageCollector(owner);

    try {
      owner.send(
        JSON.stringify({
          type: "room:create",
          payload: { displayName: "Alice" },
        }),
      );
      const created = await collector.next("room:created");
      await collector.next("room:state");
      const roomCode = (created.payload as { roomCode: string }).roomCode;

      const activeExpire = await requestJson(
        server.httpBaseUrl,
        `/api/admin/rooms/${roomCode}/expire`,
        {
          method: "POST",
          token,
          body: { reason: "should not expire active room" },
        },
      );
      assert.equal(activeExpire.status, 409);
      assert.deepEqual(activeExpire.body.error, {
        code: "room_active",
        message:
          "Room still has active members. Close the room instead of expiring it early.",
      });

      const stillExists = await requestJson(
        server.httpBaseUrl,
        `/api/admin/rooms/${roomCode}`,
        { token },
      );
      assert.equal(stillExists.status, 200);

      owner.close();
      await once(owner, "close");

      let roomBecameIdle = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const detail = await requestJson(
          server.httpBaseUrl,
          `/api/admin/rooms/${roomCode}`,
          { token },
        );
        if (
          detail.status === 200 &&
          (detail.body.data as { members: Array<unknown> }).members.length === 0
        ) {
          roomBecameIdle = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(roomBecameIdle, true);

      const idleExpire = await requestJson(
        server.httpBaseUrl,
        `/api/admin/rooms/${roomCode}/expire`,
        {
          method: "POST",
          token,
          body: { reason: "cleanup idle room" },
        },
      );
      assert.equal(idleExpire.status, 200);

      const missingRoom = await requestJson(
        server.httpBaseUrl,
        `/api/admin/rooms/${roomCode}`,
        { token },
      );
      assert.equal(missingRoom.status, 404);
    } finally {
      await closeClient(owner);
    }
  } finally {
    await server.close();
  }
});

test("admin exposes metrics and config summary", async () => {
  const server = await startAdminServer(adminDependencies("admin"));

  try {
    const token = await login(server.httpBaseUrl);
    const metrics = await requestText(server.httpBaseUrl, "/metrics");
    assert.equal(metrics.status, 200);
    assert.equal(metrics.body.includes("bili_syncplay_connections"), true);
    assert.equal(
      metrics.body.includes("bili_syncplay_room_created_total"),
      true,
    );

    const config = await requestJson(server.httpBaseUrl, "/api/admin/config", {
      token,
    });
    assert.equal(config.status, 200);
    const configData = config.body.data as {
      instanceId: string;
      persistence: { provider: string; redisConfigured: boolean };
      admin: { configured: boolean; username: string; role: string };
    };
    assert.equal(configData.instanceId, "instance-1");
    assert.equal(configData.persistence.provider, "memory");
    assert.equal(configData.persistence.redisConfigured, false);
    assert.equal(configData.admin.configured, true);
    assert.equal(configData.admin.username, "admin");
    assert.equal(configData.admin.role, "admin");
  } finally {
    await server.close();
  }
});

test("operator can close an active room", async () => {
  const server = await startAdminServer(adminDependencies("operator"));

  try {
    const token = await login(server.httpBaseUrl);
    const owner = await connectClient(server.wsUrl);
    const ownerCollector = createMessageCollector(owner);
    try {
      owner.send(
        JSON.stringify({
          type: "room:create",
          payload: { displayName: "Alice" },
        }),
      );
      const created = await ownerCollector.next("room:created");
      await ownerCollector.next("room:state");
      const roomCode = (created.payload as { roomCode: string }).roomCode;

      const closeRoom = await requestJson(
        server.httpBaseUrl,
        `/api/admin/rooms/${roomCode}/close`,
        {
          method: "POST",
          token,
          body: { reason: "shut down room" },
        },
      );
      assert.equal(closeRoom.status, 200);
      await once(owner, "close");

      const roomDetail = await requestJson(
        server.httpBaseUrl,
        `/api/admin/rooms/${roomCode}`,
        { token },
      );
      assert.equal(roomDetail.status, 404);

      const auditLogs = await requestJson(
        server.httpBaseUrl,
        "/api/admin/audit-logs?action=close_room&page=1&pageSize=10",
        { token },
      );
      assert.equal(auditLogs.status, 200);
      const items = (
        auditLogs.body.data as {
          items: Array<{ action: string; targetId: string }>;
        }
      ).items;
      assert.equal(items.length, 1);
      assert.equal(items[0]?.action, "close_room");
      assert.equal(items[0]?.targetId, roomCode);
    } finally {
      await closeClient(owner);
    }
  } finally {
    await server.close();
  }
});
