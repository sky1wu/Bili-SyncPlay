import assert from "node:assert/strict";
import test from "node:test";
import { createMessageHandler } from "../src/message-handler.js";
import { createSessionRateLimitState } from "../src/rate-limit.js";
import type { Session } from "../src/types.js";

const CONFIG = {
  maxMembersPerRoom: 8,
  rateLimits: {
    roomCreatePerMinute: 3,
    roomJoinPerMinute: 10,
    videoSharePer10Seconds: 3,
    playbackUpdatePerSecond: 8,
    playbackUpdateBurst: 12,
    syncRequestPer10Seconds: 6,
    syncPingPerSecond: 1,
    syncPingBurst: 2,
  },
};

function createSession(id: string, overrides: Partial<Session> = {}): Session {
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
    instanceId: "node-a",
    remoteAddress: "127.0.0.1",
    origin: "chrome-extension://allowed-extension",
    roomCode: null,
    memberId: null,
    displayName: "Alice",
    memberToken: null,
    joinedAt: null,
    invalidMessageCount: 0,
    rateLimitState: createSessionRateLimitState(CONFIG, 0),
    ...overrides,
  };
}

test("message handler rejects detached sessions before processing", async () => {
  const handler = createMessageHandler({
    config: CONFIG,
    roomService: {
      async createRoomForSession() {
        throw new Error("unreachable");
      },
      async joinRoomForSession() {
        throw new Error("unreachable");
      },
      async leaveRoomForSession() {
        return { room: null };
      },
      async shareVideoForSession() {
        throw new Error("unreachable");
      },
      async updatePlaybackForSession() {
        throw new Error("unreachable");
      },
      async updateProfileForSession() {
        throw new Error("unreachable");
      },
      async getRoomStateForSession() {
        throw new Error("unreachable");
      },
    },
    logEvent() {},
    send() {},
    sendError() {},
    async publishRoomEvent() {},
    instanceId: "node-a",
  });

  await assert.rejects(
    handler.handleClientMessage(
      {
        ...createSession("detached-session"),
        connectionState: "detached",
        socket: null,
      },
      {
        type: "sync:ping",
        payload: { clientSendTime: 1 },
      },
    ),
    /Detached session cannot process client message/,
  );
});

test("message handler creates a room, responds, and publishes member change", async () => {
  const sent: Array<{ type: string; roomCode?: string }> = [];
  const published: string[] = [];
  const joined: Array<{ roomCode: string; previousRoomCode: string | null }> =
    [];
  const events: string[] = [];
  const session = createSession("creator");

  const handler = createMessageHandler({
    config: CONFIG,
    roomService: {
      async createRoomForSession(currentSession, displayName) {
        currentSession.roomCode = "ROOM01";
        currentSession.memberId = "member-1";
        currentSession.displayName = displayName ?? currentSession.displayName;
        currentSession.memberToken = "member-token-1";
        return {
          room: { code: "ROOM01", joinToken: "join-token-1" },
          memberToken: "member-token-1",
        };
      },
      async joinRoomForSession() {
        throw new Error("unreachable");
      },
      async leaveRoomForSession() {
        return { room: null };
      },
      async shareVideoForSession() {
        throw new Error("unreachable");
      },
      async updatePlaybackForSession() {
        throw new Error("unreachable");
      },
      async updateProfileForSession() {
        throw new Error("unreachable");
      },
      async getRoomStateForSession() {
        throw new Error("unreachable");
      },
    },
    logEvent(event) {
      events.push(event);
    },
    send(_socket, message) {
      sent.push({
        type: message.type,
        roomCode:
          "payload" in message &&
          message.payload &&
          "roomCode" in message.payload
            ? String(message.payload.roomCode)
            : undefined,
      });
    },
    sendError() {
      throw new Error("sendError should not be called");
    },
    async publishRoomEvent(message) {
      published.push(`${message.type}:${message.roomCode}`);
    },
    instanceId: "node-a",
    onRoomJoined(_session, roomCode, previousRoomCode) {
      joined.push({ roomCode, previousRoomCode });
    },
  });

  await handler.handleClientMessage(session, {
    type: "room:create",
    payload: { displayName: "Alice" },
  });

  assert.deepEqual(sent, [{ type: "room:created", roomCode: "ROOM01" }]);
  assert.deepEqual(published, ["room_member_changed:ROOM01"]);
  assert.deepEqual(joined, [{ roomCode: "ROOM01", previousRoomCode: null }]);
  assert.ok(events.includes("room_created"));
});

