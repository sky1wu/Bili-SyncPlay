import assert from "node:assert/strict";
import test from "node:test";
import type { PlaybackState, SharedVideo } from "@bili-syncplay/protocol";
import type { WebSocket } from "ws";
import { createActiveRoomRegistry } from "../src/active-room-registry.js";
import {
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
} from "../src/app.js";
import { createSessionRateLimitState } from "../src/rate-limit.js";
import { createInMemoryRoomStore } from "../src/room-store.js";
import { createRoomService } from "../src/room-service.js";
import type { RuntimeStore } from "../src/runtime-store.js";
import type { LogEvent, Session } from "../src/types.js";

function createSession(id: string): Session {
  const config = getDefaultSecurityConfig();
  return {
    id,
    connectionState: "attached",
    socket: {} as WebSocket,
    remoteAddress: "127.0.0.1",
    origin: "chrome-extension://allowed-extension",
    roomCode: null,
    memberId: null,
    displayName: `User-${id}`,
    memberToken: null,
    joinedAt: null,
    invalidMessageCount: 0,
    rateLimitState: createSessionRateLimitState(config, 0),
  };
}

function createSharedVideo(
  url = "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
): SharedVideo {
  return {
    videoId: "BV1xx411c7mD",
    url,
    title: "Video",
  };
}

function createPlayback(
  actorId: string,
  overrides: Partial<PlaybackState> = {},
): PlaybackState {
  return {
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    currentTime: 12,
    playState: "paused",
    playbackRate: 1,
    updatedAt: 1,
    serverTime: 1,
    actorId,
    seq: 1,
    ...overrides,
  };
}

test("room service keeps empty rooms for TTL and allows rejoin before expiry", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: {
      ...getDefaultPersistenceConfig(),
      emptyRoomTtlMs: 5_000,
    },
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM01",
  });

  const owner = createSession("owner");
  const { room, memberToken } = await service.createRoomForSession(
    owner,
    "Alice",
  );
  assert.equal(owner.memberToken, memberToken);

  await service.leaveRoomForSession(owner);
  const retained = await roomStore.getRoom(room.code);
  assert.ok(retained);
  assert.equal(retained?.expiresAt, 6_000);

  currentTime = 3_000;
  const joiner = createSession("joiner");
  const joined = await service.joinRoomForSession(
    joiner,
    room.code,
    room.joinToken,
    "Bob",
  );
  assert.equal(joined.room.expiresAt, null);
  assert.ok(joiner.memberToken);
});

test("room service restores member state when empty-room expiry scheduling fails", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const activeRooms = createActiveRoomRegistry();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const baseService = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: {
      ...getDefaultPersistenceConfig(),
      emptyRoomTtlMs: 5_000,
    },
    roomStore,
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent(event, data) {
      events.push({ event, data });
    },
    now: () => 1_000,
    createRoomCode: () => "ROOM01",
  });
  const failingRoomStore = {
    ...roomStore,
    async updateRoom(code, expectedVersion, patch) {
      if (patch.expiresAt !== undefined) {
        throw new Error("expiry write failed");
      }
      return roomStore.updateRoom(code, expectedVersion, patch);
    },
  };
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: {
      ...getDefaultPersistenceConfig(),
      emptyRoomTtlMs: 5_000,
    },
    roomStore: failingRoomStore,
    activeRooms,
    generateToken: (() => {
      let id = 2;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent(event, data) {
      events.push({ event, data });
    },
    now: () => 1_000,
  });

  const owner = createSession("owner");
  const created = await baseService.createRoomForSession(owner, "Alice");

  await assert.rejects(
    service.leaveRoomForSession(owner),
    (error: unknown) =>
      error instanceof Error && error.message === "Internal server error.",
  );

  assert.equal(owner.roomCode, created.room.code);
  assert.equal(owner.memberId, "owner");
  assert.equal(owner.memberToken, created.memberToken);
  assert.equal(activeRooms.getRoom(created.room.code)?.members.size, 1);

  const persisted = await roomStore.getRoom(created.room.code);
  assert.equal(persisted?.expiresAt, null);
  assert.ok(
    events.some(
      (entry) =>
        entry.event === "room_leave_recovered" &&
        entry.data.reason === "leave_room_persist_failed",
    ),
  );
  assert.ok(
    events.some(
      (entry) =>
        entry.event === "room_persist_failed" &&
        entry.data.reason === "leave_room_persist_failed",
    ),
  );
});

