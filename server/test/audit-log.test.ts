import assert from "node:assert/strict";
import test from "node:test";
import { createAuditLogService } from "../src/admin/audit-log.js";
import type { AdminSession } from "../src/admin/types.js";

const ACTOR: AdminSession = {
  id: "session-1",
  adminId: "admin-1",
  username: "admin",
  role: "admin",
  createdAt: 1,
  expiresAt: 1_000,
  lastSeenAt: 1,
};

test("in-memory audit log service keeps query semantics through the global interface", async () => {
  const store = createAuditLogService(2);

  await store.append({
    actor: ACTOR,
    action: "close_room",
    targetType: "room",
    targetId: "ROOM01",
    result: "ok",
    instanceId: "instance-a",
  });
  const kicked = await store.append({
    actor: ACTOR,
    action: "kick_member",
    targetType: "member",
    targetId: "member-2",
    request: { roomCode: "ROOM01" },
    result: "ok",
    instanceId: "instance-a",
  });
  await store.append({
    actor: ACTOR,
    action: "disconnect_session",
    targetType: "session",
    targetId: "session-3",
    result: "error",
    reason: "socket_closed",
    instanceId: "instance-b",
  });

  const filtered = await store.query({
    action: "kick_member",
    page: 1,
    pageSize: 10,
  });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0]?.id, kicked.id);
  assert.equal(filtered.items[0]?.targetId, "member-2");

  const evicted = await store.query({
    action: "close_room",
    page: 1,
    pageSize: 10,
  });
  assert.equal(evicted.total, 0);
});
