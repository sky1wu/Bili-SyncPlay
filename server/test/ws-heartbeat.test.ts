import assert from "node:assert/strict";
import test from "node:test";
import {
  createWsHeartbeat,
  type HeartbeatSocket,
} from "../src/ws-heartbeat.js";
import type { LogEvent, Session } from "../src/types.js";

type FakeSocket = HeartbeatSocket & {
  pingCount: number;
  terminated: boolean;
  emit: (event: "pong" | "close") => void;
};

function createFakeSocket(
  overrides: Partial<HeartbeatSocket> = {},
): FakeSocket {
  const listeners = new Map<"pong" | "close", Array<() => void>>();
  const socket: FakeSocket = {
    readyState: 1,
    OPEN: 1,
    pingCount: 0,
    terminated: false,
    ping() {
      socket.pingCount += 1;
    },
    terminate() {
      socket.terminated = true;
      socket.emit("close");
    },
    on(event, listener) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
      return socket;
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
    ...overrides,
  };
  return socket;
}

function createSession(id: string, roomCode: string | null = null): Session {
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
    instanceId: "test-node",
    remoteAddress: null,
    origin: null,
    roomCode,
    memberId: null,
    memberToken: null,
    displayName: id,
    joinedAt: null,
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

function createHeartbeatHarness(options?: { enabled?: boolean }) {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const logEvent: LogEvent = (event, data) => {
    events.push({ event, data });
  };
  const heartbeat = createWsHeartbeat({
    enabled: options?.enabled ?? true,
    intervalMs: 30_000,
    logEvent,
  });
  return { heartbeat, events };
}

test("ws heartbeat pings tracked sockets and keeps responsive ones alive", () => {
  const { heartbeat, events } = createHeartbeatHarness();
  const socket = createFakeSocket();
  heartbeat.track(socket, createSession("session-1"));

  for (let sweep = 0; sweep < 5; sweep += 1) {
    const terminated = heartbeat.sweepNow();
    assert.equal(terminated, 0);
    socket.emit("pong");
  }

  assert.equal(socket.pingCount, 5);
  assert.equal(socket.terminated, false);
  assert.equal(events.length, 0);
});

test("ws heartbeat terminates a socket after two consecutive missed pongs", () => {
  const { heartbeat, events } = createHeartbeatHarness();
  const socket = createFakeSocket();
  heartbeat.track(socket, createSession("session-1", "ROOM01"));

  assert.equal(heartbeat.sweepNow(), 0);
  assert.equal(heartbeat.sweepNow(), 0);
  assert.equal(socket.terminated, false);

  assert.equal(heartbeat.sweepNow(), 1);
  assert.equal(socket.terminated, true);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, "ws_heartbeat_timeout_terminated");
  assert.equal(events[0]?.data.sessionId, "session-1");
  assert.equal(events[0]?.data.roomCode, "ROOM01");
  assert.equal(events[0]?.data.missedPongs, 2);
});

test("ws heartbeat resets the miss counter when a late pong arrives", () => {
  const { heartbeat } = createHeartbeatHarness();
  const socket = createFakeSocket();
  heartbeat.track(socket, createSession("session-1"));

  assert.equal(heartbeat.sweepNow(), 0);
  assert.equal(heartbeat.sweepNow(), 0);
  socket.emit("pong");

  assert.equal(heartbeat.sweepNow(), 0);
  assert.equal(heartbeat.sweepNow(), 0);
  assert.equal(socket.terminated, false);
});

test("ws heartbeat stops tracking sockets that close normally", () => {
  const { heartbeat } = createHeartbeatHarness();
  const socket = createFakeSocket();
  heartbeat.track(socket, createSession("session-1"));

  assert.equal(heartbeat.sweepNow(), 0);
  socket.emit("close");

  for (let sweep = 0; sweep < 3; sweep += 1) {
    assert.equal(heartbeat.sweepNow(), 0);
  }
  assert.equal(socket.pingCount, 1);
  assert.equal(socket.terminated, false);
});

test("ws heartbeat does not ping sockets that are no longer open", () => {
  const { heartbeat } = createHeartbeatHarness();
  const socket = createFakeSocket({ readyState: 3 });
  heartbeat.track(socket, createSession("session-1"));

  assert.equal(heartbeat.sweepNow(), 0);
  assert.equal(socket.pingCount, 0);
});

test("ws heartbeat sweep survives a terminate() throw and still processes remaining sockets", () => {
  const { heartbeat, events } = createHeartbeatHarness();
  const throwingSocket = createFakeSocket({
    terminate() {
      throw new Error("stream already destroyed");
    },
  });
  const healthySocket = createFakeSocket();
  heartbeat.track(throwingSocket, createSession("session-throwing"));
  heartbeat.track(healthySocket, createSession("session-healthy"));

  heartbeat.sweepNow();
  healthySocket.emit("pong");
  heartbeat.sweepNow();
  healthySocket.emit("pong");
  const terminated = heartbeat.sweepNow();

  assert.equal(terminated, 0);
  const failure = events.find((e) => e.event === "ws_heartbeat_sweep_failed");
  assert.ok(failure);
  assert.equal(failure.data.sessionId, "session-throwing");
  assert.equal(failure.data.error, "stream already destroyed");
  assert.equal(healthySocket.pingCount, 3);
  assert.equal(healthySocket.terminated, false);
});

test("ws heartbeat tracks nothing when disabled", () => {
  const { heartbeat, events } = createHeartbeatHarness({ enabled: false });
  const socket = createFakeSocket();
  heartbeat.track(socket, createSession("session-1"));

  for (let sweep = 0; sweep < 4; sweep += 1) {
    assert.equal(heartbeat.sweepNow(), 0);
  }
  assert.equal(socket.pingCount, 0);
  assert.equal(socket.terminated, false);
  assert.equal(events.length, 0);
});
