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
import { createInMemoryRoomStore, type RoomStore } from "../src/room-store.js";
import { createRoomService } from "../src/room-service.js";
import {
  createInMemoryRuntimeStore,
  type RuntimeStore,
} from "../src/runtime-store.js";
import type { ActiveRoom, LogEvent, Session } from "../src/types.js";

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

test("room service skips lastActiveAt persistence for reconnect joins within refresh window", async () => {
  let currentTime = 1_000;
  const baseRoomStore = createInMemoryRoomStore({ now: () => currentTime });
  let updateCount = 0;
  const roomStore = {
    ...baseRoomStore,
    async updateRoom(...args: Parameters<typeof baseRoomStore.updateRoom>) {
      updateCount += 1;
      return baseRoomStore.updateRoom(...args);
    },
  };
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
    createRoomCode: () => "ROOM02",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  currentTime = 2_000;
  const joiner = createSession("joiner");
  const firstJoin = await service.joinRoomForSession(
    joiner,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );
  const writesAfterFirstJoin = updateCount;

  currentTime = 5_000;
  const reconnect = createSession("reconnect");
  const rejoined = await service.joinRoomForSession(
    reconnect,
    created.room.code,
    created.room.joinToken,
    "Bob",
    firstJoin.memberToken,
  );

  const persisted = await baseRoomStore.getRoom(created.room.code);
  assert.equal(updateCount, writesAfterFirstJoin);
  assert.equal(rejoined.room.version, firstJoin.room.version);
  assert.equal(persisted?.lastActiveAt, firstJoin.room.lastActiveAt);
});

test("room service rejects reconnect skip path when room was deleted concurrently", async () => {
  let currentTime = 1_000;
  const baseRoomStore = createInMemoryRoomStore({ now: () => currentTime });
  let validateDeletedRoom = false;
  let validationReadCount = 0;
  const roomStore = {
    ...baseRoomStore,
    async getRoom(code: string) {
      const room = await baseRoomStore.getRoom(code);
      if (validateDeletedRoom) {
        validationReadCount += 1;
        if (validationReadCount === 2) {
          await baseRoomStore.deleteRoom(code);
          return null;
        }
      }
      return room;
    },
  };
  const activeRooms = createActiveRoomRegistry();
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM02B",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  currentTime = 2_000;
  const joiner = createSession("joiner");
  const firstJoin = await service.joinRoomForSession(
    joiner,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );

  currentTime = 5_000;
  validateDeletedRoom = true;
  const reconnect = createSession("reconnect");
  await assert.rejects(
    service.joinRoomForSession(
      reconnect,
      created.room.code,
      created.room.joinToken,
      "Bob",
      firstJoin.memberToken,
    ),
    /Room not found/,
  );

  assert.equal(reconnect.roomCode, null);
  assert.equal(
    activeRooms.getRoom(created.room.code)?.members.get(joiner.id),
    joiner,
  );
});

