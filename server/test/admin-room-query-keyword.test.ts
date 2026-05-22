import assert from "node:assert/strict";
import test from "node:test";
import { createAdminRoomQueryService } from "../src/admin/room-query-service.js";
import type { GlobalEventStore } from "../src/admin/global-event-store.js";
import { createInMemoryRoomStore } from "../src/room-store.js";
import { createInMemoryRuntimeStore } from "../src/runtime-store.js";
import type { Session } from "../src/types.js";

const INSTANCE_ID = "instance-test";

function makeSession(overrides: {
  id: string;
  roomCode: string;
  memberId?: string;
  displayName: string;
}): Session {
  return {
    id: overrides.id,
    connectionState: "attached",
    socket: {
      readyState: 1,
      OPEN: 1,
      send() {},
      close() {},
      terminate() {},
    } as Session["socket"],
    instanceId: INSTANCE_ID,
    remoteAddress: "127.0.0.1",
    origin: "chrome-extension://allowed-extension",
    roomCode: overrides.roomCode,
    memberId: overrides.memberId ?? overrides.id,
    displayName: overrides.displayName,
    memberToken: `token-${overrides.id}`,
    protocolVersion: 2,
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

const stubEventStore: GlobalEventStore = {
  async append() {},
  async query() {
    return { items: [], pagination: { page: 1, pageSize: 0, total: 0 } };
  },
};

async function buildFixture() {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const runtimeStore = createInMemoryRuntimeStore(() => 1_000);

  await roomStore.createRoom({
    code: "ROOMAA",
    joinToken: "join-a",
    createdAt: 100,
    ownerMemberId: "owner-alice",
    ownerDisplayName: "Alice",
  });
  await roomStore.saveRoom({
    code: "ROOMAA",
    joinToken: "join-a",
    createdAt: 100,
    ownerMemberId: "owner-alice",
    ownerDisplayName: "Alice",
    sharedVideo: {
      videoId: "BV1aa",
      url: "https://www.bilibili.com/video/BV1aa",
      title: "猫咪的日常 vlog",
      sharedByDisplayName: "Alice",
    },
    playback: null,
    version: 1,
    lastActiveAt: 200,
    expiresAt: null,
  });
  runtimeStore.registerSession(
    makeSession({
      id: "session-alice",
      roomCode: "ROOMAA",
      memberId: "owner-alice",
      displayName: "Alice",
    }),
  );
  runtimeStore.markSessionJoinedRoom("session-alice", "ROOMAA");
  runtimeStore.registerSession(
    makeSession({
      id: "session-bob",
      roomCode: "ROOMAA",
      memberId: "member-bob",
      displayName: "Bob",
    }),
  );
  runtimeStore.markSessionJoinedRoom("session-bob", "ROOMAA");

  await roomStore.createRoom({
    code: "ROOMBB",
    joinToken: "join-b",
    createdAt: 110,
    ownerMemberId: "owner-carol",
    ownerDisplayName: "Carol",
  });
  await roomStore.saveRoom({
    code: "ROOMBB",
    joinToken: "join-b",
    createdAt: 110,
    ownerMemberId: "owner-carol",
    ownerDisplayName: "Carol",
    sharedVideo: {
      videoId: "BV1bb",
      url: "https://www.bilibili.com/video/BV1bb",
      title: "深度学习入门教程",
      sharedByDisplayName: "Carol",
    },
    playback: null,
    version: 1,
    lastActiveAt: 210,
    expiresAt: null,
  });
  runtimeStore.registerSession(
    makeSession({
      id: "session-carol",
      roomCode: "ROOMBB",
      memberId: "owner-carol",
      displayName: "Carol",
    }),
  );
  runtimeStore.markSessionJoinedRoom("session-carol", "ROOMBB");

  await roomStore.createRoom({
    code: "ROOMCC",
    joinToken: "join-c",
    createdAt: 120,
    ownerMemberId: null,
    ownerDisplayName: null,
  });
  await roomStore.saveRoom({
    code: "ROOMCC",
    joinToken: "join-c",
    createdAt: 120,
    ownerMemberId: null,
    ownerDisplayName: null,
    sharedVideo: null,
    playback: null,
    version: 1,
    lastActiveAt: 220,
    expiresAt: null,
  });

  const service = createAdminRoomQueryService({
    instanceId: INSTANCE_ID,
    roomStore,
    runtimeStore,
    eventStore: stubEventStore,
  });

  return { service };
}

const baseQuery = {
  status: "all" as const,
  includeExpired: true,
  page: 1,
  pageSize: 20,
  sortBy: "lastActiveAt" as const,
  sortOrder: "desc" as const,
};

test("keyword filter matches room code (case-insensitive)", async () => {
  const { service } = await buildFixture();
  const result = await service.listRooms({ ...baseQuery, keyword: "roomaa" });
  assert.equal(result.pagination.total, 1);
  assert.deepEqual(
    result.items.map((item) => item.roomCode),
    ["ROOMAA"],
  );
});

test("keyword filter matches active member display name", async () => {
  const { service } = await buildFixture();
  const result = await service.listRooms({ ...baseQuery, keyword: "bob" });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.items[0]?.roomCode, "ROOMAA");
});

test("keyword filter matches shared video title", async () => {
  const { service } = await buildFixture();
  const result = await service.listRooms({ ...baseQuery, keyword: "深度学习" });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.items[0]?.roomCode, "ROOMBB");
});

test("keyword filter matches shared video URL fragment (BV id)", async () => {
  const { service } = await buildFixture();
  const result = await service.listRooms({ ...baseQuery, keyword: "BV1bb" });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.items[0]?.roomCode, "ROOMBB");
});

test("keyword filter requires every space-separated token to match (AND)", async () => {
  const { service } = await buildFixture();
  const both = await service.listRooms({
    ...baseQuery,
    keyword: "alice 猫咪",
  });
  assert.equal(both.pagination.total, 1);
  assert.equal(both.items[0]?.roomCode, "ROOMAA");

  const conflicting = await service.listRooms({
    ...baseQuery,
    keyword: "alice 深度学习",
  });
  assert.equal(conflicting.pagination.total, 0);
});

test("keyword filter composes with status=active", async () => {
  const { service } = await buildFixture();
  const idle = await service.listRooms({
    ...baseQuery,
    status: "idle",
    keyword: "room",
  });
  assert.deepEqual(
    idle.items.map((item) => item.roomCode),
    ["ROOMCC"],
  );

  const active = await service.listRooms({
    ...baseQuery,
    status: "active",
    keyword: "room",
  });
  assert.deepEqual(active.items.map((item) => item.roomCode).sort(), [
    "ROOMAA",
    "ROOMBB",
  ]);
});

test("blank keyword falls back to the unfiltered fast path", async () => {
  const { service } = await buildFixture();
  const result = await service.listRooms({ ...baseQuery, keyword: "   " });
  assert.equal(result.pagination.total, 3);
});
