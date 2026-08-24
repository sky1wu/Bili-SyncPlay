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
import {
  createInMemoryRoomStore,
  type RoomReadCaller,
  type RoomStore,
} from "../src/room-store.js";
import { RedisStoreUnavailableError } from "../src/redis-store-unavailable.js";
import { createRoomService, RoomServiceError } from "../src/room-service.js";
import { settleWithin } from "../src/retry-pacer.js";
import {
  createInMemoryRuntimeStore,
  type RuntimeReadCaller,
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
    async getRoom(code: string, caller?: RoomReadCaller) {
      const room = await baseRoomStore.getRoom(code, caller);
      if (validateDeletedRoom) {
        validationReadCount += 1;
        if (validationReadCount === 2) {
          if (room) {
            await baseRoomStore.deleteRoom(room);
          }
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

test("a leave whose revocation fails has nothing to compensate", async () => {
  // Why the revocation goes FIRST. It is bounded (#277), so it can answer its
  // caller while still unanswered; done after the removal, every such answer
  // left a member torn out of the runtime that something had to put back — and
  // that compensating write is unguarded, so it would re-seat the departed
  // session over a successor who reconnected onto another node meanwhile. Done
  // first, there is nothing to put back.
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const activeRooms = createActiveRoomRegistry();
  const events: string[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...activeRooms,
      revokeMemberToken: async () => {
        throw new Error("redis unavailable");
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: ((name) => {
      events.push(name);
    }) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMNC",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  await assert.rejects(
    service.leaveRoomForSession(owner),
    (error: unknown) =>
      error instanceof Error && error.message === "Internal server error.",
  );

  // Still seated, because the removal never ran.
  assert.equal(activeRooms.getRoom(created.room.code)?.members.size, 1);
  assert.equal(
    activeRooms.getRoom(created.room.code)?.members.get("owner"),
    owner,
  );
  // And no recovery happened, because there was nothing to recover. This is the
  // assertion the old ordering fails: it removed first, so the failure had to
  // be compensated.
  assert.ok(!events.includes("room_leave_recovered"));
});

test("a revocation that stood is not undone when the removal then fails", async () => {
  // The other side of the reordering, pinned so it is not "fixed" later into a
  // compensation. Once the revocation has landed the identity is over ON
  // PURPOSE; putting the token back would undo a write that succeeded. The
  // member keeps only a seat they can no longer authenticate against, which the
  // next message or the socket-close leave resolves — and unlike before the
  // reordering, a synchronous failure here is inside the try and reported.
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const activeRooms = createActiveRoomRegistry();
  const events: string[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...activeRooms,
      removeMember: () => {
        throw new Error("runtime store backpressure");
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: ((name) => {
      events.push(name);
    }) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMRF2",
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  await assert.rejects(
    service.leaveRoomForSession(owner),
    (error: unknown) =>
      error instanceof Error && error.message === "Internal server error.",
  );

  const room = activeRooms.getRoom(created.room.code);
  assert.equal(room?.memberTokens.has("owner"), false, "the revocation stood");
  assert.ok(!events.includes("room_leave_recovered"));
  assert.ok(events.includes("room_persist_failed"));
});

test("a leave answers on its own deadline and the write still reports itself", async () => {
  // Two facts, two lines, and the second one is the effect's. The leave stops
  // waiting on its OWN deadline — `updateRoom`'s CAS is uncapped in the store,
  // so a leave that simply awaited it hung forever on a stalled Redis. After
  // that a late answer reaches nobody through the returned promise, so the
  // effect owns the last word: without it the timeout line would stand as the
  // final statement about a room whose expiry did get scheduled (#266, #277).
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const activeRooms = createActiveRoomRegistry();
  const events: string[] = [];
  let releaseExpiryWrite: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseExpiryWrite = resolve;
  });
  const baseService = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: { ...getDefaultPersistenceConfig(), emptyRoomTtlMs: 5_000 },
    roomStore,
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMEX",
  });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: { ...getDefaultPersistenceConfig(), emptyRoomTtlMs: 5_000 },
    roomStore: {
      ...roomStore,
      async updateRoom(code, expected, patch, options) {
        if (patch.expiresAt === undefined || patch.expiresAt === null) {
          return roomStore.updateRoom(code, expected, patch, options);
        }
        await held;
        return roomStore.updateRoom(code, expected, patch, options);
      },
    },
    activeRooms,
    generateToken: (() => {
      let id = 2;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: ((name) => {
      events.push(name);
    }) satisfies LogEvent,
    now: () => 1_000,
    // The only small one, so a wait built on a sibling's deadline would fail
    // here instead of passing on a value that happens to be small too.
    roomExpiryScheduleConfirmationTimeoutMs: 20,
    roomDeleteConfirmationTimeoutMs: 30_000,
    roomRollbackConfirmationTimeoutMs: 30_000,
  });

  const owner = createSession("owner");
  const created = await baseService.createRoomForSession(owner, "Alice");

  const answered = await settleWithin(
    service.leaveRoomForSession(owner).catch(() => undefined),
    500,
  );
  assert.equal(answered, true, "the leave must not wait on the expiry write");

  // The WAIT ended — said as its own fact, and not as the room's.
  assert.ok(events.includes("room_expiry_schedule_unconfirmed"));
  assert.ok(!events.includes("room_expiry_scheduled"));
  assert.equal((await roomStore.getRoom(created.room.code))?.expiresAt, null);

  // Now the write lands. The effect reports it, long after its caller left.
  releaseExpiryWrite?.();
  await service.close();

  assert.ok(
    events.includes("room_expiry_scheduled"),
    "the effect must report its own outcome after the wait ended",
  );
  assert.equal((await roomStore.getRoom(created.room.code))?.expiresAt, 6_000);
});

test("a late expiry schedule does not land on a room that recycled the code", async () => {
  // A version is not an identity. This effect can reach Redis long after the
  // leave stopped waiting, and a replacement that took the freed code starts at
  // version 0 — exactly the version a leave sees for a room its creator never
  // joined. Pinning the version alone would match it and hand the reaper a room
  // that has members (#277 review).
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const activeRooms = createActiveRoomRegistry();
  let releaseExpiryWrite: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseExpiryWrite = resolve;
  });
  const baseService = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: { ...getDefaultPersistenceConfig(), emptyRoomTtlMs: 5_000 },
    roomStore,
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMRC2",
  });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: { ...getDefaultPersistenceConfig(), emptyRoomTtlMs: 5_000 },
    roomStore: {
      ...roomStore,
      async updateRoom(code, expected, patch, options) {
        if (patch.expiresAt === undefined || patch.expiresAt === null) {
          return roomStore.updateRoom(code, expected, patch, options);
        }
        await held;
        return roomStore.updateRoom(code, expected, patch, options);
      },
    },
    activeRooms,
    generateToken: (() => {
      let id = 2;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    roomExpiryScheduleConfirmationTimeoutMs: 20,
  });

  const owner = createSession("owner");
  const created = await baseService.createRoomForSession(owner, "Alice");
  assert.equal(created.room.version, 0);
  await service.leaveRoomForSession(owner);

  // The room is collected and the code handed out again while the write is
  // still out. The replacement is at version 0, just like the one that left.
  const original = await roomStore.getRoom(created.room.code);
  assert.ok(original);
  await roomStore.deleteRoom(original);
  const replacement = await roomStore.createRoom({
    code: created.room.code,
    joinToken: "replacement-tok",
    createdAt: 2_000,
  });
  assert.equal(replacement.version, created.room.version);

  releaseExpiryWrite?.();
  await service.close();

  const current = await roomStore.getRoom(created.room.code);
  assert.equal(current?.joinToken, "replacement-tok");
  assert.equal(
    current?.expiresAt,
    null,
    "a late expiry write landed on the room that recycled the code",
  );
});

test("a late expiry schedule does not land on a room somebody rejoined", async () => {
  // The interleaving the deadline opens up: the leave stops waiting, and while
  // its write is still out somebody joins and revives the room. The write is
  // pinned to the version this leave judged EMPTY against, so it declines — a
  // retry loop would have read the newer version and written the old expiry
  // over a live room, which the reaper then deletes (#237's hazard, re-entered
  // through the back door) (#277 review).
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const activeRooms = createActiveRoomRegistry();
  let releaseExpiryWrite: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseExpiryWrite = resolve;
  });
  const baseService = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: { ...getDefaultPersistenceConfig(), emptyRoomTtlMs: 5_000 },
    roomStore,
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMRJ",
  });
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: { ...getDefaultPersistenceConfig(), emptyRoomTtlMs: 5_000 },
    roomStore: {
      ...roomStore,
      async updateRoom(code, expected, patch, options) {
        if (patch.expiresAt === undefined || patch.expiresAt === null) {
          return roomStore.updateRoom(code, expected, patch, options);
        }
        await held;
        return roomStore.updateRoom(code, expected, patch, options);
      },
    },
    activeRooms,
    generateToken: (() => {
      let id = 2;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    roomExpiryScheduleConfirmationTimeoutMs: 20,
  });

  const owner = createSession("owner");
  const created = await baseService.createRoomForSession(owner, "Alice");
  await service.leaveRoomForSession(owner);

  // Somebody joins while the expiry write is still out; the join clears the
  // expiry and moves the version.
  const latecomer = createSession("latecomer");
  await baseService.joinRoomForSession(
    latecomer,
    created.room.code,
    created.room.joinToken,
    "Bob",
  );

  releaseExpiryWrite?.();
  await service.close();

  assert.equal(
    (await roomStore.getRoom(created.room.code))?.expiresAt,
    null,
    "a late expiry write landed on a room that had been rejoined",
  );
  assert.equal(activeRooms.getRoom(created.room.code)?.members.size, 1);
});

