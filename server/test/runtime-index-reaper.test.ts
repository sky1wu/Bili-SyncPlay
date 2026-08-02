import assert from "node:assert/strict";
import test from "node:test";
import { createRedisRuntimeStore } from "../src/redis-runtime-store.js";
import {
  createRuntimeIndexReaper,
  type RuntimeIndexReaperStore,
} from "../src/runtime-index-reaper.js";
import type { AttachedSession, Session } from "../src/types.js";

const REDIS_URL = process.env.REDIS_URL;

function createKeyPrefix(): string {
  return `bsp:test:reaper:${Date.now()}:${Math.random().toString(16).slice(2)}:`;
}

function createSession(id: string, instanceId: string): Session {
  return {
    id,
    instanceId,
    connectionState: "attached",
    socket: {
      readyState: 1,
      OPEN: 1,
      send() {},
      close() {},
      terminate() {},
    } as unknown as AttachedSession["socket"],
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
    const offlineStatuses = await runtimeStore.listNodeStatuses(currentTime);
    assert.equal(offlineStatuses.length, 1);
    assert.equal(offlineStatuses[0]?.instanceId, "offline-node");
    assert.equal(offlineStatuses[0]?.health, "offline");

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
    // The offline node's members are gone, but their identity is not: those
    // clients are alive and reconnecting to a surviving node, and they must
    // come back as the same members (#234). The token is what lets them.
    const reapedRoom = await runtimeStore.getRoom("ROOM01");
    assert.equal(reapedRoom?.members.size ?? 0, 0);
    assert.equal(
      await runtimeStore.findMemberIdByToken("ROOM01", "token-offline"),
      "member-offline",
    );

    let remainingStatuses: Awaited<
      ReturnType<typeof runtimeStore.listNodeStatuses>
    > = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await reaper.sweep();
      remainingStatuses = await runtimeStore.listNodeStatuses(currentTime);
      if (remainingStatuses.length === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(remainingStatuses, []);
  } finally {
    await reaper.stop();
    await runtimeStore.close();
  }
});

test("runtime index reaper tells the rooms it emptied to rebuild", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  // A node that dies takes its members' seats with it and publishes nothing, so
  // as far as the survivors are concerned nobody left. When one of those seats
  // held the share, every client still names it as `sharedByMemberId` and the
  // room stops advancing (#235 review).
  let currentTime = 1_000;
  const keyPrefix = createKeyPrefix();
  const runtimeStore = await createRedisRuntimeStore(REDIS_URL, {
    keyPrefix,
    now: () => currentTime,
  });
  const publishedRooms: string[] = [];
  const reaper = createRuntimeIndexReaper({
    enabled: true,
    runtimeStore,
    intervalMs: 50,
    now: () => currentTime,
    publishRoomStateUpdate: async (roomCode) => {
      publishedRooms.push(roomCode);
    },
  });

  const first = createSession("session-dead-1", "offline-node");
  const second = createSession("session-dead-2", "offline-node");

  try {
    for (const [index, session] of [first, second].entries()) {
      runtimeStore.registerSession(session);
      runtimeStore.markSessionJoinedRoom(session.id, "ROOM41");
      session.roomCode = "ROOM41";
      session.memberId = `member-dead-${index}`;
      session.memberToken = `token-dead-${index}`;
      runtimeStore.registerSession(session);
      runtimeStore.addMember(
        "ROOM41",
        session.memberId,
        session,
        session.memberToken,
      );
    }
    await runtimeStore.heartbeatNode({
      instanceId: "offline-node",
      version: "test-version",
      startedAt: 100,
      lastHeartbeatAt: currentTime,
      staleAt: currentTime + 50,
      expiresAt: currentTime + 100,
      connectionCount: 2,
      activeRoomCount: 1,
      activeMemberCount: 2,
      health: "ok",
    });

    currentTime += 200;
    assert.equal(await reaper.sweep(), 2);

    // Once per room, not once per seat: both members sat in the same room.
    assert.deepEqual(publishedRooms, ["ROOM41"]);
  } finally {
    await reaper.stop();
    await runtimeStore.close();
  }
});

