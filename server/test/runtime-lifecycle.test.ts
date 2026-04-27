import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, type RawData } from "ws";
import { EventEmitter } from "node:events";
import {
  cleanupSessionAfterClose,
  createSyncServer,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
  runShutdownSteps,
} from "../src/app.js";
import { createWsConnectionHandler } from "../src/ws-session-handler.js";
import { createRedisRoomStore } from "../src/redis-room-store.js";
import { createRedisRuntimeStore } from "../src/redis-runtime-store.js";
import type { Session } from "../src/types.js";

const ALLOWED_ORIGIN = "chrome-extension://allowed-extension";
const REDIS_URL = process.env.REDIS_URL;

async function startRedisServer() {
  const instanceId = `runtime-lifecycle-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
  const server = await createSyncServer(
    {
      ...getDefaultSecurityConfig(),
      allowedOrigins: [ALLOWED_ORIGIN],
    },
    {
      ...getDefaultPersistenceConfig(),
      provider: "redis",
      runtimeStoreProvider: "redis",
      roomEventBusProvider: "redis",
      instanceId,
      redisUrl: REDIS_URL ?? getDefaultPersistenceConfig().redisUrl,
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.httpServer.listen(0, "127.0.0.1", () => resolve());
    server.httpServer.once("error", reject);
  });

  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine test server address.");
  }

  return {
    close: server.close,
    instanceId,
    wsUrl: `ws://127.0.0.1:${address.port}`,
  };
}

async function connectClient(wsUrl: string): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl, { origin: ALLOWED_ORIGIN });
  await once(socket, "open");
  return socket;
}