test("the sweep collects a room that would never expire and has nobody in it", async () => {
  // The shape no reaper could reach: `expiresAt === null` keeps a record out of
  // every expiry sweep, and it is produced whenever a write meant to make a
  // memberless room collectable did not land. Three producers each grew their
  // own cleanup; this pass is what makes those best-effort rather than
  // load-bearing (#277).
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createActiveRoomRegistry();
  const events: string[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: ((name) => {
      events.push(name);
    }) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOMNE",
  });

  // The orphan: a room with no expiry and nobody in it.
  const orphan = await roomStore.createRoom({
    code: "ROOMNE",
    joinToken: "orphan-join-token",
    createdAt: currentTime,
  });
  assert.equal(orphan.expiresAt, null);

  // Inside the grace window it is a race, not evidence: a room is created
  // before its owner is seated, and a join revives one before it seats anybody.
  await service.deleteExpiredRooms(currentTime);
  assert.equal((await roomStore.getRoom("ROOMNE"))?.expiresAt, null);
  assert.ok(!events.includes("room_never_expiring_collected"));

  // Past it, the sweep expires it — and expiring is deliberate: the collection
  // that follows is the ordinary one, with the guards and follow-ups it has.
  currentTime += 10 * 60_000;
  await service.deleteExpiredRooms(currentTime);
  assert.equal((await roomStore.getRoom("ROOMNE"))?.expiresAt, currentTime);
  assert.ok(events.includes("room_never_expiring_collected"));

  // And the next sweep collects it through the ordinary expiry path.
  currentTime += 1;
  await service.deleteExpiredRooms(currentTime);
  assert.equal(await roomStore.getRoom("ROOMNE"), null);
});

test("a failing never-expiring sweep does not strand what the expiry sweep deleted", async () => {
  // The sweep before it is DESTRUCTIVE: those rooms are already gone from
  // Redis, so a throw between the delete and its follow-ups would strand their
  // runtime state, their reclamation count and their `room_deleted` broadcast
  // with nothing able to name them again. The new judgement is secondary and
  // retried every tick, so it runs last and reports its own failure (#277
  // review).
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createInMemoryRuntimeStore(() => currentTime);
  const events: string[] = [];
  const teardowns: string[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: {
      ...roomStore,
      listNeverExpiringRooms: async () => {
        throw new Error("redis unavailable");
      },
    },
    activeRooms: {
      ...activeRooms,
      deleteRoom: async (code: string, expectedGeneration: string | null) => {
        teardowns.push(code);
        return activeRooms.deleteRoom(code, expectedGeneration);
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: ((name) => {
      events.push(name);
    }) satisfies LogEvent,
    now: () => currentTime,
  });

  const doomed = await roomStore.createRoom({
    code: "ROOMDM",
    joinToken: "doomed-join-token",
    createdAt: currentTime,
  });
  await roomStore.updateRoom(doomed.code, doomed.version, {
    expiresAt: currentTime + 1,
  });
  currentTime += 2;

  const counts = await service.deleteExpiredRooms(currentTime);

  // The destructive sweep's own results were consumed before anything else
  // could throw.
  assert.equal(counts.deletedRooms, 1);
  assert.deepEqual(teardowns, ["ROOMDM"]);
  // And the secondary judgement's failure is reported rather than swallowed.
  assert.ok(events.includes("room_persist_failed"));
});

test("the never-expiring cursor advances past a page the bodies filtered out", async () => {
  // The index is a hint, the body is the truth — and a full page that yielded
  // nothing usable is still a full page. A cursor advanced by what survived the
  // filters would reset here and read this same prefix forever, starving every
  // orphan behind it (#277 review).
  const currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createInMemoryRuntimeStore(() => currentTime);
  const offsets: number[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: {
      ...roomStore,
      async listNeverExpiringRooms(limit, offset) {
        offsets.push(offset);
        // A full page the bodies rejected: the index named `limit` codes and
        // none of them turned out to be a candidate.
        return offset === 0
          ? { rooms: [], scanned: limit }
          : await roomStore.listNeverExpiringRooms(limit, offset);
      },
    },
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    neverExpiringSweepChunk: 1,
  });

  await service.deleteExpiredRooms(currentTime);
  await service.deleteExpiredRooms(currentTime);

  assert.deepEqual(offsets, [0, 1], "the cursor reset on a full page");
});

test("the never-expiring sweep rotates so an orphan behind live rooms is reached", async () => {
  // The set holds EVERY room without an expiry, which is every live room. A
  // fixed prefix of it is dominated by rooms that are perfectly fine, so a
  // sweep that never advanced would look at the same healthy rooms forever and
  // the orphan behind them would be starved (#277 review).
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createInMemoryRuntimeStore(() => currentTime);
  const events: string[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: ((name) => {
      events.push(name);
    }) satisfies LogEvent,
    now: () => currentTime,
    neverExpiringSweepChunk: 1,
  });

  // Two rooms without an expiry, in code order. The first is occupied and stays
  // that way; the orphan sits behind it.
  const owner = createSession("owner");
  await activeRooms.registerSession(owner);
  activeRooms.addMember("ROOMAA", "owner", owner, "token-1xxxxxxxxxxx");
  owner.roomCode = "ROOMAA";
  await roomStore.createRoom({
    code: "ROOMAA",
    joinToken: "live-join-token",
    createdAt: currentTime,
  });
  await roomStore.createRoom({
    code: "ROOMBB",
    joinToken: "orphan-join-token",
    createdAt: currentTime,
  });

  currentTime += 10 * 60_000;
  // First tick sees only the live room and must not collect it.
  await service.deleteExpiredRooms(currentTime);
  assert.equal((await roomStore.getRoom("ROOMBB"))?.expiresAt, null);
  // Second tick has advanced past it and reaches the orphan.
  await service.deleteExpiredRooms(currentTime);
  assert.equal((await roomStore.getRoom("ROOMBB"))?.expiresAt, currentTime);
  assert.equal((await roomStore.getRoom("ROOMAA"))?.expiresAt, null);
});

test("the sweep leaves a never-expiring room that still has somebody in it", async () => {
  // Emptiness comes from the cluster session index, which every connection
  // registers. An occupied room legitimately has no expiry, and collecting it
  // would hand the reaper a room with members (#277).
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createInMemoryRuntimeStore(() => currentTime);
  const events: string[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: ((name) => {
      events.push(name);
    }) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOMOC",
  });

  const owner = createSession("owner");
  await activeRooms.registerSession(owner);
  const created = await service.createRoomForSession(owner, "Alice");
  assert.equal(created.room.expiresAt, null);

  currentTime += 10 * 60_000;
  await service.deleteExpiredRooms(currentTime);

  assert.equal((await roomStore.getRoom(created.room.code))?.expiresAt, null);
  assert.ok(!events.includes("room_never_expiring_collected"));
  assert.equal(activeRooms.getRoom(created.room.code)?.members.size, 1);
});

