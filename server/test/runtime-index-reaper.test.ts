import assert from "node:assert/strict";
import test from "node:test";
import { createRedisRuntimeStore } from "../src/redis-runtime-store.js";
import {
  createRuntimeIndexReaper,
  type RuntimeIndexReaperStore,
} from "../src/runtime-index-reaper.js";
import type { AttachedSession, Session } from "../src/types.js";
import { seatSession } from "./runtime-seat-helpers.js";

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
    await seatSession(runtimeStore, session, {
      roomCode: "ROOM01",
      memberId: "member-offline",
      memberToken: "token-offline",
    });
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

    // `seatSession` above carries the write-behind barrier: without it the read
    // below races the queue, and the failure is silent and partial, because the
    // queue drains in order — the session write lands (so `listClusterSessions`
    // is right) while the room-index write is still pending (so
    // `countClusterActiveRooms` reads 0).
    assert.equal(
      (await runtimeStore.listClusterSessions("maintenance_pass")).length,
      1,
    );
    assert.equal(await runtimeStore.countClusterActiveRooms(), 1);

    currentTime += 200;
    const offlineStatuses = await runtimeStore.listNodeStatuses(
      "maintenance_pass",
      currentTime,
    );
    assert.equal(offlineStatuses.length, 1);
    assert.equal(offlineStatuses[0]?.instanceId, "offline-node");
    assert.equal(offlineStatuses[0]?.health, "offline");

    const cleanedSessions = await reaper.sweep();
    assert.equal(cleanedSessions, 1);

    assert.equal(
      (await runtimeStore.listClusterSessions("maintenance_pass")).length,
      0,
    );
    assert.equal(await runtimeStore.countClusterActiveRooms(), 0);
    // The offline node's members are gone, but their identity is not: those
    // clients are alive and reconnecting to a surviving node, and they must
    // come back as the same members (#234). The token is what lets them.
    const reapedRoom = await runtimeStore.getRoom("ROOM01");
    assert.equal(reapedRoom?.members.size ?? 0, 0);
    assert.equal(
      await runtimeStore.findMemberIdByToken("ROOM01", "token-offline"),
      "member-offline",
    );

    assert.deepEqual(
      await runtimeStore.listNodeStatuses("maintenance_pass", currentTime),
      [],
    );
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
      await seatSession(runtimeStore, session, {
        roomCode: "ROOM41",
        memberId: `member-dead-${index}`,
        memberToken: `token-dead-${index}`,
      });
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

    // Same write-behind barrier as the test above, carried by `seatSession`:
    // the sweep reads the cluster index, so the seats must have actually landed
    // in it or it finds nothing to clean and returns 0.
    currentTime += 200;
    assert.equal(await reaper.sweep(), 2);

    // Once per room, not once per seat: both members sat in the same room.
    assert.deepEqual(publishedRooms, ["ROOM41"]);
  } finally {
    await reaper.stop();
    await runtimeStore.close();
  }
});

