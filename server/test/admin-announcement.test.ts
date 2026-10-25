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
import {
  ANNOUNCEMENT_MAX_LIFETIME_MS,
  createAdminAnnouncementService,
} from "../src/admin/announcement-service.js";
import { AdminActionError } from "../src/admin/action-service.js";
import { createAuditLogService } from "../src/admin/audit-log.js";
import type { AdminRole, AdminSession } from "../src/admin/types.js";
import { createInMemoryRoomStore } from "../src/room-store.js";

const ALLOWED_ORIGIN = "chrome-extension://allowed-extension";
const ACTOR: AdminSession = {
  id: "session-1",
  adminId: "admin-1",
  username: "admin",
  role: "operator",
  createdAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
  lastSeenAt: 0,
};

function createService(now = 1_000_000) {
  const roomStore = createInMemoryRoomStore({ now: () => now });
  const auditLogService = createAuditLogService();
  const events: string[] = [];
  let nextId = 0;
  const service = createAdminAnnouncementService({
    instanceId: "admin-node",
    roomStore,
    auditLogService,
    logEvent: (event) => {
      events.push(event);
    },
    now: () => now,
    generateId: () => `announcement-${(nextId += 1)}`,
  });
  return { service, roomStore, auditLogService, events };
}

async function rejection(promise: Promise<unknown>): Promise<AdminActionError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AdminActionError);
    return error;
  }
  assert.fail("expected a rejection");
}

async function flushAudit(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("publishing stores the announcement with the lifetime up to expiresAt", async () => {
  const { service, roomStore } = createService(1_000_000);
  const published = await service.publish(ACTOR, {
    level: "warning",
    message: "  今晚 04:30 维护  ",
    scheduledAt: 2_000_000,
    expiresAt: 1_600_000,
  });
  assert.deepEqual(published.announcement, {
    id: "announcement-1",
    level: "warning",
    message: "今晚 04:30 维护",
    scheduledAt: 2_000_000,
    publishedAt: 1_000_000,
    expiresAt: 1_600_000,
  });
  const stored = await roomStore.getAnnouncement();
  assert.equal(stored?.remainingMs, 600_000);
  assert.equal(stored?.announcement.id, "announcement-1");
  assert.deepEqual(await service.getCurrent(), {
    announcement: published.announcement,
  });
});

test("a new publication replaces the current one under a new id", async () => {
  const { service } = createService();
  await service.publish(ACTOR, {
    level: "info",
    message: "first",
    expiresAt: 2_000_000,
  });
  await service.publish(ACTOR, {
    level: "info",
    message: "second",
    expiresAt: 2_000_000,
  });
  const current = await service.getCurrent();
  assert.equal(current.announcement?.id, "announcement-2");
  assert.equal(current.announcement?.message, "second");
  assert.equal(current.announcement?.scheduledAt, null);
});

test("publishing refuses input no receiver could take", async () => {
  const { service, roomStore } = createService(1_000_000);
  const valid = { level: "info", message: "ok", expiresAt: 1_100_000 };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["invalid_level", { level: "critical" }],
    ["invalid_message", { message: "   " }],
    ["invalid_message", { message: 42 }],
    ["input_too_long", { message: "x".repeat(501) }],
    ["invalid_scheduled_at", { scheduledAt: "04:30" }],
    ["invalid_expires_at", { expiresAt: undefined }],
    ["expires_at_in_past", { expiresAt: 1_000_000 }],
    [
      "expires_at_too_far",
      { expiresAt: 1_000_000 + ANNOUNCEMENT_MAX_LIFETIME_MS + 1 },
    ],
  ];
  for (const [code, override] of cases) {
    const error = await rejection(
      service.publish(ACTOR, { ...valid, ...override }),
    );
    assert.equal(error.statusCode, 400, code);
    assert.equal(error.code, code);
  }
  assert.equal(await roomStore.getAnnouncement(), null);
});