test("runtime index reaper announces the room even when the index write fails", async () => {
  // Gating the announcement on that write lost it for good: `unregisterSession`
  // deletes the session hash and SREMs the same room-sessions key on its own, so
  // the room ends up clean either way — while the session disappears from
  // `listClusterSessions`, leaving the next pass nothing to retry (#235 review).
  const published: string[] = [];
  let flushed = 0;
  const reaped: string[] = [];
  const deadSession = createSession("session-unwritable", "offline-node");
  deadSession.roomCode = "ROOM42";
  deadSession.memberId = "member-unwritable";

  const runtimeStore: RuntimeIndexReaperStore = {
    async listNodeStatuses() {
      return [
        {
          instanceId: "offline-node",
          version: "test",
          startedAt: 0,
          lastHeartbeatAt: 0,
          staleAt: 0,
          expiresAt: 0,
          connectionCount: 1,
          activeRoomCount: 1,
          activeMemberCount: 1,
          health: "offline" as const,
        },
      ];
    },
    async listClusterSessions() {
      return reaped.length > 0 ? [] : [deadSession];
    },
    removeMember() {
      return { room: null, roomEmpty: false, removed: true };
    },
    async markSessionLeftRoom() {
      throw new Error("index write failed");
    },
    unregisterSession(sessionId: string) {
      reaped.push(sessionId);
    },
    async purgeNodeStatus() {},
    async flush() {
      flushed += 1;
    },
  };

  const reaper = createRuntimeIndexReaper({
    enabled: true,
    // Structurally checked, not cast: the whole point of this test is the
    // contract of the writes it drives (#235 review).
    runtimeStore,
    intervalMs: 50,
    now: () => 1_000,
    publishRoomStateUpdate: async (roomCode) => {
      published.push(roomCode);
    },
  });

  try {
    assert.equal(await reaper.sweep(), 1);
    assert.deepEqual(reaped, ["session-unwritable"]);
    assert.deepEqual(published, ["ROOM42"]);
    assert.ok(
      flushed > 0,
      "queued cleanups must drain before the announcement",
    );
  } finally {
    await reaper.stop();
  }
});

test("runtime index reaper keeps a failed announcement until it is published", async () => {
  // The announcement is one-shot. Once this sweep has cleaned the indexes,
  // `listClusterSessions` no longer returns those sessions, so a later sweep
  // finds nothing to rediscover the room from — a swallowed publish failure
  // stranded the room forever, with every survivor caching a dead member as
  // `sharedByMemberId` (#242).
  const published: string[] = [];
  const events: string[] = [];
  let publishFailures = 2;
  const reaped: string[] = [];
  const deadSession = createSession("session-stranded", "offline-node");
  deadSession.roomCode = "ROOM43";
  deadSession.memberId = "member-stranded";

  const runtimeStore: RuntimeIndexReaperStore = {
    async listNodeStatuses() {
      // Only the FIRST sweep sees a dead node. Every later sweep takes the
      // "nothing to do" early return — which the retry has to survive.
      return reaped.length > 0
        ? []
        : [
            {
              instanceId: "offline-node",
              version: "test",
              startedAt: 0,
              lastHeartbeatAt: 0,
              staleAt: 0,
              expiresAt: 0,
              connectionCount: 1,
              activeRoomCount: 1,
              activeMemberCount: 1,
              health: "offline" as const,
            },
          ];
    },
    async listClusterSessions() {
      return reaped.length > 0 ? [] : [deadSession];
    },
    removeMember() {
      return { room: null, roomEmpty: false, removed: true };
    },
    async markSessionLeftRoom() {},
    unregisterSession(sessionId: string) {
      reaped.push(sessionId);
    },
    async purgeNodeStatus() {},
    async flush() {},
  };

  const reaper = createRuntimeIndexReaper({
    enabled: true,
    runtimeStore,
    intervalMs: 50,
    now: () => 1_000,
    logEvent: (event) => {
      events.push(event);
    },
    publishRoomStateUpdate: async (roomCode) => {
      if (publishFailures > 0) {
        publishFailures -= 1;
        throw new Error("bus rejected");
      }
      published.push(roomCode);
    },
  });

  try {
    assert.equal(await reaper.sweep(), 1);
    assert.deepEqual(published, [], "the first announcement failed");
    assert.ok(events.includes("runtime_index_resync_publish_failed"));

    // The session is gone from the cluster index by now, so the record kept in
    // the reaper is the only trail left.
    assert.equal(await reaper.sweep(), 0);
    assert.deepEqual(published, []);

    assert.equal(await reaper.sweep(), 0);
    assert.deepEqual(published, ["ROOM43"]);

    // Dropped only once it landed: a fourth sweep must not re-announce.
    assert.equal(await reaper.sweep(), 0);
    assert.deepEqual(published, ["ROOM43"]);
  } finally {
    await reaper.stop();
  }
});