test("a failed empty-room expiry schedule leaves the leave alone", async () => {
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
    async updateRoom(code, expected, patch, options) {
      if (patch.expiresAt !== undefined) {
        throw new Error("expiry write failed");
      }
      return roomStore.updateRoom(code, expected, patch, options);
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

  // The leave stands. What failed is the ROOM's bookkeeping — scheduling the
  // expiry of a room nobody is in — and the member was removed and the session
  // cleared long before that write. Undoing all of it used to put a member back
  // into a room they had successfully left, and left the room body saying
  // "expiring" while it had an occupant again: the one shape neither collect
  // path can judge, because membership lives in the other store (#277).
  await service.leaveRoomForSession(owner);

  assert.equal(owner.roomCode, null);
  assert.equal(owner.memberId, null);
  assert.equal(activeRooms.getRoom(created.room.code), null);
  assert.ok(!events.some((entry) => entry.event === "room_leave_recovered"));

  // Exactly one thing is left wrong, and it is reported: the room may now be a
  // memberless record with no expiry, which no reaper collects.
  const persisted = await roomStore.getRoom(created.room.code);
  assert.equal(persisted?.expiresAt, null);
  assert.ok(
    events.some(
      (entry) =>
        entry.event === "room_leave_orphan_possible" &&
        entry.data.reason === "leave_room_expiry_schedule_failed",
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
    async getRoom(_code: string, _caller?: RoomReadCaller) {
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

  // Driven from the room read that follows the removal, not from the expiry
  // write: a failed expiry schedule no longer reaches the catch at all, because
  // it is not a reason to undo a leave that already happened (#277). The read
  // deletes the room and then fails, so the catch's existence check sees it
  // gone — concurrent deletion, from the recovery's point of view.
  let roomReads = 0;
  const concurrentDeleteRoomStore: RoomStore = {
    ...roomStore,
    async getRoom(code, caller) {
      roomReads += 1;
      if (roomReads === 1) {
        const existing = await roomStore.getRoom(code);
        if (existing) {
          await roomStore.deleteRoom(existing);
        }
        throw new Error("room read failed");
      }
      return roomStore.getRoom(code, caller);
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
  // Driven from the room read that follows the removal: a failed expiry
  // schedule no longer reaches the catch (#277).
  const failingRoomStore: RoomStore = {
    ...roomStore,
    async getRoom() {
      throw new Error("room read failed");
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
    async getRoom(_code: string, _caller?: RoomReadCaller) {
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
  assert.equal((await service.deleteExpiredRooms()).deletedRooms, 1);

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
    isMemberTokenBlocked(code, memberToken, currentTime) {
      return activeRooms.isMemberTokenBlocked(code, memberToken, currentTime);
    },
    tryClaimMessageSlot() {
      return Promise.resolve(true);
    },
    releaseMessageSlot() {
      return Promise.resolve(true);
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
    revokeMemberToken(code, memberId, session) {
      activeRooms.revokeMemberToken(code, memberId, session);
    },
    evictMemberToken(code, memberId, memberToken, blockedUntil) {
      activeRooms.evictMemberToken(code, memberId, memberToken, blockedUntil);
    },
    hasRoomResidue(code) {
      return activeRooms.hasRoomResidue(code);
    },
    getRoomGeneration(code, caller?: RuntimeReadCaller) {
      return activeRooms.getRoomGeneration(code, caller);
    },
    markRoomGeneration(code, generation, expectedPrevious) {
      return activeRooms.markRoomGeneration(code, generation, expectedPrevious);
    },
    deleteRoom(code, expectedGeneration) {
      clusterSessionsByRoom.delete(code);
      return activeRooms.deleteRoom(code, expectedGeneration);
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
      tryClaimMessageSlot: (roomCode, key, token, expiresAt) =>
        shared.tryClaimMessageSlot(roomCode, key, token, expiresAt),
      releaseMessageSlot: (roomCode, key, token) =>
        shared.releaseMessageSlot(roomCode, key, token),
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
    revokeMemberToken: (code, memberId, session) => {
      local.revokeMemberToken(code, memberId, session);
      shared.revokeMemberToken(code, memberId, session);
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
    revokeMemberToken: (code, memberId, session) => {
      local.revokeMemberToken(code, memberId, session);
      shared.revokeMemberToken(code, memberId, session);
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

test("message-slot cleanup failures do not replace playback validation errors", async () => {
  const currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const activeRooms = createActiveRoomRegistry(() => currentTime);
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...activeRooms,
      async releaseMessageSlot() {
        throw new Error("cleanup timed out");
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent(event, data) {
      events.push({ event, data });
    },
    now: () => currentTime,
    createRoomCode: () => "ROOMCL",
  });

  const owner = createSession("owner-cleanup");
  const created = await service.createRoomForSession(owner, "Alice");
  await assert.rejects(
    service.updatePlaybackForSession(
      owner,
      created.memberToken,
      createPlayback(owner.memberId ?? owner.id),
    ),
    (error: unknown) =>
      error instanceof RoomServiceError && error.code === "invalid_message",
  );
  assert.equal(
    events.some(
      (entry) =>
        entry.event === "message_slot_release_failed" &&
        entry.data.slotKind === "playback" &&
        entry.data.error === "cleanup timed out",
    ),
    true,
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

test("a request stops waiting for runtime teardown while its one real effect still converges", async () => {
  const currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const created = await roomStore.createRoom({
    code: "ROOMUC",
    joinToken: "join-token-123456",
    createdAt: 1,
  });
  await roomStore.updateRoom(created.code, created.version, {
    expiresAt: currentTime,
  });

  const activeRooms = createActiveRoomRegistry();
  const ghost = createSession("runtime-teardown-ghost");
  ghost.memberId = "member-runtime-teardown-ghost";
  ghost.memberToken = "token-runtime-teardown-ghost";
  activeRooms.addMember(created.code, ghost.memberId, ghost, ghost.memberToken);

  let releaseDelete!: () => void;
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let deleteCalls = 0;
  let realEffect: Promise<boolean> | null = null;
  const events: string[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...activeRooms,
      deleteRoom(code, expectedGeneration) {
        deleteCalls += 1;
        realEffect = deleteGate.then(() =>
          activeRooms.deleteRoom(code, expectedGeneration),
        );
        return realEffect;
      },
    },
    generateToken: () => "generated-token-123456",
    logEvent: ((event) => events.push(event)) satisfies LogEvent,
    now: () => currentTime,
    runtimeTeardownConfirmationTimeoutMs: 10,
  });

  const request = service.getRoomStateByCode(created.code);
  assert.equal(await settleWithin(request, 200), true);
  assert.equal(await request, null);
  assert.equal(deleteCalls, 1);
  assert.ok(activeRooms.getRoom(created.code));
  assert.ok(events.includes("room_runtime_cleanup_unconfirmed"));

  releaseDelete();
  assert.ok(realEffect);
  await realEffect;
  await Promise.resolve();
  assert.equal(activeRooms.getRoom(created.code), null);
  assert.ok(events.includes("room_runtime_cleanup_late_settled"));

  // The late success retired the debt itself. An empty later sweep must not
  // issue a second teardown merely to discover that the first one landed.
  await service.deleteExpiredRooms();
  assert.equal(deleteCalls, 1);
});

test("a maintenance backlog snapshot cannot recreate a teardown debt settled during its reads", async () => {
  const currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const created = await roomStore.createRoom({
    code: "ROOMUB",
    joinToken: "join-token-123456",
    createdAt: 1,
  });
  await roomStore.updateRoom(created.code, created.version, {
    expiresAt: currentTime,
  });

  const activeRooms = createActiveRoomRegistry();
  const ghost = createSession("runtime-teardown-backlog-ghost");
  ghost.memberId = "member-runtime-teardown-backlog-ghost";
  ghost.memberToken = "token-runtime-teardown-backlog-ghost";
  activeRooms.addMember(created.code, ghost.memberId, ghost, ghost.memberToken);

  let holdMaintenanceGenerationRead = false;
  let markMaintenanceReadStarted!: () => void;
  const maintenanceReadStarted = new Promise<void>((resolve) => {
    markMaintenanceReadStarted = resolve;
  });
  let releaseMaintenanceRead!: () => void;
  const maintenanceReadGate = new Promise<void>((resolve) => {
    releaseMaintenanceRead = resolve;
  });
  let releaseDelete!: () => void;
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let deleteCalls = 0;
  let realEffect: Promise<boolean> | null = null;
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...activeRooms,
      async getRoomGeneration(code, caller) {
        if (holdMaintenanceGenerationRead && caller === "maintenance_pass") {
          holdMaintenanceGenerationRead = false;
          markMaintenanceReadStarted();
          await maintenanceReadGate;
        }
        return activeRooms.getRoomGeneration(code, caller);
      },
      deleteRoom(code, expectedGeneration) {
        deleteCalls += 1;
        realEffect = deleteGate.then(() =>
          activeRooms.deleteRoom(code, expectedGeneration),
        );
        return realEffect;
      },
    },
    generateToken: () => "generated-token-123456",
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    runtimeTeardownConfirmationTimeoutMs: 10,
  });

  assert.equal(await service.getRoomStateByCode(created.code), null);
  assert.equal(deleteCalls, 1);

  // The reaper snapshots the pending debt, then blocks before reading the
  // generation. The original effect settles and retires that exact debt while
  // the maintenance candidate is still carrying its identity.
  holdMaintenanceGenerationRead = true;
  const reaping = service.deleteExpiredRooms();
  await maintenanceReadStarted;
  releaseDelete();
  assert.ok(realEffect);
  await realEffect;
  await Promise.resolve();
  releaseMaintenanceRead();

  assert.deepEqual(await reaping, {
    deletedRooms: 0,
    orphanedIndexEntries: 0,
  });
  assert.equal(deleteCalls, 1);
});

test("request waiters reuse one confirmation cap for the same runtime teardown effect", async () => {
  const currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const created = await roomStore.createRoom({
    code: "ROOMUD",
    joinToken: "join-token-123456",
    createdAt: 1,
  });
  await roomStore.updateRoom(created.code, created.version, {
    expiresAt: currentTime,
  });

  const activeRooms = createActiveRoomRegistry();
  let releaseDelete!: () => void;
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let deleteCalls = 0;
  let realEffect: Promise<boolean> | null = null;
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...activeRooms,
      deleteRoom(code, expectedGeneration) {
        deleteCalls += 1;
        realEffect = deleteGate.then(() =>
          activeRooms.deleteRoom(code, expectedGeneration),
        );
        return realEffect;
      },
    },
    generateToken: () => "generated-token-123456",
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    runtimeTeardownConfirmationTimeoutMs: 40,
  });

  assert.equal(await service.getRoomStateByCode(created.code), null);

  // The exact effect is already known to be unconfirmed. A new waiter shares
  // that settled confirmation instead of creating another timer and another
  // tracked promise which would live as long as the unanswered Redis command.
  const repeatedWait = service.teardownRoomRuntime(created.code);
  assert.equal(await settleWithin(repeatedWait, 10), true);
  await repeatedWait;
  assert.equal(deleteCalls, 1);

  releaseDelete();
  assert.ok(realEffect);
  await realEffect;
  await service.deleteExpiredRooms();
  assert.equal(deleteCalls, 1);
});

async function assertStaleTeardownWaiterCannotRetakeDebt(
  settleOldEffectBeforeWaiter: boolean,
): Promise<void> {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const runtime = createInMemoryRuntimeStore(() => currentTime, 5_000);
  let holdNextMissingRoomRead = false;
  let markStaleRoomReadStarted!: () => void;
  const staleRoomReadStarted = new Promise<void>((resolve) => {
    markStaleRoomReadStarted = resolve;
  });
  let releaseStaleRoomRead!: () => void;
  const staleRoomReadGate = new Promise<void>((resolve) => {
    releaseStaleRoomRead = resolve;
  });
  const serviceRoomStore: typeof roomStore = {
    ...roomStore,
    async getRoom(code, caller) {
      const snapshot = await roomStore.getRoom(code, caller);
      if (holdNextMissingRoomRead && snapshot === null) {
        holdNextMissingRoomRead = false;
        markStaleRoomReadStarted();
        await staleRoomReadGate;
      }
      return snapshot;
    },
  };
  let releaseFirstDelete!: () => void;
  const firstDeleteGate = new Promise<void>((resolve) => {
    releaseFirstDelete = resolve;
  });
  const deleteGenerations: Array<string | null> = [];
  let firstDeleteEffect: Promise<boolean> | null = null;
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: {
      ...getDefaultPersistenceConfig(),
      emptyRoomTtlMs: 1_000,
    },
    roomStore: serviceRoomStore,
    activeRooms: {
      ...runtime,
      deleteRoom(code, expectedGeneration) {
        deleteGenerations.push(expectedGeneration);
        if (deleteGenerations.length === 1) {
          firstDeleteEffect = firstDeleteGate.then(() =>
            runtime.deleteRoom(code, expectedGeneration),
          );
          return firstDeleteEffect;
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
    createRoomCode: () => "ROOMUG",
    resolveActiveRoom: async (code) => runtime.getRoom(code),
    runtimeTeardownConfirmationTimeoutMs: 10,
  });

  const first = createSession("first-generation-owner");
  const firstRoom = await service.createRoomForSession(first, "Alice");
  await service.leaveRoomForSession(first, "disconnect");
  currentTime += 1_001;
  assert.equal(await service.getRoomStateByCode(firstRoom.room.code), null);
  assert.equal(deleteGenerations.length, 1);

  // This waiter pins the old generation and captures the absent room, then
  // pauses across the room-read await while a new generation takes the code.
  holdNextMissingRoomRead = true;
  const staleWaiter = service.teardownRoomRuntime(firstRoom.room.code);
  await staleRoomReadStarted;

  // The old identity ages out, so allocation may reuse the code even though
  // its guarded teardown command is still unanswered.
  currentTime += 5_001;
  const second = createSession("second-generation-owner");
  const secondRoom = await service.createRoomForSession(second, "Bob");
  assert.equal(secondRoom.room.code, firstRoom.room.code);
  await roomStore.deleteRoom(secondRoom.room);

  // Cleanup for the new generation is a distinct effect. Keying only by code
  // reused the old promise here, returned unconfirmed, and stranded the new
  // room's runtime state until some unrelated future teardown happened.
  await service.teardownRoomRuntime(secondRoom.room.code);
  assert.equal(deleteGenerations.length, 2);
  assert.notEqual(deleteGenerations[0], deleteGenerations[1]);
  assert.equal(runtime.getRoom(secondRoom.room.code), null);

  if (settleOldEffectBeforeWaiter) {
    // Once the old effect is gone, the stale waiter must not create a new copy
    // of it and take the newer generation's already-satisfied debt.
    releaseFirstDelete();
    assert.ok(firstDeleteEffect);
    await firstDeleteEffect;
    releaseStaleRoomRead();
    await staleWaiter;
  } else {
    // While the old effect remains, the stale waiter may reuse its promise but
    // must not transfer the retry debt back from the newer generation.
    releaseStaleRoomRead();
    await staleWaiter;
    releaseFirstDelete();
    assert.ok(firstDeleteEffect);
    await firstDeleteEffect;
  }

  // The new generation's successful effect owned and satisfied the retry
  // debt. The older generation now settles as skipped; it must not retain that
  // debt merely because it happened to finish last.
  await service.deleteExpiredRooms();
  assert.equal(deleteGenerations.length, 2);
}

test("a stale waiter cannot retake debt by reusing an old generation effect", async () => {
  await assertStaleTeardownWaiterCannotRetakeDebt(false);
});

test("a stale waiter cannot retake debt by recreating an old generation effect", async () => {
  await assertStaleTeardownWaiterCannotRetakeDebt(true);
});

test("a late runtime teardown failure stays on the retry trail", async () => {
  const currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const created = await roomStore.createRoom({
    code: "ROOMUF",
    joinToken: "join-token-123456",
    createdAt: 1,
  });
  await roomStore.updateRoom(created.code, created.version, {
    expiresAt: currentTime,
  });

  const activeRooms = createActiveRoomRegistry();
  const ghost = createSession("runtime-teardown-failure");
  ghost.memberId = "member-runtime-teardown-failure";
  ghost.memberToken = "token-runtime-teardown-failure";
  activeRooms.addMember(created.code, ghost.memberId, ghost, ghost.memberToken);

  let rejectDelete!: (error: Error) => void;
  const firstDelete = new Promise<boolean>((_resolve, reject) => {
    rejectDelete = reject;
  });
  let deleteCalls = 0;
  const events: string[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...activeRooms,
      deleteRoom(code, expectedGeneration) {
        deleteCalls += 1;
        if (deleteCalls === 1) {
          return firstDelete;
        }
        return activeRooms.deleteRoom(code, expectedGeneration);
      },
    },
    generateToken: () => "generated-token-123456",
    logEvent: ((event) => events.push(event)) satisfies LogEvent,
    now: () => currentTime,
    runtimeTeardownConfirmationTimeoutMs: 10,
  });

  const request = service.getRoomStateByCode(created.code);
  assert.equal(await settleWithin(request, 200), true);
  assert.equal(await request, null);
  assert.equal(deleteCalls, 1);

  rejectDelete(new Error("redis unavailable after deadline"));
  await assert.rejects(firstDelete, /redis unavailable after deadline/);
  await Promise.resolve();
  assert.ok(events.includes("room_runtime_cleanup_late_failed"));

  await service.deleteExpiredRooms();
  assert.equal(deleteCalls, 2);
  assert.equal(activeRooms.getRoom(created.code), null);
});

test("a maintenance pass keeps waiting for the real runtime teardown effect", async () => {
  const currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const created = await roomStore.createRoom({
    code: "ROOMUM",
    joinToken: "join-token-123456",
    createdAt: 1,
  });
  await roomStore.updateRoom(created.code, created.version, {
    expiresAt: currentTime,
  });

  const activeRooms = createActiveRoomRegistry();
  let releaseDelete!: () => void;
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let deleteCalls = 0;
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...activeRooms,
      deleteRoom(code, expectedGeneration) {
        deleteCalls += 1;
        return deleteGate.then(() =>
          activeRooms.deleteRoom(code, expectedGeneration),
        );
      },
    },
    generateToken: () => "generated-token-123456",
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    runtimeTeardownConfirmationTimeoutMs: 10,
  });

  const reaping = service.deleteExpiredRooms();
  assert.equal(await settleWithin(reaping, 50), false);
  assert.equal(deleteCalls, 1);

  releaseDelete();
  assert.deepEqual(await reaping, {
    deletedRooms: 1,
    orphanedIndexEntries: 0,
  });
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
      deleteRoom: async (code: string, expectedGeneration: string | null) => {
        if (code === "ROOMF1") {
          failedFor.push(code);
          throw new Error("redis unavailable");
        }
        return activeRooms.deleteRoom(code, expectedGeneration);
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
  assert.equal((await service.deleteExpiredRooms()).deletedRooms, 2);
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
      deleteRoom: async (code: string, expectedGeneration: string | null) => {
        if (failTeardown) {
          throw new Error("redis unavailable");
        }
        teardowns.push(code);
        return activeRooms.deleteRoom(code, expectedGeneration);
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
  assert.equal((await service.deleteExpiredRooms()).deletedRooms, 1);
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
  assert.equal((await service.deleteExpiredRooms()).deletedRooms, 0);
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
      deleteRoom: async (code: string, expectedGeneration: string | null) => {
        if (failTeardown) {
          throw new Error("redis unavailable");
        }
        return activeRooms.deleteRoom(code, expectedGeneration);
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
      getRoom: async (code: string, caller?: RoomReadCaller) => {
        if (failRoomRead) {
          throw new Error("redis unavailable");
        }
        return roomStore.getRoom(code, caller);
      },
    },
    activeRooms: {
      ...activeRooms,
      deleteRoom: async (code: string, expectedGeneration: string | null) => {
        if (failTeardown) {
          throw new Error("redis unavailable");
        }
        teardowns.push(code);
        return activeRooms.deleteRoom(code, expectedGeneration);
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
      deleteRoom: async (code: string, expectedGeneration: string | null) => {
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
      getRoom: async (code: string, caller?: RoomReadCaller) => {
        const room = await roomStore.getRoom(code, caller);
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

test("rolls the room back when its generation stamp lost the code", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const runtime = createInMemoryRuntimeStore(() => 1_000);
  const events: { name: string; reason?: unknown }[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...runtime,
      async getRoomGeneration(code, caller) {
        const pinned = await runtime.getRoomGeneration(code, caller);
        // Between this creator's pin and its stamp, the teardown still owed for
        // the code's PREVIOUS occupant lands and tombstones the key. The stamp
        // that follows is therefore holding a value that no longer describes
        // the key — the same shape as a stamp arriving after its caller stopped
        // waiting, which is why the write has to be conditional (#277).
        await runtime.markRoomGeneration(code, "deleted", pinned);
        return pinned;
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: ((name, payload) => {
      events.push({
        name,
        reason: (payload as { reason?: unknown } | undefined)?.reason,
      });
    }) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMSU",
    resolveActiveRoom: async (code) => runtime.getRoom(code),
  });

  await assert.rejects(
    service.createRoomForSession(createSession("owner"), "Alice"),
    /internal server error/i,
  );

  // A stamp that did not land leaves the same memberless, never-expiring room
  // behind as a stamp that threw, so it takes the same rollback.
  assert.equal((await roomStore.getRoom("ROOMSU"))?.expiresAt, 1_000);
  assert.equal(await roomStore.countRooms({ includeExpired: false }), 0);
  // Reported as what it is: nothing failed, the code was taken.
  assert.ok(
    events.some(
      (event) =>
        event.name === "room_persist_failed" &&
        event.reason === "room_generation_superseded",
    ),
  );
  // And the value the winner wrote is untouched.
  assert.equal(runtime.getRoomGeneration("ROOMSU"), "deleted");
});

test("rolls an unstamped room back over a concurrent update of the same record", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const runtime = createInMemoryRuntimeStore(() => 1_000);
  const events: string[] = [];
  let raced = false;
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: {
      ...roomStore,
      async updateRoom(code, expected, patch, options) {
        if (!raced) {
          raced = true;
          // An admin touches the still-memberless room between our create and
          // our rollback. The version we are holding is now stale — a conflict
          // that says nothing about whether our room is still there.
          const current = await roomStore.getRoom(code);
          assert.ok(current);
          await roomStore.updateRoom(code, current.version, {
            lastActiveAt: 2_000,
          });
        }
        return await roomStore.updateRoom(code, expected, patch, options);
      },
    },
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
    logEvent: ((name) => {
      events.push(name);
    }) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMCF",
    resolveActiveRoom: async (code) => runtime.getRoom(code),
  });

  await assert.rejects(
    service.createRoomForSession(createSession("owner"), "Alice"),
    /internal server error/i,
  );

  // Treating the conflict as "somebody else owns this code now" left the room
  // behind: same record, still memberless, still never expiring.
  assert.equal((await roomStore.getRoom("ROOMCF"))?.expiresAt, 1_000);
  assert.ok(!events.includes("room_rollback_failed"));
});

test("reports the residue when the rollback keeps losing the version race", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const runtime = createInMemoryRuntimeStore(() => 1_000);
  const events: string[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: {
      ...roomStore,
      // A writer that never lets go: every rollback attempt loses to it.
      async updateRoom() {
        return { ok: false, reason: "version_conflict" };
      },
    },
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
    logEvent: ((name) => {
      events.push(name);
    }) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMCX",
    resolveActiveRoom: async (code) => runtime.getRoom(code),
  });

  await assert.rejects(
    service.createRoomForSession(createSession("owner"), "Alice"),
    /internal server error/i,
  );

  // Bounded, so the request still ends — and the room it could not expire is
  // named, because nothing else will ever collect it.
  assert.equal((await roomStore.getRoom("ROOMCX"))?.expiresAt, null);
  assert.ok(events.includes("room_rollback_failed"));
});

test("does not report a rollback whose room was replaced on the last attempt", async () => {
  // Giving up is a report, and a report about a room that has since been
  // replaced is a false alarm. The rollback no longer re-reads to find that
  // out: pinned by INSTANCE, the store answers `not_found` for a code that
  // changed hands — including on the attempt that would otherwise have been
  // the last (#277 review).
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const runtime = createInMemoryRuntimeStore(() => 1_000);
  const events: string[] = [];
  let attempts = 0;
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: {
      ...roomStore,
      async updateRoom() {
        attempts += 1;
        return attempts < 3
          ? { ok: false, reason: "version_conflict" }
          : { ok: false, reason: "not_found" };
      },
    },
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
    logEvent: ((name) => {
      events.push(name);
    }) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMLR",
    resolveActiveRoom: async (code) => runtime.getRoom(code),
  });

  await assert.rejects(
    service.createRoomForSession(createSession("owner"), "Alice"),
    /internal server error/i,
  );

  assert.equal(attempts, 3);
  assert.ok(!events.includes("room_rollback_failed"));
});

test("reports the residue when the rollback of an unstamped room fails", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const runtime = createInMemoryRuntimeStore(() => 1_000);
  const events: { name: string; roomCode?: unknown }[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: {
      ...roomStore,
      async updateRoom() {
        throw new Error("redis unavailable");
      },
    },
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
    logEvent: ((name, payload) => {
      events.push({
        name,
        roomCode: (payload as { roomCode?: unknown } | undefined)?.roomCode,
      });
    }) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMRF",
    resolveActiveRoom: async (code) => runtime.getRoom(code),
  });

  await assert.rejects(
    service.createRoomForSession(createSession("owner"), "Alice"),
    /internal server error/i,
  );

  // The room is still there, memberless and with no `expiresAt`: the reaper
  // never collects that, so the code and the room total are held until somebody
  // acts on it. Which nobody could, while this failure was swallowed.
  const orphan = await roomStore.getRoom("ROOMRF");
  assert.equal(orphan?.expiresAt, null);
  assert.ok(
    events.some(
      (event) =>
        event.name === "room_rollback_failed" && event.roomCode === "ROOMRF",
    ),
  );
});

test("expires the room a capped create may have built", async () => {
  // `createRoom`'s guard pins EXISTENCE, not identity, so unlike the CAS and
  // the two guarded deletes its late landing is not a no-op: it builds the
  // memberless, never-expiring room the reaper cannot collect. That is why the
  // cap is paid for HERE — the creator is the one caller, and it owns the
  // compensation (#277). Modelled as the write landing and the reply not.
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const runtime = createInMemoryRuntimeStore(() => 1_000);
  const events: { name: string; reason?: unknown }[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: {
      ...roomStore,
      async createRoom(input) {
        const created = await roomStore.createRoom(input);
        throw new RedisStoreUnavailableError(
          "room",
          "create_room",
          "timeout",
          `Redis room store command "create_room" went unanswered. (${created.code})`,
        );
      },
    },
    activeRooms: runtime,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: ((name, payload) => {
      events.push({
        name,
        reason: (payload as { reason?: unknown } | undefined)?.reason,
      });
    }) satisfies LogEvent,
    now: () => 1_000,
    // Distinct per attempt: a loop that kept trying other codes would leave one
    // orphan per attempt, which is what the room count below is for.
    createRoomCode: (() => {
      let id = 0;
      return () => `ROOMT${++id}`;
    })(),
    resolveActiveRoom: async (code) => runtime.getRoom(code),
  });

  await assert.rejects(
    service.createRoomForSession(createSession("owner"), "Alice"),
    /internal server error/i,
  );

  assert.equal((await roomStore.getRoom("ROOMT1"))?.expiresAt, 1_000);
  assert.equal(await roomStore.countRooms({ includeExpired: false }), 0);
  // And it stops on the first one. Another code cannot help a store that is
  // not answering, and each further attempt would leave another orphan.
  assert.equal(await roomStore.countRooms({ includeExpired: true }), 1);
  assert.ok(
    events.some(
      (event) =>
        event.name === "room_persist_failed" &&
        event.reason === "room_create_unconfirmed",
    ),
  );
  assert.ok(!events.some((event) => event.name === "room_rollback_failed"));
});

test("answers the creator when its orphan rollback goes unconfirmed", async () => {
  // The cap on `createRoom` buys nothing if the compensation can hang instead:
  // the rollback's write half is `updateRoom`'s CAS, which the store leaves
  // uncapped on purpose. So the request bounds its WAIT and the rollback keeps
  // going (#277 review).
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const runtime = createInMemoryRuntimeStore(() => 1_000);
  const events: { name: string; roomCode?: unknown }[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: {
      ...roomStore,
      async createRoom(input) {
        await roomStore.createRoom(input);
        throw new RedisStoreUnavailableError(
          "room",
          "create_room",
          "timeout",
          "Redis room store command went unanswered.",
        );
      },
      // The CAS that never comes back.
      updateRoom: () => new Promise(() => undefined),
    },
    activeRooms: runtime,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: ((name, payload) => {
      events.push({
        name,
        roomCode: (payload as { roomCode?: unknown } | undefined)?.roomCode,
      });
    }) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMUC",
    resolveActiveRoom: async (code) => runtime.getRoom(code),
    // Deliberately the only small one. Its two siblings are set far apart so a
    // wait built on either of them would fail this test instead of passing on
    // a value that happens to be small too (#277 review).
    roomRollbackConfirmationTimeoutMs: 20,
    roomDeleteConfirmationTimeoutMs: 30_000,
    runtimeTeardownConfirmationTimeoutMs: 30_000,
  });

  const answered = await settleWithin(
    service
      .createRoomForSession(createSession("owner"), "Alice")
      .catch(() => undefined),
    500,
  );
  assert.equal(answered, true, "the creator must not wait on the rollback");
  assert.ok(
    events.some(
      (event) =>
        event.name === "room_rollback_unconfirmed" &&
        event.roomCode === "ROOMUC",
    ),
  );
  // Reported, not silently converted into success: the room is still there and
  // the rollback that may yet expire it is still out.
  assert.equal((await roomStore.getRoom("ROOMUC"))?.expiresAt, null);

  // The other direction, so the assertion above cannot pass on any short wait:
  // with only the rollback constant made long, the creator must still be
  // waiting.
  const patientRoomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const patient = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: {
      ...patientRoomStore,
      async createRoom(input) {
        await patientRoomStore.createRoom(input);
        throw new RedisStoreUnavailableError(
          "room",
          "create_room",
          "timeout",
          "Redis room store command went unanswered.",
        );
      },
      updateRoom: () => new Promise(() => undefined),
    },
    activeRooms: createInMemoryRuntimeStore(() => 1_000),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMPT",
    roomRollbackConfirmationTimeoutMs: 30_000,
    roomDeleteConfirmationTimeoutMs: 1,
    runtimeTeardownConfirmationTimeoutMs: 1,
    closeBudgetMs: 1,
  });
  assert.equal(
    await settleWithin(
      patient
        .createRoomForSession(createSession("owner"), "Alice")
        .catch(() => undefined),
      200,
    ),
    false,
    "the creator's wait must be the rollback's constant, not a sibling's",
  );
  await patient.close();
});