test("room service refreshes lastActiveAt for active room joins after refresh window", async () => {
  let currentTime = 1_000;
  const baseRoomStore = createInMemoryRoomStore({ now: () => currentTime });
  const patches: Array<Parameters<typeof baseRoomStore.updateRoom>[2]> = [];
  const roomStore = {
    ...baseRoomStore,
    async updateRoom(...args: Parameters<typeof baseRoomStore.updateRoom>) {
      patches.push(args[2]);
      return baseRoomStore.updateRoom(...args);
    },
  };
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
    createRoomCode: () => "ROOM03",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  currentTime = 31_000;
  const joiner = createSession("joiner");
  const joined = await service.joinRoomForSession(
    joiner,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );

  const persisted = await baseRoomStore.getRoom(created.room.code);
  assert.deepEqual(patches, [{ lastActiveAt: currentTime }]);
  assert.equal(joined.room.version, created.room.version + 1);
  assert.equal(persisted?.lastActiveAt, currentTime);
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
  const failingRoomStore: RoomStore = {
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

test("room service does not recover stale session leave state when member removal is skipped", async () => {
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
    async getRoom() {
      throw new Error("transient read failure");
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

  const staleSession = createSession("owner");
  const created = await baseService.createRoomForSession(staleSession, "Alice");
  const replacementSession = createSession("owner-replaced");
  activeRooms.addMember(
    created.room.code,
    "owner",
    replacementSession,
    created.memberToken,
  );

  await assert.rejects(
    service.leaveRoomForSession(staleSession),
    (error: unknown) =>
      error instanceof Error && error.message === "Internal server error.",
  );

  assert.equal(staleSession.roomCode, null);
  assert.equal(staleSession.memberId, null);
  assert.equal(
    activeRooms.getRoom(created.room.code)?.members.get("owner"),
    replacementSession,
  );
  assert.ok(!events.some((entry) => entry.event === "room_leave_recovered"));
  assert.ok(
    events.some(
      (entry) =>
        entry.event === "room_persist_failed" &&
        entry.data.reason === "leave_room_persist_failed",
    ),
  );
});

test("room service skips leave recovery when room is concurrently deleted", async () => {
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

  const owner = createSession("owner");
  await baseService.createRoomForSession(owner, "Alice");

  // Make updateRoom fail on expiry writes and delete the room from persistence
  // after the failed attempt to simulate concurrent deletion before the
  // catch block's existence check.
  const concurrentDeleteRoomStore: RoomStore = {
    ...roomStore,
    async updateRoom(code, expectedVersion, patch) {
      if (patch.expiresAt !== undefined) {
        // Delete the room so the catch block's getRoom check sees the room is gone.
        await roomStore.deleteRoom(code);
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
    roomStore: concurrentDeleteRoomStore,
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

  await assert.rejects(
    service.leaveRoomForSession(owner),
    (error: unknown) =>
      error instanceof Error && error.message === "Internal server error.",
  );

  // Session should NOT be restored since the room is gone
  assert.equal(owner.roomCode, null);
  assert.equal(owner.memberId, null);
  assert.ok(!events.some((entry) => entry.event === "room_leave_recovered"));
  assert.ok(
    events.some((entry) => entry.event === "room_leave_recovery_skipped"),
  );
  assert.ok(
    events.some(
      (entry) =>
        entry.event === "room_persist_failed" &&
        entry.data.reason === "leave_room_persist_failed",
    ),
  );
});

test("room service skips leave recovery when socket is already closed", async () => {
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
  const failingRoomStore: RoomStore = {
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
  owner.socket = { readyState: 3, OPEN: 1 } as unknown as WebSocket;
  const created = await baseService.createRoomForSession(owner, "Alice");

  await assert.rejects(
    service.leaveRoomForSession(owner),
    (error: unknown) =>
      error instanceof Error && error.message === "Internal server error.",
  );

  assert.equal(owner.roomCode, null);
  assert.equal(owner.memberId, null);
  assert.equal(owner.memberToken, null);
  // With the last member removed, the in-memory room entry should stay
  // deleted — restoreLeaveState must not resurrect it and leave a zombie
  // member that `unregisterSession` cannot clean up.
  assert.equal(activeRooms.getRoom(created.room.code), null);
  assert.ok(!events.some((entry) => entry.event === "room_leave_recovered"));
  assert.ok(
    events.some(
      (entry) =>
        entry.event === "room_leave_recovery_skipped" &&
        entry.data.reason === "socket_detached",
    ),
  );
  // Empty-leave + failed expiry write could leave an orphan in persistence.
  // We intentionally do not force-delete here (a concurrent join could have
  // re-populated the room), but emit a signal for ops/reaper to reconcile.
  assert.ok(
    events.some((entry) => entry.event === "room_leave_orphan_possible"),
  );
  assert.ok(
    events.some(
      (entry) =>
        entry.event === "room_persist_failed" &&
        entry.data.reason === "leave_room_persist_failed",
    ),
  );
});

test("room service still notifies remaining members when socket-detached leave hits persistence error", async () => {
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

  const owner = createSession("owner");
  const created = await baseService.createRoomForSession(owner, "Alice");
  const joiner = createSession("joiner");
  await baseService.joinRoomForSession(
    joiner,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );

  // Simulate a transient persistence read failure on the leaving session's
  // path. Because the room still has another live member, we want the leave
  // to succeed from the caller's perspective so the caller broadcasts
  // `room_member_changed` and remaining clients see a fresh roster.
  const failingRoomStore = {
    ...roomStore,
    async getRoom() {
      throw new Error("transient read failure");
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
      let id = 10;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent(event, data) {
      events.push({ event, data });
    },
    now: () => 1_000,
  });

  // The owner socket has already closed before cleanup runs.
  owner.socket = { readyState: 3, OPEN: 1 } as unknown as WebSocket;

  const result = await service.leaveRoomForSession(owner);

  assert.equal(result.room, null);
  assert.equal(result.notifyRoom, true);
  // The read failed before the election could run, so whether this member held
  // the share is unknowable here. Ask for the full state rather than leave the
  // rest of the room pointing at somebody who is gone (#235).
  assert.equal(result.needsRoomStateResync, true);
  // Runtime reflects the leave; joiner is still in the room.
  assert.equal(activeRooms.getRoom(created.room.code)?.members.size, 1);
  assert.ok(activeRooms.getRoom(created.room.code)?.members.has("joiner"));
  assert.equal(owner.roomCode, null);
  assert.ok(
    events.some(
      (entry) =>
        entry.event === "room_leave_recovery_skipped" &&
        entry.data.reason === "socket_detached",
    ),
  );
  assert.ok(
    !events.some((entry) => entry.event === "room_leave_orphan_possible"),
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

function createIdentityService(roomStore: RoomStore, roomCode: string) {
  return createRoomService({
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
    createRoomCode: () => roomCode,
  });
}

const IDENTITY_TEST_VIDEO: SharedVideo = {
  videoId: "BV1Cx3q6gELa",
  url: "https://www.bilibili.com/video/BV1Cx3q6gELa",
  title: "Shared Video",
};

test("a disconnect keeps the identity that owns the shared video", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const service = createIdentityService(roomStore, "ROOMID");

  const sharer = createSession("sharer");
  const created = await service.createRoomForSession(sharer, "Alice");
  const sharerMemberId = sharer.memberId;
  await service.shareVideoForSession(
    sharer,
    created.memberToken,
    IDENTITY_TEST_VIDEO,
  );

  // A server restart closes every socket at once. That is a disconnect, not a
  // departure: the client still holds the memberToken it persisted.
  await service.leaveRoomForSession(sharer, "disconnect");

  const reconnected = createSession("sharer-reconnect");
  await service.joinRoomForSession(
    reconnected,
    created.room.code,
    created.room.joinToken,
    "Alice",
    created.memberToken,
  );

  assert.equal(reconnected.memberId, sharerMemberId);
  // The whole point: `sharedVideo.sharedByMemberId` is written once at share
  // time and never rewritten, so if the reconnect had been issued a new
  // memberId nobody in the room would match it and the room could no longer
  // advance to the next video (#234).
  const persisted = await roomStore.getRoom(created.room.code);
  assert.equal(persisted?.sharedVideo?.sharedByMemberId, reconnected.memberId);
});

test("an explicit leave revokes the identity", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const service = createIdentityService(roomStore, "ROOMLV");

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const originalMemberId = owner.memberId;

  // The member said they were done, unlike the disconnect above.
  await service.leaveRoomForSession(owner, "client-request");

  const returning = createSession("owner-returns");
  await service.joinRoomForSession(
    returning,
    created.room.code,
    created.room.joinToken,
    "Alice",
    created.memberToken,
  );

  assert.notEqual(returning.memberId, originalMemberId);
});

test("a disconnected member does not get a free seat past the room limit", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const activeRooms = createActiveRoomRegistry();
  const service = createRoomService({
    config: { ...getDefaultSecurityConfig(), maxMembersPerRoom: 2 },
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMCP",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  const guest = createSession("guest");
  await service.joinRoomForSession(
    guest,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );

  // The owner drops. Their token survives (#234) — but a token is not a seat,
  // and the seat they vacated is immediately taken by somebody else.
  await service.leaveRoomForSession(owner, "disconnect");
  const late = createSession("late");
  await service.joinRoomForSession(
    late,
    created.room.code,
    created.room.joinToken,
    "Carol",
  );

  // Room is full again. The owner coming back with a still-valid token must
  // queue behind the limit like anyone else, not be waved through as a
  // "reconnect" — otherwise every disconnected member is an extra seat.
  const returning = createSession("owner-returns");
  await assert.rejects(
    service.joinRoomForSession(
      returning,
      created.room.code,
      created.room.joinToken,
      "Alice",
      created.memberToken,
    ),
    /room is full/i,
  );
});

test("a reconnect that still holds its seat is admitted to a full room", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const service = createRoomService({
    config: { ...getDefaultSecurityConfig(), maxMembersPerRoom: 2 },
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMSE",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const guest = createSession("guest");
  await service.joinRoomForSession(
    guest,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );

  // Control for the test above: a session replacement (the old socket has not
  // been cleaned up yet) still occupies its seat, so the capacity check must
  // keep exempting it or every flapping connection would be locked out.
  const replacement = createSession("owner-replacement");
  const rejoined = await service.joinRoomForSession(
    replacement,
    created.room.code,
    created.room.joinToken,
    "Alice",
    created.memberToken,
  );

  assert.equal(replacement.memberId, owner.memberId);
  assert.equal(rejoined.room.code, created.room.code);
});

test("expiring a room collects the runtime state that outlives it", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createActiveRoomRegistry();
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOMEX",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  // Captured before leaving: the leave clears it off the session.
  const ownerMemberId = owner.memberId;
  await service.leaveRoomForSession(owner, "disconnect");

  // Survives the disconnect, as it must.
  assert.equal(
    activeRooms.findMemberIdByToken(created.room.code, created.memberToken),
    ownerMemberId,
  );

  currentTime += getDefaultPersistenceConfig().emptyRoomTtlMs + 1;
  assert.equal(await service.deleteExpiredRooms(), 1);

  // The reaper is the only path that ever deletes a room nobody touches again.
  // If it leaves the runtime state behind, tokens pile up for every abandoned
  // room and a recycled room code inherits the previous room's identities.
  assert.equal(activeRooms.getRoom(created.room.code), null);
  assert.equal(
    activeRooms.findMemberIdByToken(created.room.code, created.memberToken),
    null,
  );
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

test("room service skips owner persistence when profile display name is unchanged", async () => {
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
  const created = await service.createRoomForSession(owner, "Alice");

  await service.updateProfileForSession(owner, created.memberToken, "Alice");

  const persisted = await roomStore.getRoom(created.room.code);
  assert.equal(persisted?.version, created.room.version);
  assert.equal(persisted?.lastActiveAt, created.room.lastActiveAt);
  assert.equal(persisted?.ownerDisplayName, "Alice");
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
    async markSessionJoinedRoom(sessionId, roomCode) {
      const staged = stagedSessionsById.get(sessionId);
      if (staged) {
        staged.roomCode = roomCode;
      }
    },
    async markSessionLeftRoom() {},
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
    tryClaimMessageSlot() {
      return Promise.resolve(true);
    },
    releaseMessageSlot() {
      return Promise.resolve();
    },
    acquireRoomLock() {
      return Promise.resolve(true);
    },
    releaseRoomLock() {
      return Promise.resolve(true);
    },
    removeMember(code, memberId, session) {
      return activeRooms.removeMember(code, memberId, session);
    },
    revokeMemberToken(code, memberId) {
      activeRooms.revokeMemberToken(code, memberId);
    },
    evictMemberToken(code, memberId, memberToken, blockedUntil) {
      activeRooms.evictMemberToken(code, memberId, memberToken, blockedUntil);
    },
    hasRoomResidue(code) {
      return activeRooms.hasRoomResidue(code);
    },
    getRoomGeneration(code) {
      return activeRooms.getRoomGeneration(code);
    },
    markRoomGeneration(code, generation) {
      return activeRooms.markRoomGeneration(code, generation);
    },
    deleteRoom(code) {
      clusterSessionsByRoom.delete(code);
      return activeRooms.deleteRoom(code);
    },
    async heartbeatNode() {},
    async listNodeStatuses() {
      return [];
    },
    async purgeNodeStatus() {},
    async countClusterActiveRooms() {
      return 0;
    },
    async listClusterActiveRoomCodes() {
      return Array.from(clusterSessionsByRoom.keys()).sort();
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

test("room service does not let a steady paused tick claim the authority window", async () => {
  // Reproduces the autoplay-next stall seen in production: the sharer switches
  // to the next video, which starts out paused at the remembered position, and
  // a peer that hard-seeks to that position leaks the pause it just applied
  // back into the room as repeated frames. Those frames change nothing, so
  // they must not hand the peer a veto over the sharer's own start-up.
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
    createRoomCode: () => "ROOM31",
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
      currentTime: 49,
    }),
  );

  // Past the share's own authority window, so nothing but the guest's frames
  // can decide the outcome below.
  currentTime = 2_500;
  const echo = await service.updatePlaybackForSession(
    guest,
    joined.memberToken,
    createPlayback(guest.memberId ?? guest.id, {
      playState: "paused",
      currentTime: 49,
      seq: 1,
    }),
  );
  assert.equal(echo.ignored, false);

  currentTime = 2_600;
  const repeatedEcho = await service.updatePlaybackForSession(
    guest,
    joined.memberToken,
    createPlayback(guest.memberId ?? guest.id, {
      playState: "paused",
      currentTime: 49,
      seq: 2,
    }),
  );
  assert.equal(repeatedEcho.ignored, false);
  assert.equal(service.getPlaybackAuthority(created.room.code), null);

  currentTime = 2_700;
  const sharerStartsPlaying = await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 49,
      seq: 2,
    }),
  );

  assert.equal(sharerStartsPlaying.ignored, false);
  const finalState = await service.getRoomStateForSession(
    owner,
    created.memberToken,
    "sync:request",
  );
  assert.equal(finalState.playback?.playState, "playing");
  assert.equal(finalState.playback?.actorId, owner.memberId);
});

test("room service still lets a real pause claim the authority window", async () => {
  // Counterpart to the steady-tick test above: a frame that actually changes
  // playState is a genuine intent and must keep vetoing a competing play, or
  // the steady-tick gate would have simply disabled pause dominance.
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
    createRoomCode: () => "ROOM32",
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

  currentTime = 2_500;
  const realPause = await service.updatePlaybackForSession(
    guest,
    joined.memberToken,
    createPlayback(guest.memberId ?? guest.id, {
      playState: "paused",
      currentTime: 40,
      seq: 1,
    }),
  );
  assert.equal(realPause.ignored, false);
  assert.equal(
    service.getPlaybackAuthority(created.room.code)?.actorId,
    guest.memberId,
  );
  assert.equal(service.getPlaybackAuthority(created.room.code)?.kind, "pause");

  currentTime = 2_600;
  const competingPlay = await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(owner.memberId ?? owner.id, {
      playState: "playing",
      currentTime: 40,
      seq: 2,
    }),
  );

  assert.equal(competingPlay.ignored, true);
  const finalState = await service.getRoomStateForSession(
    owner,
    created.memberToken,
    "sync:request",
  );
  assert.equal(finalState.playback?.playState, "paused");
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
  let resolveMemberIdCalls = 0;
  // The shared-view fixture below stands in for another node's runtime state.
  // It must not exist before the room does: a code is only handed out while no
  // runtime state remains under it, so a fixture that answers unconditionally
  // would block the room from ever being created.
  let sharedRoomExists = false;
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
    resolveActiveRoom: async () =>
      sharedRoomExists
        ? {
            code: "ROOM11",
            members: new Map(),
            memberTokens: new Map([["shared-member", "shared-token"]]),
          }
        : null,
    resolveMemberIdByToken: async (_roomCode, memberToken) => {
      resolveMemberIdCalls += 1;
      return memberToken === "shared-token" ? "shared-member" : null;
    },
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  sharedRoomExists = true;
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
  assert.equal(resolveMemberIdCalls, 1);
});

test("room service enforces room capacity from shared room membership", async () => {
  const config = {
    ...getDefaultSecurityConfig(),
    maxMembersPerRoom: 1,
  };
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  // Same reason as the test above: the shared-view fixture only exists once the
  // room does, or the allocation-time residue check would refuse the code.
  let sharedRoomExists = false;
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
    resolveActiveRoom: async () =>
      sharedRoomExists
        ? {
            code: "ROOM12",
            members: new Map([["member-a", createSession("member-a")]]),
            memberTokens: new Map([["member-a", "token-a"]]),
          }
        : null,
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  sharedRoomExists = true;
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

test("concurrent joins both succeed when room has capacity for all", async () => {
  // Two sessions race to join the same room. The per-room join admission lock
  // and forced lastActiveAt persistence on non-reconnect joins serialize
  // capacity checks with runtime membership updates, so both land and the
  // runtime has exactly owner + 2 members.
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const activeRooms = createActiveRoomRegistry();
  const service = createRoomService({
    config: { ...getDefaultSecurityConfig(), maxMembersPerRoom: 8 },
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOM15",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  const joinerA = createSession("joiner-a");
  const joinerB = createSession("joiner-b");

  const [resultA, resultB] = await Promise.all([
    service.joinRoomForSession(
      joinerA,
      created.room.code,
      created.room.joinToken,
      "Bob",
    ),
    service.joinRoomForSession(
      joinerB,
      created.room.code,
      created.room.joinToken,
      "Carol",
    ),
  ]);

  assert.ok(resultA.room);
  assert.ok(resultB.room);

  const runtimeRoom = activeRooms.getRoom(created.room.code);
  assert.equal(runtimeRoom?.members.size, 3);

  // Non-reconnect joins always persist lastActiveAt so the version-conflict
  // retry path serializes capacity checks across nodes.
  const persistedRoom = await roomStore.getRoom(created.room.code);
  assert.equal(
    persistedRoom?.version,
    2,
    "persisted room version should bump once per non-reconnect join",
  );
});

test("concurrent joins with multiple open slots do not exceed room capacity", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const activeRooms = createActiveRoomRegistry();
  const service = createRoomService({
    config: { ...getDefaultSecurityConfig(), maxMembersPerRoom: 3 },
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOM16",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const joiners = [
    createSession("joiner-a"),
    createSession("joiner-b"),
    createSession("joiner-c"),
  ];

  const results = await Promise.allSettled(
    joiners.map((joiner, index) =>
      service.joinRoomForSession(
        joiner,
        created.room.code,
        created.room.joinToken,
        `User ${index}`,
      ),
    ),
  );

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 2, "two open slots should be filled");
  assert.equal(rejected.length, 1, "overflow joiner should be rejected");
  assert.match(
    (rejected[0] as PromiseRejectedResult).reason.message,
    /Room is full/,
  );

  const runtimeRoom = activeRooms.getRoom(created.room.code);
  assert.equal(
    runtimeRoom?.members.size,
    3,
    "runtime member count must stay at maxMembersPerRoom",
  );
});

test("concurrent joins at capacity allow exactly one new member", async () => {
  // With maxMembersPerRoom=2 (owner already occupies 1 slot), two sessions
  // race for the single remaining slot. The per-room join admission lock
  // causes the second joiner to re-check capacity after the first has been
  // added, at which point the room is full and the second gets room_full.
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const activeRooms = createActiveRoomRegistry();
  const service = createRoomService({
    config: { ...getDefaultSecurityConfig(), maxMembersPerRoom: 2 },
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOM17",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  const joinerA = createSession("joiner-a");
  const joinerB = createSession("joiner-b");

  const results = await Promise.allSettled([
    service.joinRoomForSession(
      joinerA,
      created.room.code,
      created.room.joinToken,
      "Bob",
    ),
    service.joinRoomForSession(
      joinerB,
      created.room.code,
      created.room.joinToken,
      "Carol",
    ),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "exactly one joiner should succeed");
  assert.equal(rejected.length, 1, "exactly one joiner should be rejected");
  assert.match(
    (rejected[0] as PromiseRejectedResult).reason.message,
    /Room is full/,
  );

  const runtimeRoom = activeRooms.getRoom(created.room.code);
  assert.equal(
    runtimeRoom?.members.size,
    2,
    "runtime member count must not exceed maxMembersPerRoom",
  );
});

test("concurrent joins respect capacity even when shared runtime store flushes asynchronously", async () => {
  // Reproduces the production wiring where `runtimeStore.addMember` writes to
  // the shared runtime store via a fire-and-forget async path, and
  // `resolveActiveRoom` reads from that shared store. The per-room join lock
  // must hold until the shared write is visible, otherwise concurrent joiners
  // would all read a stale member count and overshoot `maxMembersPerRoom`.
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const local = createInMemoryRuntimeStore(() => 1_000);
  const shared = createInMemoryRuntimeStore(() => 1_000);
  const pendingSharedWrites: Promise<void>[] = [];
  const runtimeStore: RuntimeStore = {
    ...local,
    addMember: (code, memberId, session, memberToken) => {
      const room = local.addMember(code, memberId, session, memberToken);
      pendingSharedWrites.push(
        new Promise((resolve) => {
          setImmediate(() => {
            shared.addMember(code, memberId, session, memberToken);
            resolve();
          });
        }),
      );
      return room;
    },
    flush: async () => {
      await Promise.allSettled(pendingSharedWrites.splice(0));
    },
  };

  const service = createRoomService({
    config: { ...getDefaultSecurityConfig(), maxMembersPerRoom: 3 },
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    runtimeStore,
    resolveActiveRoom: async (roomCode) => shared.getRoom(roomCode),
    resolveMemberIdByToken: async (roomCode, memberToken) =>
      shared.findMemberIdByToken(roomCode, memberToken),
    resolveBlockedMemberToken: async (roomCode, memberToken, currentTime) =>
      shared.isMemberTokenBlocked(roomCode, memberToken, currentTime),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOM18",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  await runtimeStore.flush?.();

  const joiners = [
    createSession("joiner-a"),
    createSession("joiner-b"),
    createSession("joiner-c"),
  ];

  const results = await Promise.allSettled(
    joiners.map((joiner, index) =>
      service.joinRoomForSession(
        joiner,
        created.room.code,
        created.room.joinToken,
        `User ${index}`,
      ),
    ),
  );
  await runtimeStore.flush?.();

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 2, "two open slots should be filled");
  assert.equal(rejected.length, 1, "overflow joiner should be rejected");
  assert.match(
    (rejected[0] as PromiseRejectedResult).reason.message,
    /Room is full/,
  );

  const localRoom = local.getRoom(created.room.code);
  assert.equal(
    localRoom?.members.size,
    3,
    "local member count must stay at maxMembersPerRoom",
  );
  const sharedRoom = shared.getRoom(created.room.code);
  assert.equal(
    sharedRoom?.members.size,
    3,
    "shared member count must stay at maxMembersPerRoom",
  );
});

test("cross-node concurrent joins respect capacity via shared admission lock", async () => {
  // Two `roomService` instances share the persistence and shared runtime store
  // — each has its own in-process join lock (mirroring two nodes). The shared
  // `tryClaimMessageSlot`/`releaseMessageSlot` mutex must serialize admission
  // across both nodes; otherwise concurrent joiners would all read the same
  // shared member count and overshoot `maxMembersPerRoom`.
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const shared = createInMemoryRuntimeStore(() => 1_000);

  function buildNode(nodeId: string) {
    const local = createInMemoryRuntimeStore(() => 1_000);
    const pendingSharedWrites: Promise<void>[] = [];
    const runtimeStore: RuntimeStore = {
      ...local,
      addMember: (code, memberId, session, memberToken) => {
        const room = local.addMember(code, memberId, session, memberToken);
        pendingSharedWrites.push(
          new Promise((resolve) => {
            setImmediate(() => {
              shared.addMember(code, memberId, session, memberToken);
              resolve();
            });
          }),
        );
        return room;
      },
      flush: async () => {
        await Promise.allSettled(pendingSharedWrites.splice(0));
      },
      tryClaimMessageSlot: (roomCode, key, expiresAt) =>
        shared.tryClaimMessageSlot(roomCode, key, expiresAt),
      releaseMessageSlot: (roomCode, key) =>
        shared.releaseMessageSlot(roomCode, key),
      acquireRoomLock: (roomCode, key, token, expiresAt) =>
        shared.acquireRoomLock(roomCode, key, token, expiresAt),
      releaseRoomLock: (roomCode, key, token) =>
        shared.releaseRoomLock(roomCode, key, token),
    };
    const service = createRoomService({
      config: { ...getDefaultSecurityConfig(), maxMembersPerRoom: 3 },
      persistence: getDefaultPersistenceConfig(),
      roomStore,
      runtimeStore,
      resolveActiveRoom: async (roomCode) => shared.getRoom(roomCode),
      resolveMemberIdByToken: async (roomCode, memberToken) =>
        shared.findMemberIdByToken(roomCode, memberToken),
      resolveBlockedMemberToken: async (roomCode, memberToken, currentTime) =>
        shared.isMemberTokenBlocked(roomCode, memberToken, currentTime),
      generateToken: (() => {
        let id = 0;
        return () => `${nodeId}-token-${++id}`.padEnd(16, "x");
      })(),
      logEvent: (() => undefined) satisfies LogEvent,
      now: () => 1_000,
      createRoomCode: () => "ROOM19",
    });
    return { service, runtimeStore };
  }

  const nodeA = buildNode("a");
  const nodeB = buildNode("b");

  const owner = createSession("owner");
  const created = await nodeA.service.createRoomForSession(owner, "Alice");
  await nodeA.runtimeStore.flush?.();

  const joinPlans = [
    { node: nodeA, session: createSession("joiner-a1") },
    { node: nodeB, session: createSession("joiner-b1") },
    { node: nodeA, session: createSession("joiner-a2") },
    { node: nodeB, session: createSession("joiner-b2") },
  ];

  const results = await Promise.allSettled(
    joinPlans.map(({ node, session }, index) =>
      node.service.joinRoomForSession(
        session,
        created.room.code,
        created.room.joinToken,
        `User ${index}`,
      ),
    ),
  );
  await Promise.all([
    nodeA.runtimeStore.flush?.(),
    nodeB.runtimeStore.flush?.(),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(
    fulfilled.length,
    2,
    "exactly two joiners should fill the remaining slots",
  );
  assert.equal(
    rejected.length,
    2,
    "exactly two joiners should be rejected as room_full",
  );
  for (const result of rejected) {
    assert.match(
      (result as PromiseRejectedResult).reason.message,
      /Room is full/,
    );
  }

  const sharedRoom = shared.getRoom(created.room.code);
  assert.equal(
    sharedRoom?.members.size,
    3,
    "shared member count must stay at maxMembersPerRoom across both nodes",
  );
});

test("join admission rejects with internal error when shared mutex is unavailable", async () => {
  // The distributed `tryClaimMessageSlot` slot is permanently held by another
  // caller. The join flow must NOT silently fall back to single-node-only
  // serialization — it should refuse the join after the bounded wait so cross
  // node mutex is preserved instead of degrading correctness for availability.
  let advancingNow = 1_000;
  const advanceTime = () => {
    advancingNow += 200;
    return advancingNow;
  };
  const baseStore = createInMemoryRuntimeStore(() => advancingNow);
  let acquireCalls = 0;
  let releaseCalls = 0;
  const runtimeStore: RuntimeStore = {
    ...baseStore,
    acquireRoomLock: async () => {
      acquireCalls += 1;
      return false;
    },
    releaseRoomLock: async () => {
      releaseCalls += 1;
      return true;
    },
  };
  const roomStore = createInMemoryRoomStore({ now: () => advancingNow });
  const service = createRoomService({
    config: { ...getDefaultSecurityConfig(), maxMembersPerRoom: 3 },
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    runtimeStore,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: advanceTime,
    createRoomCode: () => "ROOM20",
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
    /unable|internal/i,
  );

  assert.ok(
    acquireCalls >= 2,
    "lock acquisition should poll multiple times before timing out",
  );
  assert.equal(
    releaseCalls,
    0,
    "release must not be called when lock was never acquired",
  );
});

test("join admission releases local queue when shared mutex acquisition throws", async () => {
  const currentTime = 1_000;
  const baseStore = createInMemoryRuntimeStore(() => currentTime);
  let acquireCalls = 0;
  const runtimeStore: RuntimeStore = {
    ...baseStore,
    acquireRoomLock: async (...args) => {
      acquireCalls += 1;
      if (acquireCalls === 1) {
        throw new Error("redis unavailable");
      }
      return baseStore.acquireRoomLock(...args);
    },
  };
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const service = createRoomService({
    config: { ...getDefaultSecurityConfig(), maxMembersPerRoom: 3 },
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    runtimeStore,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM20B",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  await assert.rejects(
    service.joinRoomForSession(
      createSession("failing-joiner"),
      created.room.code,
      created.room.joinToken,
      "Bob",
    ),
    /redis unavailable/,
  );

  const joined = await service.joinRoomForSession(
    createSession("successful-joiner"),
    created.room.code,
    created.room.joinToken,
    "Carol",
  );

  assert.equal(joined.room.code, created.room.code);
});

test("join admission rejects when action exceeds the lock TTL", async () => {
  // Simulate a join whose persistence write stalls past the distributed lock
  // TTL. By the time the action returns, the lock is logically expired and
  // could already belong to another node, so the join must be rejected instead
  // of reporting success outside the serialization window.
  let advancingNow = 1_000;
  const baseStore = createInMemoryRuntimeStore(() => advancingNow);
  let acquireCalls = 0;
  let releaseCalls = 0;
  const runtimeStore: RuntimeStore = {
    ...baseStore,
    acquireRoomLock: async (...args) => {
      acquireCalls += 1;
      return baseStore.acquireRoomLock(...args);
    },
    releaseRoomLock: async (...args) => {
      releaseCalls += 1;
      return baseStore.releaseRoomLock(...args);
    },
  };
  const baseRoomStore = createInMemoryRoomStore({ now: () => advancingNow });
  const roomStore = {
    ...baseRoomStore,
    async updateRoom(...args: Parameters<typeof baseRoomStore.updateRoom>) {
      advancingNow += 60_000;
      return baseRoomStore.updateRoom(...args);
    },
  };
  const service = createRoomService({
    config: { ...getDefaultSecurityConfig(), maxMembersPerRoom: 3 },
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    runtimeStore,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => advancingNow,
    createRoomCode: () => "ROOM21",
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
    /internal/i,
  );

  assert.equal(acquireCalls, 1, "lock should be acquired exactly once");
  assert.equal(
    releaseCalls,
    0,
    "release must be skipped when the held lock has already expired",
  );
  assert.equal(joiner.roomCode, null);
  assert.equal(
    baseStore.getRoom(created.room.code)?.members.has(joiner.id),
    false,
  );
});

test("join admission restores previous reconnect session when rollback follows replacement", async () => {
  let advancingNow = 1_000;
  const baseStore = createInMemoryRuntimeStore(() => advancingNow);
  let expireAfterNextFlush = false;
  const runtimeStore: RuntimeStore = {
    ...baseStore,
    flush: async () => {
      await baseStore.flush?.();
      if (expireAfterNextFlush) {
        expireAfterNextFlush = false;
        advancingNow += 60_000;
      }
    },
  };
  const roomStore = createInMemoryRoomStore({ now: () => advancingNow });
  const service = createRoomService({
    config: { ...getDefaultSecurityConfig(), maxMembersPerRoom: 3 },
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    runtimeStore,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => advancingNow,
    createRoomCode: () => "ROOM21C",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const originalJoiner = createSession("joiner");
  const joined = await service.joinRoomForSession(
    originalJoiner,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );
  const originalMemberId = originalJoiner.memberId;

  assert.ok(originalMemberId);
  expireAfterNextFlush = true;

  const reconnectingJoiner = createSession("joiner-reconnect");
  await assert.rejects(
    service.joinRoomForSession(
      reconnectingJoiner,
      created.room.code,
      created.room.joinToken,
      "Bob",
      joined.memberToken,
    ),
    /internal/i,
  );

  const activeRoom = baseStore.getRoom(created.room.code);
  assert.equal(activeRoom?.members.get(originalMemberId), originalJoiner);
  assert.equal(
    activeRoom?.memberTokens.get(originalMemberId),
    joined.memberToken,
  );
  assert.equal(reconnectingJoiner.roomCode, null);
  assert.equal(reconnectingJoiner.memberId, null);
  assert.equal(reconnectingJoiner.memberToken, null);
});

test("join admission restores shared previous session when reconnect rollback happens on another node", async () => {
  let advancingNow = 1_000;
  const local = createInMemoryRuntimeStore(() => advancingNow);
  const shared = createInMemoryRuntimeStore(() => advancingNow);
  let expireAfterNextFlush = false;
  const runtimeStore: RuntimeStore = {
    ...local,
    addMember: (code, memberId, session, memberToken) => {
      const room = local.addMember(code, memberId, session, memberToken);
      shared.addMember(code, memberId, session, memberToken);
      return room;
    },
    removeMember: (code, memberId, session) => {
      const removal = local.removeMember(code, memberId, session);
      shared.removeMember(code, memberId, session);
      return removal;
    },
    revokeMemberToken: (code, memberId) => {
      local.revokeMemberToken(code, memberId);
      shared.revokeMemberToken(code, memberId);
    },
    evictMemberToken: (code, memberId, memberToken, blockedUntil) => {
      local.evictMemberToken(code, memberId, memberToken, blockedUntil);
      shared.evictMemberToken(code, memberId, memberToken, blockedUntil);
    },
    flush: async () => {
      await local.flush?.();
      await shared.flush?.();
      if (expireAfterNextFlush) {
        expireAfterNextFlush = false;
        advancingNow += 60_000;
      }
    },
  };
  const roomStore = createInMemoryRoomStore({ now: () => advancingNow });
  const service = createRoomService({
    config: { ...getDefaultSecurityConfig(), maxMembersPerRoom: 3 },
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    runtimeStore,
    resolveActiveRoom: async (roomCode) => shared.getRoom(roomCode),
    resolveMemberIdByToken: async (roomCode, memberToken) =>
      shared.findMemberIdByToken(roomCode, memberToken),
    resolveBlockedMemberToken: async (roomCode, memberToken, currentTime) =>
      shared.isMemberTokenBlocked(roomCode, memberToken, currentTime),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => advancingNow,
    createRoomCode: () => "ROOM21D",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const remoteSession = createSession("remote-joiner");
  const remoteMemberId = "remote-member";
  const remoteMemberToken = "remote-token".padEnd(16, "x");
  remoteSession.memberId = remoteMemberId;
  remoteSession.roomCode = created.room.code;
  remoteSession.memberToken = remoteMemberToken;
  remoteSession.joinedAt = advancingNow;
  shared.addMember(
    created.room.code,
    remoteMemberId,
    remoteSession,
    remoteMemberToken,
  );
  assert.equal(
    local.getRoom(created.room.code)?.members.has(remoteMemberId),
    false,
  );

  expireAfterNextFlush = true;

  const reconnectingJoiner = createSession("joiner-reconnect");
  await assert.rejects(
    service.joinRoomForSession(
      reconnectingJoiner,
      created.room.code,
      created.room.joinToken,
      "Bob",
      remoteMemberToken,
    ),
    /internal/i,
  );

  const sharedRoom = shared.getRoom(created.room.code);
  assert.equal(sharedRoom?.members.get(remoteMemberId), remoteSession);
  assert.equal(sharedRoom?.memberTokens.get(remoteMemberId), remoteMemberToken);
  assert.equal(reconnectingJoiner.roomCode, null);
  assert.equal(reconnectingJoiner.memberId, null);
  assert.equal(reconnectingJoiner.memberToken, null);
});

test("join admission does not restore stale reconnect session over newer shared binding", async () => {
  let advancingNow = 1_000;
  const local = createInMemoryRuntimeStore(() => advancingNow);
  const shared = createInMemoryRuntimeStore(() => advancingNow);
  const newerSession = createSession("newer-reconnect");
  let replaceSharedBindingAfterNextFlush = false;
  const runtimeStore: RuntimeStore = {
    ...local,
    addMember: (code, memberId, session, memberToken) => {
      const room = local.addMember(code, memberId, session, memberToken);
      shared.addMember(code, memberId, session, memberToken);
      return room;
    },
    removeMember: (code, memberId, session) => {
      const removal = local.removeMember(code, memberId, session);
      shared.removeMember(code, memberId, session);
      return removal;
    },
    revokeMemberToken: (code, memberId) => {
      local.revokeMemberToken(code, memberId);
      shared.revokeMemberToken(code, memberId);
    },
    evictMemberToken: (code, memberId, memberToken, blockedUntil) => {
      local.evictMemberToken(code, memberId, memberToken, blockedUntil);
      shared.evictMemberToken(code, memberId, memberToken, blockedUntil);
    },
    flush: async () => {
      await local.flush?.();
      await shared.flush?.();
      if (replaceSharedBindingAfterNextFlush) {
        replaceSharedBindingAfterNextFlush = false;
        shared.addMember(
          newerSession.roomCode ?? "",
          newerSession.memberId ?? "",
          newerSession,
          newerSession.memberToken ?? "",
        );
        advancingNow += 60_000;
      }
    },
  };
  const roomStore = createInMemoryRoomStore({ now: () => advancingNow });
  const service = createRoomService({
    config: { ...getDefaultSecurityConfig(), maxMembersPerRoom: 3 },
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    runtimeStore,
    resolveActiveRoom: async (roomCode) => shared.getRoom(roomCode),
    resolveMemberIdByToken: async (roomCode, memberToken) =>
      shared.findMemberIdByToken(roomCode, memberToken),
    resolveBlockedMemberToken: async (roomCode, memberToken, currentTime) =>
      shared.isMemberTokenBlocked(roomCode, memberToken, currentTime),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => advancingNow,
    createRoomCode: () => "ROOM21E",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const previousSession = createSession("previous-joiner");
  const memberId = "remote-member";
  const memberToken = "remote-token".padEnd(16, "x");
  previousSession.memberId = memberId;
  previousSession.roomCode = created.room.code;
  previousSession.memberToken = memberToken;
  previousSession.joinedAt = advancingNow;
  newerSession.memberId = memberId;
  newerSession.roomCode = created.room.code;
  newerSession.memberToken = memberToken;
  newerSession.joinedAt = advancingNow;
  shared.addMember(created.room.code, memberId, previousSession, memberToken);

  replaceSharedBindingAfterNextFlush = true;

  const reconnectingJoiner = createSession("joiner-reconnect");
  await assert.rejects(
    service.joinRoomForSession(
      reconnectingJoiner,
      created.room.code,
      created.room.joinToken,
      "Bob",
      memberToken,
    ),
    /internal/i,
  );

  const sharedRoom = shared.getRoom(created.room.code);
  assert.equal(sharedRoom?.members.get(memberId), newerSession);
  assert.equal(sharedRoom?.memberTokens.get(memberId), memberToken);
  assert.equal(reconnectingJoiner.roomCode, null);
  assert.equal(reconnectingJoiner.memberId, null);
  assert.equal(reconnectingJoiner.memberToken, null);
});

test("join admission does not fail after successful action when lock expires before return", async () => {
  let advancingNow = 1_000;
  const baseStore = createInMemoryRuntimeStore(() => advancingNow);
  let releaseCalls = 0;
  const runtimeStore: RuntimeStore = {
    ...baseStore,
    releaseRoomLock: async (...args) => {
      releaseCalls += 1;
      return baseStore.releaseRoomLock(...args);
    },
  };
  const roomStore = createInMemoryRoomStore({ now: () => advancingNow });
  const service = createRoomService({
    config: { ...getDefaultSecurityConfig(), maxMembersPerRoom: 3 },
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    runtimeStore,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (event) => {
      if (event === "room_restored") {
        advancingNow += 60_000;
      }
    },
    now: () => advancingNow,
    createRoomCode: () => "ROOM21B",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  const joiner = createSession("joiner");
  const joined = await service.joinRoomForSession(
    joiner,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );

  assert.equal(joined.room.code, created.room.code);
  assert.equal(joiner.roomCode, created.room.code);
  assert.equal(
    baseStore.getRoom(created.room.code)?.members.get(joiner.id),
    joiner,
  );
  assert.equal(
    releaseCalls,
    0,
    "expired locks should not be released after the action commits",
  );
});

test("concurrent playback updates produce consistent final state without errors", async () => {
  // Two members simultaneously submit playback updates. Both calls must
  // complete (one may be ignored by authority arbitration) and the final
  // persisted room must contain one of the two submitted states — no
  // partial writes or thrown errors.
  const currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createActiveRoomRegistry(() => currentTime);
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM17",
  });

  const owner = createSession("owner");
  const createdRoom = await service.createRoomForSession(owner, "Alice");
  const joiner = createSession("joiner");
  const joinedRoom = await service.joinRoomForSession(
    joiner,
    createdRoom.room.code,
    createdRoom.room.joinToken,
    "Bob",
  );

  await service.shareVideoForSession(
    owner,
    createdRoom.memberToken,
    createSharedVideo(),
  );

  const ownerPlayback = createPlayback(owner.id, {
    seq: 1,
    playState: "playing",
    currentTime: 10,
    serverTime: 1_000,
    updatedAt: 1_000,
  });
  const joinerPlayback = createPlayback(joiner.id, {
    seq: 1,
    playState: "paused",
    currentTime: 20,
    serverTime: 1_000,
    updatedAt: 1_000,
  });

  const [ownerResult, joinerResult] = await Promise.all([
    service.updatePlaybackForSession(
      owner,
      createdRoom.memberToken,
      ownerPlayback,
    ),
    service.updatePlaybackForSession(
      joiner,
      joinedRoom.memberToken,
      joinerPlayback,
    ),
  ]);

  // At least one update must land; neither call may throw
  const ownerLanded = !ownerResult.ignored && ownerResult.room !== null;
  const joinerLanded = !joinerResult.ignored && joinerResult.room !== null;
  assert.ok(
    ownerLanded || joinerLanded,
    "at least one playback update must be applied",
  );

  // Final persisted playback must equal one of the two submitted states in
  // every field — not just actorId. A partial write (e.g. actorId from owner
  // but currentTime/playState from joiner) would pass an actorId-only check
  // but fail this full comparison.
  // The service overwrites actorId = session.memberId (= session.id for fresh
  // sessions) and serverTime = now() (= 1_000 in this test), so both values
  // are identical to the submitted fixtures and a direct deepEqual is valid.
  const finalRoom = await roomStore.getRoom(createdRoom.room.code);
  assert.ok(finalRoom?.playback, "room must have a playback state");
  const isOwnerPlayback =
    finalRoom.playback?.actorId === owner.id &&
    finalRoom.playback?.currentTime === ownerPlayback.currentTime &&
    finalRoom.playback?.playState === ownerPlayback.playState &&
    finalRoom.playback?.seq === ownerPlayback.seq;
  const isJoinerPlayback =
    finalRoom.playback?.actorId === joiner.id &&
    finalRoom.playback?.currentTime === joinerPlayback.currentTime &&
    finalRoom.playback?.playState === joinerPlayback.playState &&
    finalRoom.playback?.seq === joinerPlayback.seq;
  assert.ok(
    isOwnerPlayback || isJoinerPlayback,
    `final playback must exactly match one submitted state, got: ${JSON.stringify(finalRoom.playback)}`,
  );
});

test("concurrent duplicate video:share requests are deduplicated to a single write", async () => {
  // Two concurrent shareVideoForSession calls with an identical video are
  // issued via Promise.all. Both pass requireJoinedRoomSession (an awaited
  // async step), which creates a genuine interleaving point: call A suspends,
  // call B suspends, then A resumes first and claims the dedup slot. When B
  // resumes and reaches tryClaimMessageSlot the key is already set, so B is
  // deduplicated without issuing an updateRoom write.
  //
  // The observable invariant: the persisted room version increases by exactly
  // 1 (one write), not 2 (both writes landing) or 0 (both rejected).
  const currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createActiveRoomRegistry(() => currentTime);
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM18",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const versionAfterCreate = (await roomStore.getRoom(created.room.code))
    ?.version;

  const video = createSharedVideo();

  const [resultA, resultB] = await Promise.all([
    service.shareVideoForSession(owner, created.memberToken, video),
    service.shareVideoForSession(owner, created.memberToken, video),
  ]);

  // Both calls complete without throwing; one lands, one is deduplicated
  assert.ok(resultA.room, "resultA must return a room");
  assert.ok(resultB.room, "resultB must return a room");

  const finalRoom = await roomStore.getRoom(created.room.code);
  assert.equal(
    finalRoom?.version,
    (versionAfterCreate ?? 0) + 1,
    "exactly one updateRoom write must have occurred; version must advance by 1",
  );
});

test("shareVideoForSession persists the sharer's display name so popups survive rejoin", async () => {
  const currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createActiveRoomRegistry(() => currentTime);
  const service = createRoomService({
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
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM19",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo(),
  );

  const persisted = await roomStore.getRoom(created.room.code);
  assert.equal(persisted?.sharedVideo?.sharedByDisplayName, "Alice");

  // Owner leaves and rejoins as a fresh member; sharedByMemberId no longer
  // matches a current member, but sharedByDisplayName must still be present so
  // the popup can render the sharer hint.
  await service.leaveRoomForSession(owner);
  const rejoined = await service.joinRoomForSession(
    createSession("owner-2"),
    created.room.code,
    created.room.joinToken,
    "Alice",
  );
  assert.equal(rejoined.room.sharedVideo?.sharedByDisplayName, "Alice");
});

test("shareVideoForSession rejects client-supplied sharedByDisplayName", async () => {
  const currentTime = 1_000;
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
    createRoomCode: () => "ROOM20",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  await service.shareVideoForSession(owner, created.memberToken, {
    ...createSharedVideo(),
    sharedByDisplayName: "Spoofed",
  });

  const persisted = await roomStore.getRoom(created.room.code);
  assert.equal(
    persisted?.sharedVideo?.sharedByDisplayName,
    "Alice",
    "server must overwrite client-supplied sharedByDisplayName with session.displayName",
  );
});

test("playback_update_applied skips steady timeupdate ticks but logs user actions", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent(event, data) {
      events.push({ event, data });
    },
    now: () => currentTime,
    createRoomCode: () => "ROOM21",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const ownerId = owner.memberId ?? owner.id;

  // Baseline: share video at t=10, playing @ 1x.
  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo(),
    createPlayback(ownerId, {
      currentTime: 10,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 1_000,
      seq: 1,
    }),
  );
  events.length = 0;

  // Steady tick: +2s wall, +2s media, no state change.
  currentTime = 3_000;
  await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(ownerId, {
      currentTime: 12,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 3_000,
      seq: 2,
    }),
  );
  // Another steady tick.
  currentTime = 5_000;
  await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(ownerId, {
      currentTime: 14,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 5_000,
      seq: 3,
    }),
  );

  // User pause: state change → logged.
  currentTime = 5_500;
  await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(ownerId, {
      currentTime: 14,
      playState: "paused",
      playbackRate: 1,
      updatedAt: 5_500,
      seq: 4,
    }),
  );

  // Steady paused tick: time should not advance during pause → not logged.
  currentTime = 7_500;
  await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(ownerId, {
      currentTime: 14,
      playState: "paused",
      playbackRate: 1,
      updatedAt: 7_500,
      seq: 5,
    }),
  );

  // User resume: state change → logged.
  currentTime = 9_000;
  await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(ownerId, {
      currentTime: 14,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 9_000,
      seq: 6,
    }),
  );

  // User explicit seek (forward): → logged via syncIntent.
  currentTime = 11_000;
  await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(ownerId, {
      currentTime: 80,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 11_000,
      syncIntent: "explicit-seek",
      seq: 7,
    }),
  );

  // Steady tick after seek: +2s wall, +2s media → not logged.
  currentTime = 13_000;
  await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(ownerId, {
      currentTime: 82,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 13_000,
      seq: 8,
    }),
  );

  // Time jump without explicit intent (e.g., recovery from buffering on the
  // client): expected +2s, actual +30s → logged.
  currentTime = 15_000;
  await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(ownerId, {
      currentTime: 112,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 15_000,
      seq: 9,
    }),
  );

  // Rate change → logged even with naturally-advancing time.
  currentTime = 17_000;
  await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(ownerId, {
      currentTime: 114,
      playState: "playing",
      playbackRate: 2,
      updatedAt: 17_000,
      seq: 10,
    }),
  );

  // Steady tick at the new 2x rate: +2s wall, +4s media → not logged.
  currentTime = 19_000;
  await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(ownerId, {
      currentTime: 118,
      playState: "playing",
      playbackRate: 2,
      updatedAt: 19_000,
      seq: 11,
    }),
  );

  const applied = events.filter(
    (entry) => entry.event === "playback_update_applied",
  );
  assert.deepEqual(
    applied.map((entry) => ({
      seq: entry.data.seq,
      playState: entry.data.playState,
      playbackRate: entry.data.playbackRate,
      syncIntent: entry.data.syncIntent,
    })),
    [
      { seq: 4, playState: "paused", playbackRate: 1, syncIntent: "none" },
      { seq: 6, playState: "playing", playbackRate: 1, syncIntent: "none" },
      {
        seq: 7,
        playState: "playing",
        playbackRate: 1,
        syncIntent: "explicit-seek",
      },
      { seq: 9, playState: "playing", playbackRate: 1, syncIntent: "none" },
      { seq: 10, playState: "playing", playbackRate: 2, syncIntent: "none" },
    ],
  );
});

test("playback_update_applied still logs seeks when a modified client forges a matching updatedAt delta", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent(event, data) {
      events.push({ event, data });
    },
    now: () => currentTime,
    createRoomCode: () => "ROOM22",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const ownerId = owner.memberId ?? owner.id;

  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo(),
    createPlayback(ownerId, {
      currentTime: 10,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 1_000,
      seq: 1,
    }),
  );
  events.length = 0;

  // Server clock advances by ~2s (one normal broadcast interval), but the
  // client claims its own clock advanced by 30s and that media moved 30s
  // forward — i.e., a forged steady tick masking a 30s seek. Without using
  // the server-stamped serverTime as the elapsed-time source, this would be
  // classified as steady and silently dropped.
  currentTime = 3_000;
  await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(ownerId, {
      currentTime: 40,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 31_000,
      seq: 2,
    }),
  );

  const applied = events.filter(
    (entry) => entry.event === "playback_update_applied",
  );
  assert.equal(applied.length, 1);
  assert.equal(applied[0]?.data.seq, 2);
  assert.equal(applied[0]?.data.currentTime, 40);
});

test("playback_update_applied skips steady ticks across actor handovers in multi-member rooms", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent(event, data) {
      events.push({ event, data });
    },
    now: () => currentTime,
    createRoomCode: () => "ROOM23",
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
  const ownerId = owner.memberId ?? owner.id;
  const guestId = guest.memberId ?? guest.id;

  await service.shareVideoForSession(
    owner,
    created.memberToken,
    createSharedVideo(),
    createPlayback(ownerId, {
      currentTime: 10,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 1_000,
      seq: 1,
    }),
  );
  events.length = 0;

  // Authority window is 1.2s but timeupdate cadence is ~2s, so after the
  // owner's authority expires the guest's tick can be accepted on a
  // following broadcast. With actor identity gating the steady-tick check,
  // each handover would re-flood the log — even though no one touched
  // playback. Verify both actors' steady ticks stay silent.
  currentTime = 3_000;
  await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(ownerId, {
      currentTime: 12,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 3_000,
      seq: 2,
    }),
  );
  currentTime = 5_000;
  await service.updatePlaybackForSession(
    guest,
    joined.memberToken,
    createPlayback(guestId, {
      currentTime: 14,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 5_000,
      seq: 1,
    }),
  );
  currentTime = 7_000;
  await service.updatePlaybackForSession(
    owner,
    created.memberToken,
    createPlayback(ownerId, {
      currentTime: 16,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 7_000,
      seq: 3,
    }),
  );

  const applied = events.filter(
    (entry) => entry.event === "playback_update_applied",
  );
  assert.deepEqual(applied, []);
});

test("room service sweeps expired playback authorities when recording new ones", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const roomCodes = ["ROOMSW1", "ROOMSW2"];
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
    createRoomCode: () => roomCodes.shift() ?? "ROOMSWX",
  });

  const ownerA = createSession("owner-a");
  const roomA = await service.createRoomForSession(ownerA, "Alice");
  await service.shareVideoForSession(
    ownerA,
    roomA.memberToken,
    createSharedVideo(),
    createPlayback(ownerA.memberId ?? ownerA.id, {
      playState: "paused",
      currentTime: 10,
    }),
  );
  currentTime = 2_000;
  await service.updatePlaybackForSession(
    ownerA,
    roomA.memberToken,
    createPlayback(ownerA.memberId ?? ownerA.id, {
      playState: "playing",
      currentTime: 10.1,
      seq: 2,
    }),
  );
  assert.equal(service.getPlaybackAuthority(roomA.room.code)?.kind, "play");

  // Long past room A's authority window and the sweep interval; recording a
  // new authority in room B triggers the sweep and must not clobber the
  // entry it is about to record.
  currentTime = 70_000;
  const ownerB = createSession("owner-b");
  const roomB = await service.createRoomForSession(ownerB, "Bob");
  await service.shareVideoForSession(
    ownerB,
    roomB.memberToken,
    createSharedVideo(),
    createPlayback(ownerB.memberId ?? ownerB.id, {
      playState: "paused",
      currentTime: 5,
    }),
  );
  currentTime = 71_000;
  await service.updatePlaybackForSession(
    ownerB,
    roomB.memberToken,
    createPlayback(ownerB.memberId ?? ownerB.id, {
      playState: "playing",
      currentTime: 5.05,
      seq: 2,
    }),
  );

  assert.equal(service.getPlaybackAuthority(roomB.room.code)?.kind, "play");
  assert.equal(service.getPlaybackAuthority(roomA.room.code), null);
});

test("restores the member when revoking their identity fails on leave", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const activeRooms = createActiveRoomRegistry();
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...activeRooms,
      // The durable revoke now rejects when the write does not land.
      revokeMemberToken: async () => {
        throw new Error("redis unavailable");
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMRC",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const guest = createSession("guest");
  await service.joinRoomForSession(
    guest,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );
  const guestMemberId = guest.memberId;

  // Surfaced as the service's generic internal error, like every other failed
  // leave — what matters is that the recovery path ran first.
  await assert.rejects(
    service.leaveRoomForSession(guest, "client-request"),
    /internal server error/i,
  );

  // The failure must not leave the client holding a session that claims to be
  // joined while the runtime has already dropped the membership behind it —
  // every later request would then be rejected as "not in room".
  assert.equal(guest.roomCode, created.room.code);
  assert.equal(guest.memberId, guestMemberId);
  assert.equal(
    activeRooms.getRoom(created.room.code)?.members.has(guestMemberId!),
    true,
  );
});

test("reaper keeps collecting rooms when one runtime teardown fails", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createActiveRoomRegistry();
  const failedFor: string[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...activeRooms,
      deleteRoom: async (code: string) => {
        if (code === "ROOMF1") {
          failedFor.push(code);
          throw new Error("redis unavailable");
        }
        return activeRooms.deleteRoom(code);
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: (() => {
      const codes = ["ROOMF1", "ROOMF2"];
      return () => codes.shift() ?? "ROOMFX";
    })(),
  });

  // Room creation now wipes any runtime state left under a recycled code, which
  // also goes through the failing stub; only the reaping phase is under test.
  for (const name of ["Alice", "Bob"]) {
    const owner = createSession(`owner-${name}`);
    const created = await service.createRoomForSession(owner, name);
    await service.leaveRoomForSession(owner, "disconnect");
    assert.ok(created.room.code);
  }

  failedFor.length = 0;
  currentTime += getDefaultPersistenceConfig().emptyRoomTtlMs + 1;
  // Both rooms are collected even though the first teardown throws — one
  // failure must not strand every room queued behind it.
  assert.equal(await service.deleteExpiredRooms(), 2);
  assert.deepEqual(failedFor, ["ROOMF1"]);
  assert.equal(activeRooms.getRoom("ROOMF2"), null);
});

test("retries a failed runtime teardown on the next reaper pass", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createActiveRoomRegistry();
  let failTeardown = true;
  const teardowns: string[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...activeRooms,
      deleteRoom: async (code: string) => {
        if (failTeardown) {
          throw new Error("redis unavailable");
        }
        teardowns.push(code);
        return activeRooms.deleteRoom(code);
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOMRT",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const ownerMemberId = owner.memberId;
  await service.leaveRoomForSession(owner, "disconnect");

  currentTime += getDefaultPersistenceConfig().emptyRoomTtlMs + 1;
  assert.equal(await service.deleteExpiredRooms(), 1);
  // The persisted room and its expiry index are already gone, so nothing else
  // will ever name this code again — a swallowed failure strands it for good.
  assert.equal(
    activeRooms.findMemberIdByToken(created.room.code, created.memberToken),
    ownerMemberId,
  );

  failTeardown = false;
  teardowns.length = 0;
  // A later pass finds nothing newly expired, but must still work through what
  // it owes.
  assert.equal(await service.deleteExpiredRooms(), 0);
  assert.deepEqual(teardowns, ["ROOMRT"]);
  assert.equal(activeRooms.getRoom("ROOMRT"), null);
});

test("does not hand out a room code that still has runtime state under it", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createActiveRoomRegistry();
  let failTeardown = true;
  // Offers ROOMA1 again for the second room's FIRST attempt. A sequential list
  // would hand out ROOMA2 either way, so the test could not tell whether the
  // residue check ran at all.
  const offeredCodes: string[] = [];
  const codeSequence = ["ROOMA1", "ROOMA1", "ROOMA2"];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...activeRooms,
      deleteRoom: async (code: string) => {
        if (failTeardown) {
          throw new Error("redis unavailable");
        }
        return activeRooms.deleteRoom(code);
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => {
      const code = codeSequence.shift() ?? "ROOMAX";
      offeredCodes.push(code);
      return code;
    },
    resolveActiveRoom: async (code) => activeRooms.getRoom(code),
  });

  const first = createSession("first-owner");
  const created = await service.createRoomForSession(first, "Alice");
  assert.equal(created.room.code, "ROOMA1");
  await service.leaveRoomForSession(first, "disconnect");

  currentTime += getDefaultPersistenceConfig().emptyRoomTtlMs + 1;
  // The teardown fails, so ROOMA1 still carries the previous occupant's tokens.
  await service.deleteExpiredRooms();
  assert.equal(await roomStore.getRoom("ROOMA1"), null);
  assert.ok(activeRooms.getRoom("ROOMA1"));

  // A code is only safe to hand out once nothing is left under it. Reusing
  // ROOMA1 here would let the previous occupant's token resolve to their old
  // memberId inside the new room; enforcing it at allocation is what removes
  // the need for a clean-slate wipe and a recycled-code guard downstream.
  failTeardown = false;
  const second = createSession("second-owner");
  const recreated = await service.createRoomForSession(second, "Bob");
  assert.equal(recreated.room.code, "ROOMA2");
  // ROOMA1 was offered again and had to be refused before ROOMA2 was tried.
  assert.deepEqual(offeredCodes, ["ROOMA1", "ROOMA1", "ROOMA2"]);
  assert.equal(
    activeRooms.findMemberIdByToken("ROOMA2", created.memberToken),
    null,
  );
});

test("keeps an owed teardown when the room store cannot be read", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createActiveRoomRegistry();
  let failTeardown = true;
  let failRoomRead = false;
  const teardowns: string[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: {
      ...roomStore,
      getRoom: async (code: string) => {
        if (failRoomRead) {
          throw new Error("redis unavailable");
        }
        return roomStore.getRoom(code);
      },
    },
    activeRooms: {
      ...activeRooms,
      deleteRoom: async (code: string) => {
        if (failTeardown) {
          throw new Error("redis unavailable");
        }
        teardowns.push(code);
        return activeRooms.deleteRoom(code);
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOMRD",
    resolveActiveRoom: async (code) => activeRooms.getRoom(code),
  });

  const owner = createSession("owner");
  await service.createRoomForSession(owner, "Alice");
  await service.leaveRoomForSession(owner, "disconnect");
  currentTime += getDefaultPersistenceConfig().emptyRoomTtlMs + 1;
  await service.deleteExpiredRooms();

  // The room store is unreadable on the retry pass. "Unknown" is not "absent":
  // treating it as absent made the guard fail in exactly the conditions that
  // queue teardowns in the first place, and it would then wipe whatever now
  // owns the code.
  failRoomRead = true;
  failTeardown = false;
  await service.deleteExpiredRooms();
  assert.deepEqual(teardowns, []);
  assert.ok(activeRooms.getRoom("ROOMRD"));

  // Once it can be read again the debt is settled.
  failRoomRead = false;
  await service.deleteExpiredRooms();
  assert.deepEqual(teardowns, ["ROOMRD"]);
});

test("an owed teardown does not wipe a room that took the code in the meantime", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  // Short identity retention so the residue can expire on its own, which is
  // what frees the code — and, unlike a teardown, leaves the generation behind.
  const runtime = createInMemoryRuntimeStore(() => currentTime, 5_000);
  let releaseTeardown!: () => void;
  const teardownGate = new Promise<void>((resolve) => {
    releaseTeardown = resolve;
  });
  let gateTeardown = false;

  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...runtime,
      deleteRoom: async (code: string, expectedGeneration?: string | null) => {
        if (gateTeardown) {
          await teardownGate;
        }
        return runtime.deleteRoom(code, expectedGeneration);
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOMGR",
    resolveActiveRoom: async (code) => runtime.getRoom(code),
  });

  const first = createSession("first-owner");
  await service.createRoomForSession(first, "Alice");
  await service.leaveRoomForSession(first, "disconnect");

  currentTime += getDefaultPersistenceConfig().emptyRoomTtlMs + 1;
  // The reaper clears the room-store guard and then stalls inside the delete —
  // the exact gap the two check-then-act guards cannot cover.
  gateTeardown = true;
  const reaping = service.deleteExpiredRooms();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The previous occupant's identity retention runs out, which frees the code.
  currentTime += 5_001;
  const second = createSession("second-owner");
  const recreated = await service.createRoomForSession(second, "Bob");
  assert.equal(recreated.room.code, "ROOMGR");

  releaseTeardown();
  await reaping;

  // The stale teardown was decided against the previous room instance, so the
  // delete itself has to refuse. No arrangement of the guards around it helps:
  // both had already passed before this room existed.
  assert.equal(
    runtime.findMemberIdByToken("ROOMGR", recreated.memberToken),
    second.memberId,
  );
});

test("pins the teardown generation before checking whether the room is gone", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const runtime = createInMemoryRuntimeStore(() => currentTime, 5_000);
  let releaseRoomRead!: () => void;
  const roomReadGate = new Promise<void>((resolve) => {
    releaseRoomRead = resolve;
  });
  let gateRoomRead = false;

  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: {
      ...roomStore,
      // Stall the absence check itself. Reading the generation after this point
      // hands the teardown the NEW room's value, which then matches.
      getRoom: async (code: string) => {
        const room = await roomStore.getRoom(code);
        if (gateRoomRead) {
          await roomReadGate;
        }
        return room;
      },
    },
    activeRooms: runtime,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOMPN",
    resolveActiveRoom: async (code) => runtime.getRoom(code),
  });

  const first = createSession("first-owner");
  await service.createRoomForSession(first, "Alice");
  await service.leaveRoomForSession(first, "disconnect");

  currentTime += getDefaultPersistenceConfig().emptyRoomTtlMs + 1;
  gateRoomRead = true;
  const reaping = service.deleteExpiredRooms();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The previous occupant's identity expires, freeing the code, and a new room
  // claims it — all while the absence check is still in flight.
  currentTime += 5_001;
  gateRoomRead = false;
  const second = createSession("second-owner");
  const recreated = await service.createRoomForSession(second, "Bob");
  assert.equal(recreated.room.code, "ROOMPN");

  releaseRoomRead();
  await reaping;

  assert.equal(
    runtime.findMemberIdByToken("ROOMPN", recreated.memberToken),
    second.memberId,
  );
});