test("runtime index reaper reports writes it could not confirm before announcing", async () => {
  // `flush` says only that the queue emptied; the sweep is about to announce a
  // state rebuilt from those very writes, so it asks the question that can be
  // answered wrong (#242). It does NOT gate the announcement — silence is worse
  // than a state naming a member every client already caches.
  const published: string[] = [];
  const events: string[] = [];
  const reaped: string[] = [];
  const deadSession = createSession("session-unconfirmed", "offline-node");
  deadSession.roomCode = "ROOM44";
  deadSession.memberId = "member-unconfirmed";

  const runtimeStore: RuntimeIndexReaperStore = {
    async listNodeStatuses() {
      return [
        {
          instanceId: "offline-node",
          version: "test",
          startedAt: 0,
          lastHeartbeatAt: 0,
          staleAt: 0,
          expiresAt: 0,
          connectionCount: 1,
          activeRoomCount: 1,
          activeMemberCount: 1,
          health: "offline" as const,
        },
      ];
    },
    async listClusterSessions() {
      return reaped.length > 0 ? [] : [deadSession];
    },
    removeMember() {
      return { room: null, roomEmpty: false, removed: true };
    },
    async markSessionLeftRoom() {},
    unregisterSession(sessionId: string) {
      reaped.push(sessionId);
    },
    async purgeNodeStatus() {},
    async confirmWrites() {
      throw new AggregateError([new Error("redis down")], "not confirmed");
    },
  };

  const reaper = createRuntimeIndexReaper({
    enabled: true,
    runtimeStore,
    intervalMs: 50,
    now: () => 1_000,
    logEvent: (event) => {
      events.push(event);
    },
    publishRoomStateUpdate: async (roomCode) => {
      published.push(roomCode);
    },
  });

  try {
    assert.equal(await reaper.sweep(), 1);
    assert.ok(events.includes("runtime_index_writes_unconfirmed"));
    assert.deepEqual(published, ["ROOM44"]);
  } finally {
    await reaper.stop();
  }
});

test("runtime index reaper takes one last shot at its announcements on stop", async () => {
  // The record set is memory-only and the sessions are already out of the
  // cluster index, so shutting down without trying loses the announcement for
  // good — nothing will ever rediscover the room (#242).
  const published: string[] = [];
  let publishFailures = 1;
  const reaped: string[] = [];
  const deadSession = createSession("session-shutdown", "offline-node");
  deadSession.roomCode = "ROOM45";
  deadSession.memberId = "member-shutdown";

  const runtimeStore: RuntimeIndexReaperStore = {
    async listNodeStatuses() {
      return [
        {
          instanceId: "offline-node",
          version: "test",
          startedAt: 0,
          lastHeartbeatAt: 0,
          staleAt: 0,
          expiresAt: 0,
          connectionCount: 1,
          activeRoomCount: 1,
          activeMemberCount: 1,
          health: "offline" as const,
        },
      ];
    },
    async listClusterSessions() {
      return reaped.length > 0 ? [] : [deadSession];
    },
    removeMember() {
      return { room: null, roomEmpty: false, removed: true };
    },
    async markSessionLeftRoom() {},
    unregisterSession(sessionId: string) {
      reaped.push(sessionId);
    },
    async purgeNodeStatus() {},
    async flush() {},
  };

  const reaper = createRuntimeIndexReaper({
    enabled: true,
    runtimeStore,
    intervalMs: 50,
    now: () => 1_000,
    publishRoomStateUpdate: async (roomCode) => {
      if (publishFailures > 0) {
        publishFailures -= 1;
        throw new Error("bus rejected");
      }
      published.push(roomCode);
    },
  });

  assert.equal(await reaper.sweep(), 1);
  assert.deepEqual(published, []);

  await reaper.stop();
  assert.deepEqual(published, ["ROOM45"]);
});

test("runtime index reaper does not start a sweep while one is still running", async () => {
  // The sweeps share `roomsAwaitingResync`, so two of them would walk the same
  // records and announce the same room twice — and `stop()` awaits whichever
  // was scheduled LAST, so a newer sweep finishing first let shutdown tear
  // Redis down under an older one (#242).
  let releaseSweep: (() => void) | null = null;
  let sweepsStarted = 0;
  const runtimeStore: RuntimeIndexReaperStore = {
    async listNodeStatuses() {
      sweepsStarted += 1;
      await new Promise<void>((resolve) => {
        releaseSweep = resolve;
      });
      return [];
    },
    async listClusterSessions() {
      return [];
    },
    removeMember() {
      return { room: null, roomEmpty: false, removed: true };
    },
    async markSessionLeftRoom() {},
    unregisterSession() {},
    async purgeNodeStatus() {},
    async flush() {},
  };

  const reaper = createRuntimeIndexReaper({
    enabled: true,
    runtimeStore,
    // Clamped up by `clampTimerIntervalMs`, but still far below the time the
    // first sweep is held for.
    intervalMs: 1,
    now: () => 1_000,
  });

  try {
    reaper.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(sweepsStarted, 1, "ticks must not stack sweeps");
  } finally {
    (releaseSweep as (() => void) | null)?.();
    await reaper.stop();
  }
});
