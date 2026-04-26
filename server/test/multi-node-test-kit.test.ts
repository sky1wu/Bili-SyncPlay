import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import test from "node:test";
import {
  closeClient,
  connectClient,
  createMessageCollector,
  createMultiNodeTestKit,
  requestJson,
} from "./multi-node-test-kit.js";

test("connectClient rejects when WebSocket open exceeds the timeout", async () => {
  const acceptedSockets = new Set<Socket>();
  const server = createServer((socket) => {
    acceptedSockets.add(socket);
    socket.once("close", () => acceptedSockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    await assert.rejects(
      () =>
        connectClient(`ws://127.0.0.1:${address.port}`, {
          openTimeoutMs: 10,
        }),
      /Timed out opening WebSocket after 10ms\./,
    );
  } finally {
    for (const socket of acceptedSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("multi-node test kit starts two room nodes and one global admin on the same redis namespace", async (t) => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const kit = await createMultiNodeTestKit(redisUrl);
  try {
    const roomNodeA = await kit.startRoomNode("node-a");
    const roomNodeB = await kit.startRoomNode("node-b");
    const globalAdmin = await kit.startGlobalAdmin();

    assert.notEqual(roomNodeA.httpBaseUrl, roomNodeB.httpBaseUrl);
    assert.notEqual(roomNodeA.wsUrl, roomNodeB.wsUrl);
    assert.ok(kit.namespace.startsWith("bsp:test:"));

    const token = await kit.login(globalAdmin.httpBaseUrl);
    const overview = await requestJson(
      globalAdmin.httpBaseUrl,
      "/api/admin/overview",
      {
        token,
      },
    );
    assert.equal(overview.status, 200);
    assert.equal(
      (overview.body.data as { service: { name: string } }).service.name,
      "bili-syncplay-global-admin",
    );
  } finally {
    await kit.closeAll();
  }
});

test("multi-node test kit merges partial security config overrides with defaults", async (t) => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const kit = await createMultiNodeTestKit(redisUrl, {
    securityConfig: {
      maxMembersPerRoom: 12,
    },
  });

  let socket: Awaited<ReturnType<typeof connectClient>> | undefined;

  try {
    const roomNode = await kit.startRoomNode("node-partial-security");
    socket = await connectClient(roomNode.wsUrl);
    const inbox = createMessageCollector(socket);

    socket.send(
      JSON.stringify({
        type: "room:create",
        payload: { displayName: "Bench Owner" },
      }),
    );

    const created = await inbox.next("room:created");
    assert.equal(typeof created.payload, "object");
  } finally {
    if (socket) {
      await closeClient(socket);
    }
    await kit.closeAll();
  }
});