test("room service clears sync intent when sharing a new video with playback", async () => {
  const currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM01A",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo("https://www.bilibili.com/video/BV199W9zEEcH"),
    createPlayback(owner.memberId ?? owner.id, {
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      currentTime: 95,
      playState: "playing",
      playbackRate: 1.08,
      syncIntent: "explicit-seek",
    }),
  );

  const roomState = await service.getRoomStateForSession(
    owner,
    created.memberToken,
    "sync:request",
  );

  assert.equal(
    roomState.playback?.url,
    "https://www.bilibili.com/video/BV199W9zEEcH",
  );
  assert.equal(roomState.playback?.syncIntent, undefined);
});

test("room service rejects expired rooms and old member tokens after restart semantics", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const tokenFactory = (() => {
    let id = 0;
    return () => `token-${++id}`.padEnd(16, "x");
  })();
  const config = getDefaultSecurityConfig();
  const persistence = {
    ...getDefaultPersistenceConfig(),
    emptyRoomTtlMs: 1_000,
  };

  const firstService = createRoomService({
    config,
    persistence,
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: tokenFactory,
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM02",
  });

  const owner = createSession("owner");
  const created = await firstService.createRoomForSession(owner, "Alice");
  const oldMemberToken = created.memberToken;
  owner.roomCode = created.room.code;
  owner.memberToken = oldMemberToken;
  await firstService.leaveRoomForSession(owner);
  owner.roomCode = created.room.code;
  owner.memberToken = oldMemberToken;

  const restartedService = createRoomService({
    config,
    persistence,
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: tokenFactory,
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
  });

  await assert.rejects(
    restartedService.getRoomStateForSession(
      owner,
      oldMemberToken,
      "sync:request",
    ),
    /Member token is invalid/,
  );

  currentTime = 2_500;
  const expiredJoiner = createSession("expired");
  await assert.rejects(
    restartedService.joinRoomForSession(
      expiredJoiner,
      created.room.code,
      created.room.joinToken,
      "Late",
    ),
    /Room not found/,
  );
});

test("room service reuses member identity when reconnecting with the same member token", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOM03",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const originalMemberId = owner.memberId;

  const reconnectingOwner = createSession("owner-reconnect");
  const joined = await service.joinRoomForSession(
    reconnectingOwner,
    created.room.code,
    created.room.joinToken,
    "Alice",
    created.memberToken,
  );

  assert.equal(joined.memberToken, created.memberToken);
  assert.equal(reconnectingOwner.memberId, originalMemberId);

  await service.leaveRoomForSession(owner);
  const state = await service.getRoomStateForSession(
    reconnectingOwner,
    joined.memberToken,
    "sync:request",
  );
  assert.deepEqual(state.members, [{ id: originalMemberId, name: "Alice" }]);
});

test("room service updates member display name after join", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOM04",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Guest-123");

  await service.updateProfileForSession(owner, created.memberToken, "Alice");

  const state = await service.getRoomStateForSession(
    owner,
    created.memberToken,
    "sync:request",
  );
  assert.deepEqual(state.members, [{ id: owner.memberId, name: "Alice" }]);
});

