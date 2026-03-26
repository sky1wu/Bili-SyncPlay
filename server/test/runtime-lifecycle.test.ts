import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, type RawData } from "ws";
import {
  createSyncServer,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
} from "../src/app.js";
import { createRedisRoomStore } from "../src/redis-room-store.js";
import { createRedisRuntimeStore } from "../src/redis-runtime-store.js";

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