test("rolls the room back when its generation cannot be stamped", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const runtime = createInMemoryRuntimeStore(() => 1_000);
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...runtime,
      markRoomGeneration: async () => {
        throw new Error("redis unavailable");
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMRB",
    resolveActiveRoom: async (code) => runtime.getRoom(code),
  });

  await assert.rejects(
    service.createRoomForSession(createSession("owner"), "Alice"),
    /internal server error/i,
  );

  // Left behind, the room would have no members and no `expiresAt`, so the
  // reaper never collects it: the code is held and the room counted forever.
  // Expired rather than deleted, so the rollback can be conditional on the
  // version we created — see the recycling test below.
  assert.equal((await roomStore.getRoom("ROOMRB"))?.expiresAt, 1_000);
  assert.equal(await roomStore.countRooms({ includeExpired: false }), 0);
});

test("a failed generation stamp does not roll back a room that recycled the code", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const runtime = createInMemoryRuntimeStore(() => 1_000);
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...runtime,
      markRoomGeneration: async () => {
        // Concurrently: our memberless room is expired and reaped, and another
        // request takes the freed code. Only then does our stamp fail.
        await roomStore.deleteRoom("ROOMRC");
        await roomStore.saveRoom({
          code: "ROOMRC",
          joinToken: "replacement-token",
          ownerMemberId: "other-owner",
          ownerDisplayName: "Bob",
          createdAt: 2_000,
          lastActiveAt: 2_000,
          expiresAt: null,
          version: 1,
          sharedVideo: null,
          playback: null,
        });
        await roomStore.updateRoom("ROOMRC", 1, { lastActiveAt: 2_500 });
        throw new Error("redis unavailable");
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMRC",
    resolveActiveRoom: async (code) => runtime.getRoom(code),
  });

  await assert.rejects(
    service.createRoomForSession(createSession("owner"), "Alice"),
    /internal server error/i,
  );

  // Rolling back by code deleted the replacement out from under an owner who
  // had already been told their creation succeeded.
  const replacement = await roomStore.getRoom("ROOMRC");
  assert.equal(replacement?.joinToken, "replacement-token");
  assert.equal(replacement?.expiresAt, null);
});

