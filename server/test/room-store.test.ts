import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryRoomStore, roomStateOf } from "../src/room-store.js";
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

  assert.equal(await store.deleteExpiredRooms(500), 0);
  assert.equal(await store.deleteExpiredRooms(999), 1);
  assert.equal(await store.getRoom(createdRoom.code), null);
});

test("roomStateOf serializes persisted room state with active members", () => {
  const session = {
    id: "member-1",
    memberId: "member-1",
    displayName: "Alice",
  } as Session;
  const persistedRoom: PersistedRoom = {
    code: "ROOM01",
    joinToken: "join-token",
    createdAt: 1,
    sharedVideo: {
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      title: "Video",
      ownerName: "Owner",
      bvid: "BV1xx411c7mD",
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
