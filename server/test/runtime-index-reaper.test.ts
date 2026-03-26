import assert from "node:assert/strict";
import test from "node:test";
import { createRedisRuntimeStore } from "../src/redis-runtime-store.js";
import { createRuntimeIndexReaper } from "../src/runtime-index-reaper.js";
import type { Session } from "../src/types.js";

const REDIS_URL = process.env.REDIS_URL;

function createKeyPrefix(): string {
  return `bsp:test:reaper:${Date.now()}:${Math.random().toString(16).slice(2)}:`;
}

function createSession(id: string, instanceId: string): Session {
  return {
    id,
    instanceId,
    socket: {
      readyState: 1,
      OPEN: 1,
      send() {},
      close() {},
      terminate() {},
    } as Session["socket"],
    remoteAddress: "127.0.0.1",
    origin: "chrome-extension://allowed-extension",
    roomCode: null,
    memberId: null,
    memberToken: null,
    displayName: id,
    joinedAt: 1_000,
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

test("runtime index reaper clears sessions left behind by offline nodes", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  let currentTime = 1_000;
  const keyPrefix = createKeyPrefix();
  const runtimeStore = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    now: () => currentTime,
  });
  const reaper = createRuntimeIndexReaper({
    enabled: true,
    runtimeStore,
    intervalMs: 50,
    now: () => currentTime,
  });
  const session = createSession("session-offline", "offline-node");

  try {
    runtimeStore.registerSession(session);
    runtimeStore.markSessionJoinedRoom(session.id, "ROOM01");
    session.roomCode = "ROOM01";
    session.memberId = "member-offline";
    session.memberToken = "token-offline";
    runtimeStore.registerSession(session);
    runtimeStore.addMember(
      "ROOM01",
      "member-offline",
      session,
      "token-offline",
    );
    await runtimeStore.heartbeatNode({
      instanceId: "offline-node",
      version: "test-version",
      startedAt: 100,
      lastHeartbeatAt: currentTime,
      staleAt: currentTime + 50,
      expiresAt: currentTime + 100,
      connectionCount: 1,
      activeRoomCount: 1,
      activeMemberCount: 1,
      health: "ok",
    });

    assert.equal((await runtimeStore.listClusterSessions()).length, 1);
    assert.equal(await runtimeStore.countClusterActiveRooms(), 1);

    currentTime += 200;
    const cleanedSessions = await reaper.sweep();
    assert.equal(cleanedSessions, 1);

    let remainingSessions = -1;
    let remainingRooms = -1;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      remainingSessions = (await runtimeStore.listClusterSessions()).length;
      remainingRooms = await runtimeStore.countClusterActiveRooms();
      if (remainingSessions === 0 && remainingRooms === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(remainingSessions, 0);
    assert.equal(remainingRooms, 0);
    assert.equal(await runtimeStore.getRoom("ROOM01"), null);
  } finally {
    await reaper.stop();
    await runtimeStore.close();
  }
});
