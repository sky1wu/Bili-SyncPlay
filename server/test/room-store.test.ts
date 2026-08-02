import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemoryRoomStore,
  roomStateFromSessions,
  roomStateOf,
} from "../src/room-store.js";
import type { ActiveRoom, PersistedRoom, Session } from "../src/types.js";

test("room store persists create, update, delete, and expiry behaviors", async () => {
  const store = createInMemoryRoomStore({ now: () => 123 });

  const createdRoom = await store.createRoom({
    code: "AAAAAA",
    joinToken: "join-token-123456",
    createdAt: 100,
    ownerMemberId: "member-owner",
    ownerDisplayName: "Alice",
  });
  assert.equal(createdRoom.code, "AAAAAA");
  assert.equal(createdRoom.version, 0);
  assert.equal(createdRoom.ownerMemberId, "member-owner");
  assert.equal(createdRoom.ownerDisplayName, "Alice");

  const updated = await store.updateRoom(
    createdRoom.code,
    createdRoom.version,
    {
      expiresAt: 999,
      lastActiveAt: 500,
    },
  );
  assert.equal(updated.ok, true);
  if (!updated.ok) {
    throw new Error("Expected update to succeed.");
  }
  assert.equal(updated.room.version, 1);
  assert.equal(updated.room.expiresAt, 999);

  const conflict = await store.updateRoom(
    createdRoom.code,
    createdRoom.version,
    {
      expiresAt: null,
    },
  );
  assert.deepEqual(conflict, { ok: false, reason: "version_conflict" });

  assert.equal((await store.deleteExpiredRooms(500)).length, 0);
  assert.equal((await store.deleteExpiredRooms(999)).length, 1);
  assert.equal(await store.getRoom(createdRoom.code), null);
});

test("roomStateOf serializes persisted room state with active members", () => {
  const session = {
    id: "member-1",
    memberId: "member-1",
    displayName: "Alice",
    // A member of this room says so. The `as Session` cast had been hiding the
    // field, and the residue filter reads it (#235 review).
    roomCode: "ROOM01",
  } as Session;
  const persistedRoom: PersistedRoom = {
    code: "ROOM01",
    joinToken: "join-token",
    createdAt: 1,
    sharedVideo: {
      videoId: "BV1xx411c7mD",
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      title: "Video",
      sharedByMemberId: "member-1",
    },
    playback: {
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      currentTime: 10,
      playState: "paused",
      playbackRate: 1,
      updatedAt: 1,
      serverTime: 1,
      actorId: "member-1",
      seq: 2,
    },
    version: 3,
    lastActiveAt: 1,
    expiresAt: null,
  };
  const activeRoom: ActiveRoom = {
    code: persistedRoom.code,
    members: new Map([[session.id, session]]),
    memberTokens: new Map([[session.id, "member-token"]]),
  };

  assert.deepEqual(roomStateOf(persistedRoom, activeRoom), {
    roomCode: "ROOM01",
    sharedVideo: persistedRoom.sharedVideo,
    playback: persistedRoom.playback,
    members: [{ id: "member-1", name: "Alice" }],
  });
});

test("roomStateFromSessions ignores sessions that belong to another room", () => {
  // Removing a session from a room's index is the one write keyed on the OLD
  // room code, and nothing afterwards remembers that code — a switch whose
  // cleanup failed leaves the id in the old room's set forever. Loading it back
  // would rejoin that roster and could hand it the share (#235 review).
  const persistedRoom: PersistedRoom = {
    code: "ROOMRS",
    joinToken: "join-token-123456",
    createdAt: 1,
    ownerMemberId: "member-1",
    ownerDisplayName: "Alice",
    sharedVideo: {
      videoId: "BV1xx411c7mD",
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      title: "Video",
      sharedByMemberId: "member-gone",
      sharedByDisplayName: "Gone",
    },
    playback: null,
    version: 3,
    lastActiveAt: 2,
    expiresAt: null,
  };

  const state = roomStateFromSessions(persistedRoom, [
    {
      id: "session-stale",
      memberId: "member-stale",
      displayName: "Stale",
      joinedAt: 1_000,
      roomCode: "ROOM-ELSEWHERE",
    },
    {
      id: "session-here",
      memberId: "member-here",
      displayName: "Here",
      joinedAt: 2_000,
      roomCode: "ROOMRS",
    },
  ]);

  assert.deepEqual(state.members, [{ id: "member-here", name: "Here" }]);
  // And the residue must not win the election either.
  assert.equal(state.sharedVideo?.sharedByMemberId, "member-here");
});

test("roomStateFromSessions drops a session whose room was already cleared", () => {
  // An explicit leave re-registers the session with its room already cleared, so
  // a failed index write leaves exactly this shape in the room's set. Treating
  // `null` as "unknown, keep it" put the leaver back on the roster and let them
  // win the share again (#235 review). Safe to drop because a join writes the
  // hash's `roomCode` and the room-set entry in one transaction, so no in-flight
  // join can look like this.
  const persistedRoom: PersistedRoom = {
    code: "ROOMRK",
    joinToken: "join-token-123456",
    createdAt: 1,
    ownerMemberId: null,
    ownerDisplayName: null,
    sharedVideo: null,
    playback: null,
    version: 1,
    lastActiveAt: 2,
    expiresAt: null,
  };

  const state = roomStateFromSessions(persistedRoom, [
    {
      id: "session-left",
      memberId: "member-left",
      displayName: "Carol",
      roomCode: null,
    },
    {
      id: "session-here",
      memberId: "member-here",
      displayName: "Dave",
      roomCode: "ROOMRK",
    },
  ]);

  assert.deepEqual(state.members, [{ id: "member-here", name: "Dave" }]);
});