test("publish and withdraw are both audited against the announcement", async () => {
  const { service, auditLogService } = createService();
  await service.publish(ACTOR, {
    level: "warning",
    message: "maintenance",
    expiresAt: 2_000_000,
  });
  const withdrawn = await service.withdraw(ACTOR, "  done early  ");
  assert.deepEqual(withdrawn, { withdrawnId: "announcement-1" });
  assert.deepEqual(await service.getCurrent(), { announcement: null });
  await flushAudit();

  const { items } = await auditLogService.query({ page: 1, pageSize: 10 });
  const byAction = new Map(items.map((item) => [item.action, item]));
  const publishAudit = byAction.get("publish_announcement");
  assert.equal(publishAudit?.targetType, "announcement");
  assert.equal(publishAudit?.targetId, "announcement-1");
  assert.equal(publishAudit?.result, "ok");
  const withdrawAudit = byAction.get("withdraw_announcement");
  assert.equal(withdrawAudit?.targetId, "announcement-1");
  assert.equal(withdrawAudit?.reason, "done early");
});

test("withdrawing with nothing published still clears and says so", async () => {
  const { service } = createService();
  assert.deepEqual(await service.withdraw(ACTOR), { withdrawnId: null });
});

test("a store failure is audited as an error and surfaces to the caller", async () => {
  const roomStore = createInMemoryRoomStore();
  const auditLogService = createAuditLogService();
  const service = createAdminAnnouncementService({
    instanceId: "admin-node",
    roomStore: {
      getAnnouncement: roomStore.getAnnouncement,
      setAnnouncement: async () => {
        throw new Error("redis down");
      },
      clearAnnouncement: roomStore.clearAnnouncement,
    },
    auditLogService,
    logEvent: () => {},
    now: () => 1_000_000,
  });
  await assert.rejects(
    service.publish(ACTOR, {
      level: "info",
      message: "x",
      expiresAt: 2_000_000,
    }),
    /redis down/,
  );
  await flushAudit();
  const { items } = await auditLogService.query({ page: 1, pageSize: 10 });
  assert.equal(items[0]?.action, "publish_announcement");
  assert.equal(items[0]?.result, "error");
});

test("an audit store that throws is reported, not raised, with the instance", async () => {
  const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
  const service = createAdminAnnouncementService({
    instanceId: "admin-node",
    roomStore: createInMemoryRoomStore({ now: () => 1_000_000 }),
    auditLogService: {
      append: () => {
        // Synchronously, the case the deferral exists for.
        throw new Error("audit down");
      },
      query: () => ({ items: [], total: 0 }),
    },
    logEvent: (event, data) => {
      logged.push({ event, data });
    },
    now: () => 1_000_000,
  });
  await service.publish(ACTOR, {
    level: "info",
    message: "x",
    expiresAt: 2_000_000,
  });
  await flushAudit();
  const failure = logged.find(
    (entry) => entry.event === "admin_audit_log_append_failed",
  );
  assert.equal(failure?.data.instanceId, "admin-node");
  assert.equal(failure?.data.targetType, "announcement");
  assert.equal(failure?.data.error, "audit down");
});