test("runtime index reaper leaves the session alone when its index write fails", async () => {
  // The announcement is one-shot, so spending it on a room whose index this
  // sweep has not cleaned strands that room for good. #235 answered this by
  // announcing anyway, on the grounds that `unregisterSession` deletes the
  // session hash regardless and gating would leave the next pass nothing to
  // retry. The session record IS the retry trail — so the sweep now stops
  // short of destroying it, and the next sweep redoes the whole cleanup
  // (#242 review).
  const published: string[] = [];
  let flushed = 0;
  const reaped: string[] = [];
  const events: string[] = [];
  let indexWriteFailures = 1;
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
      // The session is still in the cluster index precisely because the sweep
      // did not unregister it.
      return reaped.length > 0 ? [] : [deadSession];
    },
    removeMember() {
      return { room: null, roomEmpty: false, removed: true };
    },
    async markSessionLeftRoom() {
      if (indexWriteFailures > 0) {
        indexWriteFailures -= 1;
        throw new Error("index write failed");
      }
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
    logEvent: (event) => {
      events.push(event);
    },
    publishRoomStateUpdate: async (roomCode) => {
      published.push(roomCode);
    },
  });

  try {
    assert.equal(await reaper.sweep(), 0, "nothing was cleaned");
    assert.deepEqual(reaped, [], "the retry trail must survive");
    assert.deepEqual(published, [], "and the one-shot announcement with it");
    assert.ok(events.includes("runtime_index_cleanup_unconfirmed"));

    // Next sweep: the write lands, and only now is the session destroyed.
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

test("runtime index reaper retries a member removal that never landed", async () => {
  // `removeMember`'s durable write can exhaust its retries. Unregistering the
  // session anyway took the room code and member id with it, so nothing could
  // ever re-issue the removal: the stale binding stayed in Redis with its token
  // retention never armed, and `hasRoomResidue` kept the code reserved for good
  // (#242 review).
  const published: string[] = [];
  const reaped: string[] = [];
  const removals: Array<[string, string]> = [];
  const leftRoom: string[] = [];
  let removalFailures = 1;
  const deadSession = createSession("session-stuckremoval", "offline-node");
  deadSession.roomCode = "ROOM56";
  deadSession.memberId = "member-stuckremoval";

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
    removeMember(code: string, memberId: string) {
      removals.push([code, memberId]);
      if (removalFailures > 0) {
        removalFailures -= 1;
        return {
          room: null,
          roomEmpty: false,
          removed: true,
          durable: Promise.reject(new Error("member removal exhausted")),
        };
      }
      return {
        room: null,
        roomEmpty: false,
        removed: true,
        durable: Promise.resolve(),
      };
    },
    async markSessionLeftRoom(sessionId: string) {
      leftRoom.push(sessionId);
    },
    unregisterSession(sessionId: string) {
      reaped.push(sessionId);
    },
    async purgeNodeStatus() {},
    async confirmWrites() {},
  };

  const reaper = createRuntimeIndexReaper({
    enabled: true,
    runtimeStore,
    intervalMs: 50,
    now: () => 1_000,
    publishRoomStateUpdate: async (roomCode) => {
      published.push(roomCode);
    },
  });

  try {
    assert.equal(await reaper.sweep(), 0);
    assert.deepEqual(
      leftRoom,
      [],
      "blanking the room code destroys what a retry needs",
    );
    assert.deepEqual(reaped, []);
    assert.deepEqual(published, []);

    assert.equal(await reaper.sweep(), 1);
    assert.deepEqual(removals, [
      ["ROOM56", "member-stuckremoval"],
      ["ROOM56", "member-stuckremoval"],
    ]);
    assert.deepEqual(reaped, ["session-stuckremoval"]);
    assert.deepEqual(published, ["ROOM56"]);
  } finally {
    await reaper.stop();
  }
});

test("runtime index reaper does not announce a room it stopped halfway through", async () => {
  // Stop resolves the wait immediately, and the sweep used to carry on to
  // `roomsAwaitingResync` from there — where `stop()`'s own final pass
  // broadcasts it at once. The cleanup writes then land AFTER the broadcast,
  // and with the session unregistered nothing can rediscover the room: every
  // other node keeps a state built from the dirty index for good (#242 review).
  const published: string[] = [];
  const reaped: string[] = [];
  const deadSession = createSession("session-stopmid", "offline-node");
  deadSession.roomCode = "ROOM57";
  deadSession.memberId = "member-stopmid";
  let releaseWrite: (() => void) | null = null;

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
      return [deadSession];
    },
    removeMember() {
      return { room: null, roomEmpty: false, removed: true };
    },
    markSessionLeftRoom() {
      // Outstanding when the stop signal arrives — the write is on its way,
      // just not answered yet.
      return new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
    },
    unregisterSession(sessionId: string) {
      reaped.push(sessionId);
    },
    async purgeNodeStatus() {},
    async confirmWrites() {},
  };

  const reaper = createRuntimeIndexReaper({
    enabled: true,
    runtimeStore,
    intervalMs: 50,
    now: () => 1_000,
    publishRoomStateUpdate: async (roomCode) => {
      published.push(roomCode);
    },
  });

  const swept = reaper.sweep();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(releaseWrite, "the index write really was outstanding");

  // `stop` runs its own final publish pass; the room must not be in it.
  await reaper.stop();
  await swept;
  (releaseWrite as (() => void) | null)?.();

  assert.deepEqual(published, [], "no announcement off an uncleaned index");
  assert.deepEqual(reaped, [], "and the session stays for the next instance");
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