function createMessageCollector(socket: WebSocket) {
  const queuedMessages: Array<Record<string, unknown>> = [];
  socket.on("message", (raw: RawData) => {
    queuedMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
  });

  return {
    async next(type: string, timeoutMs = 2_000) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const index = queuedMessages.findIndex(
          (message) => message.type === type,
        );
        if (index >= 0) {
          return queuedMessages.splice(index, 1)[0] as Record<string, unknown>;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for message type ${type}`);
    },
  };
}

async function closeClient(socket: WebSocket): Promise<void> {
  if (
    socket.readyState === WebSocket.CLOSING ||
    socket.readyState === WebSocket.CLOSED
  ) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 250);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.close();
  });
}

function createSession(id: string): Session {
  return {
    id,
    connectionState: "attached",
    socket: {
      readyState: WebSocket.OPEN,
      OPEN: WebSocket.OPEN,
      send() {},
      close() {},
      terminate() {},
    } as Session["socket"],
    instanceId: "runtime-test-node",
    remoteAddress: "127.0.0.1",
    origin: ALLOWED_ORIGIN,
    roomCode: "ROOM01",
    memberId: "member-1",
    displayName: "Alice",
    memberToken: "token-1",
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

test("cleanupSessionAfterClose unregisters and decrements even when leaveRoom fails", async () => {
  const session = createSession("cleanup-session");
  const unregistered: string[] = [];
  const decremented: Array<string | null> = [];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];

  await cleanupSessionAfterClose({
    session,
    code: 1006,
    reason: Buffer.from(""),
    messageHandler: {
      async leaveRoom() {
        throw new Error("leave failed");
      },
    },
    runtimeStore: {
      unregisterSession(sessionId) {
        unregistered.push(sessionId);
      },
    },
    securityPolicy: {
      decrementConnectionCount(remoteAddress) {
        decremented.push(remoteAddress);
      },
    },
    logEvent(event, data) {
      events.push({ event, data });
    },
    decodeCloseReason() {
      return "";
    },
  });

  assert.deepEqual(unregistered, [session.id]);
  assert.deepEqual(decremented, [session.remoteAddress]);
  assert.ok(
    events.some((entry) => entry.event === "ws_connection_cleanup_failed"),
  );
  assert.ok(events.some((entry) => entry.event === "ws_connection_closed"));
});

test("runShutdownSteps logs timeout and continues closing remaining steps", async () => {
  const stepsRun: string[] = [];
  const logs: Array<{ event: string; step: string | null; result: string }> =
    [];

  await runShutdownSteps(
    [
      {
        name: "hang",
        run: async () => {
          stepsRun.push("hang");
          await new Promise(() => undefined);
        },
        timeoutMs: 10,
      },
      {
        name: "after_timeout",
        run: () => {
          stepsRun.push("after_timeout");
        },
      },
    ],
    (event, data) => {
      logs.push({
        event,
        step: typeof data.step === "string" ? data.step : null,
        result: String(data.result),
      });
    },
    10,
  );

  assert.deepEqual(stepsRun, ["hang", "after_timeout"]);
  assert.deepEqual(logs, [
    {
      event: "server_shutdown_step_failed",
      step: "hang",
      result: "timeout",
    },
  ]);
});

test("ws close cleanup proceeds after drain timeout when handler is hung", async () => {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const unregistered: string[] = [];
  const decremented: Array<string | null> = [];
  const pendingSessionCleanup = new Set<Promise<void>>();

  const fakeSocket = Object.assign(new EventEmitter(), {
    readyState: 1,
    OPEN: 1,
    send() {},
    close() {},
    terminate() {},
  }) as unknown as Parameters<ReturnType<typeof createWsConnectionHandler>>[0];

  const handler = createWsConnectionHandler({
    securityPolicy: {
      getRemoteAddress: () => "127.0.0.1",
      incrementConnectionCount() {},
      decrementConnectionCount(remoteAddress) {
        decremented.push(remoteAddress);
      },
    },
    securityConfig: getDefaultSecurityConfig(),
    instanceId: "drain-timeout-node",
    runtimeStore: {
      registerSession() {},
      unregisterSession(sessionId) {
        unregistered.push(sessionId);
      },
      markSessionJoinedRoom() {},
      markSessionLeftRoom() {},
      // Other RuntimeStore members are unused by the connection handler.
    } as unknown as Parameters<
      typeof createWsConnectionHandler
    >[0]["runtimeStore"],
    messageHandler: {
      // Hangs forever — simulates a deadlocked downstream call.
      handleClientMessage: () => new Promise<void>(() => undefined),
      async leaveRoom() {},
    },
    logEvent(event, data) {
      events.push({ event, data: data as Record<string, unknown> });
    },
    pendingSessionCleanup,
    messageQueueDrainTimeoutMs: 30,
  });

  const fakeRequest = {
    biliSyncPlayContext: {
      remoteAddress: "127.0.0.1",
      origin: "chrome-extension://allowed-extension",
    },
    headers: {},
  } as unknown as Parameters<ReturnType<typeof createWsConnectionHandler>>[1];

  handler(fakeSocket, fakeRequest);

  // Push a message that will be picked up but never finish handling.
  (fakeSocket as unknown as EventEmitter).emit(
    "message",
    Buffer.from(
      JSON.stringify({
        type: "sync:ping",
        payload: { clientSendTime: Date.now() },
      }),
    ),
  );

  // Yield once so the messageQueue chain extends with the hung handler.
  await new Promise((resolve) => setImmediate(resolve));

  // Trigger close — cleanup should proceed after drainTimeoutMs even though
  // the handler is still pending.
  (fakeSocket as unknown as EventEmitter).emit("close", 1006, Buffer.from(""));

  await Promise.allSettled(Array.from(pendingSessionCleanup));

  assert.equal(unregistered.length, 1);
  assert.equal(decremented.length, 1);
  assert.equal(decremented[0], "127.0.0.1");
  assert.ok(
    events.some((entry) => entry.event === "ws_close_drain_timeout"),
    "ws_close_drain_timeout must be logged when the queue does not drain",
  );
  assert.ok(events.some((entry) => entry.event === "ws_connection_closed"));
});

test("websocket lifecycle mirrors sessions into the shared redis runtime store", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const serverA = await startRedisServer();
  const serverB = await startRedisServer();
  const runtimeStore = await createRedisRuntimeStore(REDIS_URL);
  const roomStore = await createRedisRoomStore(REDIS_URL);
  let roomCode = "";
  let joinToken = "";

  try {
    const owner = await connectClient(serverA.wsUrl);
    const ownerCollector = createMessageCollector(owner);
    const joiner = await connectClient(serverB.wsUrl);
    const joinerCollector = createMessageCollector(joiner);

    try {
      owner.send(
        JSON.stringify({
          type: "room:create",
          payload: { displayName: "Alice" },
        }),
      );
      const created = await ownerCollector.next("room:created");
      roomCode = (created.payload as { roomCode: string }).roomCode;
      joinToken = (created.payload as { joinToken: string }).joinToken;
      await ownerCollector.next("room:state");

      joiner.send(
        JSON.stringify({
          type: "room:join",
          payload: {
            roomCode,
            joinToken,
            displayName: "Bob",
          },
        }),
      );
      await joinerCollector.next("room:joined");

      let sharedRoom = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        sharedRoom = await runtimeStore.getRoom(roomCode);
        if (sharedRoom?.members.size === 2) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      assert.ok(sharedRoom);
      assert.equal(sharedRoom.members.size, 2);
      assert.deepEqual(
        Array.from(sharedRoom.members.values())
          .map((session) => session.displayName)
          .sort(),
        ["Alice", "Bob"],
      );
      assert.deepEqual(
        Array.from(sharedRoom.members.values())
          .map((session) => session.instanceId)
          .sort(),
        [serverA.instanceId, serverB.instanceId].sort(),
      );
    } finally {
      await closeClient(owner);
      await closeClient(joiner);
    }
  } finally {
    if (roomCode) {
      await roomStore.deleteRoom(roomCode);
      await runtimeStore.deleteRoom(roomCode);
    }
    await roomStore.close();
    await runtimeStore.close();
    await serverA.close();
    await serverB.close();
  }
});

test("profile updates are reflected in redis-backed room state views", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const serverA = await startRedisServer();
  const serverB = await startRedisServer();
  const runtimeStore = await createRedisRuntimeStore(REDIS_URL);
  const roomStore = await createRedisRoomStore(REDIS_URL);
  let roomCode = "";

  try {
    const owner = await connectClient(serverA.wsUrl);
    const ownerCollector = createMessageCollector(owner);
    const joiner = await connectClient(serverB.wsUrl);
    const joinerCollector = createMessageCollector(joiner);

    try {
      owner.send(
        JSON.stringify({
          type: "room:create",
          payload: { displayName: "Guest-123" },
        }),
      );
      const created = await ownerCollector.next("room:created");
      roomCode = (created.payload as { roomCode: string }).roomCode;
      const joinToken = (created.payload as { joinToken: string }).joinToken;
      await ownerCollector.next("room:state");

      joiner.send(
        JSON.stringify({
          type: "room:join",
          payload: {
            roomCode,
            joinToken,
            displayName: "Bob",
          },
        }),
      );
      await joinerCollector.next("room:joined");
      await joinerCollector.next("room:state");
      await ownerCollector.next("room:state");

      owner.send(
        JSON.stringify({
          type: "profile:update",
          payload: {
            memberToken: (created.payload as { memberToken: string })
              .memberToken,
            displayName: "Alice",
          },
        }),
      );

      const ownerState = await ownerCollector.next("room:state");
      const joinerState = await joinerCollector.next("room:state");
      assert.deepEqual(
        (ownerState.payload as { members: Array<{ name: string }> }).members
          .map((member) => member.name)
          .sort((left, right) => left.localeCompare(right)),
        ["Alice", "Bob"],
      );
      assert.deepEqual(
        (joinerState.payload as { members: Array<{ name: string }> }).members
          .map((member) => member.name)
          .sort((left, right) => left.localeCompare(right)),
        ["Alice", "Bob"],
      );
    } finally {
      await closeClient(owner);
      await closeClient(joiner);
    }
  } finally {
    if (roomCode) {
      await roomStore.deleteRoom(roomCode);
      await runtimeStore.deleteRoom(roomCode);
    }
    await roomStore.close();
    await runtimeStore.close();
    await serverA.close();
    await serverB.close();
  }
});
