import assert from "node:assert/strict";
import test from "node:test";
import { createRedisAuditStore } from "../src/admin/redis-audit-store.js";
import type { AdminSession } from "../src/admin/types.js";

const REDIS_URL = process.env.REDIS_URL;

const ACTOR: AdminSession = {
  id: "session-1",
  adminId: "admin-1",
  username: "admin",
  role: "admin",
  createdAt: 1,
  expiresAt: 1_000,
  lastSeenAt: 1,
};

function createStreamKey(): string {
  return `bsp:test:audit:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

test("redis audit store appends, trims, and queries records across store instances", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const streamKey = createStreamKey();
  const storeA = await createRedisAuditStore(REDIS_URL, {
    streamKey,
    maxLen: 2,
  });
  const storeB = await createRedisAuditStore(REDIS_URL, {
    streamKey,
    maxLen: 2,
  });

  try {
    await storeA.append({
      actor: ACTOR,
      action: "close_room",
      targetType: "room",
      targetId: "ROOM01",
      result: "ok",
      instanceId: "instance-a",
    });
    const kicked = await storeB.append({
      actor: ACTOR,
      action: "kick_member",
      targetType: "member",
      targetId: "member-2",
      request: { roomCode: "ROOM01" },
      result: "ok",
      instanceId: "instance-b",
      targetInstanceId: "instance-a",
      executorInstanceId: "instance-a",
      commandRequestId: "req-2",
      commandStatus: "ok",
    });
    await storeA.append({
      actor: ACTOR,
      action: "disconnect_session",
      targetType: "session",
      targetId: "session-3",
      result: "error",
      reason: "socket_closed",
      instanceId: "instance-a",
    });

    const filtered = await storeA.query({
      action: "kick_member",
      page: 1,
      pageSize: 10,
    });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0]?.id, kicked.id);
    assert.equal(filtered.items[0]?.instanceId, "instance-b");
    assert.equal(filtered.items[0]?.targetInstanceId, "instance-a");
    assert.equal(filtered.items[0]?.executorInstanceId, "instance-a");
    assert.equal(filtered.items[0]?.commandRequestId, "req-2");
    assert.equal(filtered.items[0]?.commandStatus, "ok");

    const trimmed = await storeB.query({
      page: 1,
      pageSize: 10,
    });
    assert.equal(trimmed.total, 2);
    assert.equal(
      trimmed.items.some((item) => item.action === "close_room"),
      false,
    );
  } finally {
    await storeA.close();
    await storeB.close();
  }
});
