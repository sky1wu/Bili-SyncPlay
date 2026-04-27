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
        return {
          roomCode: "ROOM01",
          sharedVideo: null,
          playback: null,
          members: [{ id: "member-1", name: "Alice" }],
        };
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

test("message handler creates a room and sends bootstrap state to the creator", async () => {
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
        return {
          roomCode: "ROOM01",
          sharedVideo: null,
          playback: null,
          members: [{ id: "member-1", name: "Alice" }],
        };
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

  assert.deepEqual(sent, [
    { type: "room:created", roomCode: "ROOM01" },
    { type: "room:state", roomCode: "ROOM01" },
  ]);
  assert.deepEqual(published, []);
  assert.deepEqual(joined, [{ roomCode: "ROOM01", previousRoomCode: null }]);
  assert.ok(events.includes("room_created"));
});

test("message handler keeps room:create successful when bootstrap state fails", async () => {
  const sent: string[] = [];
  const errors: string[] = [];
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
        throw new Error("transient room state read failure");
      },
    },
    logEvent(event) {
      events.push(event);
    },
    send(_socket, message) {
      sent.push(message.type);
    },
    sendError(_socket, code) {
      errors.push(code);
    },
    async publishRoomEvent() {},
    instanceId: "node-a",
  });

  await handler.handleClientMessage(session, {
    type: "room:create",
    payload: { displayName: "Alice" },
  });

  assert.deepEqual(sent, ["room:created"]);
  assert.deepEqual(errors, []);
  assert.ok(events.includes("room_state_bootstrap_failed"));
  assert.ok(events.includes("room_created"));
});

test("message handler keeps room:create successful when room join hook fails", async () => {
  const sent: string[] = [];
  const errors: string[] = [];
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
        return {
          roomCode: "ROOM01",
          sharedVideo: null,
          playback: null,
          members: [{ id: "member-1", name: "Alice" }],
        };
      },
    },
    logEvent(event) {
      events.push(event);
    },
    send(_socket, message) {
      sent.push(message.type);
    },
    sendError(_socket, code) {
      errors.push(code);
    },
    async publishRoomEvent() {},
    instanceId: "node-a",
    async onRoomJoined() {
      throw new Error("runtime index unavailable");
    },
  });

  await handler.handleClientMessage(session, {
    type: "room:create",
    payload: { displayName: "Alice" },
  });

  assert.deepEqual(sent, ["room:created", "room:state"]);
  assert.deepEqual(errors, []);
  assert.ok(events.includes("room_join_hook_failed"));
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
        return {
          roomCode: "ROOM-M1",
          sharedVideo: null,
          playback: null,
          members: [{ id: "member-m1", name: "Alice" }],
        };
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
          memberRemoved: true,
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
        return {
          roomCode: "ROOM01",
          sharedVideo: null,
          playback: null,
          members: [{ id: "member-1", name: "Alice" }],
        };
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

test("message handler keeps leave completed when room left hook fails", async () => {
  const events: string[] = [];
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
      async leaveRoomForSession(currentSession) {
        currentSession.roomCode = null;
        currentSession.memberId = null;
        currentSession.memberToken = null;
        return {
          room: { code: "ROOM01" },
          memberRemoved: true,
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
    async publishRoomEvent(message) {
      published.push(message.type);
    },
    instanceId: "node-a",
    onRoomLeft() {
      throw new Error("runtime index unavailable");
    },
  });

  await handler.handleClientMessage(session, {
    type: "room:leave",
    payload: { memberToken: "member-token-1" },
  });

  assert.equal(session.roomCode, null);
  assert.deepEqual(published, ["room_member_left"]);
  assert.ok(events.includes("room_left_hook_failed"));
});

test("message handler skips member-left publish when leave did not remove the member", async () => {
  const published: string[] = [];
  const session = createSession("old-session", {
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
          room: { code: "ROOM01" },
          memberRemoved: false,
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
    logEvent() {},
    send() {},
    sendError() {
      throw new Error("sendError should not be called");
    },
    async publishRoomEvent(message) {
      published.push(message.type);
    },
    instanceId: "node-a",
  });

  await handler.handleClientMessage(session, {
    type: "room:leave",
    payload: { memberToken: "member-token-1" },
  });

  assert.deepEqual(published, []);
});

