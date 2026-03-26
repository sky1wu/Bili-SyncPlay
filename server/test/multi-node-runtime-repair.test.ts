import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeIndexReaper } from "../src/runtime-index-reaper.js";
import { getRedisRuntimeKeyPrefix } from "../src/redis-namespace.js";
import { createRedisRuntimeStore } from "../src/redis-runtime-store.js";
import type { Session } from "../src/types.js";
import {
  closeClient,
  connectClient,
  createMessageCollector,
  createMultiNodeTestKit,
  requestJson,
} from "./multi-node-test-kit.js";

const DETACHED_SOCKET = {
  readyState: 3,
  OPEN: 1,
  send() {},
  close() {},
  terminate() {},
} as Session["socket"];

function createGhostSession(roomCode: string): Session {
  return {
    id: "offline-session-1",
    socket: DETACHED_SOCKET,
    instanceId: "node-crashed",
    remoteAddress: "127.0.0.10",
    origin: "chrome-extension://allowed-extension",
    roomCode,
    memberId: "offline-member-1",
    displayName: "Ghost",
    memberToken: "offline-member-token",
    joinedAt: Date.now() - 5_000,
    invalidMessageCount: 0,
    rateLimitState: {
      roomCreate: { windowStart: 0, count: 0 },
      roomJoin: { windowStart: 0, count: 0 },
      videoShare: { windowStart: 0, count: 0 },
      playbackUpdate: { tokens: 0, lastRefillAt: 0 },
      syncRequest: { windowStart: 0, count: 0 },
      syncPing: { tokens: 0, lastRefillAt: 0 },
    },
  };
}

test("offline node sessions are reaped from the global room view after heartbeat timeout", async (t) => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const kit = await createMultiNodeTestKit(redisUrl);
  const nodeA = await kit.startRoomNode("node-a");
  const globalAdmin = await kit.startGlobalAdmin();
  const token = await kit.login(globalAdmin.httpBaseUrl);
  const owner = await connectClient(nodeA.wsUrl);
  const ownerCollector = createMessageCollector(owner);
  const runtimeStore = await createRedisRuntimeStore(redisUrl, {
    keyPrefix: getRedisRuntimeKeyPrefix(kit.namespace),
  });

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

    const ghostSession = createGhostSession(roomCode);
    runtimeStore.registerSession(ghostSession);
    runtimeStore.markSessionJoinedRoom(ghostSession.id, roomCode);
    runtimeStore.addMember(
      roomCode,
      ghostSession.memberId ?? "offline-member-1",
      ghostSession,
      ghostSession.memberToken ?? "offline-member-token",
    );
    await runtimeStore.heartbeatNode({
      instanceId: "node-crashed",
      version: "0.9.0-node-crashed-test",
      startedAt: Date.now() - 60_000,
      lastHeartbeatAt: Date.now() - 5_000,
      staleAt: Date.now() - 4_000,
      expiresAt: Date.now() - 3_000,
      connectionCount: 1,
      activeRoomCount: 1,
      activeMemberCount: 1,
      health: "offline",
    });

    const detailBeforeRepair = await requestJson(
      globalAdmin.httpBaseUrl,
      `/api/admin/rooms/${roomCode}`,
      { token },
    );
    assert.equal(detailBeforeRepair.status, 200);
    assert.equal(
      (
        detailBeforeRepair.body.data as {
          members: Array<{ displayName: string }>;
        }
      ).members.some((member) => member.displayName === "Ghost"),
      true,
    );

    const overviewBeforeRepair = await requestJson(
      globalAdmin.httpBaseUrl,
      "/api/admin/overview",
      { token },
    );
    assert.equal(overviewBeforeRepair.status, 200);
    assert.equal(
      (overviewBeforeRepair.body.data as { nodes: { offline: number } }).nodes
        .offline >= 1,
      true,
    );

    const reaper = createRuntimeIndexReaper({
      enabled: true,
      runtimeStore,
      intervalMs: 50,
      now: Date.now,
    });
    await reaper.sweep();
    await reaper.stop();

    const detailAfterRepair = await requestJson(
      globalAdmin.httpBaseUrl,
      `/api/admin/rooms/${roomCode}`,
      { token },
    );
    assert.equal(detailAfterRepair.status, 200);
    assert.deepEqual(
      (
        detailAfterRepair.body.data as {
          members: Array<{ displayName: string }>;
        }
      ).members.map((member) => member.displayName),
      ["Alice"],
    );
  } finally {
    await runtimeStore.close();
    await closeClient(owner);
    await kit.closeAll();
  }
});
