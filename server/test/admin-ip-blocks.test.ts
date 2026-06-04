import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
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

async function startAdminServer(dependencies: SyncServerDependencies = {}) {
  const server = await createSyncServer(
    {
      ...getDefaultSecurityConfig(),
      allowedOrigins: [ALLOWED_ORIGIN],
    },
    getDefaultPersistenceConfig(),
    {
      ...adminDependencies(),
      now: () => 0,
      ...dependencies,
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

  return {
    close: server.close,
    httpBaseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function requestJson(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    origin?: string | null;
  } = {},
) {
  const method = options.method ?? "GET";
  const originHeader =
    options.origin === null ? undefined : (options.origin ?? baseUrl);
  const response = await fetch(`${baseUrl}${path}`, {
    method,
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

async function login(baseUrl: string): Promise<string> {
  const response = await requestJson(baseUrl, "/api/admin/auth/login", {
    method: "POST",
    body: { username: "admin", password: "secret-123" },
  });
  assert.equal(response.status, 200);
  return (response.body.data as { token: string }).token;
}

test("admin IP block routes list, add, delete, and audit blacklist entries", async () => {
  const server = await startAdminServer();

  try {
    const token = await login(server.httpBaseUrl);

    const empty = await requestJson(
      server.httpBaseUrl,
      "/api/admin/ip-blocks",
      {
        token,
      },
    );
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.data, { items: [], total: 0 });

    const added = await requestJson(
      server.httpBaseUrl,
      "/api/admin/ip-blocks",
      {
        method: "POST",
        token,
        body: { ip: "::ffff:203.0.113.4", reason: "spam" },
      },
    );
    assert.equal(added.status, 200);
    assert.deepEqual(added.body.data, {
      record: {
        ip: "203.0.113.4",
        createdAt: 0,
        actor: {
          adminId: "admin-1",
          username: "admin",
          role: "admin",
        },
        reason: "spam",
      },
      created: true,
      disconnectedSessionCount: 0,
    });

    const duplicate = await requestJson(
      server.httpBaseUrl,
      "/api/admin/ip-blocks",
      {
        method: "POST",
        token,
        body: { ip: "203.0.113.4", reason: "duplicate" },
      },
    );
    assert.equal(duplicate.status, 200);
    assert.equal(
      (duplicate.body.data as { created: boolean; record: { reason: string } })
        .created,
      false,
    );
    assert.equal(
      (duplicate.body.data as { created: boolean; record: { reason: string } })
        .record.reason,
      "spam",
    );

    const listed = await requestJson(
      server.httpBaseUrl,
      "/api/admin/ip-blocks",
      { token },
    );
    assert.equal(listed.status, 200);
    assert.deepEqual(
      (listed.body.data as { items: Array<{ ip: string }> }).items.map(
        (record) => record.ip,
      ),
      ["203.0.113.4"],
    );

    const deleted = await requestJson(
      server.httpBaseUrl,
      "/api/admin/ip-blocks/203.0.113.4",
      {
        method: "DELETE",
        token,
        body: { reason: "appeal accepted" },
      },
    );
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body.data, {
      ip: "203.0.113.4",
      removed: true,
    });

    const audit = await requestJson(
      server.httpBaseUrl,
      "/api/admin/audit-logs?targetType=block&pageSize=10",
      { token },
    );
    assert.equal(audit.status, 200);
    assert.deepEqual(
      (audit.body.data as { items: Array<{ action: string }> }).items.map(
        (record) => record.action,
      ),
      ["unblock_ip", "block_ip", "block_ip"],
    );
  } finally {
    await server.close();
  }
});

test("admin IP block write routes reject invalid IPs and insufficient roles", async () => {
  const adminServer = await startAdminServer();
  const viewerServer = await startAdminServer({
    adminConfig: adminDependencies("viewer").adminConfig,
  });

  try {
    const adminToken = await login(adminServer.httpBaseUrl);
    const invalid = await requestJson(
      adminServer.httpBaseUrl,
      "/api/admin/ip-blocks",
      {
        method: "POST",
        token: adminToken,
        body: { ip: "not-an-ip" },
      },
    );
    assert.equal(invalid.status, 400);
    assert.equal(
      (invalid.body.error as { code: string }).code,
      "invalid_ip_address",
    );

    const viewerToken = await login(viewerServer.httpBaseUrl);
    const forbidden = await requestJson(
      viewerServer.httpBaseUrl,
      "/api/admin/ip-blocks",
      {
        method: "POST",
        token: viewerToken,
        body: { ip: "203.0.113.9" },
      },
    );
    assert.equal(forbidden.status, 403);

    const csrfRejected = await requestJson(
      adminServer.httpBaseUrl,
      "/api/admin/ip-blocks",
      {
        method: "POST",
        token: adminToken,
        origin: "https://evil.example",
        body: { ip: "203.0.113.10" },
      },
    );
    assert.equal(csrfRejected.status, 403);
  } finally {
    await adminServer.close();
    await viewerServer.close();
  }
});