test("refuses an orphan rollback admitted after the shutdown snapshot", async () => {
  // A session handler may keep running past the drain timeout, so a create can
  // still be in flight when `close()` returns. An effect admitted then is one
  // nobody waits for and nobody reports — refused for the same reason a lazy
  // delete is, and said out loud instead (#277 review).
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const events: { name: string; error?: unknown }[] = [];
  let releaseCreate: (() => void) | undefined;
  const createHeld = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  let rollbackAttempts = 0;
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: {
      ...roomStore,
      async createRoom(input) {
        await roomStore.createRoom(input);
        await createHeld;
        throw new RedisStoreUnavailableError(
          "room",
          "create_room",
          "timeout",
          "Redis room store command went unanswered.",
        );
      },
      async updateRoom(code, expectedVersion, patch, options) {
        rollbackAttempts += 1;
        return await roomStore.updateRoom(
          code,
          expectedVersion,
          patch,
          options,
        );
      },
    },
    activeRooms: createInMemoryRuntimeStore(() => 1_000),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: ((name, payload) => {
      events.push({
        name,
        error: (payload as { error?: unknown } | undefined)?.error,
      });
    }) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: () => "ROOMSC",
    roomRollbackConfirmationTimeoutMs: 5,
    closeBudgetMs: 5,
  });

  const creating = service
    .createRoomForSession(createSession("owner"), "Alice")
    .catch(() => undefined);
  await service.close();
  releaseCreate?.();
  await creating;

  assert.equal(rollbackAttempts, 0);
  assert.ok(
    events.some(
      (event) =>
        event.name === "room_rollback_failed" &&
        event.error === "service_closing",
    ),
  );
});

