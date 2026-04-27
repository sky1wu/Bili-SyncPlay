import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryRoomEventBus } from "../src/room-event-bus.js";
import { createRoomEventConsumer } from "../src/room-event-consumer.js";
import type { Session } from "../src/types.js";

function createSession(
  id: string,
  roomCode: string,
  protocolVersion = 2,
): Session {
  return {
    id,
    connectionState: "attached",
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
    protocolVersion,
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

test("room event consumer sends member join deltas to other local room sessions", async () => {
  const bus = createInMemoryRoomEventBus();
  const joiningSession = createSession("member-a", "ROOM01");
  const existingSession = createSession("member-b", "ROOM01");
  const sent: Array<{
    sessionId: string;
    type: string;
    memberId: string;
    displayName: string;
  }> = [];

  const consumer = await createRoomEventConsumer({
    roomEventBus: bus,
    async getRoomStateByCode() {
      throw new Error("member delta should not reload room state");
    },
    listLocalSessionsByRoom() {
      return [joiningSession, existingSession];
    },
    send(socket, message) {
      const session =
        socket === joiningSession.socket ? joiningSession : existingSession;
      if (
        message.type === "room:member-joined" ||
        message.type === "room:member-left"
      ) {
        sent.push({
          sessionId: session.id,
          type: message.type,
          memberId: message.payload.member.id,
          displayName: message.payload.member.name,
        });
      }
    },
  });

  try {
    await bus.publish({
      type: "room_member_joined",
      roomCode: "ROOM01",
      sourceInstanceId: "instance-b",
      emittedAt: 1_100,
      memberId: "member-a",
      displayName: "Alice",
    });
  } finally {
    await consumer.close();
  }

  assert.deepEqual(sent, [
    {
      sessionId: "member-b",
      type: "room:member-joined",
      memberId: "member-a",
      displayName: "Alice",
    },
  ]);
});

test("room event consumer sends full room state for legacy member event sessions", async () => {
  const bus = createInMemoryRoomEventBus();
  const joiningSession = createSession("member-a", "ROOM01", 2);
  const legacySession = createSession("member-b", "ROOM01", 1);
  const sent: Array<{
    sessionId: string;
    type: string;
    memberCount: number;
  }> = [];
  let roomStateLoads = 0;

  const consumer = await createRoomEventConsumer({
    roomEventBus: bus,
    async getRoomStateByCode(roomCode) {
      roomStateLoads += 1;
      return {
        roomCode,
        sharedVideo: null,
        playback: null,
        members: [
          { id: "member-a", name: "Alice" },
          { id: "member-b", name: "Bob" },
        ],
      };
    },
    listLocalSessionsByRoom() {
      return [joiningSession, legacySession];
    },
    send(socket, message) {
      const session =
        socket === joiningSession.socket ? joiningSession : legacySession;
      sent.push({
        sessionId: session.id,
        type: message.type,
        memberCount:
          message.type === "room:state" ? message.payload.members.length : 1,
      });
    },
  });

  try {
    await bus.publish({
      type: "room_member_joined",
      roomCode: "ROOM01",
      sourceInstanceId: "instance-b",
      emittedAt: 1_100,
      memberId: "member-a",
      displayName: "Alice",
    });
  } finally {
    await consumer.close();
  }

  assert.equal(roomStateLoads, 1);
  assert.deepEqual(sent, [
    {
      sessionId: "member-b",
      type: "room:state",
      memberCount: 2,
    },
  ]);
});

test("room event consumer re-checks legacy sessions after loading fallback room state", async () => {
  const bus = createInMemoryRoomEventBus();
  const joiningSession = createSession("member-a", "ROOM01", 2);
  const detachingLegacySession = createSession("member-b", "ROOM01", 1);
  const remainingLegacySession = createSession("member-c", "ROOM01", 1);
  const sent: Array<{
    sessionId: string;
    type: string;
    memberCount: number;
  }> = [];
  const logs: Array<{ event: string; result: string }> = [];
  let roomStateLoads = 0;

  const consumer = await createRoomEventConsumer({
    roomEventBus: bus,
    async getRoomStateByCode(roomCode) {
      roomStateLoads += 1;
      detachingLegacySession.connectionState = "detached";
      detachingLegacySession.socket = null;
      detachingLegacySession.roomCode = null;
      return {
        roomCode,
        sharedVideo: null,
        playback: null,
        members: [
          { id: "member-a", name: "Alice" },
          { id: "member-c", name: "Carol" },
        ],
      };
    },
    listLocalSessionsByRoom() {
      return [joiningSession, detachingLegacySession, remainingLegacySession];
    },
    send(socket, message) {
      assert.notEqual(socket, null, "detached socket should not be used");
      const session =
        socket === remainingLegacySession.socket
          ? remainingLegacySession
          : detachingLegacySession;
      sent.push({
        sessionId: session.id,
        type: message.type,
        memberCount:
          message.type === "room:state" ? message.payload.members.length : 1,
      });
    },
    logEvent(event, data) {
      logs.push({
        event,
        result: String(data.result),
      });
    },
  });

  try {
    await bus.publish({
      type: "room_member_joined",
      roomCode: "ROOM01",
      sourceInstanceId: "instance-b",
      emittedAt: 1_100,
      memberId: "member-a",
      displayName: "Alice",
    });
  } finally {
    await consumer.close();
  }

  assert.equal(roomStateLoads, 1);
  assert.deepEqual(sent, [
    {
      sessionId: "member-c",
      type: "room:state",
      memberCount: 2,
    },
  ]);
  assert.deepEqual(logs, [
    {
      event: "room_event_consumed",
      result: "ok",
    },
  ]);
});

test("room event consumer sends member leave deltas to remaining room sessions", async () => {
  const bus = createInMemoryRoomEventBus();
  const remainingSession = createSession("member-b", "ROOM01");
  const sent: Array<{ type: string; memberId: string }> = [];

  const consumer = await createRoomEventConsumer({
    roomEventBus: bus,
    async getRoomStateByCode() {
      throw new Error("member delta should not reload room state");
    },
    listLocalSessionsByRoom() {
      return [remainingSession];
    },
    send(_socket, message) {
      if (message.type === "room:member-left") {
        sent.push({
          type: message.type,
          memberId: message.payload.member.id,
        });
      }
    },
  });

  try {
    await bus.publish({
      type: "room_member_left",
      roomCode: "ROOM01",
      sourceInstanceId: "instance-b",
      emittedAt: 1_100,
      memberId: "member-a",
      displayName: "Alice",
    });
  } finally {
    await consumer.close();
  }

  assert.deepEqual(sent, [
    {
      type: "room:member-left",
      memberId: "member-a",
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

test("room event consumer skips detached sessions", async () => {
  const bus = createInMemoryRoomEventBus();
  const attachedSession = createSession("member-a", "ROOM01");
  const detachedSession: Session = {
    ...createSession("member-b", "ROOM01"),
    connectionState: "detached",
    socket: null,
  };
  const sent: string[] = [];

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
    listLocalSessionsByRoom() {
      return [attachedSession, detachedSession];
    },
    send(socket) {
      if (socket === attachedSession.socket) {
        sent.push(attachedSession.id);
      }
    },
  });

  try {
    await bus.publish({
      type: "room_member_changed",
      roomCode: "ROOM01",
      sourceInstanceId: "instance-a",
      emittedAt: 1_500,
    });
  } finally {
    await consumer.close();
  }

  assert.deepEqual(sent, ["member-a"]);
});

test("room event consumer re-checks room membership after loading room state", async () => {
  const bus = createInMemoryRoomEventBus();
  const movedSession = createSession("member-a", "ROOM01");
  const remainingSession = createSession("member-b", "ROOM01");
  const sent: string[] = [];

  const consumer = await createRoomEventConsumer({
    roomEventBus: bus,
    async getRoomStateByCode(roomCode) {
      movedSession.roomCode = "ROOM02";
      return {
        roomCode,
        sharedVideo: null,
        playback: null,
        members: [{ id: "member-b", name: "Bob" }],
      };
    },
    listLocalSessionsByRoom() {
      return [movedSession, remainingSession];
    },
    send(socket) {
      const session =
        socket === movedSession.socket ? movedSession : remainingSession;
      sent.push(session.id);
    },
  });

  try {
    await bus.publish({
      type: "room_state_updated",
      roomCode: "ROOM01",
      sourceInstanceId: "instance-a",
      emittedAt: 1_600,
    });
  } finally {
    await consumer.close();
  }

  assert.deepEqual(sent, ["member-b"]);
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