test("an admin teardown works through the retry backlog", async () => {
  const currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const runtime = createInMemoryRuntimeStore(() => currentTime);
  let failTeardown = true;
  const teardowns: string[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...runtime,
      deleteRoom: async (code: string, expectedGeneration?: string | null) => {
        if (failTeardown) {
          throw new Error("redis unavailable");
        }
        teardowns.push(code);
        return runtime.deleteRoom(code, expectedGeneration);
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: (() => {
      const codes = ["ROOMB1", "ROOMB2"];
      return () => codes.shift() ?? "ROOMBX";
    })(),
    resolveActiveRoom: async (code) => runtime.getRoom(code),
  });

  const first = createSession("first-owner");
  const owed = await service.createRoomForSession(first, "Alice");
  await roomStore.deleteRoom(owed.room.code);
  // An admin close whose teardown failed: the debt is queued.
  await service.teardownRoomRuntime(owed.room.code);
  assert.deepEqual(teardowns, []);

  const second = createSession("second-owner");
  const other = await service.createRoomForSession(second, "Bob");
  await roomStore.deleteRoom(other.room.code);

  // The standalone global-admin process never runs the reaper, so
  // `deleteExpiredRooms` is not what drains this — every teardown has to.
  failTeardown = false;
  await service.teardownRoomRuntime(other.room.code);
  assert.deepEqual(teardowns.sort(), ["ROOMB1", "ROOMB2"]);
});