test("runtime index reaper never evicts an announcement it has not published", async () => {
  // A record is the only trail back to its room: the offline sessions are
  // already out of the cluster index. Shedding load by discarding unpublished
  // one-shot notifications reintroduces the exact loss the set exists to
  // prevent (#242 review).
  const published: string[] = [];
  let busDown = true;
  let sweepIndex = 0;
  const roomCount = 600;

  const runtimeStore: RuntimeIndexReaperStore = {
    async listNodeStatuses() {
      return sweepIndex === 0
        ? [
            {
              instanceId: "offline-node",
              version: "test",
              startedAt: 0,
              lastHeartbeatAt: 0,
              staleAt: 0,
              expiresAt: 0,
              connectionCount: roomCount,
              activeRoomCount: roomCount,
              activeMemberCount: roomCount,
              health: "offline" as const,
            },
          ]
        : [];
    },
    async listClusterSessions() {
      if (sweepIndex > 0) {
        return [];
      }
      return Array.from({ length: roomCount }, (_unused, index) => {
        const session = createSession(`session-${index}`, "offline-node");
        session.roomCode = `ROOM${index}`;
        session.memberId = `member-${index}`;
        return session;
      });
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
    intervalMs: 50,
    now: () => 1_000,
    publishRoomStateUpdate: async (roomCode) => {
      if (busDown) {
        throw new Error("bus down");
      }
      published.push(roomCode);
    },
  });

  try {
    assert.equal(await reaper.sweep(), roomCount);
    // `.length`, not `deepEqual(published, [])`: under `assert/strict` that is
    // an assertion signature and narrows `published` to `never[]` for the rest
    // of the test, which `tsx --test` runs happily and `tsc` then rejects.
    assert.equal(published.length, 0, "every publish failed");

    // The bus recovers. Every room — including the ones a cap would have
    // evicted — still gets its announcement, and the sessions are long gone
    // from the cluster index by now.
    sweepIndex = 1;
    busDown = false;
    assert.equal(await reaper.sweep(), 0);
    assert.equal(published.length, roomCount);
    assert.ok(published.includes("ROOM0"), "the oldest record survived");
    assert.ok(published.includes(`ROOM${roomCount - 1}`));
  } finally {
    await reaper.stop();
  }
});

test("runtime index reaper bounds its shutdown announcement pass", async () => {
  // The backlog has no cap, so a serial drain of it is unbounded too — and
  // `stop_runtime_index_reaper` is on a clock. Overrunning it is not a harmless
  // delay: the step is recorded as FAILED, shutdown closes the event bus
  // anyway, and publishes still in flight then return early against a closing
  // bus with their records deleted as if they had succeeded (#242 review).
  const events: string[] = [];
  let currentTime = 1_000;
  let busDown = true;
  let sweepDone = false;
  let shutdownPublishes = 0;
  const roomCount = 200;

  const runtimeStore: RuntimeIndexReaperStore = {
    async listNodeStatuses() {
      return sweepDone
        ? []
        : [
            {
              instanceId: "offline-node",
              version: "test",
              startedAt: 0,
              lastHeartbeatAt: 0,
              staleAt: 0,
              expiresAt: 0,
              connectionCount: roomCount,
              activeRoomCount: roomCount,
              activeMemberCount: roomCount,
              health: "offline" as const,
            },
          ];
    },
    async listClusterSessions() {
      if (sweepDone) {
        return [];
      }
      return Array.from({ length: roomCount }, (_unused, index) => {
        const session = createSession(`session-${index}`, "offline-node");
        session.roomCode = `ROOM${index}`;
        session.memberId = `member-${index}`;
        return session;
      });
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
    intervalMs: 50,
    now: () => currentTime,
    logEvent: (event) => {
      events.push(event);
    },
    publishRoomStateUpdate: async () => {
      // Every publish fails during the sweep, so the whole backlog survives it.
      if (busDown) {
        throw new Error("bus down");
      }
      // The bus is back by shutdown, but each publish "costs" a second of the
      // pass's budget — so a serial drain of 200 rooms could never fit.
      shutdownPublishes += 1;
      currentTime += 1_000;
    },
  });

  assert.equal(await reaper.sweep(), roomCount);
  sweepDone = true;
  busDown = false;

  await reaper.stop();

  assert.ok(
    shutdownPublishes > 0,
    "the shutdown pass must actually try to publish",
  );
  assert.ok(
    shutdownPublishes < roomCount,
    `the shutdown pass must stop at its deadline, made ${shutdownPublishes} publishes`,
  );
  assert.ok(events.includes("runtime_index_resync_abandoned_at_shutdown"));
});