test("room service flushes pending runtime store writes before exposing updated display names", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const clusterSessionsByRoom = new Map<string, Session[]>();
  const stagedSessionsById = new Map<string, Session>();
  const activeRooms = createActiveRoomRegistry();
  const runtimeStore: RuntimeStore = {
    registerSession(session) {
      stagedSessionsById.set(session.id, { ...session });
    },
    async flush() {
      for (const session of stagedSessionsById.values()) {
        if (!session.roomCode) {
          continue;
        }
        const roomSessions = clusterSessionsByRoom.get(session.roomCode) ?? [];
        const nextSessions = roomSessions.filter(
          (entry) => entry.id !== session.id,
        );
        nextSessions.push({ ...session });
        clusterSessionsByRoom.set(session.roomCode, nextSessions);
      }
      stagedSessionsById.clear();
    },
    unregisterSession() {},
    markSessionJoinedRoom(sessionId, roomCode) {
      const staged = stagedSessionsById.get(sessionId);
      if (staged) {
        staged.roomCode = roomCode;
      }
    },
    markSessionLeftRoom() {},
    recordEvent() {},
    getSession() {
      return null;
    },
    listSessionsByRoom(roomCode) {
      return clusterSessionsByRoom.get(roomCode) ?? [];
    },
    getConnectionCount() {
      return 0;
    },
    getActiveRoomCount() {
      return 0;
    },
    getActiveMemberCount() {
      return 0;
    },
    getStartedAt() {
      return 0;
    },
    getRecentEventCounts() {
      return {};
    },
    getLifetimeEventCounts() {
      return {};
    },
    getActiveRoomCodes() {
      return new Set<string>();
    },
    getRoom(code) {
      return activeRooms.getRoom(code);
    },
    getOrCreateRoom(code) {
      return activeRooms.getOrCreateRoom(code);
    },
    addMember(code, memberId, session, memberToken) {
      return activeRooms.addMember(code, memberId, session, memberToken);
    },
    findMemberIdByToken(code, memberToken) {
      return activeRooms.findMemberIdByToken(code, memberToken);
    },
    blockMemberToken(code, memberToken, expiresAt) {
      activeRooms.blockMemberToken(code, memberToken, expiresAt);
    },
    isMemberTokenBlocked(code, memberToken, currentTime) {
      return activeRooms.isMemberTokenBlocked(code, memberToken, currentTime);
    },
    removeMember(code, memberId, session) {
      return activeRooms.removeMember(code, memberId, session);
    },
    deleteRoom(code) {
      activeRooms.deleteRoom(code);
      clusterSessionsByRoom.delete(code);
    },
    async heartbeatNode() {},
    async listNodeStatuses() {
      return [];
    },
    async purgeNodeStatus() {},
    async countClusterActiveRooms() {
      return 0;
    },
    async listClusterSessionsByRoom(roomCode) {
      return clusterSessionsByRoom.get(roomCode) ?? [];
    },
    async listClusterSessions() {
      return Array.from(clusterSessionsByRoom.values()).flat();
    },
  };
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    runtimeStore,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOM04B",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Guest-123");
  await runtimeStore.flush?.();

  await service.updateProfileForSession(owner, created.memberToken, "Alice");

  const state = await service.getRoomStateForSession(
    owner,
    created.memberToken,
    "sync:request",
  );
  assert.deepEqual(state.members, [{ id: owner.memberId, name: "Alice" }]);
});

test("room service preserves a pause when a different actor's weak-network playing update arrives shortly after", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM05",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const guest = createSession("guest");
  const joined = await service.joinRoomForSession(
    guest,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );

  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo(),
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 40,
    }),
  );

  currentTime = 2_000;
  const paused = await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(owner.memberId ?? owner.id, {
      playState: "paused",
      currentTime: 42,
      seq: 2,
    }),
  );
  assert.equal(paused.ignored, false);

  currentTime = 2_120;
  const lateFollow = await service.updatePlaybackForSession(
    guest,
    joined.memberToken,
    createPlayback(guest.memberId ?? guest.id, {
      playState: "playing",
      currentTime: 42.4,
      seq: 1,
    }),
  );

  assert.equal(lateFollow.ignored, true);
  const finalState = await service.getRoomStateForSession(
    owner,
    created.memberToken,
    "sync:request",
  );
  assert.equal(finalState.playback?.playState, "paused");
  assert.equal(finalState.playback?.actorId, owner.memberId);
  assert.equal(finalState.playback?.currentTime, 42);
});