test("does not hand out a code whose only leftover is a session index entry", async () => {
  const currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const runtime = createInMemoryRuntimeStore(() => currentTime);
  const offeredCodes: string[] = [];
  const codeSequence = ["ROOMSI", "ROOMSI", "ROOMS2"];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: runtime,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => {
      const code = codeSequence.shift() ?? "ROOMSX";
      offeredCodes.push(code);
      return code;
    },
  });

  // No members and no member tokens, so the members/tokens view reads as empty —
  // but a stale session index entry is exactly the kind of leftover a new room
  // would inherit as a ghost member.
  const ghost = createSession("ghost-session");
  runtime.registerSession(ghost);
  runtime.markSessionJoinedRoom(ghost.id, "ROOMSI");
  assert.equal(runtime.getRoom("ROOMSI"), null);

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  assert.equal(created.room.code, "ROOMS2");
  assert.deepEqual(offeredCodes, ["ROOMSI", "ROOMSI", "ROOMS2"]);
});

test("leave does not schedule expiry when the shared room still has members", async () => {
  const local = createInMemoryRuntimeStore();
  const shared = createInMemoryRuntimeStore();
  const runtimeStore: RuntimeStore = {
    ...local,
    addMember: (code, memberId, session, memberToken) => {
      const room = local.addMember(code, memberId, session, memberToken);
      shared.addMember(code, memberId, session, memberToken);
      return room;
    },
    removeMember: (code, memberId, session) => {
      const removal = local.removeMember(code, memberId, session);
      shared.removeMember(code, memberId, session);
      return removal;
    },
  };
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    runtimeStore,
    resolveActiveRoom: async (code) => shared.getRoom(code),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMSE",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  // The same member reconnected onto another node: the shared binding is that
  // node's session, while this node still holds the stale one it is about to
  // clean up. Only this node's local view goes empty.
  const reconnected = createSession("owner-elsewhere");
  reconnected.roomCode = created.room.code;
  reconnected.memberId = owner.memberId;
  reconnected.memberToken = owner.memberToken;
  shared.addMember(
    created.room.code,
    owner.memberId ?? "",
    reconnected,
    owner.memberToken ?? "",
  );

  const result = await service.leaveRoomForSession(owner, "disconnect");

  assert.equal(local.getRoom(created.room.code)?.members.size, 0);
  assert.equal(shared.getRoom(created.room.code)?.members.size, 1);
  // Trusting this node's local emptiness wrote an `expiresAt` over the one the
  // reconnect had just cleared, so the reaper deleted a room with members in it.
  assert.equal(result.room?.expiresAt, null);
  assert.equal(
    (await roomStore.getRoom(created.room.code))?.expiresAt ?? null,
    null,
  );
});