test("runtime index reaper cuts a sweep's serial backlog drain short at stop", async () => {
  // `stop` waits for the sweep in flight BEFORE its own bounded pass runs, and
  // that sweep's drain of an uncapped backlog is serial and uncapped too — so
  // the step budget was still being blown by the wait itself (#242 review).
  const events: string[] = [];
  let currentTime = 1_000;
  let busDown = true;
  let sweepDone = false;
  let sweepDrainPublishes = 0;
  let releaseSweepDrain: (() => void) | null = null;
  const roomCount = 100;

  const runtimeStore: RuntimeIndexReaperStore = {
    async listNodeStatuses() {
      return sweepDone
        ? []
        : [
            {
              instanceId: "offline-node",
              version: "test",
              startedAt: 0,
              lastHeartbeatAt: 0,
              staleAt: 0,
              expiresAt: 0,
              connectionCount: roomCount,
              activeRoomCount: roomCount,
              activeMemberCount: roomCount,
              health: "offline" as const,
            },
          ];
    },
    async listClusterSessions() {
      if (sweepDone) {
        return [];
      }
      return Array.from({ length: roomCount }, (_unused, index) => {
        const session = createSession(`session-${index}`, "offline-node");
        session.roomCode = `ROOM${index}`;
        session.memberId = `member-${index}`;
        return session;
      });
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
    intervalMs: 50,
    now: () => currentTime,
    logEvent: (event) => {
      events.push(event);
    },
    publishRoomStateUpdate: async () => {
      if (busDown) {
        throw new Error("bus down");
      }
      sweepDrainPublishes += 1;
      // The bus recovered mid-sweep, so this sweep's SERIAL drain would happily
      // walk the whole backlog. Hold the first one so `stop` can overlap it.
      if (sweepDrainPublishes === 1) {
        await new Promise<void>((resolve) => {
          releaseSweepDrain = resolve;
        });
      }
      currentTime += 100;
    },
  });

  // Sweep one: the whole backlog fails to publish and is retained.
  assert.equal(await reaper.sweep(), roomCount);
  sweepDone = true;
  busDown = false;

  // Sweep two starts its serial drain of the retained backlog and parks.
  reaper.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(sweepDrainPublishes, 1, "the sweep drain is parked");

  const stopStartedAt = currentTime;
  const stopped = reaper.stop();
  (releaseSweepDrain as (() => void) | null)?.();
  await stopped;

  // The whole of `stop` — the wait for the sweep INCLUDED — has to fit in the
  // budget. Without the yield the sweep's serial drain walks all 100 rooms at
  // 100ms each before the bounded pass ever starts.
  const stopCostMs = currentTime - stopStartedAt;
  assert.ok(
    stopCostMs <= 3_100,
    `stop must stay inside its budget, spent ${stopCostMs}ms`,
  );
  assert.ok(events.includes("runtime_index_resync_abandoned_at_shutdown"));
});

test("runtime index reaper caps a resync publish that never settles", async () => {
  // A deadline that only decides whether to START the next record is no bound
  // at all when the bus hangs rather than rejecting: the call already in flight
  // pins the sweep drain and the shutdown pass alike (#242 review).
  const events: string[] = [];
  let releasePublish: (() => void) | null = null;
  const deadSession = createSession("session-hung", "offline-node");
  deadSession.roomCode = "ROOM46";
  deadSession.memberId = "member-hung";
  let sweepDone = false;

  const runtimeStore: RuntimeIndexReaperStore = {
    async listNodeStatuses() {
      return sweepDone
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
      return sweepDone ? [] : [deadSession];
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
    intervalMs: 50,
    now: () => 1_000,
    logEvent: (event) => {
      events.push(event);
    },
    // Never settles until released. Without a per-publish cap the sweep — and
    // every later shutdown pass — waits on it forever.
    publishRoomStateUpdate: () =>
      new Promise<void>((resolve) => {
        releasePublish = resolve;
      }),
  });

  try {
    assert.equal(await reaper.sweep(), 1);
    assert.ok(events.includes("runtime_index_resync_publish_failed"));
  } finally {
    sweepDone = true;
    // The shutdown pass deliberately waits out its budget for a call still in
    // flight; letting it answer keeps this test off that 3s path.
    (releasePublish as (() => void) | null)?.();
    await reaper.stop();
  }
});