test("room service ignores weak-network paused or buffering follow-up after another actor resumes playback", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM05B",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const guest = createSession("guest");
  const joined = await service.joinRoomForSession(
    guest,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );

  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo(),
    createPlayback(owner.memberId ?? owner.id, {
      playState: "paused",
      currentTime: 52,
    }),
  );

  currentTime = 2_000;
  const resumed = await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 52.2,
      seq: 2,
    }),
  );
  assert.equal(resumed.ignored, false);
  assert.equal(service.getPlaybackAuthority(created.room.code)?.kind, "play");

  currentTime = 2_090;
  const pausedFollow = await service.updatePlaybackForSession(
    guest,
    joined.memberToken,
    createPlayback(guest.memberId ?? guest.id, {
      playState: "paused",
      currentTime: 52.1,
      seq: 1,
    }),
  );
  assert.equal(pausedFollow.ignored, true);

  currentTime = 2_120;
  const bufferingFollow = await service.updatePlaybackForSession(
    guest,
    joined.memberToken,
    createPlayback(guest.memberId ?? guest.id, {
      playState: "buffering",
      currentTime: 52.2,
      seq: 2,
    }),
  );
  assert.equal(bufferingFollow.ignored, true);

  const finalState = await service.getRoomStateForSession(
    owner,
    created.memberToken,
    "sync:request",
  );
  assert.equal(finalState.playback?.playState, "playing");
  assert.equal(finalState.playback?.actorId, owner.memberId);
});

test("room service keeps the latest arriving control state across actors and orderings", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM06",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const guest = createSession("guest");
  const joined = await service.joinRoomForSession(
    guest,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );

  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo(),
    createPlayback(owner.memberId ?? owner.id, {
      playState: "paused",
      currentTime: 18,
    }),
  );

  currentTime = 2_500;
  const playing = await service.updatePlaybackForSession(
    guest,
    joined.memberToken,
    createPlayback(guest.memberId ?? guest.id, {
      playState: "playing",
      currentTime: 18.2,
      seq: 3,
    }),
  );
  assert.equal(playing.ignored, false);

  currentTime = 2_550;
  const paused = await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(owner.memberId ?? owner.id, {
      playState: "paused",
      currentTime: 18.5,
      seq: 4,
    }),
  );
  assert.equal(paused.ignored, false);

  const finalState = await service.getRoomStateForSession(
    guest,
    joined.memberToken,
    "sync:request",
  );
  assert.equal(finalState.playback?.playState, "paused");
  assert.equal(finalState.playback?.actorId, owner.memberId);
  assert.equal(finalState.playback?.currentTime, 18.5);
});

test("room service ignores an older position after a seek authority takes over", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM07",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const guest = createSession("guest");
  const joined = await service.joinRoomForSession(
    guest,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );

  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo(),
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 40,
    }),
  );

  currentTime = 2_000;
  const seeked = await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 120,
      seq: 3,
    }),
  );
  assert.equal(seeked.ignored, false);
  assert.equal(service.getPlaybackAuthority(created.room.code)?.kind, "seek");

  currentTime = 2_080;
  const lateFollow = await service.updatePlaybackForSession(
    guest,
    joined.memberToken,
    createPlayback(guest.memberId ?? guest.id, {
      playState: "playing",
      currentTime: 40.5,
      seq: 1,
    }),
  );

  assert.equal(lateFollow.ignored, true);
  const finalState = await service.getRoomStateForSession(
    owner,
    created.memberToken,
    "sync:request",
  );
  assert.equal(finalState.playback?.currentTime, 120);
  assert.equal(finalState.playback?.actorId, owner.memberId);
});

