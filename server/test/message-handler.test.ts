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
  await handler.flushPendingPublishes();

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
  await handler.flushPendingPublishes();

  assert.equal(session.roomCode, null);
  assert.deepEqual(left, ["ROOM01"]);
  assert.ok(events.includes("room_event_publish_failed"));
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
        throw new Error("unreachable");
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
        throw new Error("unreachable");
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
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "room:created");
  assert.equal(sent[0].serverProtocolVersion, 1);
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
        throw new Error("unreachable");
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
        throw new Error("unreachable");
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
        throw new Error("unreachable");
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
      protocolVersion: 1,
    },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "room:joined");
  assert.equal(sent[0].serverProtocolVersion, 1);
});

function createBackpressureRoomService() {
  return {
    async createRoomForSession(currentSession: Session, displayName?: string) {
      currentSession.roomCode = `ROOM-${currentSession.id}`;
      currentSession.memberId = `member-${currentSession.id}`;
      currentSession.displayName = displayName ?? currentSession.displayName;
      currentSession.memberToken = `token-${currentSession.id}`;
      return {
        room: {
          code: `ROOM-${currentSession.id}`,
          joinToken: `join-${currentSession.id}`,
        },
        memberToken: `token-${currentSession.id}`,
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
  };
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
    const session = createSession(`s${i}`);
    calls.push(
      handler.handleClientMessage(session, {
        type: "room:create",
        payload: { displayName: `n${i}` },
      }),
    );
  }

  await flushMicrotasks();
  // At this point the first two publishes should be in flight and the
  // remaining four calls should be parked in the backpressure wait.
  assert.equal(inFlight, 2);
  assert.equal(maxInFlight, 2);
  assert.equal(releases.length, 2);

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
  });

  // Caller 1 occupies the only slot; its publish stays in-flight.
  const first = handler.handleClientMessage(createSession("s-first"), {
    type: "room:create",
    payload: { displayName: "first" },
  });
  await flushMicrotasks();
  assert.equal(release.length, 1);

  // Caller 2 enters the backpressure wait and should drop after ~30ms.
  const second = handler.handleClientMessage(createSession("s-second"), {
    type: "room:create",
    payload: { displayName: "second" },
  });

  await second;
  // Drop must be recorded with the right reason context.
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, "create_room_broadcast_failed");

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

  const first = handler.handleClientMessage(createSession("s-hung"), {
    type: "room:create",
    payload: { displayName: "hung" },
  });
  await first;

  // Wait long enough for the wrapper timeout to fire and free the slot.
  await new Promise((resolve) => setTimeout(resolve, 60));
  await handler.flushPendingPublishes();

  assert.equal(timeoutEvents.length, 1);
  assert.equal(timeoutEvents[0].reason, "create_room_broadcast_failed");
  assert.equal(timeoutEvents[0].timeoutMs, 30);
  // Underlying publish never rejected, so the failed-event log must stay quiet.
  assert.equal(failedEvents.length, 0);
});