test("waits for an orphan rollback that lands inside the close budget", async () => {
  // The half a "still pending" assertion cannot make: with no drain, `close()`
  // returns before the effect lands and the count is still 1 either way. Here
  // the rollback is slower than the REQUEST's cap but well inside the shutdown
  // budget, so only a close that actually waits sees it land (#277 review).
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const closeEvents: Array<Record<string, unknown>> = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: {
      ...roomStore,
      async createRoom(input) {
        await roomStore.createRoom(input);
        throw new RedisStoreUnavailableError(
          "room",
          "create_room",
          "timeout",
          "Redis room store command went unanswered.",
        );
      },
      async updateRoom(code, expected, patch, options) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return await roomStore.updateRoom(code, expected, patch, options);
      },
    },
    activeRooms: createInMemoryRuntimeStore(() => 1_000),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (event, data) => {
      if (event === "room_service_close_unfinished") {
        closeEvents.push(data);
      }
    },
    now: () => 1_000,
    createRoomCode: () => "ROOMDR",
    roomRollbackConfirmationTimeoutMs: 1,
    closeBudgetMs: 2_000,
  });

  await assert.rejects(
    service.createRoomForSession(createSession("owner"), "Alice"),
  );
  // The creator already gave up on it; the effect is still out.
  assert.equal((await roomStore.getRoom("ROOMDR"))?.expiresAt, null);

  await service.close();

  assert.equal((await roomStore.getRoom("ROOMDR"))?.expiresAt, 1_000);
  assert.deepEqual(closeEvents, []);
});