test("runtime index reaper does not start a second publish for a room still waiting", async () => {
  // The per-publish cap races the bus call, it cannot abort it — so without
  // tracking, every sweep starts ANOTHER publish for the same room and one hung
  // bus accumulates Redis commands for as long as it stays hung (#242 review).
  let publishCalls = 0;
  let releasePublish: (() => void) | null = null;
  let sweepsRun = 0;
  const deadSession = createSession("session-stuck", "offline-node");
  deadSession.roomCode = "ROOM47";
  deadSession.memberId = "member-stuck";

  const runtimeStore: RuntimeIndexReaperStore = {
    async listNodeStatuses() {
      return sweepsRun > 0
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
      return sweepsRun > 0 ? [] : [deadSession];
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
    intervalMs: 50,
    now: () => 1_000,
    publishRoomStateUpdate: () => {
      publishCalls += 1;
      return new Promise<void>((resolve) => {
        releasePublish = resolve;
      });
    },
  });

  try {
    // Sweep one starts the publish; its cap fires and the record is retained.
    await reaper.sweep();
    sweepsRun = 1;
    assert.equal(publishCalls, 1);

    // Later sweeps retry the record — but the first call has still not come
    // back, so they must not open another.
    await reaper.sweep();
    await reaper.sweep();
    assert.equal(publishCalls, 1, "one in-flight publish per room, no more");
  } finally {
    (releasePublish as (() => void) | null)?.();
    await reaper.stop();
  }
});

test("runtime index reaper waits out its own writes, and stop is what releases it", async () => {
  // The 2s cap this used to carry was itself the first patch — put there for
  // the shutdown budget — and the latch map, the re-confirmation pass and the
  // re-issued removal all existed to compensate for giving up early. A sweep
  // has no deadline of its own, so it simply waits; `stop()` is the only thing
  // that cuts it short (#242).
  const events: string[] = [];
  const deadSession = createSession("session-slowconfirm", "offline-node");
  deadSession.roomCode = "ROOM48";
  deadSession.memberId = "member-slowconfirm";
  let releaseConfirm: (() => void) | null = null;
  const published: string[] = [];

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
      return published.length > 0 ? [] : [deadSession];
    },
    removeMember() {
      return { room: null, roomEmpty: false, removed: true };
    },
    async markSessionLeftRoom() {},
    unregisterSession() {},
    async purgeNodeStatus() {},
    confirmWrites: () =>
      new Promise<void>((resolve) => {
        releaseConfirm = resolve;
      }),
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
    let sweepDone = false;
    const swept = reaper.sweep().then(() => {
      sweepDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sweepDone, false, "the sweep waits for its own writes");
    assert.deepEqual(published, [], "and announces nothing before they land");

    (releaseConfirm as (() => void) | null)?.();
    await swept;
    assert.deepEqual(published, ["ROOM48"]);
  } finally {
    (releaseConfirm as (() => void) | null)?.();
    await reaper.stop();
  }
});

test("runtime index reaper stops waiting for its writes when it is told to stop", async () => {
  const deadSession = createSession("session-stopwait", "offline-node");
  deadSession.roomCode = "ROOM55";
  deadSession.memberId = "member-stopwait";
  let releaseConfirm: (() => void) | null = null;

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
      return [deadSession];
    },
    removeMember() {
      return { room: null, roomEmpty: false, removed: true };
    },
    async markSessionLeftRoom() {},
    unregisterSession() {},
    async purgeNodeStatus() {},
    confirmWrites: () =>
      new Promise<void>((resolve) => {
        releaseConfirm = resolve;
      }),
  };

  const reaper = createRuntimeIndexReaper({
    enabled: true,
    runtimeStore,
    intervalMs: 50,
    now: () => 1_000,
    publishRoomStateUpdate: async () => {},
  });

  const swept = reaper.sweep();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // No timer releases this — only the stop signal.
  await reaper.stop();
  await swept;
  (releaseConfirm as (() => void) | null)?.();
});