test("room service accepts cross-actor explicit ratechange during another actor's authority window", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM07B",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const guest = createSession("guest");
  const joined = await service.joinRoomForSession(
    guest,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );

  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo(),
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 42,
      playbackRate: 1,
    }),
  );

  currentTime = 2_000;
  const ownerUpdate = await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 42.2,
      playbackRate: 1,
      seq: 2,
    }),
  );
  assert.equal(ownerUpdate.ignored, false);
  assert.notEqual(service.getPlaybackAuthority(created.room.code), null);

  currentTime = 2_100;
  const guestRatechange = await service.updatePlaybackForSession(
    guest,
    joined.memberToken,
    createPlayback(guest.memberId ?? guest.id, {
      playState: "playing",
      currentTime: 42.1,
      playbackRate: 1.5,
      syncIntent: "explicit-ratechange",
      seq: 3,
    }),
  );

  assert.equal(guestRatechange.ignored, false);

  const finalState = await service.getRoomStateForSession(
    owner,
    created.memberToken,
    "sync:request",
  );
  assert.equal(finalState.playback?.actorId, guest.memberId);
  assert.equal(finalState.playback?.playbackRate, 1.5);
  assert.equal(finalState.playback?.syncIntent, "explicit-ratechange");
});

test("room service ignores a far-ahead playing update while seek authority is active", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM07C",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const guest = createSession("guest");
  const joined = await service.joinRoomForSession(
    guest,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );

  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo(),
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 200,
    }),
  );

  currentTime = 2_000;
  const seeked = await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 70,
      syncIntent: "explicit-seek",
      seq: 3,
    }),
  );
  assert.equal(seeked.ignored, false);
  assert.equal(service.getPlaybackAuthority(created.room.code)?.kind, "seek");

  currentTime = 2_100;
  const farAheadFollow = await service.updatePlaybackForSession(
    guest,
    joined.memberToken,
    createPlayback(guest.memberId ?? guest.id, {
      playState: "playing",
      currentTime: 205,
      seq: 1,
    }),
  );

  assert.equal(farAheadFollow.ignored, true);
  const finalState = await service.getRoomStateForSession(
    owner,
    created.memberToken,
    "sync:request",
  );
  assert.equal(finalState.playback?.currentTime, 70);
  assert.equal(finalState.playback?.actorId, owner.memberId);
});

test("room service accepts cross-actor explicit seek during another actor's authority window", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM07D",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const guest = createSession("guest");
  const joined = await service.joinRoomForSession(
    guest,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );

  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo(),
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 80,
      seq: 4,
    }),
  );

  currentTime = 1_200;
  const ownerFollow = await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 81.9,
      seq: 5,
    }),
  );
  assert.equal(ownerFollow.ignored, false);
  assert.equal(service.getPlaybackAuthority(created.room.code) !== null, true);

  currentTime = 1_300;
  const guestSeek = await service.updatePlaybackForSession(
    guest,
    joined.memberToken,
    createPlayback(guest.memberId ?? guest.id, {
      playState: "playing",
      currentTime: 47.1,
      syncIntent: "explicit-seek",
      seq: 1,
    }),
  );

  assert.equal(guestSeek.ignored, false);
  assert.equal(service.getPlaybackAuthority(created.room.code)?.kind, "seek");
  const finalState = await service.getRoomStateForSession(
    owner,
    created.memberToken,
    "sync:request",
  );
  assert.equal(finalState.playback?.actorId, guest.memberId);
  assert.equal(finalState.playback?.currentTime, 47.1);
  assert.equal(finalState.playback?.syncIntent, "explicit-seek");
});

test("room service treats explicit seek intent as seek authority even for a small delta", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM07B",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo(),
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 40,
    }),
  );

  currentTime = 2_000;
  const seeked = await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 41.2,
      syncIntent: "explicit-seek",
      seq: 3,
    }),
  );

  assert.equal(seeked.ignored, false);
  assert.equal(service.getPlaybackAuthority(created.room.code)?.kind, "seek");
});

test("room service keeps same-actor follow-up controls effective during an authority window", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM08",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo(),
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 10,
    }),
  );

  currentTime = 2_000;
  const paused = await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(owner.memberId ?? owner.id, {
      playState: "paused",
      currentTime: 12,
      seq: 2,
    }),
  );
  assert.equal(paused.ignored, false);

  currentTime = 2_100;
  const resumed = await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 12.1,
      seq: 3,
    }),
  );

  assert.equal(resumed.ignored, false);
  const finalState = await service.getRoomStateForSession(
    owner,
    created.memberToken,
    "sync:request",
  );
  assert.equal(finalState.playback?.playState, "playing");
  assert.equal(finalState.playback?.actorId, owner.memberId);
});