test("reports an orphan rollback still out when the service closes", async () => {
  // An effect that outlived its request owes the shutdown boundary a report,
  // like the delete chain and the runtime teardowns beside it (#277).
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const closeEvents: Array<Record<string, unknown>> = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: {
      ...roomStore,
      async createRoom(input) {
        await roomStore.createRoom(input);
        throw new RedisStoreUnavailableError(
          "room",
          "create_room",
          "timeout",
          "Redis room store command went unanswered.",
        );
      },
      updateRoom: () => new Promise(() => undefined),
    },
    activeRooms: createInMemoryRuntimeStore(() => 1_000),
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (event, data) => {
      if (event === "room_service_close_unfinished") {
        closeEvents.push(data);
      }
    },
    now: () => 1_000,
    createRoomCode: () => "ROOMCL",
    roomRollbackConfirmationTimeoutMs: 5,
    closeBudgetMs: 5,
  });

  await assert.rejects(
    service.createRoomForSession(createSession("owner"), "Alice"),
  );
  await service.close();

  assert.equal(closeEvents.length, 1);
  assert.equal(closeEvents[0]?.pendingRoomRollbacks, 1);
});

test("does not roll back a create that admission refused before issuing it", async () => {
  // The one answer on this connection that cannot mean "it may have landed
  // later": admission refuses BEFORE the command is issued. There is no room
  // to expire, so a rollback here would only be a write nobody needs — and its
  // own failure would be reported as a residue that never existed.
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const runtime = createInMemoryRuntimeStore(() => 1_000);
  const events: { name: string; reason?: unknown }[] = [];
  let updateRoomCalls = 0;
  let createRoomCalls = 0;
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: {
      ...roomStore,
      async createRoom() {
        createRoomCalls += 1;
        throw new RedisStoreUnavailableError(
          "room",
          "create_room",
          "admission",
          "Redis room store refused create_room.",
        );
      },
      async updateRoom(code, expected, patch, options) {
        updateRoomCalls += 1;
        return await roomStore.updateRoom(code, expected, patch, options);
      },
    },
    activeRooms: runtime,
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: ((name, payload) => {
      events.push({
        name,
        reason: (payload as { reason?: unknown } | undefined)?.reason,
      });
    }) satisfies LogEvent,
    now: () => 1_000,
    createRoomCode: (() => {
      let id = 0;
      return () => `ROOMA${++id}`;
    })(),
    resolveActiveRoom: async (code) => runtime.getRoom(code),
  });

  await assert.rejects(
    service.createRoomForSession(createSession("owner"), "Alice"),
    /internal server error/i,
  );

  assert.equal(updateRoomCalls, 0);
  // And it stops on the first refusal, like the timeout above: a store that is
  // refusing will refuse the next code too.
  assert.equal(createRoomCalls, 1);
  assert.equal(await roomStore.countRooms({ includeExpired: true }), 0);
  assert.ok(
    events.some(
      (event) =>
        event.name === "room_persist_failed" &&
        event.reason === "room_create_unconfirmed",
    ),
  );
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
        const stale = await roomStore.getRoom("ROOMRC");
        if (stale) {
          await roomStore.deleteRoom(stale);
        }
        await roomStore.createRoom({
          code: "ROOMRC",
          joinToken: "replacement-token",
          ownerMemberId: "other-owner",
          ownerDisplayName: "Bob",
          createdAt: 2_000,
        });
        // Left at version 0, which is the case that matters: this test used to
        // bump it first, and a version-only guard passes only because of that
        // bump — every new room starts at 0, so a rollback holding version 0
        // matches a replacement exactly (#277 review).
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
      deleteRoom: async (code: string, expectedGeneration: string | null) => {
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
  await roomStore.deleteRoom(owed.room);
  // An admin close whose teardown failed: the debt is queued.
  await service.teardownRoomRuntime(owed.room.code);
  assert.deepEqual(teardowns, []);

  const second = createSession("second-owner");
  const other = await service.createRoomForSession(second, "Bob");
  await roomStore.deleteRoom(other.room);

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

test("room service meters a reaper sweep by rooms, not by sweeps", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const reclaimed: number[] = [];
  const codes = ["ROOM01", "ROOM02"];
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
    metricsCollector: {
      recordRoomsExpiredDeleted: (roomCount) => reclaimed.push(roomCount),
    },
    now: () => currentTime,
    createRoomCode: () => codes.shift() ?? "ROOM99",
  });

  for (const id of ["owner-1", "owner-2"]) {
    const owner = createSession(id);
    await service.createRoomForSession(owner, "Alice");
    await service.leaveRoomForSession(owner);
  }

  currentTime = 7_000;
  assert.equal((await service.deleteExpiredRooms()).deletedRooms, 2);

  // One sweep, two rooms. The reaper's log event fires once here, which is why
  // counting it cannot be compared against room creations.
  assert.deepEqual(reclaimed, [2]);
});

test("room service meters a room reclaimed by the lazy read path", async () => {
  let currentTime = 1_000;
  const roomStore = createInMemoryRoomStore({ now: () => currentTime });
  const reclaimed: number[] = [];
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
    metricsCollector: {
      recordRoomsExpiredDeleted: (roomCount) => reclaimed.push(roomCount),
    },
    now: () => currentTime,
    createRoomCode: () => "ROOM01",
  });

  const owner = createSession("owner");
  const { room } = await service.createRoomForSession(owner, "Alice");
  await service.leaveRoomForSession(owner);

  // Someone comes back after the TTL but before the next sweep: the read
  // deletes the room itself, and the reaper never sees that code again.
  currentTime = 7_000;
  await assert.rejects(
    service.joinRoomForSession(
      createSession("latecomer"),
      room.code,
      room.joinToken,
      "Bob",
    ),
  );

  assert.equal(await roomStore.getRoom(room.code), null);
  assert.deepEqual(reclaimed, [1]);
  // The sweep that follows must not count the same room a second time.
  assert.equal((await service.deleteExpiredRooms()).deletedRooms, 0);
  assert.deepEqual(reclaimed, [1, 0]);
});

test("a capped expiry collection still finishes what it started", async () => {
  let currentTime = 1_000;
  const baseRoomStore = createInMemoryRoomStore({ now: () => currentTime });
  const runtime = createInMemoryRuntimeStore(() => currentTime);
  const reclaimed: number[] = [];
  const teardowns: string[] = [];
  let releaseDelete!: () => void;
  let markTeardownStarted!: () => void;
  let releaseTeardown!: () => void;
  const deleteLanded = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  const teardownStarted = new Promise<void>((resolve) => {
    markTeardownStarted = resolve;
  });
  const teardownLanded = new Promise<void>((resolve) => {
    releaseTeardown = resolve;
  });
  const roomStore: RoomStore = {
    ...baseRoomStore,
    async deleteExpiredRoom(code, deleteTime) {
      // Slower than the reader's deadline: the reader stops waiting, the
      // command does not stop running.
      await deleteLanded;
      return await baseRoomStore.deleteExpiredRoom(code, deleteTime);
    },
  };
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: {
      ...getDefaultPersistenceConfig(),
      emptyRoomTtlMs: 5_000,
    },
    roomStore,
    activeRooms: {
      ...runtime,
      async deleteRoom(code, expectedGeneration) {
        teardowns.push(code);
        markTeardownStarted();
        await teardownLanded;
        return runtime.deleteRoom(code, expectedGeneration);
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    metricsCollector: {
      recordRoomsExpiredDeleted: (roomCount) => reclaimed.push(roomCount),
    },
    now: () => currentTime,
    createRoomCode: () => "ROOMDB",
    resolveActiveRoom: async (code) => runtime.getRoom(code),
    roomDeleteConfirmationTimeoutMs: 20,
    closeBudgetMs: 1_000,
  });

  const owner = createSession("owner");
  const { room } = await service.createRoomForSession(owner, "Alice");
  await service.leaveRoomForSession(owner);
  currentTime += 5_001;

  // The reader's wait ends, but the real outcome could still be `superseded`.
  // Preserve that third state instead of claiming the room is absent.
  await assert.rejects(
    () => service.getRoomStateByCode(room.code),
    (error: unknown) =>
      error instanceof RoomServiceError &&
      // `internal_error` on the wire, the unconfirmed diagnosis in the details:
      // this state is deliberately not a protocol code (#277).
      error.code === "internal_error" &&
      error.reason === "room_resolution_unconfirmed" &&
      error.details.reason === "room_expiry_resolution_unconfirmed" &&
      error.details.trigger === "delete_timeout",
  );
  assert.deepEqual(teardowns, []);
  assert.deepEqual(reclaimed, []);

  // Shutdown drains the outer delete first, then takes a fresh snapshot of the
  // runtime teardown it creates. Taking both snapshots at close entry would
  // miss this nested effect and close Redis under it.
  let serviceClosed = false;
  const closingService = service.close().then(() => {
    serviceClosed = true;
  });
  releaseDelete();
  await teardownStarted;
  assert.equal(serviceClosed, false);
  assert.deepEqual(reclaimed, [1]);
  assert.deepEqual(teardowns, [room.code]);
  releaseTeardown();
  await closingService;
  assert.equal(serviceClosed, true);
  assert.equal(await roomStore.getRoom(room.code), null);
});