test("runtime index reaper waits for the member removal before it announces", async () => {
  // `confirmWrites` only ever sees the session write queue; `removeMember`
  // returns its own `durable` promise, and dropping it let the sweep announce a
  // state rebuilt from a member map that still held the dead seat (#242 review).
  const order: string[] = [];
  let releaseRemoval: (() => void) | null = null;
  const removalSessions: Array<string | undefined> = [];
  const deadSession = createSession("session-durable", "offline-node");
  deadSession.roomCode = "ROOM49";
  deadSession.memberId = "member-durable";
  let sweepDone = false;

  const runtimeStore: RuntimeIndexReaperStore = {
    async listNodeStatuses() {
      return sweepDone
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
      return sweepDone ? [] : [deadSession];
    },
    removeMember(_code, _memberId, session) {
      removalSessions.push(session?.id);
      return {
        room: null,
        roomEmpty: false,
        removed: true,
        durable: new Promise<void>((resolve) => {
          releaseRemoval = () => {
            order.push("removal-landed");
            resolve();
          };
        }),
      };
    },
    async markSessionLeftRoom() {},
    unregisterSession() {},
    async purgeNodeStatus() {},
    async confirmWrites() {},
  };

  const reaper = createRuntimeIndexReaper({
    enabled: true,
    runtimeStore,
    intervalMs: 50,
    now: () => 1_000,
    publishRoomStateUpdate: async () => {
      order.push("announced");
    },
  });

  try {
    const swept = reaper.sweep();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(order, [], "nothing may be announced yet");

    (releaseRemoval as (() => void) | null)?.();
    await swept;
    sweepDone = true;

    assert.deepEqual(order, ["removal-landed", "announced"]);
    // The session is passed, so `REMOVE_MEMBER_LUA`'s binding guard is armed —
    // otherwise a late script deletes a reconnected session's binding.
    assert.deepEqual(removalSessions, ["session-durable"]);
  } finally {
    (releaseRemoval as (() => void) | null)?.();
    await reaper.stop();
  }
});

test("runtime index reaper does not inherit the store's retry budget on the index write", async () => {
  // The sweep's only direct `await` on a store write ran on the write queue's
  // FULL normal budget — attempts of up to the pending-operation timeout each,
  // per session, serially. One unreachable session was enough to hold `stop()`
  // past its whole step, because `stop` waits for the sweep in flight before
  // its own bounded pass starts (#242 review).
  let releaseWrite: (() => void) | null = null;
  const deadSession = createSession("session-slowwrite", "offline-node");
  deadSession.roomCode = "ROOM54";
  deadSession.memberId = "member-slowwrite";

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
      return releaseWrite ? [] : [deadSession];
    },
    removeMember() {
      return { room: null, roomEmpty: false, removed: true };
    },
    markSessionLeftRoom() {
      // Stands in for a write burning the store's normal retry budget.
      return new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
    },
    unregisterSession() {},
    async purgeNodeStatus() {},
    async confirmWrites() {},
  };

  const reaper = createRuntimeIndexReaper({
    enabled: true,
    runtimeStore,
    intervalMs: 50,
    now: () => 1_000,
    publishRoomStateUpdate: async () => {},
  });

  try {
    const startedAt = Date.now();
    // Completes because the sweep's wait is capped, not because the write
    // answered — it never does.
    await reaper.sweep();
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed < 5_000,
      `the sweep must not inherit the write's budget, took ${elapsed}ms`,
    );
    assert.ok(releaseWrite, "the write really was still outstanding");
  } finally {
    (releaseWrite as (() => void) | null)?.();
    await reaper.stop();
  }
});

test("runtime index reaper leaves the rest of the offline sessions to the next instance", async () => {
  // A per-write bound is not a bound on the loop: each remaining session still
  // spent its own wait, and a handful of them outlasted the whole shutdown step
  // (#242 review). Stopping is the only thing that cuts the sweep short — the
  // sessions it did not reach are still in the cluster index for next time.
  const touched: string[] = [];
  const sessions = Array.from({ length: 6 }, (_unused, index) => {
    const session = createSession(`session-bulk-${index}`, "offline-node");
    session.roomCode = `ROOMB${index}`;
    session.memberId = `member-bulk-${index}`;
    return session;
  });

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
          connectionCount: sessions.length,
          activeRoomCount: sessions.length,
          activeMemberCount: sessions.length,
          health: "offline" as const,
        },
      ];
    },
    async listClusterSessions() {
      return sessions;
    },
    removeMember() {
      return { room: null, roomEmpty: false, removed: true };
    },
    markSessionLeftRoom(sessionId: string) {
      touched.push(sessionId);
      // Never answers: only the per-write bound or the stop signal ends it.
      return new Promise<void>(() => {});
    },
    unregisterSession() {},
    async purgeNodeStatus() {},
    async confirmWrites() {},
  };

  const reaper = createRuntimeIndexReaper({
    enabled: true,
    runtimeStore,
    intervalMs: 50,
    now: () => 1_000,
    publishRoomStateUpdate: async () => {},
  });

  const swept = reaper.sweep();
  // Long enough for the first session's write to be outstanding, far too short
  // for all six to have taken their own bounded wait in turn.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await reaper.stop();
  await swept;

  assert.ok(
    touched.length < sessions.length,
    `the loop must give way at stop, touched ${touched.length}/${sessions.length}`,
  );
});
