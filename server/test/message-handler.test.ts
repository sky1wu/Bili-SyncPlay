import assert from "node:assert/strict";
import test from "node:test";
import { getDefaultSecurityConfig } from "../src/app.js";
import { createMessageHandler } from "../src/message-handler.js";
import { CURRENT_PROTOCOL_VERSION } from "../src/messages.js";
import { RoomServiceError } from "../src/room-service.js";
import { createSessionRateLimitState } from "../src/rate-limit.js";
import type { AttachedSession, SecurityConfig, Session } from "../src/types.js";

const CONFIG: SecurityConfig = {
  ...getDefaultSecurityConfig(),
  maxMembersPerRoom: 8,
  rateLimits: {
    ...getDefaultSecurityConfig().rateLimits,
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

function createSession(
  id: string,
  overrides: Partial<AttachedSession> = {},
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
    } as unknown as AttachedSession["socket"],
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

test("message handler exposes retryable room resolution only to clients that implement it", async () => {
  async function run(
    protocolVersion: number,
    messageType: "room:join" | "room:create" = "room:join",
  ) {
    const errors: Array<{ code: string; message: string }> = [];
    const handler = createMessageHandler({
      config: CONFIG,
      roomService: {
        async createRoomForSession() {
          throw new RoomServiceError(
            "room_resolution_unconfirmed",
            "Internal server error.",
            "room_resolution_unconfirmed",
          );
        },
        async joinRoomForSession() {
          throw new RoomServiceError(
            "room_resolution_unconfirmed",
            "Internal server error.",
            "room_resolution_unconfirmed",
          );
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
      sendError(_socket, code, message) {
        errors.push({ code, message });
      },
      async publishRoomEvent() {},
      instanceId: "node-a",
    });

    const session = createSession(`client-${protocolVersion}-${messageType}`);
    if (messageType === "room:create") {
      await handler.handleClientMessage(session, {
        type: "room:create",
        payload: { protocolVersion },
      });
    } else {
      await handler.handleClientMessage(session, {
        type: "room:join",
        payload: {
          roomCode: "ROOM01",
          joinToken: "join-token-1",
          protocolVersion,
        },
      });
    }
    return errors;
  }

  assert.deepEqual(await run(5), [
    {
      code: "room_resolution_unconfirmed",
      message: "Internal server error.",
    },
  ]);
  assert.deepEqual(await run(4), [
    { code: "room_not_found", message: "Room not found." },
  ]);
  assert.deepEqual(await run(4, "room:create"), [
    { code: "internal_error", message: "Internal server error." },
  ]);
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
  await handler.flushPendingPublishes();

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

test("message handler aborts room:create when the room join hook fails", async () => {
  // The hook puts the session into the room index, and everything the create
  // sends next is read back off that index. Carrying on used to seat a member
  // the room could not see: their bootstrap state was missing them, and a
  // stored sharer reconnecting into that room got a stand-in owner with no full
  // state to follow (#242).
  const leaveReasons: (string | undefined)[] = [];
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
      async leaveRoomForSession(_session, reason) {
        leaveReasons.push(reason);
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

  assert.deepEqual(sent, []);
  assert.deepEqual(errors, ["internal_error"]);
  assert.ok(events.includes("room_join_hook_failed"));
  assert.ok(events.includes("room_join_aborted"));
  assert.equal(events.includes("room_created"), false);
  // `"disconnect"`, so a reconnecting member keeps the identity the whole
  // ownership rule depends on.
  assert.deepEqual(leaveReasons, ["disconnect"]);
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
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 12,
        playState: "playing",
        playbackRate: 1,
        updatedAt: 100,
        serverTime: 0,
        actorId: "member-1",
        seq: 1,
      },
    },
  });
  await handler.flushPendingPublishes();

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
  await handler.flushPendingPublishes();

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
      recordRoomEventPublishDropped() {},
      recordRateLimited() {},
      recordSessionProtocolVersion() {},
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
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
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
    type: "sync:request",
    payload: { memberToken: "member-token-1" },
  });
  await handler.handleClientMessage(session, {
    type: "room:leave",
    payload: { memberToken: "member-token-1" },
  });

  assert.deepEqual(observedTypes, [
    "room:join",
    "video:share",
    "playback:update",
    "sync:request",
    "room:leave",
  ]);
});

test("message handler records rate-limited messages with their message type", async () => {
  const rateLimitedTypes: string[] = [];
  const session = createSession("pinger");

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
    now: () => 0,
    metricsCollector: {
      observeMessageHandlerDuration() {},
      recordRoomEventPublishDropped() {},
      recordRateLimited(messageType) {
        rateLimitedTypes.push(messageType);
      },
      recordSessionProtocolVersion() {},
    },
  });

  // syncPingBurst is 2 with a frozen clock, so the third ping is limited.
  for (let index = 0; index < 3; index += 1) {
    await handler.handleClientMessage(session, {
      type: "sync:ping",
      payload: { clientSendTime: 1 },
    });
  }

  assert.deepEqual(rateLimitedTypes, ["sync:ping"]);
});

test("message handler records the negotiated protocol version once per session", async () => {
  const recordedVersions: string[] = [];
  const session = createSession("versioned-member");
  const legacySession = createSession("legacy-member");
  const futureSession = createSession("future-member");

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
    metricsCollector: {
      observeMessageHandlerDuration() {},
      recordRoomEventPublishDropped() {},
      recordRateLimited() {},
      recordSessionProtocolVersion(protocolVersion) {
        recordedVersions.push(protocolVersion);
      },
    },
  });

  const joinPayload = {
    roomCode: "ROOM01",
    joinToken: "join-token-1",
    displayName: "Alice",
    protocolVersion: 2,
  };
  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: joinPayload,
  });
  // Re-joining with the same session must not double-count it.
  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: joinPayload,
  });
  await handler.handleClientMessage(legacySession, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      displayName: "Bob",
    },
  });
  // Client-supplied versions above the server's current version must collapse
  // into one bucket so hostile clients cannot mint unbounded label values.
  await handler.handleClientMessage(futureSession, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      displayName: "Mallory",
      protocolVersion: 9999,
    },
  });

  assert.deepEqual(recordedVersions, ["2", "legacy", "future"]);
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
  assert.equal(sent[0].serverProtocolVersion, CURRENT_PROTOCOL_VERSION);
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
      protocolVersion: CURRENT_PROTOCOL_VERSION,
    },
  });

  assert.equal(sent.length, 2);
  assert.equal(sent[0].type, "room:joined");
  assert.equal(sent[0].serverProtocolVersion, CURRENT_PROTOCOL_VERSION);
  assert.equal(sent[1].type, "room:state");
});