test("room service accepts a legal cross-actor playback update after authority expires", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM09",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const guest = createSession("guest");
  const joined = await service.joinRoomForSession(
    guest,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );

  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo(),
    createPlayback(owner.memberId ?? owner.id, {
      playState: "paused",
      currentTime: 22,
    }),
  );

  currentTime = 2_000;
  const paused = await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(owner.memberId ?? owner.id, {
      playState: "paused",
      currentTime: 24,
      seq: 2,
    }),
  );
  assert.equal(paused.ignored, false);

  currentTime = 3_500;
  const accepted = await service.updatePlaybackForSession(
    guest,
    joined.memberToken,
    createPlayback(guest.memberId ?? guest.id, {
      playState: "playing",
      currentTime: 24.3,
      seq: 1,
    }),
  );

  assert.equal(accepted.ignored, false);
  const finalState = await service.getRoomStateForSession(
    guest,
    joined.memberToken,
    "sync:request",
  );
  assert.equal(finalState.playback?.playState, "playing");
  assert.equal(finalState.playback?.actorId, guest.memberId);
});

test("room service consults shared kick blocks when rejoining through another node", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOM10",
    resolveBlockedMemberToken: async (_roomCode, memberToken) =>
      memberToken === "kicked-token",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const joiner = createSession("joiner");

  await assert.rejects(
    service.joinRoomForSession(
      joiner,
      created.room.code,
      created.room.joinToken,
      "Bob",
      "kicked-token",
    ),
    /You were removed from the room by an admin/,
  );
});

test("room service reuses shared member identity during reconnect checks", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOM11",
    resolveActiveRoom: async () => ({
      code: "ROOM11",
      members: new Map(),
      memberTokens: new Map([["shared-member", "shared-token"]]),
    }),
    resolveMemberIdByToken: async (_roomCode, memberToken) =>
      memberToken === "shared-token" ? "shared-member" : null,
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const reconnecting = createSession("reconnect");
  const joined = await service.joinRoomForSession(
    reconnecting,
    created.room.code,
    created.room.joinToken,
    "Alice",
    "shared-token",
  );

  assert.equal(reconnecting.memberId, "shared-member");
  assert.equal(joined.memberToken, "shared-token");
});

test("room service enforces room capacity from shared room membership", async () => {
  const config = {
    ...getDefaultSecurityConfig(),
    maxMembersPerRoom: 1,
  };
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const service = createRoomService({
    config,
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOM12",
    resolveActiveRoom: async () => ({
      code: "ROOM12",
      members: new Map([["member-a", createSession("member-a")]]),
      memberTokens: new Map([["member-a", "token-a"]]),
    }),
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const joiner = createSession("joiner");

  await assert.rejects(
    service.joinRoomForSession(
      joiner,
      created.room.code,
      created.room.joinToken,
      "Bob",
    ),
    /Room is full/,
  );
});

test("room service deduplicates repeated video:share within 5 seconds", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(() => currentTime),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM13",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const video = createSharedVideo();

  const first = await service.shareVideoForSession(
    owner,
    created.memberToken,
    video,
  );
  assert.ok(first.room.sharedVideo);
  assert.equal(first.room.version, 1);

  // Advance time slightly (still within 5s dedup window)
  currentTime += 2_000;

  // Second call with same URL — should be deduplicated (no version bump)
  const second = await service.shareVideoForSession(
    owner,
    created.memberToken,
    video,
  );
  assert.equal(second.room.version, 1);
});

test("room service deduplicates repeated playback:update with the same seq", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(() => currentTime),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM14",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo(),
  );

  const playback = createPlayback(owner.id, { seq: 42, playState: "playing" });

  const first = await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    playback,
  );
  assert.equal(first.ignored, false);

  // Advance time past the playback authority window (>1200ms) but within dedup TTL (10s)
  currentTime += 2_000;

  // Retry with same seq — dedup kicks in before acceptance check
  const second = await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    playback,
  );
  assert.equal(second.ignored, true);
});