test("an unconfirmed expiry delete preserves a joined session when its late outcome is superseded", async () => {
  let currentTime = 1_000;
  const baseRoomStore = createInMemoryRoomStore({ now: () => currentTime });
  const runtime = createInMemoryRuntimeStore(() => currentTime);
  let markDeleteStarted!: () => void;
  let releaseDelete!: () => void;
  let deleteCalls = 0;
  const deleteStarted = new Promise<void>((resolve) => {
    markDeleteStarted = resolve;
  });
  const deleteLanded = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  const roomStore: RoomStore = {
    ...baseRoomStore,
    async deleteExpiredRoom(code, deleteTime) {
      deleteCalls += 1;
      markDeleteStarted();
      await deleteLanded;
      // Another node confirms the room is live before the guarded delete runs.
      // The real outcome is therefore `superseded`, not absence.
      const current = await baseRoomStore.getRoom(code);
      assert.ok(current);
      const revived = await baseRoomStore.updateRoom(code, current.version, {
        expiresAt: null,
        lastActiveAt: deleteTime,
      });
      assert.equal(revived.ok, true);
      return await baseRoomStore.deleteExpiredRoom(code, deleteTime);
    },
  };
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: runtime,
    generateToken: () => "token-1234567890",
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOMUS",
    roomDeleteConfirmationTimeoutMs: 5,
    closeBudgetMs: 1_000,
  });

  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");
  const ownerMemberId = owner.memberId;
  assert.ok(ownerMemberId);
  const current = await baseRoomStore.getRoom(created.room.code);
  assert.ok(current);
  const expired = await baseRoomStore.updateRoom(
    current.code,
    current.version,
    { expiresAt: currentTime },
  );
  assert.equal(expired.ok, true);
  currentTime += 1;

  const read = service.getRoomStateForSession(
    owner,
    created.memberToken,
    "sync:request",
  );
  await deleteStarted;
  await assert.rejects(
    () => read,
    (error: unknown) =>
      error instanceof RoomServiceError &&
      // `internal_error` on the wire, the unconfirmed diagnosis in the details:
      // this state is deliberately not a protocol code (#277).
      error.code === "internal_error" &&
      error.reason === "room_resolution_unconfirmed" &&
      error.details.reason === "room_expiry_resolution_unconfirmed" &&
      error.details.trigger === "delete_timeout",
  );

  // A retryable resolution failure must not revoke the still-valid local and
  // shared membership while the real delete is unresolved.
  assert.equal(owner.roomCode, created.room.code);
  assert.equal(owner.memberId, created.room.ownerMemberId);
  assert.equal(owner.memberToken, created.memberToken);
  assert.equal(
    runtime.getRoom(created.room.code)?.members.get(ownerMemberId),
    owner,
  );

  // Retrying the request waits on the exact same real effect. The request cap
  // may repeat, but it cannot issue another guarded delete while the first is
  // still unanswered.
  const retry = service.getRoomStateForSession(
    owner,
    created.memberToken,
    "room:join",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deleteCalls, 1);
  releaseDelete();
  assert.equal((await retry).roomCode, created.room.code);
  await service.close();
  const revived = await baseRoomStore.getRoom(created.room.code);
  assert.equal(revived?.expiresAt, null);
  assert.equal(owner.roomCode, created.room.code);
  assert.equal(
    runtime.getRoom(created.room.code)?.members.get(ownerMemberId),
    owner,
  );
});

test("getRoomStateForSession reuses the room snapshot that authenticated the session", async () => {
  let countRequestReads = false;
  let requestReads = 0;
  const baseRoomStore = createInMemoryRoomStore();
  const roomStore: RoomStore = {
    ...baseRoomStore,
    async getRoom(code, caller) {
      if (countRequestReads) {
        requestReads += 1;
        // Model a confirmed deletion immediately after authentication. One
        // request must use one room snapshot; the next request owns observing
        // the deletion and clearing the session through the same auth entry.
        if (requestReads > 1) {
          return null;
        }
      }
      return await baseRoomStore.getRoom(code, caller);
    },
  };
  const runtime = createInMemoryRuntimeStore();
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: runtime,
    generateToken: () => "token-1234567890",
    logEvent: (() => undefined) satisfies LogEvent,
    createRoomCode: () => "ROOMSN",
  });
  const owner = createSession("owner");
  const created = await service.createRoomForSession(owner, "Alice");

  countRequestReads = true;
  const state = await service.getRoomStateForSession(
    owner,
    created.memberToken,
    "sync:request",
  );

  assert.equal(requestReads, 1);
  assert.equal(state.roomCode, created.room.code);
  assert.equal(owner.roomCode, created.room.code);
  assert.equal(owner.memberToken, created.memberToken);
  await service.close();
});

test("repeated expiry wait caps keep one shutdown-tracked delete effect", async () => {
  let currentTime = 1_000;
  const baseRoomStore = createInMemoryRoomStore({ now: () => currentTime });
  let releaseDelete!: () => void;
  let markDeleteFinished!: () => void;
  const deleteHeld = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  const deleteFinished = new Promise<void>((resolve) => {
    markDeleteFinished = resolve;
  });
  const roomStore: RoomStore = {
    ...baseRoomStore,
    async deleteExpiredRoom(code, deleteTime) {
      await deleteHeld;
      const outcome = await baseRoomStore.deleteExpiredRoom(code, deleteTime);
      markDeleteFinished();
      return outcome;
    },
  };
  const closeEvents: Array<Record<string, unknown>> = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: {
      ...getDefaultPersistenceConfig(),
      emptyRoomTtlMs: 5_000,
    },
    roomStore,
    activeRooms: createInMemoryRuntimeStore(() => currentTime),
    generateToken: () => "token-1234567890",
    logEvent: (event, data) => {
      if (event === "room_service_close_unfinished") {
        closeEvents.push(data);
      }
    },
    now: () => currentTime,
    createRoomCode: () => "ROOMTW",
    roomDeleteConfirmationTimeoutMs: 5,
    closeBudgetMs: 5,
  });

  const owner = createSession("owner");
  const { room } = await service.createRoomForSession(owner, "Alice");
  await service.leaveRoomForSession(owner);
  currentTime += 5_001;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () => service.getRoomStateByCode(room.code),
      (error: unknown) =>
        error instanceof RoomServiceError &&
        error.code === "internal_error" &&
        error.reason === "room_resolution_unconfirmed",
    );
  }

  await service.close();
  assert.equal(closeEvents.length, 1);
  assert.equal(closeEvents[0]?.pendingRoomDeletions, 1);

  releaseDelete();
  await deleteFinished;
});

test("room service reports runtime teardown left at shutdown", async () => {
  const currentTime = 1_000;
  const runtime = createInMemoryRuntimeStore(() => currentTime);
  let markTeardownStarted!: () => void;
  let releaseTeardown!: () => void;
  const teardownStarted = new Promise<void>((resolve) => {
    markTeardownStarted = resolve;
  });
  const teardownLanded = new Promise<void>((resolve) => {
    releaseTeardown = resolve;
  });
  const events: string[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: createInMemoryRoomStore({ now: () => currentTime }),
    activeRooms: {
      ...runtime,
      async deleteRoom(code, expectedGeneration) {
        markTeardownStarted();
        await teardownLanded;
        return runtime.deleteRoom(code, expectedGeneration);
      },
    },
    generateToken: () => "token-1234567890",
    logEvent: (event) => events.push(event),
    now: () => currentTime,
    runtimeTeardownConfirmationTimeoutMs: 5,
    closeBudgetMs: 5,
  });

  const teardown = service.teardownRoomRuntime("ROOMHU");
  await teardownStarted;
  await teardown;
  await service.close();

  assert.ok(events.includes("room_service_close_unfinished"));
  releaseTeardown();
  await new Promise((resolve) => setImmediate(resolve));
});

test("room service reports settled runtime teardown retry debt at shutdown", async () => {
  const runtime = createInMemoryRuntimeStore(() => 1_000);
  const closeEvents: Array<Record<string, unknown>> = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore: createInMemoryRoomStore({ now: () => 1_000 }),
    activeRooms: {
      ...runtime,
      deleteRoom: async () => false,
    },
    generateToken: () => "token-1234567890",
    logEvent: (event, data) => {
      if (event === "room_service_close_unfinished") {
        closeEvents.push(data);
      }
    },
    now: () => 1_000,
  });

  // The effect answers immediately, so no pacer entry remains. Its guarded
  // skip still leaves one logical cleanup debt that only this process knows.
  await service.teardownRoomRuntime("ROOMDR");
  await Promise.resolve();
  await service.close();

  assert.equal(closeEvents.length, 1);
  assert.equal(closeEvents[0]?.pendingRuntimeTeardowns, 1);
});

test("room service closes lazy-delete admission before its shutdown snapshot", async () => {
  let currentTime = 1_000;
  const baseRoomStore = createInMemoryRoomStore({ now: () => currentTime });
  let holdRoomRead = false;
  let markRoomReadStarted!: () => void;
  let releaseRoomRead!: () => void;
  const roomReadStarted = new Promise<void>((resolve) => {
    markRoomReadStarted = resolve;
  });
  const roomReadLanded = new Promise<void>((resolve) => {
    releaseRoomRead = resolve;
  });
  let deleteAttempts = 0;
  const events: { name: string; trigger?: unknown }[] = [];
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: {
      ...getDefaultPersistenceConfig(),
      emptyRoomTtlMs: 5_000,
    },
    roomStore: {
      ...baseRoomStore,
      async getRoom(code, caller) {
        if (holdRoomRead) {
          markRoomReadStarted();
          await roomReadLanded;
        }
        return baseRoomStore.getRoom(code, caller);
      },
      async deleteExpiredRoom(code, deleteTime) {
        deleteAttempts += 1;
        return baseRoomStore.deleteExpiredRoom(code, deleteTime);
      },
    },
    activeRooms: createActiveRoomRegistry(),
    generateToken: () => "token-1234567890",
    logEvent: ((name, payload) => {
      events.push({ name, trigger: payload.trigger });
    }) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOMCL",
  });

  const owner = createSession("owner");
  const { room } = await service.createRoomForSession(owner, "Alice");
  await service.leaveRoomForSession(owner);
  currentTime += 5_001;

  holdRoomRead = true;
  const read = service.getRoomStateByCode(room.code);
  await roomReadStarted;
  await service.close();
  releaseRoomRead();

  await assert.rejects(
    () => read,
    (error: unknown) =>
      error instanceof RoomServiceError &&
      error.details.reason === "room_expiry_resolution_unconfirmed" &&
      error.details.trigger === "service_closing",
  );
  assert.equal(deleteAttempts, 0);
  assert.ok(await baseRoomStore.getRoom(room.code));
  // The wire answer is `internal_error` for every trigger, so this line is the
  // only thing that tells an expected retryable timing from an ordinary
  // internal failure. Logging per throw site left this trigger silent.
  assert.ok(
    events.some(
      (event) =>
        event.name === "room_expiry_delete_unconfirmed" &&
        event.trigger === "service_closing",
    ),
  );
});

