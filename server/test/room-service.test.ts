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
import type { LogEvent, Session } from "../src/types.js";

function createSession(id: string): Session {
  const config = getDefaultSecurityConfig();
  return {
    id,
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