test("message handler skips room state publish when playback update is ignored", async () => {
  const published: string[] = [];
  const session = createSession("member-1", {
    roomCode: "ROOM01",
    memberId: "member-1",
    memberToken: "member-token-1",
  });

  const handler = createMessageHandler({
    config: CONFIG,
    roomService: {
      async createRoomForSession() {
        throw new Error("unreachable");
      },
      async joinRoomForSession() {
        throw new Error("unreachable");
      },
      async leaveRoomForSession() {
        return { room: null };
      },
      async shareVideoForSession() {
        throw new Error("unreachable");
      },
      async updatePlaybackForSession() {
        return { room: { code: "ROOM01" }, ignored: true };
      },
      async updateProfileForSession() {
        throw new Error("unreachable");
      },
      async getRoomStateForSession() {
        throw new Error("unreachable");
      },
    },
    logEvent() {},
    send() {},
    sendError() {},
    async publishRoomEvent(message) {
      published.push(message.type);
    },
    instanceId: "node-a",
  });

  await handler.handleClientMessage(session, {
    type: "playback:update",
    payload: {
      memberToken: "member-token-1",
      playback: {
        currentTime: 12,
        playState: "playing",
        playbackRate: 1,
        updatedAt: 100,
        serverTime: 0,
        actorId: "member-1",
      },
    },
  });

  assert.deepEqual(published, []);
});

test("message handler keeps leave completed when member change publish fails", async () => {
  const events: string[] = [];
  const left: string[] = [];
  const session = createSession("member-1", {
    roomCode: "ROOM01",
    memberId: "member-1",
    memberToken: "member-token-1",
  });

  const handler = createMessageHandler({
    config: CONFIG,
    roomService: {
      async createRoomForSession() {
        throw new Error("unreachable");
      },
      async joinRoomForSession() {
        throw new Error("unreachable");
      },
      async leaveRoomForSession(currentSession) {
        currentSession.roomCode = null;
        currentSession.memberId = null;
        currentSession.memberToken = null;
        return {
          room: {
            code: "ROOM01",
            joinToken: "join-token-1",
            createdAt: 1,
            ownerMemberId: "member-1",
            ownerDisplayName: "Alice",
            sharedVideo: null,
            playback: null,
            version: 1,
            lastActiveAt: 1,
            expiresAt: null,
          },
        };
      },
      async shareVideoForSession() {
        throw new Error("unreachable");
      },
      async updatePlaybackForSession() {
        throw new Error("unreachable");
      },
      async updateProfileForSession() {
        throw new Error("unreachable");
      },
      async getRoomStateForSession() {
        throw new Error("unreachable");
      },
    },
    logEvent(event) {
      events.push(event);
    },
    send() {},
    sendError() {
      throw new Error("sendError should not be called");
    },
    async publishRoomEvent() {
      throw new Error("publish failed");
    },
    instanceId: "node-a",
    onRoomLeft(_session, roomCode) {
      left.push(roomCode);
    },
  });

  await handler.handleClientMessage(session, {
    type: "room:leave",
    payload: { memberToken: "member-token-1" },
  });

  assert.equal(session.roomCode, null);
  assert.deepEqual(left, ["ROOM01"]);
  assert.ok(events.includes("room_event_publish_failed"));
});