test("the room keeps exactly one sharer after the sharer leaves", async () => {
  // The #235 scenario: three members, the sharer leaves, and the two who stay
  // must resolve to exactly one owner between them — zero means nobody advances
  // the room, two means both auto-share the next episode.
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
    createRoomCode: () => "ROOM35",
  });

  const sharer = createSession("sharer");
  const created = await service.createRoomForSession(sharer, "Alice");

  // Ids ordered against tenure on purpose: the successor must be the member who
  // has been here longest, not the one with the smallest id. A rule that sorted
  // on id would pick `aaa-late` and this stays green either way otherwise.
  currentTime = 2_000;
  const early = createSession("zzz-early");
  await service.joinRoomForSession(
    early,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );
  currentTime = 3_000;
  const late = createSession("aaa-late");
  await service.joinRoomForSession(
    late,
    created.room.code,
    created.room.joinToken,
    "Carol",
  );

  await service.shareVideoForSession(
    sharer,
    created.memberToken,
    createSharedVideo(),
  );
  const sharerMemberId = sharer.memberId;

  currentTime = 4_000;
  const leave = await service.leaveRoomForSession(sharer, "client-request");
  // The remaining members only hear `room:member-left`, which edits their member
  // list and nothing else, so the leave has to announce that a full `room:state`
  // is owed.
  assert.equal(leave.needsRoomStateResync, true);

  const state = await service.getRoomStateByCode(created.room.code);
  assert.deepEqual(
    state?.members.map((member) => member.id).sort(),
    [late.memberId, early.memberId].sort(),
  );
  assert.equal(state?.sharedVideo?.sharedByMemberId, early.memberId);
  assert.equal(state?.sharedVideo?.sharedByDisplayName, "Bob");

  // The persisted room is untouched: ownership is derived at every read so the
  // original sharer stays the preferred owner.
  const persisted = await roomStore.getRoom(created.room.code);
  assert.equal(persisted?.sharedVideo?.sharedByMemberId, sharerMemberId);
  assert.equal(persisted?.sharedVideo?.sharedByDisplayName, "Alice");
});