test("message handler accepts room:join from a still-supported older protocol version", async () => {
  // v2 clients (below CURRENT but >= MIN) stay in the compatibility window: the
  // server accepts them and advertises its CURRENT version. The v3 `naturalEnd`
  // playback flag and the v4 `room:state.playbackAgeMs` are additive. The v5
  // retryable room-resolution result is gated at the server boundary, so these
  // older clients remain inside the compatibility window too.
  const sent: Array<{ type: string; serverProtocolVersion?: number }> = [];
  const session = createSession("older-joiner");

  const handler = createMessageHandler({
    config: CONFIG,
    roomService: {
      async createRoomForSession() {
        throw new Error("unreachable");
      },
      async joinRoomForSession(currentSession) {
        currentSession.roomCode = "ROOM-O1";
        currentSession.memberId = "member-o1";
        currentSession.memberToken = "member-token-o1";
        return {
          room: { code: "ROOM-O1" },
          memberToken: "member-token-o1",
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
          roomCode: "ROOM-O1",
          sharedVideo: null,
          playback: null,
          members: [{ id: "member-o1", name: "Bob" }],
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

  assert.equal(session.protocolVersion, 2);
  assert.equal(sent[0].type, "room:joined");
  assert.equal(sent[0].serverProtocolVersion, CURRENT_PROTOCOL_VERSION);
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
  // The failed read means we cannot tell whether this join took the share back,
  // so the room gets a full state anyway rather than being left pointing at a
  // stand-in with nothing scheduled to correct it (#235).
  assert.deepEqual(published, ["room_member_joined", "room_state_updated"]);
  assert.ok(events.includes("room_state_bootstrap_failed"));
  assert.ok(events.includes("room_joined"));
});

test("message handler aborts room:join when the room join hook fails", async () => {
  // Mirror of the create path: a joiner the room index never received is
  // missing from every state built off the shared view, so refusing the join —
  // which the client simply retries — beats seating them (#242).
  const leaveReasons: (string | undefined)[] = [];
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
      async leaveRoomForSession(_session, reason) {
        leaveReasons.push(reason);
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
  await handler.flushPendingPublishes();

  assert.deepEqual(sent, []);
  assert.deepEqual(errors, ["internal_error"]);
  // Nothing is announced: the room never gained this member.
  assert.deepEqual(published, []);
  assert.ok(events.includes("room_join_hook_failed"));
  assert.ok(events.includes("room_join_aborted"));
  assert.equal(events.includes("room_joined"), false);
  assert.deepEqual(leaveReasons, ["disconnect"]);
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

function createBackpressureRoomService() {
  return {
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
    async updateProfileForSession(currentSession: Session) {
      return {
        room: { code: currentSession.roomCode ?? "ROOM" },
      };
    },
    async getRoomStateForSession() {
      throw new Error("unreachable");
    },
  };
}

function createBackpressureSession(id: string): Session {
  const session = createSession(id);
  session.roomCode = `ROOM-${id}`;
  session.memberId = `member-${id}`;
  session.memberToken = `token-${id}`;
  session.displayName = id;
  return session;
}

async function flushMicrotasks(): Promise<void> {
  // setImmediate yields one full event-loop turn, which is enough for any
  // chain of microtasks scheduled from a single resolution to drain.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("publish backpressure caps in-flight publishes under concurrent load", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const releases: Array<() => void> = [];

  const handler = createMessageHandler({
    config: CONFIG,
    roomService: createBackpressureRoomService(),
    logEvent() {},
    send() {},
    sendError() {
      throw new Error("sendError should not be called");
    },
    publishRoomEvent: () =>
      new Promise<void>((resolve) => {
        inFlight += 1;
        if (inFlight > maxInFlight) {
          maxInFlight = inFlight;
        }
        releases.push(() => {
          inFlight -= 1;
          resolve();
        });
      }),
    instanceId: "node-a",
    maxPendingPublishes: 2,
    backpressureWaitMs: 60_000,
  });

  const N = 6;
  const calls: Array<Promise<void>> = [];
  for (let i = 0; i < N; i += 1) {
    const session = createBackpressureSession(`s${i}`);
    calls.push(
      handler.handleClientMessage(session, {
        type: "profile:update",
        payload: { memberToken: session.memberToken!, displayName: `n${i}` },
      }),
    );
  }

  await flushMicrotasks();
  // At this point the first two publishes should be in flight and the
  // remaining four calls should be parked in the backpressure wait.
  assert.equal(inFlight, 2);
  assert.equal(maxInFlight, 2);
  const initialReleaseCount = releases.length;
  assert.equal(initialReleaseCount, 2);

  // Drain releases until every started publish has resolved. Each release
  // wakes every waiter, but only one of them grabs the freed slot
  // synchronously; the others must re-enter the wait loop, so inFlight
  // must never exceed the cap. Each slot freed unblocks the next waiter
  // which immediately starts a publish and pushes a new release.
  while (true) {
    await flushMicrotasks();
    if (releases.length === 0) {
      break;
    }
    const fn = releases.shift();
    assert.ok(fn);
    fn();
  }

  await Promise.all(calls);
  await handler.flushPendingPublishes();

  assert.equal(
    maxInFlight,
    2,
    `expected concurrent publishes capped at 2, observed ${maxInFlight}`,
  );
  assert.equal(inFlight, 0);
});

test("publish backpressure drops new events when wait deadline elapses", async () => {
  const dropped: Array<{ event: string; reason: unknown }> = [];
  const droppedMetricTypes: string[] = [];
  const release: Array<() => void> = [];

  const handler = createMessageHandler({
    config: CONFIG,
    roomService: createBackpressureRoomService(),
    logEvent(event, data) {
      if (event === "room_event_publish_dropped") {
        dropped.push({
          event,
          reason: (data as { reason?: unknown }).reason,
        });
      }
    },
    send() {},
    sendError() {
      throw new Error("sendError should not be called");
    },
    publishRoomEvent: () =>
      new Promise<void>((resolve) => {
        release.push(() => resolve());
      }),
    instanceId: "node-a",
    maxPendingPublishes: 1,
    // Tight deadline so the test does not sleep 5s.
    backpressureWaitMs: 30,
    metricsCollector: {
      observeMessageHandlerDuration() {},
      recordRoomEventPublishDropped(eventType) {
        droppedMetricTypes.push(eventType);
      },
      recordRateLimited() {},
      recordSessionProtocolVersion() {},
    },
  });

  // Caller 1 occupies the only slot; its publish stays in-flight.
  const firstSession = createBackpressureSession("s-first");
  const first = handler.handleClientMessage(firstSession, {
    type: "profile:update",
    payload: { memberToken: firstSession.memberToken!, displayName: "first" },
  });
  await flushMicrotasks();
  assert.equal(release.length, 1);

  // Caller 2 enters the backpressure wait and should drop after ~30ms.
  const secondSession = createBackpressureSession("s-second");
  const second = handler.handleClientMessage(secondSession, {
    type: "profile:update",
    payload: { memberToken: secondSession.memberToken!, displayName: "second" },
  });

  await second;
  // Drop must be recorded with the right reason context.
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, "profile_update_broadcast_failed");
  // The drop must also surface on the per-event-type metric so member-affecting
  // drops can be observed independently of high-frequency state updates.
  assert.deepEqual(droppedMetricTypes, ["room_state_updated"]);

  // Caller 1 should still complete cleanly once we release its publish.
  release[0]();
  await first;
  await handler.flushPendingPublishes();
});

test("publish wrapper times out so a hung publish frees its slot", async () => {
  const timeoutEvents: Array<{ reason: unknown; timeoutMs: unknown }> = [];
  const failedEvents: string[] = [];

  const handler = createMessageHandler({
    config: CONFIG,
    roomService: createBackpressureRoomService(),
    logEvent(event, data) {
      if (event === "room_event_publish_timeout") {
        const payload = data as { reason?: unknown; timeoutMs?: unknown };
        timeoutEvents.push({
          reason: payload.reason,
          timeoutMs: payload.timeoutMs,
        });
      }
      if (event === "room_event_publish_failed") {
        failedEvents.push(event);
      }
    },
    send() {},
    sendError() {
      throw new Error("sendError should not be called");
    },
    // Underlying publish never resolves — simulates a Redis hang.
    publishRoomEvent: () => new Promise<void>(() => {}),
    instanceId: "node-a",
    maxPendingPublishes: 1,
    // Caller should never park on the gate; the wrapper should free the slot
    // via its own timeout instead.
    backpressureWaitMs: 60_000,
    publishTimeoutMs: 30,
  });

  const hungSession = createBackpressureSession("s-hung");
  const first = handler.handleClientMessage(hungSession, {
    type: "profile:update",
    payload: { memberToken: hungSession.memberToken!, displayName: "hung" },
  });
  await first;

  // Wait long enough for the wrapper timeout to fire and free the slot.
  await new Promise((resolve) => setTimeout(resolve, 60));
  await handler.flushPendingPublishes();

  assert.equal(timeoutEvents.length, 1);
  assert.equal(timeoutEvents[0].reason, "profile_update_broadcast_failed");
  assert.equal(timeoutEvents[0].timeoutMs, 30);
  // Underlying publish never rejected, so the failed-event log must stay quiet.
  assert.equal(failedEvents.length, 0);
});

test("room:state is aged at the send, not at the room-store read", async () => {
  // The age must cover the store read too: `getRoomStateForSession` awaits, and
  // the room keeps playing through it. Anchoring at the read would hand the
  // receiver a position already staler than the age admits.
  const sentPayloads: Array<Record<string, unknown>> = [];
  let clock = 10_000;
  const session = createSession("member-age", {
    roomCode: "ROOM-AGE",
    memberId: "member-age",
    memberToken: "member-token-age",
    joinedAt: 0,
  });

  const handler = createMessageHandler({
    config: CONFIG,
    now: () => clock,
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
        // The store read costs 400ms of room time before the send happens.
        clock += 400;
        return {
          roomCode: "ROOM-AGE",
          sharedVideo: null,
          playback: {
            url: "https://www.bilibili.com/video/BV1xx411c7mD",
            currentTime: 42,
            playState: "playing",
            playbackRate: 1,
            updatedAt: 8_000,
            serverTime: 8_000,
            actorId: "member-age",
            seq: 7,
          },
          members: [{ id: "member-age", name: "Alice" }],
        };
      },
    },
    logEvent() {},
    send(_socket, message) {
      if (message.type === "room:state") {
        sentPayloads.push(
          message.payload as unknown as Record<string, unknown>,
        );
      }
    },
    sendError() {
      throw new Error("sendError should not be called");
    },
    async publishRoomEvent() {},
    instanceId: "node-a",
  });

  await handler.handleClientMessage(session, {
    type: "sync:request",
    payload: { memberToken: "member-token-age" },
  });

  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].playbackAgeMs, 2_400);
});

/**
 * A protocol >= 2 client learns about a join/leave from `room:member-joined` /
 * `room:member-left`, which only edit its member list — its cached `sharedVideo`
 * keeps whatever owner the last full `room:state` carried. So whenever the share
 * changes hands the delta has to be followed by a `room_state_updated`, which is
 * the event the consumer answers by rebuilding and broadcasting room state
 * (#235).
 */
function createSharedOwnerHandler(options: {
  published: string[];
  leaveResult?: { memberRemoved?: boolean; needsRoomStateResync?: boolean };
  bootstrapSharedByMemberId?: string;
  bootstrapFails?: boolean;
  joinedRoomCode?: string;
  hookOrder?: string[];
  publishedRooms?: string[];
  enterRoomFails?: boolean;
  roomLeftHookFails?: boolean;
  roomJoinedHookFails?: boolean;
}) {
  return createMessageHandler({
    config: CONFIG,
    roomService: {
      async createRoomForSession(currentSession) {
        if (options.enterRoomFails) {
          // Mirrors the service: the old room is left before the failure.
          currentSession.roomCode = null;
          throw new RoomServiceError(
            "internal_error",
            "create failed",
            "internal_error",
          );
        }
        currentSession.roomCode = options.joinedRoomCode ?? "ROOM01";
        currentSession.memberId = "member-1";
        currentSession.memberToken = "member-token-1";
        return {
          room: {
            code: options.joinedRoomCode ?? "ROOM01",
            joinToken: "join-token-1",
          },
          memberToken: "member-token-1",
        };
      },
      async joinRoomForSession(currentSession) {
        if (options.enterRoomFails) {
          currentSession.roomCode = null;
          throw new RoomServiceError("room_full", "room full", "room_full");
        }
        currentSession.roomCode = options.joinedRoomCode ?? "ROOM01";
        currentSession.memberId = "member-1";
        currentSession.memberToken = "member-token-1";
        return {
          room: { code: options.joinedRoomCode ?? "ROOM01" },
          memberToken: "member-token-1",
        };
      },
      async leaveRoomForSession(currentSession) {
        currentSession.roomCode = null;
        return {
          room: { code: "ROOM01" },
          memberRemoved: true,
          ...options.leaveResult,
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
        if (options.bootstrapFails) {
          throw new Error("transient room state read failure");
        }
        return {
          roomCode: options.joinedRoomCode ?? "ROOM01",
          // The bootstrap state is already resolved against the live member
          // list, which is exactly what the join path reads back.
          sharedVideo: options.bootstrapSharedByMemberId
            ? {
                videoId: "BV1xx411c7mD",
                url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
                title: "Test Episode",
                sharedByMemberId: options.bootstrapSharedByMemberId,
              }
            : null,
          playback: null,
          members: [{ id: "member-1", name: "Alice" }],
        };
      },
    },
    logEvent() {},
    send() {},
    sendError() {},
    async publishRoomEvent(message) {
      options.published.push(message.type);
      options.publishedRooms?.push(message.roomCode);
    },
    instanceId: "node-a",
    onRoomLeft() {
      options.hookOrder?.push("room-left-hook");
      if (options.roomLeftHookFails) {
        // Stands in for the queued room-index write failing to flush.
        throw new Error("runtime flush failed");
      }
    },
    onRoomJoined() {
      options.hookOrder?.push("room-joined-hook");
      if (options.roomJoinedHookFails) {
        // Stands in for the room-index write failing, which refuses the join.
        throw new Error("runtime index unavailable");
      }
    },
  });
}

test("a leave that moves the share follows the delta with a full room state", async () => {
  const published: string[] = [];
  const session = createSession("member-1", {
    roomCode: "ROOM01",
    memberId: "member-1",
    memberToken: "member-token-1",
  });
  const handler = createSharedOwnerHandler({
    published,
    leaveResult: { needsRoomStateResync: true },
  });

  await handler.handleClientMessage(session, {
    type: "room:leave",
    payload: { memberToken: "member-token-1" },
  });
  await handler.flushPendingPublishes();

  // Order matters: the authoritative state has to be the last word, and both
  // events ride the same channel.
  assert.deepEqual(published, ["room_member_left", "room_state_updated"]);
});

test("a leave that leaves the share alone publishes only the delta", async () => {
  const published: string[] = [];
  const session = createSession("member-1", {
    roomCode: "ROOM01",
    memberId: "member-1",
    memberToken: "member-token-1",
  });
  const handler = createSharedOwnerHandler({
    published,
    leaveResult: { needsRoomStateResync: false },
  });

  await handler.handleClientMessage(session, {
    type: "room:leave",
    payload: { memberToken: "member-token-1" },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(published, ["room_member_left"]);
});

test("a joiner who ends up owning the share triggers a full room state", async () => {
  const published: string[] = [];
  const session = createSession("member-1");
  const handler = createSharedOwnerHandler({
    published,
    bootstrapSharedByMemberId: "member-1",
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      displayName: "Alice",
    },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(published, ["room_member_joined", "room_state_updated"]);
});

test("somebody else joining leaves the share where it is", async () => {
  // A join can only move the share by winning it, so a joiner who is not the
  // owner in their own bootstrap state changed nothing for anybody.
  const published: string[] = [];
  const session = createSession("member-1");
  const handler = createSharedOwnerHandler({
    published,
    bootstrapSharedByMemberId: "member-elsewhere",
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      displayName: "Alice",
    },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(published, ["room_member_joined"]);
});

test("a failed bootstrap read still asks the room for a full state", async () => {
  // `undefined` owner and "the read blew up" used to be the same answer, so a
  // transient store error during the returning sharer's join skipped the resync
  // and left everybody else on the stand-in (#235 review).
  const published: string[] = [];
  const session = createSession("member-1");
  const handler = createSharedOwnerHandler({ published, bootstrapFails: true });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      displayName: "Alice",
    },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(published, ["room_member_joined", "room_state_updated"]);
});

test("switching rooms tells the room being left", async () => {
  // `joinRoomForSession` leaves the previous room internally and publishes
  // nothing, so the old room heard neither that the member left nor that the
  // share left with them (#235 review). One full state covers both.
  const published: string[] = [];
  const publishedRooms: string[] = [];
  const session = createSession("member-1", {
    roomCode: "ROOM-OLD",
    memberId: "member-1",
    memberToken: "member-token-1",
  });
  const handler = createSharedOwnerHandler({
    published,
    publishedRooms,
    joinedRoomCode: "ROOM-NEW",
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM-NEW",
      joinToken: "join-token-1",
      displayName: "Alice",
    },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(published, [
    "room_member_left",
    "room_state_updated",
    "room_member_joined",
  ]);
  assert.deepEqual(publishedRooms, ["ROOM-OLD", "ROOM-OLD", "ROOM-NEW"]);
});

test("creating a room tells the room being left", async () => {
  const published: string[] = [];
  const publishedRooms: string[] = [];
  const session = createSession("member-1", {
    roomCode: "ROOM-OLD",
    memberId: "member-1",
    memberToken: "member-token-1",
  });
  const handler = createSharedOwnerHandler({
    published,
    publishedRooms,
    joinedRoomCode: "ROOM-NEW",
  });

  await handler.handleClientMessage(session, {
    type: "room:create",
    payload: { displayName: "Alice" },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(published, ["room_member_left", "room_state_updated"]);
  assert.deepEqual(publishedRooms, ["ROOM-OLD", "ROOM-OLD"]);
});

test("re-entering the same room resyncs it but announces no departure", async () => {
  // Nobody left, so no `room:member-left` — but the service still leaves and
  // rejoins internally, which re-stamps `joinedAt` and can issue a fresh
  // `memberId`. Either can hand the share to a member who was already seated,
  // and the owner check stays silent because this joiner did not end up owning
  // it (#235 review).
  const published: string[] = [];
  const publishedRooms: string[] = [];
  const session = createSession("member-1", {
    roomCode: "ROOM01",
    memberId: "member-1",
    memberToken: "member-token-1",
  });
  const handler = createSharedOwnerHandler({
    published,
    publishedRooms,
    bootstrapSharedByMemberId: "member-elsewhere",
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      displayName: "Alice",
    },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(published, ["room_member_joined", "room_state_updated"]);
  assert.deepEqual(publishedRooms, ["ROOM01", "ROOM01"]);
});

test("a first join into a room resyncs nothing on the joiner's behalf", async () => {
  // The session was not in any room, so there is no re-entry and this joiner
  // does not own the share — the room learns of them through the delta alone.
  const published: string[] = [];
  const session = createSession("member-1");
  const handler = createSharedOwnerHandler({
    published,
    bootstrapSharedByMemberId: "member-elsewhere",
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      displayName: "Alice",
    },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(published, ["room_member_joined"]);
});

test("nothing is published for a leave until the room-left hook has settled", async () => {
  // The hook clears the session out of the room index. Publishing first lets a
  // consumer rebuild `room:state` from an index that still lists the leaver,
  // who then reappears in the snapshot and can win the share straight back
  // (#235 review).
  const hookOrder: string[] = [];
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
        return {
          room: { code: "ROOM01" },
          memberRemoved: true,
          needsRoomStateResync: true,
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
    sendError() {},
    async publishRoomEvent(message) {
      hookOrder.push(`publish:${message.type}`);
      published.push(message.type);
    },
    instanceId: "node-a",
    async onRoomLeft() {
      // Stands in for the queued index write the real hook flushes.
      await Promise.resolve();
      hookOrder.push("hook-settled");
    },
  });

  await handler.handleClientMessage(session, {
    type: "room:leave",
    payload: { memberToken: "member-token-1" },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(hookOrder, [
    "hook-settled",
    "publish:room_member_left",
    "publish:room_state_updated",
  ]);
});

test("a failed room-left hook suppresses the full state but not the delta", async () => {
  // The hook's failure is the room-index write not landing. A `room:state` built
  // now would be rebuilt from an index that still lists the leaver, handing them
  // the share straight back and corrupting the roster on the way (#235 review).
  // The delta reads no state, so it still goes out.
  const published: string[] = [];
  const session = createSession("member-1", {
    roomCode: "ROOM01",
    memberId: "member-1",
    memberToken: "member-token-1",
  });
  const handler = createSharedOwnerHandler({
    published,
    leaveResult: { needsRoomStateResync: true },
    roomLeftHookFails: true,
  });

  await handler.handleClientMessage(session, {
    type: "room:leave",
    payload: { memberToken: "member-token-1" },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(published, ["room_member_left"]);
});

test("a failed join still releases the room it already left", async () => {
  // `joinRoomForSession` leaves the current room before it can fail on a full
  // room or a bad token. The release used to run only after success, so the old
  // room kept a ghost session in its index — one that could win the share
  // election (#235 review).
  const published: string[] = [];
  const publishedRooms: string[] = [];
  const hookOrder: string[] = [];
  const session = createSession("member-1", {
    roomCode: "ROOM-OLD",
    memberId: "member-1",
    memberToken: "member-token-1",
  });
  const handler = createSharedOwnerHandler({
    published,
    publishedRooms,
    hookOrder,
    enterRoomFails: true,
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM-NEW",
      joinToken: "join-token-1",
      displayName: "Alice",
    },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(hookOrder, ["room-left-hook"]);
  assert.deepEqual(published, ["room_member_left", "room_state_updated"]);
  assert.deepEqual(publishedRooms, ["ROOM-OLD", "ROOM-OLD"]);
});

test("a failed create still releases the room it already left", async () => {
  const published: string[] = [];
  const publishedRooms: string[] = [];
  const session = createSession("member-1", {
    roomCode: "ROOM-OLD",
    memberId: "member-1",
    memberToken: "member-token-1",
  });
  const handler = createSharedOwnerHandler({
    published,
    publishedRooms,
    enterRoomFails: true,
  });

  await handler.handleClientMessage(session, {
    type: "room:create",
    payload: { displayName: "Alice" },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(published, ["room_member_left", "room_state_updated"]);
  assert.deepEqual(publishedRooms, ["ROOM-OLD", "ROOM-OLD"]);
});

test("a create that fails before leaving releases nothing", async () => {
  // The guard is the session's own `roomCode`: unchanged means the service threw
  // before it got as far as leaving, so the old room has nothing to be told.
  const published: string[] = [];
  const hookOrder: string[] = [];
  const session = createSession("member-1", {
    roomCode: "ROOM-OLD",
    memberId: "member-1",
    memberToken: "member-token-1",
  });
  const handler = createMessageHandler({
    config: CONFIG,
    roomService: {
      async createRoomForSession() {
        throw new RoomServiceError(
          "internal_error",
          "validation failed",
          "internal_error",
        );
      },
      async joinRoomForSession() {
        throw new Error("unreachable");
      },
      async leaveRoomForSession() {
        throw new Error("unreachable");
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
    async publishRoomEvent(message) {
      published.push(message.type);
    },
    instanceId: "node-a",
    onRoomLeft() {
      hookOrder.push("room-left-hook");
    },
  });

  await handler.handleClientMessage(session, {
    type: "room:create",
    payload: { displayName: "Alice" },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(hookOrder, []);
  assert.deepEqual(published, []);
});

test("a resync survives a leave that publishes no member delta", async () => {
  // `memberRemoved` is THIS node's local removal result; `needsRoomStateResync`
  // came out of the shared view. A session replaced on another node clears no
  // local seat yet still changes who the election picks, so folding the resync
  // into the delta's early return dropped exactly that case (#235 review).
  const published: string[] = [];
  const session = createSession("member-1", {
    roomCode: "ROOM01",
    memberId: "member-1",
    memberToken: "member-token-1",
  });
  const handler = createSharedOwnerHandler({
    published,
    leaveResult: { memberRemoved: false, needsRoomStateResync: true },
  });

  await handler.handleClientMessage(session, {
    type: "room:leave",
    payload: { memberToken: "member-token-1" },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(published, ["room_state_updated"]);
});

test("switching rooms tells the old room even when the index cleanup fails", async () => {
  // Both halves go out here, unlike an explicit leave: a switcher's session hash
  // already names the NEW room, so `roomStateFromSessions` drops it from the old
  // room's roster by itself. Withholding the full state instead lost the
  // announcement permanently — nothing afterwards carries the old room code, so
  // there is no retry (#235 review).
  const published: string[] = [];
  const publishedRooms: string[] = [];
  const session = createSession("member-1", {
    roomCode: "ROOM-OLD",
    memberId: "member-1",
    memberToken: "member-token-1",
  });
  const handler = createSharedOwnerHandler({
    published,
    publishedRooms,
    joinedRoomCode: "ROOM-NEW",
    roomLeftHookFails: true,
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM-NEW",
      joinToken: "join-token-1",
      displayName: "Alice",
    },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(published, [
    "room_member_left",
    "room_state_updated",
    "room_member_joined",
  ]);
  assert.deepEqual(publishedRooms, ["ROOM-OLD", "ROOM-OLD", "ROOM-NEW"]);
});

test("a shared-owner resync that the bus rejects is retried until it lands", async () => {
  // The one broadcast nothing else repeats. It goes out precisely because the
  // room stopped advancing, so no later `video:share` / `playback:update`
  // corrects a dropped one, and an idle room never sends `sync:request` either
  // — the user would have to reload the page (#242).
  const published: string[] = [];
  let resyncFailures = 2;
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
        return {
          room: { code: "ROOM01" },
          memberRemoved: true,
          needsRoomStateResync: true,
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
    sendError() {},
    async publishRoomEvent(message) {
      if (message.type === "room_state_updated" && resyncFailures > 0) {
        resyncFailures -= 1;
        throw new Error("bus rejected");
      }
      published.push(message.type);
    },
    instanceId: "node-a",
    sharedOwnerResyncRetry: {
      initialRetryDelayMs: 1,
      sleep: () => Promise.resolve(),
    },
  });

  await handler.handleClientMessage(session, {
    type: "room:leave",
    payload: { memberToken: "member-token-1" },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(published, ["room_member_left", "room_state_updated"]);
});

test("shutdown drains the retrying shared-owner resync, not just the one-shot publishes", async () => {
  // `flushPendingPublishes` runs before the bus is torn down. A resync record
  // left behind is the broadcast nothing will ever re-send (#242).
  const published: string[] = [];
  let resyncFailures = 1;
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
        return {
          room: { code: "ROOM01" },
          memberRemoved: true,
          needsRoomStateResync: true,
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
    sendError() {},
    async publishRoomEvent(message) {
      if (message.type === "room_state_updated" && resyncFailures > 0) {
        resyncFailures -= 1;
        throw new Error("bus rejected");
      }
      published.push(message.type);
    },
    instanceId: "node-a",
    sharedOwnerResyncRetry: {
      initialRetryDelayMs: 30,
    },
  });

  await handler.handleClientMessage(session, {
    type: "room:leave",
    payload: { memberToken: "member-token-1" },
  });
  // The retry is still parked in its backoff at this point.
  assert.deepEqual(published, ["room_member_left"]);

  await handler.flushPendingPublishes();
  assert.deepEqual(published, ["room_member_left", "room_state_updated"]);
});

test("the final publish flush does not let a resync record open a second batch", async () => {
  // `flush_pending_room_event_publishes` is sized for one retry budget. A
  // request that arrived mid-batch earns a fresh one at runtime, which at
  // shutdown is two budgets in a step sized for one (#242 review).
  const published: string[] = [];
  let releaseFirstResync: (() => void) | null = null;
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
        return {
          room: { code: "ROOM01" },
          memberRemoved: true,
          needsRoomStateResync: true,
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
    sendError() {},
    publishRoomEvent(message) {
      published.push(message.type);
      if (message.type === "room_state_updated" && !releaseFirstResync) {
        return new Promise<void>((resolve) => {
          releaseFirstResync = resolve;
        });
      }
      return Promise.resolve();
    },
    instanceId: "node-a",
    sharedOwnerResyncRetry: {
      initialRetryDelayMs: 1,
      sleep: () => Promise.resolve(),
    },
  });

  // Two leaves: the second asks for a resync while the first one's publish is
  // still in flight, which is what would earn the extra batch.
  await handler.handleClientMessage(session, {
    type: "room:leave",
    payload: { memberToken: "member-token-1" },
  });
  session.roomCode = "ROOM01";
  session.memberId = "member-1";
  await handler.handleClientMessage(session, {
    type: "room:leave",
    payload: { memberToken: "member-token-1" },
  });

  const flushed = handler.flushPendingPublishes({ final: true });
  (releaseFirstResync as (() => void) | null)?.();
  await flushed;

  assert.equal(
    published.filter((type) => type === "room_state_updated").length,
    1,
    "the wind-down must not open a second resync batch",
  );
});

test("a room switch withholds the old room's full state until the join write re-stamps the session", async () => {
  // #235 published it unconditionally on the reasoning that "a switcher's
  // session hash already names the NEW room". That hash is written by
  // `onRoomLeft`'s own `registerSession`, so when the hook fails it can still
  // name the OLD room, and the state hands the switcher back in — share and all
  // (#242 review). Publishing after the JOIN hook makes it safe unconditionally:
  // that write re-stamps the whole session record under the new room code.
  const order: string[] = [];
  const session = createSession("member-1", {
    roomCode: "OLDR01",
    memberId: "member-1",
    memberToken: "member-token-1",
  });

  const handler = createSharedOwnerHandler({
    published: [],
    publishedRooms: [],
    joinedRoomCode: "NEWR01",
    hookOrder: order,
    roomLeftHookFails: true,
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "NEWR01",
      joinToken: "join-token-1",
      protocolVersion: 2,
    },
  });
  await handler.flushPendingPublishes();

  // The leave hook ran and failed; the join hook then re-stamped the record.
  assert.deepEqual(order, ["room-left-hook", "room-joined-hook"]);
});

test("a create that fails after leaving withholds the old room's state when the index is dirty", async () => {
  // Nothing re-stamps this session: the create failed, so it is in no room and
  // no later write carries the old code. A state built from an index the hook
  // could not clear still lists the switcher (#242 review).
  const published: string[] = [];
  const publishedRooms: string[] = [];
  const session = createSession("member-1", {
    roomCode: "OLDR02",
    memberId: "member-1",
    memberToken: "member-token-1",
  });

  const handler = createSharedOwnerHandler({
    published,
    publishedRooms,
    enterRoomFails: true,
    roomLeftHookFails: true,
  });

  await handler.handleClientMessage(session, {
    type: "room:create",
    payload: { displayName: "Alice" },
  });
  await handler.flushPendingPublishes();

  // The delta still goes out — it reads no state, so a dirty index cannot
  // corrupt it — but the full state does not.
  assert.deepEqual(published, ["room_member_left"]);
  assert.deepEqual(publishedRooms, ["OLDR02"]);
});

test("a create that fails after leaving still resyncs the old room when the index was cleared", async () => {
  const published: string[] = [];
  const session = createSession("member-1", {
    roomCode: "OLDR03",
    memberId: "member-1",
    memberToken: "member-token-1",
  });

  const handler = createSharedOwnerHandler({
    published,
    enterRoomFails: true,
  });

  await handler.handleClientMessage(session, {
    type: "room:create",
    payload: { displayName: "Alice" },
  });
  await handler.flushPendingPublishes();

  assert.deepEqual(published, ["room_member_left", "room_state_updated"]);
});

test("a rolled-back room switch still resyncs the old room it cleanly left", async () => {
  // The refused join is the NEW room's problem. The old room was cleanly left,
  // so it is still owed its full state — and if the leaver held the share,
  // silence there means every client keeps a `sharedByMemberId` naming them and
  // the room stops advancing (#242 review).
  const published: string[] = [];
  const publishedRooms: string[] = [];
  const session = createSession("member-1", {
    roomCode: "OLDR04",
    memberId: "member-1",
    memberToken: "member-token-1",
  });

  const handler = createSharedOwnerHandler({
    published,
    publishedRooms,
    joinedRoomCode: "NEWR04",
    roomJoinedHookFails: true,
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "NEWR04",
      joinToken: "join-token-1",
      protocolVersion: 2,
    },
  });
  await handler.flushPendingPublishes();

  // The abort's own leave announces the NEW room; what matters here is that the
  // OLD room got its full state as well as its delta.
  const oldRoomEvents = published.filter(
    (_type, index) => publishedRooms[index] === "OLDR04",
  );
  assert.deepEqual(oldRoomEvents, ["room_member_left", "room_state_updated"]);
});

test("a rolled-back room switch stays silent when the old room was not cleanly left", async () => {
  const published: string[] = [];
  const session = createSession("member-1", {
    roomCode: "OLDR05",
    memberId: "member-1",
    memberToken: "member-token-1",
  });

  const publishedRooms: string[] = [];
  const handler = createSharedOwnerHandler({
    published,
    publishedRooms,
    joinedRoomCode: "NEWR05",
    roomJoinedHookFails: true,
    roomLeftHookFails: true,
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "NEWR05",
      joinToken: "join-token-1",
      protocolVersion: 2,
    },
  });
  await handler.flushPendingPublishes();

  // Neither hook landed, so nothing can vouch for the old room's index.
  const oldRoomEvents = published.filter(
    (_type, index) => publishedRooms[index] === "OLDR05",
  );
  assert.deepEqual(oldRoomEvents, ["room_member_left"]);
});

test("a join whose rollback fails drops the socket instead of claiming it was aborted", async () => {
  // `leaveCurrentRoom` RESTORES the member when its own persistence fails and
  // the socket is still open. Telling the client the join failed while the
  // server still holds it as a member leaves the two disagreeing, and that
  // connection can go on driving playback from a seat the shared index never
  // received (#242 review).
  const errors: string[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const events: string[] = [];
  const session = createSession("member-1");
  (
    session.socket as unknown as { close: (c: number, r: string) => void }
  ).close = (code, reason) => {
    closes.push({ code, reason });
  };

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
        return { room: { code: "ROOM01" }, memberToken: "member-token-1" };
      },
      async leaveRoomForSession() {
        // The rollback cannot complete: the member stays seated.
        throw new Error("leave persistence failed");
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
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      protocolVersion: 2,
    },
  });

  assert.deepEqual(errors, ["internal_error"]);
  assert.ok(events.includes("room_join_rollback_failed"));
  assert.deepEqual(closes, [{ code: 1011, reason: "join_rollback_failed" }]);
});

test("a join whose rollback succeeds leaves the connection alone", async () => {
  const closes: number[] = [];
  const session = createSession("member-1");
  (
    session.socket as unknown as { close: (c: number, r: string) => void }
  ).close = (code) => {
    closes.push(code);
  };

  const handler = createSharedOwnerHandler({
    published: [],
    roomJoinedHookFails: true,
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      protocolVersion: 2,
    },
  });
  await handler.flushPendingPublishes();

  // The seat came back, so the client may simply retry on the same socket.
  assert.deepEqual(closes, []);
});

/**
 * `abortJoin` must treat all three ways the rollback can fail to clean the room
 * index the same. Only one of them throws; the other two resolve normally, and
 * my first fix only covered the throwing one (#242 review).
 */
async function runAbortedJoin(options: {
  leaveResult?: { room: { code: string } | null; notifyRoom?: boolean };
  leaveThrows?: boolean;
  leaveNeverSettles?: boolean;
  roomLeftHookFails?: boolean;
  joinRollbackTimeoutMs?: number;
}): Promise<{ closes: number[]; errors: string[]; events: string[] }> {
  const closes: number[] = [];
  const errors: string[] = [];
  const events: string[] = [];
  const session = createSession("member-1");
  (
    session.socket as unknown as { close: (c: number, r: string) => void }
  ).close = (code) => {
    closes.push(code);
  };

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
        return { room: { code: "ROOM01" }, memberToken: "member-token-1" };
      },
      async leaveRoomForSession() {
        if (options.leaveNeverSettles) {
          // The rollback's own index write is queued behind a command that
          // never answers: it neither resolves nor rejects.
          await new Promise<void>(() => {});
        }
        if (options.leaveThrows) {
          throw new Error("leave persistence failed");
        }
        return {
          memberRemoved: true,
          ...(options.leaveResult ?? { room: { code: "ROOM01" } }),
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
    sendError(_socket, code) {
      errors.push(code);
    },
    async publishRoomEvent() {},
    instanceId: "node-a",
    joinRollbackTimeoutMs: options.joinRollbackTimeoutMs,
    async onRoomJoined() {
      throw new Error("runtime index unavailable");
    },
    onRoomLeft() {
      if (options.roomLeftHookFails) {
        throw new Error("index cleanup failed");
      }
    },
  });

  await handler.handleClientMessage(session, {
    type: "room:join",
    payload: {
      roomCode: "ROOM01",
      joinToken: "join-token-1",
      protocolVersion: 2,
    },
  });
  await handler.flushPendingPublishes();
  return { closes, errors, events };
}

test("an aborted join drops the socket when the leave call throws", async () => {
  const { closes, errors } = await runAbortedJoin({ leaveThrows: true });
  assert.deepEqual(errors, ["internal_error"]);
  assert.deepEqual(closes, [1011]);
});

test("an aborted join drops the socket when the room-left hook reports failure", async () => {
  // Resolves normally — `runRoomLeftHook` swallows the error — so only the
  // RETURNED verdict reveals that the index was never cleaned.
  const { closes, errors } = await runAbortedJoin({ roomLeftHookFails: true });
  assert.deepEqual(errors, ["internal_error"]);
  assert.deepEqual(closes, [1011]);
});

test("an aborted join drops the socket when the leave never reaches the hook", async () => {
  // `!room && !notifyRoom` returns before `runRoomLeftHook` runs at all, so
  // `markSessionLeftRoom` never went out and the index still lists the session.
  const { closes, errors } = await runAbortedJoin({
    leaveResult: { room: null },
  });
  assert.deepEqual(errors, ["internal_error"]);
  assert.deepEqual(closes, [1011]);
});

test("an aborted join whose rollback cleaned the index keeps the connection", async () => {
  const { closes, errors } = await runAbortedJoin({});
  assert.deepEqual(errors, ["internal_error"]);
  assert.deepEqual(closes, [], "the client may retry on the same socket");
});

test("an aborted join answers the client when its rollback never settles", async () => {
  // The rollback's index write queues behind the join write's command, and a
  // command that never answers neither resolves nor rejects — so the error and
  // the socket close were unreachable and the client sat on a join that had
  // already failed (#242 review).
  const { closes, errors, events } = await runAbortedJoin({
    leaveNeverSettles: true,
    joinRollbackTimeoutMs: 30,
  });
  assert.deepEqual(errors, ["internal_error"]);
  assert.deepEqual(closes, [1011]);
  assert.ok(events.includes("room_join_rollback_timeout"));
});