test("message handler records monitored duration metrics for critical room paths", async () => {
  const observedTypes: string[] = [];
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
      async joinRoomForSession(currentSession) {
        currentSession.roomCode = "ROOM01";
        currentSession.memberId = "member-1";
        currentSession.memberToken = "member-token-1";
        return {
          room: { code: "ROOM01" },
          memberToken: "member-token-1",
        };
      },
      async leaveRoomForSession(currentSession) {
        currentSession.roomCode = null;
        return {
          room: { code: "ROOM01" },
          notifyRoom: true,
          memberRemoved: true,
        };
      },
      async shareVideoForSession() {
        return { room: { code: "ROOM01" } };
      },
      async updatePlaybackForSession() {
        return { room: { code: "ROOM01" }, ignored: false };
      },
      async updateProfileForSession() {
        throw new Error("unreachable");
      },
      async getRoomStateForSession() {
        return {
          roomCode: "ROOM01",
          sharedVideo: null,
          playback: null,
          members: [{ id: "member-1", name: "Alice" }],
        };
      },
    },
    logEvent() {},
    send() {},
    sendError() {
      throw new Error("sendError should not be called");
    },
    async publishRoomEvent() {},
    instanceId: "node-a",
    metricsCollector: {
      observeMessageHandlerDuration(messageType) {
        observedTypes.push(messageType);
      },
    },
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      displayName: "Alice",
    },
  });
  await handler.handleClientMessage(session, {
    type: "video:share",
    payload: {
      memberToken: "member-token-1",
      video: {
        videoId: "BV1xx411c7mD",
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        title: "Test Episode",
      },
      playback: {
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 0,
        playState: "paused",
        playbackRate: 1,
        updatedAt: 1,
        serverTime: 0,
        actorId: "member-1",
        seq: 1,
      },
    },
  });
  await handler.handleClientMessage(session, {
    type: "playback:update",
    payload: {
      memberToken: "member-token-1",
      playback: {
        currentTime: 5,
        playState: "playing",
        playbackRate: 1,
        updatedAt: 2,
        serverTime: 0,
        actorId: "member-1",
        seq: 2,
      },
    },
  });
  await handler.handleClientMessage(session, {
    type: "room:leave",
    payload: { memberToken: "member-token-1" },
  });

  assert.deepEqual(observedTypes, [
    "room:join",
    "video:share",
    "playback:update",
    "room:leave",
  ]);
});

test("message handler accepts room:create without protocolVersion (legacy client)", async () => {
  const events: string[] = [];
  const sent: Array<{ type: string; serverProtocolVersion?: number }> = [];
  const session = createSession("legacy-creator");

  const handler = createMessageHandler({
    config: CONFIG,
    roomService: {
      async createRoomForSession(currentSession, _displayName) {
        currentSession.roomCode = "ROOM-L1";
        currentSession.memberId = "member-l1";
        currentSession.memberToken = "member-token-l1";
        return {
          room: { code: "ROOM-L1", joinToken: "join-token-l1" },
          memberToken: "member-token-l1",
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
        return {
          roomCode: "ROOM-M1",
          sharedVideo: null,
          playback: null,
          members: [{ id: "member-m1", name: "Alice" }],
        };
      },
    },
    logEvent(event) {
      events.push(event);
    },
    send(_socket, message) {
      if (
        "payload" in message &&
        message.payload &&
        "serverProtocolVersion" in message.payload
      ) {
        sent.push({
          type: message.type,
          serverProtocolVersion: (
            message.payload as { serverProtocolVersion?: number }
          ).serverProtocolVersion,
        });
      } else {
        sent.push({ type: message.type });
      }
    },
    sendError() {
      throw new Error("sendError should not be called");
    },
    async publishRoomEvent() {},
    instanceId: "node-a",
  });

  await handler.handleClientMessage(session, {
    type: "room:create",
    payload: { displayName: "Alice" },
  });

  assert.ok(events.includes("protocol_version_missing"));
  assert.ok(events.includes("room_created"));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].type, "room:created");
  assert.equal(sent[0].serverProtocolVersion, 2);
  assert.equal(sent[1].type, "room:state");
});

test("message handler rejects room:create with protocolVersion below minimum", async () => {
  const events: string[] = [];
  const errors: Array<{ code: string; message: string }> = [];
  const session = createSession("old-creator");

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
        return {
          roomCode: "ROOM-M1",
          sharedVideo: null,
          playback: null,
          members: [{ id: "member-m1", name: "Alice" }],
        };
      },
    },
    logEvent(event) {
      events.push(event);
    },
    send() {
      throw new Error("send should not be called");
    },
    sendError(_socket, code, message) {
      errors.push({ code, message });
    },
    async publishRoomEvent() {},
    instanceId: "node-a",
  });

  await handler.handleClientMessage(session, {
    type: "room:create",
    payload: { displayName: "Alice", protocolVersion: 0 },
  });

  assert.ok(events.includes("protocol_version_rejected"));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "unsupported_protocol_version");
});