// ---------------------------------------------------------------------------
// End to end: HTTP API → store → node poll → WebSocket client.

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function startServer(role: AdminRole = "admin") {
  const dependencies: SyncServerDependencies = {
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
    announcementPollIntervalMs: 50,
  };
  const server = await createSyncServer(
    { ...getDefaultSecurityConfig(), allowedOrigins: [ALLOWED_ORIGIN] },
    getDefaultPersistenceConfig(),
    dependencies,
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
  options: { method?: string; token?: string; body?: unknown } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
      Origin: baseUrl,
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

async function joinRoomClient(
  wsUrl: string,
  protocolVersion?: number,
  join?: { roomCode: string; joinToken: string },
) {
  const socket = new WebSocket(wsUrl, { origin: ALLOWED_ORIGIN });
  const messages: Array<Record<string, unknown>> = [];
  socket.on("message", (raw: RawData) => {
    messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
  });
  await once(socket, "open");
  const version = protocolVersion === undefined ? {} : { protocolVersion };
  socket.send(
    JSON.stringify(
      join
        ? {
            type: "room:join",
            payload: { ...join, displayName: "Bob", ...version },
          }
        : {
            type: "room:create",
            payload: { displayName: "Alice", ...version },
          },
    ),
  );
  return { socket, messages };
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 2_000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}

function announcementsIn(messages: Array<Record<string, unknown>>) {
  return messages
    .filter((message) => message.type === "server:announcement")
    .map(
      (message) =>
        (message.payload as { announcement: Record<string, unknown> | null })
          .announcement,
    );
}

test("an announcement published over HTTP reaches capable clients, and its withdrawal too", async () => {
  const server = await startServer();
  try {
    const token = await login(server.httpBaseUrl);
    const capable = await joinRoomClient(server.wsUrl, 5);
    const legacy = await joinRoomClient(server.wsUrl, 4);
    const created = await waitFor(() =>
      capable.messages.find((message) => message.type === "room:created"),
    );
    const { roomCode, joinToken } = created.payload as {
      roomCode: string;
      joinToken: string;
    };
    await waitFor(() =>
      legacy.messages.find((message) => message.type === "room:created"),
    );

    const published = await requestJson(
      server.httpBaseUrl,
      "/api/admin/announcement",
      {
        method: "POST",
        token,
        body: {
          level: "warning",
          message: "今晚 04:30 维护",
          expiresAt: Date.now() + 600_000,
        },
      },
    );
    assert.equal(published.status, 200);
    const publishedId = (
      published.body.data as { announcement: { id: string } }
    ).announcement.id;

    const delivered = await waitFor(() =>
      announcementsIn(capable.messages).find(
        (announcement): announcement is Record<string, unknown> =>
          announcement?.id === publishedId,
      ),
    );
    assert.equal(delivered.level, "warning");
    assert.equal(delivered.message, "今晚 04:30 维护");
    assert.ok(
      typeof delivered.expiresInMs === "number" &&
        delivered.expiresInMs > 590_000 &&
        delivered.expiresInMs <= 600_000,
    );

    const current = await requestJson(
      server.httpBaseUrl,
      "/api/admin/announcement",
      { token },
    );
    assert.equal(
      (current.body.data as { announcement: { id: string } }).announcement.id,
      publishedId,
    );

    // A client entering after publication gets it right after it is told it
    // is in the room, on both the create and the join path.
    const late = await joinRoomClient(server.wsUrl, 5);
    const joiner = await joinRoomClient(server.wsUrl, 5, {
      roomCode,
      joinToken,
    });
    for (const [client, entered] of [
      [late, "room:created"],
      [joiner, "room:joined"],
    ] as const) {
      const types = await waitFor(() => {
        const seen = client.messages.map((message) => message.type);
        return seen.includes("room:state") ? seen : undefined;
      });
      assert.deepEqual(
        types.filter((type) => type !== "room:member-joined").slice(0, 3),
        [entered, "server:announcement", "room:state"],
      );
    }

    const withdrawn = await requestJson(
      server.httpBaseUrl,
      "/api/admin/announcement/withdraw",
      { method: "POST", token, body: { reason: "cancelled" } },
    );
    assert.equal(withdrawn.status, 200);
    await waitFor(() => {
      const received = announcementsIn(capable.messages);
      return received[received.length - 1] === null ? true : undefined;
    });

    assert.deepEqual(announcementsIn(legacy.messages), []);
    capable.socket.terminate();
    legacy.socket.terminate();
    late.socket.terminate();
    joiner.socket.terminate();
  } finally {
    await server.close();
  }
});

test("only operators may publish or withdraw; viewers may read", async () => {
  const server = await startServer("viewer");
  try {
    const token = await login(server.httpBaseUrl);
    const read = await requestJson(
      server.httpBaseUrl,
      "/api/admin/announcement",
      { token },
    );
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.data, { announcement: null });

    const publish = await requestJson(
      server.httpBaseUrl,
      "/api/admin/announcement",
      {
        method: "POST",
        token,
        body: {
          level: "info",
          message: "x",
          expiresAt: Date.now() + 60_000,
        },
      },
    );
    assert.equal(publish.status, 403);
    const withdraw = await requestJson(
      server.httpBaseUrl,
      "/api/admin/announcement/withdraw",
      { method: "POST", token, body: {} },
    );
    assert.equal(withdraw.status, 403);

    const anonymous = await requestJson(
      server.httpBaseUrl,
      "/api/admin/announcement",
    );
    assert.equal(anonymous.status, 401);
  } finally {
    await server.close();
  }
});

test("an invalid publication is a 400 with the reason", async () => {
  const server = await startServer();
  try {
    const token = await login(server.httpBaseUrl);
    const response = await requestJson(
      server.httpBaseUrl,
      "/api/admin/announcement",
      {
        method: "POST",
        token,
        body: { level: "info", message: "x", expiresAt: Date.now() - 1 },
      },
    );
    assert.equal(response.status, 400);
    assert.equal(
      (response.body.error as { code: string }).code,
      "expires_at_in_past",
    );
  } finally {
    await server.close();
  }
});