test("a bystander leaving does not move the share", async () => {
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
    createRoomCode: () => "ROOM36",
  });

  const sharer = createSession("sharer");
  const created = await service.createRoomForSession(sharer, "Alice");
  currentTime = 2_000;
  const guest = createSession("guest");
  await service.joinRoomForSession(
    guest,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );
  await service.shareVideoForSession(
    sharer,
    created.memberToken,
    createSharedVideo(),
  );

  currentTime = 3_000;
  const leave = await service.leaveRoomForSession(guest, "client-request");

  assert.equal(leave.needsRoomStateResync, false);
  const state = await service.getRoomStateByCode(created.room.code);
  assert.equal(state?.sharedVideo?.sharedByMemberId, sharer.memberId);
});

test("the sharer reclaims the share on reconnect", async () => {
  // The stand-in only holds the share while the sharer is away. #237 keeps the
  // memberToken alive across a disconnect, so a suspended service worker coming
  // back must get its room back rather than lose it for good — which is what a
  // persisted transfer would have done.
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
    createRoomCode: () => "ROOM37",
  });

  const sharer = createSession("sharer");
  const created = await service.createRoomForSession(sharer, "Alice");
  const sharerMemberId = sharer.memberId;
  currentTime = 2_000;
  const guest = createSession("guest");
  await service.joinRoomForSession(
    guest,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );
  await service.shareVideoForSession(
    sharer,
    created.memberToken,
    createSharedVideo(),
  );

  currentTime = 3_000;
  await service.leaveRoomForSession(sharer, "disconnect");
  assert.equal(
    (await service.getRoomStateByCode(created.room.code))?.sharedVideo
      ?.sharedByMemberId,
    guest.memberId,
  );

  currentTime = 4_000;
  const reconnected = createSession("sharer-reconnect");
  await service.joinRoomForSession(
    reconnected,
    created.room.code,
    created.room.joinToken,
    "Alice",
    created.memberToken,
  );

  assert.equal(reconnected.memberId, sharerMemberId);
  assert.equal(
    (await service.getRoomStateByCode(created.room.code))?.sharedVideo
      ?.sharedByMemberId,
    sharerMemberId,
  );
});