test("message handler rejects room:join with protocolVersion below minimum", async () => {
  const events: string[] = [];
  const errors: Array<{ code: string; message: string }> = [];
  const session = createSession("old-joiner");

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
        return {
          roomCode: "ROOM-M1",
          sharedVideo: null,
          playback: null,
          members: [{ id: "member-m1", name: "Alice" }],
        };
      },
    },
    logEvent(event) {
      events.push(event);
    },
    send() {
      throw new Error("send should not be called");
    },
    sendError(_socket, code, message) {
      errors.push({ code, message });
    },
    async publishRoomEvent() {},
    instanceId: "node-a",
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      protocolVersion: 0,
    },
  });

  assert.ok(events.includes("protocol_version_rejected"));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "unsupported_protocol_version");
});

test("message handler accepts room:join with matching protocolVersion and returns serverProtocolVersion", async () => {
  const sent: Array<{ type: string; serverProtocolVersion?: number }> = [];
  const session = createSession("modern-joiner");

  const handler = createMessageHandler({
    config: CONFIG,
    roomService: {
      async createRoomForSession() {
        throw new Error("unreachable");
      },
      async joinRoomForSession(currentSession) {
        currentSession.roomCode = "ROOM-M1";
        currentSession.memberId = "member-m1";
        currentSession.memberToken = "member-token-m1";
        return {
          room: { code: "ROOM-M1" },
          memberToken: "member-token-m1",
        };
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
        return {
          roomCode: "ROOM-M1",
          sharedVideo: null,
          playback: null,
          members: [{ id: "member-m1", name: "Alice" }],
        };
      },
    },
    logEvent() {},
    send(_socket, message) {
      if (
        "payload" in message &&
        message.payload &&
        "serverProtocolVersion" in message.payload
      ) {
        sent.push({
          type: message.type,
          serverProtocolVersion: (
            message.payload as { serverProtocolVersion?: number }
          ).serverProtocolVersion,
        });
      } else {
        sent.push({ type: message.type });
      }
    },
    sendError() {
      throw new Error("sendError should not be called");
    },
    async publishRoomEvent() {},
    instanceId: "node-a",
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      protocolVersion: 2,
    },
  });

  assert.equal(sent.length, 2);
  assert.equal(sent[0].type, "room:joined");
  assert.equal(sent[0].serverProtocolVersion, 2);
  assert.equal(sent[1].type, "room:state");
});

test("message handler waits for room join hook before bootstrap state", async () => {
  const sent: string[] = [];
  const session = createSession("joiner");
  let roomJoinHookFlushed = false;
  let roomStateReadAfterFlush = false;

  const handler = createMessageHandler({
    config: CONFIG,
    roomService: {
      async createRoomForSession() {
        throw new Error("unreachable");
      },
      async joinRoomForSession(currentSession) {
        currentSession.roomCode = "ROOM01";
        currentSession.memberId = "member-2";
        currentSession.memberToken = "member-token-2";
        return {
          room: { code: "ROOM01" },
          memberToken: "member-token-2",
        };
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
        roomStateReadAfterFlush = roomJoinHookFlushed;
        return {
          roomCode: "ROOM01",
          sharedVideo: null,
          playback: null,
          members: [{ id: "member-2", name: "Alice" }],
        };
      },
    },
    logEvent() {},
    send(_socket, message) {
      sent.push(message.type);
    },
    sendError() {
      throw new Error("sendError should not be called");
    },
    async publishRoomEvent() {},
    async onRoomJoined() {
      await Promise.resolve();
      roomJoinHookFlushed = true;
    },
    instanceId: "node-a",
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      protocolVersion: 2,
    },
  });

  assert.deepEqual(sent, ["room:joined", "room:state"]);
  assert.equal(roomStateReadAfterFlush, true);
});

