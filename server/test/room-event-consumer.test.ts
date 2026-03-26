import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryRoomEventBus } from "../src/room-event-bus.js";
import { createRoomEventConsumer } from "../src/room-event-consumer.js";
import type { Session } from "../src/types.js";

function createSession(id: string, roomCode: string): Session {
  return {
    id,
    socket: {
      readyState: 1,
      OPEN: 1,
      send() {},
      close() {},
      terminate() {},
    } as Session["socket"],
    instanceId: "instance-a",
    remoteAddress: "127.0.0.1",
    origin: "chrome-extension://allowed-extension",
    roomCode,
    memberId: id,
    displayName: id,
    memberToken: `token-${id}`,
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

test("room event consumer sends room state only to local room sessions", async () => {
  const bus = createInMemoryRoomEventBus();
  const localRoomSession = createSession("member-a", "ROOM01");
  const otherRoomSession = createSession("member-b", "ROOM02");
  const sent: Array<{
    sessionId: string;
    roomCode: string;
    memberCount: number;
  }> = [];
  const logs: Array<{
    event: string;
    roomCode: string | null;
    result: string;
  }> = [];

  const consumer = await createRoomEventConsumer({
    roomEventBus: bus,
    async getRoomStateByCode(roomCode) {
      return {
        roomCode,
        sharedVideo: null,
        playback: null,
        members: [{ id: "member-a", name: "Alice" }],
      };
    },
    listLocalSessionsByRoom(roomCode) {
      return roomCode === "ROOM01" ? [localRoomSession] : [otherRoomSession];
    },
    send(socket, message) {
      const session =
        socket === localRoomSession.socket
          ? localRoomSession
          : otherRoomSession;
      sent.push({
        sessionId: session.id,
        roomCode: message.payload.roomCode,
        memberCount: message.payload.members.length,
      });
    },
    instanceId: "instance-a",
    logEvent(event, data) {
      logs.push({
        event,
        roomCode: typeof data.roomCode === "string" ? data.roomCode : null,
        result: String(data.result),
      });
    },
  });

  try {
    await bus.publish({
      type: "room_member_changed",
      roomCode: "ROOM01",
      sourceInstanceId: "instance-b",
      emittedAt: 1_100,
    });
  } finally {
    await consumer.close();
  }

  assert.deepEqual(sent, [
    {
      sessionId: "member-a",
      roomCode: "ROOM01",
      memberCount: 1,
    },
  ]);
  assert.deepEqual(logs, [
    {
      event: "room_event_consumed",
      roomCode: "ROOM01",
      result: "ok",
    },
  ]);
});

test("room event consumer emits an empty state for deleted rooms", async () => {
  const bus = createInMemoryRoomEventBus();
  const localRoomSession = createSession("member-a", "ROOM01");
  const sent: Array<{ roomCode: string; members: number }> = [];

  const consumer = await createRoomEventConsumer({
    roomEventBus: bus,
    async getRoomStateByCode() {
      throw new Error("room_deleted should not reload persisted room state");
    },
    listLocalSessionsByRoom() {
      return [localRoomSession];
    },
    send(_socket, message) {
      sent.push({
        roomCode: message.payload.roomCode,
        members: message.payload.members.length,
      });
    },
  });

  try {
    await bus.publish({
      type: "room_deleted",
      roomCode: "ROOM01",
      sourceInstanceId: "instance-a",
      emittedAt: 1_200,
    });
  } finally {
    await consumer.close();
  }

  assert.deepEqual(sent, [{ roomCode: "ROOM01", members: 0 }]);
});

test("room event consumer logs failures without throwing to the bus", async () => {
  const bus = createInMemoryRoomEventBus();
  const logs: Array<{
    event: string;
    result: string;
    roomCode: string | null;
  }> = [];

  const consumer = await createRoomEventConsumer({
    roomEventBus: bus,
    async getRoomStateByCode() {
      throw new Error("boom");
    },
    listLocalSessionsByRoom() {
      return [];
    },
    send() {},
    instanceId: "instance-a",
    logEvent(event, data) {
      logs.push({
        event,
        result: String(data.result),
        roomCode: typeof data.roomCode === "string" ? data.roomCode : null,
      });
    },
  });

  try {
    await bus.publish({
      type: "room_state_updated",
      roomCode: "ROOM99",
      sourceInstanceId: "instance-b",
      emittedAt: 2_000,
    });
  } finally {
    await consumer.close();
  }

  assert.deepEqual(logs, [
    {
      event: "room_event_consume_failed",
      result: "error",
      roomCode: "ROOM99",
    },
  ]);
});