test("an unreadable shared member view still asks for a resync", async () => {
  // The election cannot run without the shared member list, and silence is the
  // worse default: a room left pointing at a member who is gone has nothing
  // scheduled to correct it, while an unnecessary broadcast costs one message
  // (#235 review).
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createActiveRoomRegistry();
  let sharedViewFails = false;
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms,
    resolveActiveRoom: async (roomCode) => {
      if (sharedViewFails) {
        throw new Error("transient shared runtime read failure");
      }
      return activeRooms.getRoom(roomCode);
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM38",
  });

  const sharer = createSession("sharer");
  const created = await service.createRoomForSession(sharer, "Alice");
  currentTime = 2_000;
  const guest = createSession("guest");
  await service.joinRoomForSession(
    guest,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );
  await service.shareVideoForSession(
    sharer,
    created.memberToken,
    createSharedVideo(),
  );

  currentTime = 3_000;
  sharedViewFails = true;
  const leave = await service.leaveRoomForSession(guest, "client-request");

  assert.equal(leave.needsRoomStateResync, true);
});

test("an unconfirmed member removal still asks for a resync", async () => {
  // The member hash and the session index are separate writes. When the member
  // removal fails but the index cleanup succeeds, the shared view still lists
  // the leaver — so the election says nothing moved — while the `room:state`
  // clients eventually get is built from the index and no longer contains them.
  // The two disagree exactly where it matters, so an unconfirmed removal is
  // treated like an unreadable view (#235 review).
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createActiveRoomRegistry();
  let removalFails = false;
  const runtimeStore = {
    ...activeRooms,
    removeMember: (code: string, memberId: string, session?: Session) => {
      const removal = activeRooms.removeMember(code, memberId, session);
      return removalFails
        ? {
            ...removal,
            durable: Promise.reject(new Error("member write failed")),
          }
        : removal;
    },
  };
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: runtimeStore,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM39",
  });

  const sharer = createSession("sharer");
  const created = await service.createRoomForSession(sharer, "Alice");
  currentTime = 2_000;
  const guest = createSession("guest");
  await service.joinRoomForSession(
    guest,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );
  await service.shareVideoForSession(
    sharer,
    created.memberToken,
    createSharedVideo(),
  );

  // A bystander leaves, so a confirmed removal would report no handover at all.
  currentTime = 3_000;
  removalFails = true;
  const leave = await service.leaveRoomForSession(guest, "client-request");

  assert.equal(leave.needsRoomStateResync, true);
});

test("an unreadable shared member view is not treated as an empty room", async () => {
  // This node's last member leaving is not the room emptying — the paragraph
  // above `roomEmpty` says so — but the fallback reinstated exactly that on the
  // one path where nothing can contradict it. The expiry then lands on a room
  // other nodes are still using, and the same `!roomEmpty` guard swallows the
  // resync that would have told them (#235 review).
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createActiveRoomRegistry();
  let sharedViewFails = false;
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: { ...getDefaultPersistenceConfig(), emptyRoomTtlMs: 5_000 },
    roomStore,
    activeRooms,
    resolveActiveRoom: async (roomCode) => {
      if (sharedViewFails) {
        throw new Error("transient shared runtime read failure");
      }
      return activeRooms.getRoom(roomCode);
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM40",
  });

  const sharer = createSession("sharer");
  const created = await service.createRoomForSession(sharer, "Alice");
  await service.shareVideoForSession(
    sharer,
    created.memberToken,
    createSharedVideo(),
  );

  // The only member this node knows about leaves, so the local view says empty.
  currentTime = 2_000;
  sharedViewFails = true;
  const leave = await service.leaveRoomForSession(sharer, "client-request");

  assert.equal(leave.needsRoomStateResync, true);
  assert.equal(
    (await roomStore.getRoom(created.room.code))?.expiresAt ?? null,
    null,
    "a room whose membership is unknown must not be scheduled for expiry",
  );
});

test("an unconfirmed removal of the last member still empties the room", async () => {
  // The member write is queued, so an unconfirmed one leaves this leave's own
  // seat in the shared view. Counting it kept the room "occupied": no
  // `expiresAt` was written, and nothing afterwards collects the room, its
  // member map or its tokens (#235 review).
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createActiveRoomRegistry();
  let removalFails = false;
  let staleMembers: ActiveRoom | null = null;
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: { ...getDefaultPersistenceConfig(), emptyRoomTtlMs: 5_000 },
    roomStore,
    activeRooms: {
      ...activeRooms,
      removeMember: (code: string, memberId: string, session?: Session) => {
        // Snapshot the pre-removal view, which is what a failed write leaves
        // the shared store holding.
        const room = activeRooms.getRoom(code);
        staleMembers = room
          ? { ...room, members: new Map(room.members) }
          : null;
        const removal = activeRooms.removeMember(code, memberId, session);
        return removalFails
          ? {
              ...removal,
              durable: Promise.reject(new Error("member write failed")),
            }
          : removal;
      },
    },
    resolveActiveRoom: async (roomCode) =>
      removalFails ? staleMembers : activeRooms.getRoom(roomCode),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOM43",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  currentTime = 2_000;
  removalFails = true;
  await service.leaveRoomForSession(owner, "disconnect");

  assert.equal(
    (await roomStore.getRoom(created.room.code))?.expiresAt,
    7_000,
    "the room the leaver just emptied must still be scheduled for expiry",
  );
});