test("message handler keeps room:join successful when bootstrap state fails", async () => {
  const sent: string[] = [];
  const errors: string[] = [];
  const events: string[] = [];
  const published: string[] = [];
  const session = createSession("joiner");

  const handler = createMessageHandler({
    config: CONFIG,
    roomService: {
      async createRoomForSession() {
        throw new Error("unreachable");
      },
      async joinRoomForSession(currentSession) {
        currentSession.roomCode = "ROOM01";
        currentSession.memberId = "member-2";
        currentSession.memberToken = "member-token-2";
        return {
          room: { code: "ROOM01" },
          memberToken: "member-token-2",
        };
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
        throw new Error("transient room state read failure");
      },
    },
    logEvent(event) {
      events.push(event);
    },
    send(_socket, message) {
      sent.push(message.type);
    },
    sendError(_socket, code) {
      errors.push(code);
    },
    async publishRoomEvent(message) {
      published.push(message.type);
    },
    instanceId: "node-a",
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      protocolVersion: 2,
    },
  });

  assert.deepEqual(sent, ["room:joined"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(published, ["room_member_joined"]);
  assert.ok(events.includes("room_state_bootstrap_failed"));
  assert.ok(events.includes("room_joined"));
});

test("message handler keeps room:join successful when room join hook fails", async () => {
  const sent: string[] = [];
  const errors: string[] = [];
  const events: string[] = [];
  const published: string[] = [];
  const session = createSession("joiner");

  const handler = createMessageHandler({
    config: CONFIG,
    roomService: {
      async createRoomForSession() {
        throw new Error("unreachable");
      },
      async joinRoomForSession(currentSession) {
        currentSession.roomCode = "ROOM01";
        currentSession.memberId = "member-2";
        currentSession.memberToken = "member-token-2";
        return {
          room: { code: "ROOM01" },
          memberToken: "member-token-2",
        };
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
        return {
          roomCode: "ROOM01",
          sharedVideo: null,
          playback: null,
          members: [{ id: "member-2", name: "Alice" }],
        };
      },
    },
    logEvent(event) {
      events.push(event);
    },
    send(_socket, message) {
      sent.push(message.type);
    },
    sendError(_socket, code) {
      errors.push(code);
    },
    async publishRoomEvent(message) {
      published.push(message.type);
    },
    async onRoomJoined() {
      throw new Error("runtime index unavailable");
    },
    instanceId: "node-a",
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      protocolVersion: 2,
    },
  });

  assert.deepEqual(sent, ["room:joined", "room:state"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(published, ["room_member_joined"]);
  assert.ok(events.includes("room_join_hook_failed"));
  assert.ok(events.includes("room_joined"));
});

test("message handler keeps room:join successful when member joined publish fails", async () => {
  const sent: string[] = [];
  const errors: string[] = [];
  const events: string[] = [];
  const session = createSession("joiner");

  const handler = createMessageHandler({
    config: CONFIG,
    roomService: {
      async createRoomForSession() {
        throw new Error("unreachable");
      },
      async joinRoomForSession(currentSession) {
        currentSession.roomCode = "ROOM01";
        currentSession.memberId = "member-2";
        currentSession.memberToken = "member-token-2";
        return {
          room: { code: "ROOM01" },
          memberToken: "member-token-2",
        };
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
        return {
          roomCode: "ROOM01",
          sharedVideo: null,
          playback: null,
          members: [{ id: "member-2", name: "Alice" }],
        };
      },
    },
    logEvent(event) {
      events.push(event);
    },
    send(_socket, message) {
      sent.push(message.type);
    },
    sendError(_socket, code) {
      errors.push(code);
    },
    async publishRoomEvent() {
      throw new Error("publish failed");
    },
    instanceId: "node-a",
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      protocolVersion: 2,
    },
  });

  assert.deepEqual(sent, ["room:joined", "room:state"]);
  assert.deepEqual(errors, []);
  assert.ok(events.includes("room_event_publish_failed"));
  assert.ok(events.includes("room_joined"));
});

test("message handler skips joined delta when session leaves during bootstrap state", async () => {
  const sent: string[] = [];
  const errors: string[] = [];
  const events: string[] = [];
  const published: string[] = [];
  const session = createSession("joiner");

  const handler = createMessageHandler({
    config: CONFIG,
    roomService: {
      async createRoomForSession() {
        throw new Error("unreachable");
      },
      async joinRoomForSession(currentSession) {
        currentSession.roomCode = "ROOM01";
        currentSession.memberId = "member-2";
        currentSession.memberToken = "member-token-2";
        return {
          room: { code: "ROOM01" },
          memberToken: "member-token-2",
        };
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
      async getRoomStateForSession(currentSession) {
        currentSession.connectionState = "detached";
        currentSession.socket = null;
        currentSession.roomCode = null;
        currentSession.memberId = null;
        currentSession.memberToken = null;
        return {
          roomCode: "ROOM01",
          sharedVideo: null,
          playback: null,
          members: [{ id: "member-2", name: "Alice" }],
        };
      },
    },
    logEvent(event) {
      events.push(event);
    },
    send(_socket, message) {
      sent.push(message.type);
    },
    sendError(_socket, code) {
      errors.push(code);
    },
    async publishRoomEvent(message) {
      published.push(message.type);
    },
    instanceId: "node-a",
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      protocolVersion: 2,
    },
  });

  assert.deepEqual(sent, ["room:joined"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(published, []);
  assert.ok(events.includes("room_join_delta_skipped"));
  assert.ok(!events.includes("room_joined"));
});
