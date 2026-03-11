import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket, type RawData } from "ws";
import type { ServerMessage } from "@bili-syncplay/protocol";
import {
  createSyncServer,
  INVALID_CLIENT_MESSAGE_MESSAGE,
  INVALID_JSON_MESSAGE
} from "../src/app";

async function startTestServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createSyncServer();
  await new Promise<void>((resolve, reject) => {
    server.httpServer.listen(0, "127.0.0.1", () => resolve());
    server.httpServer.once("error", reject);
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine test server address.");
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: server.close
  };
}

async function connectClient(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await once(socket, "open");
  return socket;
}

async function waitForJsonMessage(socket: WebSocket): Promise<ServerMessage> {
  const [raw] = await once(socket, "message");
  return JSON.parse(raw.toString()) as ServerMessage;
}

async function waitForJsonMessages(socket: WebSocket, count: number): Promise<ServerMessage[]> {
  return await new Promise((resolve) => {
    const messages: ServerMessage[] = [];
    const onMessage = (raw: RawData) => {
      messages.push(JSON.parse(raw.toString()) as ServerMessage);
      if (messages.length >= count) {
        socket.off("message", onMessage);
        resolve(messages);
      }
    };
    socket.on("message", onMessage);
  });
}

async function closeClient(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  socket.terminate();
}

async function runCase(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await runCase("rejects invalid JSON without destabilizing the server", async () => {
  const server = await startTestServer();
  try {
    const socket = await connectClient(server.url);
    try {
      socket.send("{invalid json");
      const response = await waitForJsonMessage(socket);
      assert.deepEqual(response, {
        type: "error",
        payload: { message: INVALID_JSON_MESSAGE }
      });

      socket.send(JSON.stringify({ type: "sync:ping", payload: { clientSendTime: 123 } }));
      const followUpResponse = await waitForJsonMessage(socket);
      assert.equal(followUpResponse.type, "sync:pong");
      assert.equal(followUpResponse.payload.clientSendTime, 123);
    } finally {
      await closeClient(socket);
    }
  } finally {
    await server.close();
  }
});

await runCase("rejects invalid client message payloads before entering business logic", async () => {
  const server = await startTestServer();
  try {
    const socket = await connectClient(server.url);
    try {
      socket.send(JSON.stringify({ type: "room:join" }));
      const response = await waitForJsonMessage(socket);
      assert.deepEqual(response, {
        type: "error",
        payload: { message: INVALID_CLIENT_MESSAGE_MESSAGE }
      });
    } finally {
      await closeClient(socket);
    }
  } finally {
    await server.close();
  }
});

await runCase("keeps valid message flow working after validation hardening", async () => {
  const server = await startTestServer();
  try {
    const socket = await connectClient(server.url);
    try {
      const responsesPromise = waitForJsonMessages(socket, 2);
      socket.send(JSON.stringify({ type: "room:create", payload: { displayName: "Alice" } }));
      const [created, roomState] = await responsesPromise;
      assert.equal(created.type, "room:created");
      assert.equal(created.payload.roomCode.length, 6);
      assert.equal(roomState.type, "room:state");
      assert.equal(roomState.payload.roomCode, created.payload.roomCode);
      assert.equal(roomState.payload.members.length, 1);
      assert.equal(roomState.payload.members[0]?.name, "Alice");
    } finally {
      await closeClient(socket);
    }
  } finally {
    await server.close();
  }
});