test("a room that stopped being expired is served, not collected", async () => {
  let currentTime = 1_000;
  const baseRoomStore = createInMemoryRoomStore({ now: () => currentTime });
  const runtime = createInMemoryRuntimeStore(() => currentTime);
  const reclaimed: number[] = [];
  const teardowns: string[] = [];
  let revived = false;
  const roomStore: RoomStore = {
    ...baseRoomStore,
    async deleteExpiredRoom(code, deleteTime) {
      if (!revived) {
        revived = true;
        // Another node still has members here and clears the expiry between
        // this reader's snapshot and its delete — the case an expiry written by
        // a leave is already known to produce (#235 review).
        const current = await baseRoomStore.getRoom(code);
        if (current) {
          await baseRoomStore.updateRoom(code, current.version, {
            expiresAt: null,
            lastActiveAt: deleteTime,
          });
        }
      }
      return await baseRoomStore.deleteExpiredRoom(code, deleteTime);
    },
  };
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: {
      ...getDefaultPersistenceConfig(),
      emptyRoomTtlMs: 5_000,
    },
    roomStore,
    activeRooms: {
      ...runtime,
      deleteRoom(code, expectedGeneration) {
        teardowns.push(code);
        return runtime.deleteRoom(code, expectedGeneration);
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    metricsCollector: {
      recordRoomsExpiredDeleted: (roomCount) => reclaimed.push(roomCount),
    },
    now: () => currentTime,
    createRoomCode: () => "ROOMRV",
    resolveActiveRoom: async (code) => runtime.getRoom(code),
  });

  const owner = createSession("owner");
  const { room } = await service.createRoomForSession(owner, "Alice");
  await service.leaveRoomForSession(owner);
  currentTime += 5_001;

  // The snapshot said expired; the record says otherwise by the time the delete
  // runs. Answering `null` here would hide a room other nodes are using, and
  // tearing its runtime state down would take their members' identities with it.
  const state = await service.getRoomStateByCode(room.code);
  assert.equal(state?.roomCode, room.code);
  assert.deepEqual(reclaimed, []);
  assert.deepEqual(teardowns, []);
  assert.ok(await roomStore.getRoom(room.code));
});

test("a superseded expiry that elapses before the fresh read remains unconfirmed", async () => {
  let currentTime = 1_000;
  const baseRoomStore = createInMemoryRoomStore({ now: () => currentTime });
  const roomStore: RoomStore = {
    ...baseRoomStore,
    async deleteExpiredRoom(code, deleteTime) {
      const current = await baseRoomStore.getRoom(code);
      assert.ok(current);
      const brieflyRevived = await baseRoomStore.updateRoom(
        code,
        current.version,
        { expiresAt: deleteTime + 1, lastActiveAt: deleteTime },
      );
      assert.equal(brieflyRevived.ok, true);
      const outcome = await baseRoomStore.deleteExpiredRoom(code, deleteTime);
      assert.equal(outcome, "superseded");
      currentTime = deleteTime + 2;
      return outcome;
    },
  };
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: {
      ...getDefaultPersistenceConfig(),
      emptyRoomTtlMs: 5_000,
    },
    roomStore,
    activeRooms: createActiveRoomRegistry(),
    generateToken: () => "token-1234567890",
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    createRoomCode: () => "ROOMRE",
  });

  const owner = createSession("owner");
  const { room } = await service.createRoomForSession(owner, "Alice");
  await service.leaveRoomForSession(owner);
  currentTime += 5_001;

  await assert.rejects(
    () => service.getRoomStateByCode(room.code),
    (error: unknown) =>
      error instanceof RoomServiceError &&
      error.details.reason === "room_expiry_resolution_unconfirmed" &&
      error.details.trigger === "still_expired_after_superseded",
  );
  assert.ok(await baseRoomStore.getRoom(room.code));
});

test("room service shares one collection effect across concurrent expired-room readers", async () => {
  let currentTime = 1_000;
  const baseRoomStore = createInMemoryRoomStore({ now: () => currentTime });
  const reclaimed: number[] = [];
  let releaseDeletes!: () => void;
  const deletesHeld = new Promise<void>((resolve) => {
    releaseDeletes = resolve;
  });
  let heldDeletes = 0;
  const roomStore = {
    ...baseRoomStore,
    // Both readers take their expired snapshot, but the service owns one real
    // collection effect and both request-side waits join it.
    async deleteExpiredRoom(code: string, currentTimeMs: number) {
      heldDeletes += 1;
      await deletesHeld;
      return await baseRoomStore.deleteExpiredRoom(code, currentTimeMs);
    },
  };
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
    metricsCollector: {
      recordRoomsExpiredDeleted: (roomCount) => reclaimed.push(roomCount),
    },
    now: () => currentTime,
    createRoomCode: () => "ROOM01",
  });

  const owner = createSession("owner");
  const { room } = await service.createRoomForSession(owner, "Alice");
  await service.leaveRoomForSession(owner);

  // `getRoomStateByCode` reads through `resolveRoom` with no admission lock, so
  // two of them genuinely overlap; concurrent joins would serialise instead.
  currentTime = 7_000;
  const reads = [
    service.getRoomStateByCode(room.code),
    service.getRoomStateByCode(room.code),
  ];

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(heldDeletes, 1);
  releaseDeletes();
  assert.deepEqual(await Promise.all(reads), [null, null]);

  // One room died through one guarded delete and is counted once.
  assert.deepEqual(reclaimed, [1]);
});

test("room service tears down orphaned index codes without metering them as reclaimed rooms", async () => {
  const currentTime = 1_000;
  const baseRoomStore = createInMemoryRoomStore({ now: () => currentTime });
  const reclaimed: number[] = [];
  const tornDown: string[] = [];
  const acknowledgedClaims: string[] = [];
  const cleanupOrder: string[] = [];
  const runtime = createInMemoryRuntimeStore(() => currentTime);
  const roomStore = {
    ...baseRoomStore,
    // What the Redis sweep reports when one candidate had a live body and the
    // other was an index entry whose body was already gone — manual cleanup, an
    // older build, or corruption.
    async deleteExpiredRooms() {
      return {
        deletedRoomCodes: ["REALRM"],
        orphanedIndexCodes: ["ORPHAN"],
        orphanedIndexClaims: [{ code: "ORPHAN", token: "claim-1" }],
      };
    },
    async acknowledgeOrphanedIndexClaims(claims: readonly { code: string }[]) {
      cleanupOrder.push("acknowledge");
      acknowledgedClaims.push(...claims.map(({ code }) => code));
    },
  };
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...runtime,
      deleteRoom: async (code: string, expectedGeneration: string | null) => {
        cleanupOrder.push(`teardown:${code}`);
        tornDown.push(code);
        return runtime.deleteRoom(code, expectedGeneration);
      },
    },
    generateToken: (() => {
      let id = 0;
      return () => `token-${++id}`.padEnd(16, "x");
    })(),
    logEvent: (() => undefined) satisfies LogEvent,
    metricsCollector: {
      recordRoomsExpiredDeleted: (roomCount) => reclaimed.push(roomCount),
    },
    now: () => currentTime,
    resolveActiveRoom: async (code) => runtime.getRoom(code),
  });

  const swept = await service.deleteExpiredRooms();

  // The orphan owes runtime teardown exactly like a real deletion — its code
  // stays unallocatable until that state is gone (#237 review) …
  assert.deepEqual(tornDown.sort(), ["ORPHAN", "REALRM"]);
  assert.deepEqual(acknowledgedClaims, ["ORPHAN"]);
  assert.ok(
    cleanupOrder.indexOf("teardown:ORPHAN") <
      cleanupOrder.indexOf("acknowledge"),
  );
  // … but no room died under it, so metering it would put this counter back
  // out of step with room creations (#254 review).
  assert.deepEqual(reclaimed, [1]);
  assert.deepEqual(swept, { deletedRooms: 1, orphanedIndexEntries: 1 });
});

test("room service keeps an orphan claim until runtime teardown succeeds", async () => {
  const currentTime = 1_000;
  const baseRoomStore = createInMemoryRoomStore({ now: () => currentTime });
  const claim = { code: "ORPHAN", token: "claim-1" };
  const acknowledged: string[] = [];
  let roomReadFails = true;
  const roomStore = {
    ...baseRoomStore,
    async getRoom(code: string, caller?: RoomReadCaller) {
      if (roomReadFails) {
        throw new Error("invalid persisted room body");
      }
      return baseRoomStore.getRoom(code, caller);
    },
    async deleteExpiredRooms() {
      return {
        deletedRoomCodes: [],
        orphanedIndexCodes: [claim.code],
        orphanedIndexClaims: [claim],
      };
    },
    async acknowledgeOrphanedIndexClaims(claims: readonly (typeof claim)[]) {
      acknowledged.push(...claims.map(({ token }) => token));
    },
  };
  const runtime = createInMemoryRuntimeStore(() => currentTime);
  let teardownFails = true;
  let teardownAttempts = 0;
  const service = createRoomService({
    config: getDefaultSecurityConfig(),
    persistence: getDefaultPersistenceConfig(),
    roomStore,
    activeRooms: {
      ...runtime,
      deleteRoom: async (code: string, expectedGeneration: string | null) => {
        teardownAttempts += 1;
        if (teardownFails) {
          throw new Error("redis unavailable");
        }
        return runtime.deleteRoom(code, expectedGeneration);
      },
    },
    generateToken: () => "token-1234567890",
    logEvent: (() => undefined) satisfies LogEvent,
    now: () => currentTime,
    resolveActiveRoom: async (code) => runtime.getRoom(code),
  });

  await service.deleteExpiredRooms();
  assert.deepEqual(acknowledged, []);
  assert.equal(teardownAttempts, 0);

  roomReadFails = false;
  await service.deleteExpiredRooms();
  assert.deepEqual(acknowledged, []);
  assert.equal(teardownAttempts, 1);

  teardownFails = false;
  await service.deleteExpiredRooms();
  assert.deepEqual(acknowledged, [claim.token]);
  assert.equal(teardownAttempts, 2);
});
