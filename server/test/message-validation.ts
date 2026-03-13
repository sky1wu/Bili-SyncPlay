import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { WebSocket, type RawData } from "ws";
import type { SecurityConfig } from "../src/app";
import {
  createSyncServer,
  getDefaultSecurityConfig,
  INVALID_CLIENT_MESSAGE_MESSAGE,
  INVALID_JSON_MESSAGE
} from "../src/app";
import type { ServerMessage } from "@bili-syncplay/protocol";

const ALLOWED_ORIGIN = "chrome-extension://allowed-extension";

async function startTestServer(overrides: Partial<SecurityConfig> = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const defaultConfig = getDefaultSecurityConfig();
  const config: SecurityConfig = {
    ...defaultConfig,
    ...overrides,
    rateLimits: {
      ...defaultConfig.rateLimits,
      ...overrides.rateLimits
    },
    allowedOrigins: overrides.allowedOrigins ?? [ALLOWED_ORIGIN]
  };
  const server = createSyncServer(config);
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

async function connectClient(url: string, origin = ALLOWED_ORIGIN): Promise<WebSocket> {
  const socket = new WebSocket(url, origin ? { origin } : undefined);
  await once(socket, "open");
  return socket;
}

async function connectClientWithHeaders(
  url: string,
  options: {
    origin?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<WebSocket> {
  const socket = new WebSocket(url, {
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.headers ? { headers: options.headers } : {})
  });
  await once(socket, "open");
  return socket;
}

async function connectClientExpectFailure(url: string, origin: string): Promise<{ code: number; reason: Buffer }> {
  const socket = new WebSocket(url, { origin });
  const [code, reason] = await once(socket, "close");
  return { code: code as number, reason: reason as Buffer };
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

async function waitForMessageType<TType extends ServerMessage["type"]>(
  socket: WebSocket,
  type: TType,
  timeoutMs = 2_000
): Promise<Extract<ServerMessage, { type: TType }>> {
  return await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for message type ${type}`));
    }, timeoutMs);

    const onMessage = (raw: RawData) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type !== type) {
        return;
      }

      clearTimeout(timeoutId);
      socket.off("message", onMessage);
      resolve(message as Extract<ServerMessage, { type: TType }>);
    };

    socket.on("message", onMessage);
  });
}

function createMessageCollector(socket: WebSocket): {
  next: <TType extends ServerMessage["type"]>(type: TType, timeoutMs?: number) => Promise<Extract<ServerMessage, { type: TType }>>;
} {
  const queuedMessages: ServerMessage[] = [];
  const waiters = new Map<
    ServerMessage["type"],
    Array<{
      resolve: (message: ServerMessage) => void;
      reject: (error: Error) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }>
  >();

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as ServerMessage;
    const typedWaiters = waiters.get(message.type);
    const waiter = typedWaiters?.shift();
    if (waiter) {
      clearTimeout(waiter.timeoutId);
      waiter.resolve(message);
      return;
    }
    queuedMessages.push(message);
  });

  return {
    next: <TType extends ServerMessage["type"]>(type: TType, timeoutMs = 2_000) => {
      const queuedIndex = queuedMessages.findIndex((message) => message.type === type);
      if (queuedIndex >= 0) {
        return Promise.resolve(queuedMessages.splice(queuedIndex, 1)[0] as Extract<ServerMessage, { type: TType }>);
      }

      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          const typedWaiters = waiters.get(type) ?? [];
          waiters.set(
            type,
            typedWaiters.filter((entry) => entry.timeoutId !== timeoutId)
          );
          reject(new Error(`Timed out waiting for message type ${type}`));
        }, timeoutMs);

        const typedWaiters = waiters.get(type) ?? [];
        typedWaiters.push({
          resolve: (message) => resolve(message as Extract<ServerMessage, { type: TType }>),
          reject,
          timeoutId
        });
        waiters.set(type, typedWaiters);
      });
    }
  };
}

async function closeClient(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }

  socket.terminate();
}

async function captureStructuredLogs<T>(run: () => Promise<T>): Promise<{ result: T; logs: Array<Record<string, unknown>> }> {
  const originalConsoleLog = console.log;
  const logs: Array<Record<string, unknown>> = [];
  console.log = (message?: unknown, ...optionalParams: unknown[]) => {
    if (typeof message === "string") {
      try {
        logs.push(JSON.parse(message) as Record<string, unknown>);
      } catch {
        // Ignore non-JSON log lines in tests.
      }
    }
    if (optionalParams.length > 0) {
      originalConsoleLog(message, ...optionalParams);
      return;
    }
  };

  try {
    const result = await run();
    return { result, logs };
  } finally {
    console.log = originalConsoleLog;
  }
}

test("rejects invalid JSON without destabilizing the server", async () => {
  const server = await startTestServer();
  try {
    const socket = await connectClient(server.url);
    try {
      socket.send("{invalid json");
      const response = await waitForJsonMessage(socket);
      assert.deepEqual(response, {
        type: "error",
        payload: { code: "invalid_message", message: INVALID_JSON_MESSAGE }
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

test("rejects invalid client message payloads before entering business logic", async () => {
  const server = await startTestServer();
  try {
    const socket = await connectClient(server.url);
    try {
      socket.send(JSON.stringify({ type: "room:join" }));
      const response = await waitForJsonMessage(socket);
      assert.deepEqual(response, {
        type: "error",
        payload: { code: "invalid_message", message: INVALID_CLIENT_MESSAGE_MESSAGE }
      });
    } finally {
      await closeClient(socket);
    }
  } finally {
    await server.close();
  }
});

test("rejects non-whitelisted origins during the websocket handshake", async () => {
  const server = await startTestServer();
  try {
    await assert.rejects(
      connectClient(server.url, "https://malicious.example"),
      /Unexpected server response: 403/
    );
  } finally {
    await server.close();
  }
});

test("rejects origins by default when ALLOWED_ORIGINS is not configured", async () => {
  const server = await startTestServer({ allowedOrigins: [] });
  try {
    await assert.rejects(
      connectClient(server.url, ALLOWED_ORIGIN),
      /Unexpected server response: 403/
    );
  } finally {
    await server.close();
  }
});

test("rejects missing Origin headers by default and only allows them in explicit dev mode", async () => {
  const secureServer = await startTestServer();
  try {
    await assert.rejects(connectClient(secureServer.url, ""), /Unexpected server response: 403/);
  } finally {
    await secureServer.close();
  }

  const devServer = await startTestServer({ allowMissingOriginInDev: true });
  try {
    const socket = await connectClient(devServer.url, "");
    await closeClient(socket);
  } finally {
    await devServer.close();
  }
});

test("rate limits repeated invalid origin handshakes from the same IP", async () => {
  const server = await startTestServer({
    connectionAttemptsPerMinute: 2
  });
  try {
    await assert.rejects(connectClient(server.url, "https://malicious.example"), /Unexpected server response: 403/);
    await assert.rejects(connectClient(server.url, "https://malicious.example"), /Unexpected server response: 403/);
    await assert.rejects(connectClient(server.url, "https://malicious.example"), /Unexpected server response: 429/);
  } finally {
    await server.close();
  }
});

test("rate limits repeated missing origin handshakes by default", async () => {
  const server = await startTestServer({
    connectionAttemptsPerMinute: 1
  });
  try {
    await assert.rejects(connectClient(server.url, ""), /Unexpected server response: 403/);
    await assert.rejects(connectClient(server.url, ""), /Unexpected server response: 429/);
  } finally {
    await server.close();
  }
});

test("creates a room with joinToken and memberToken", async () => {
  const server = await startTestServer();
  try {
    const socket = await connectClient(server.url);
    try {
      const responsesPromise = waitForJsonMessages(socket, 2);
      socket.send(JSON.stringify({ type: "room:create", payload: { displayName: "Alice" } }));
      const [created, roomState] = await responsesPromise;
      assert.equal(created.type, "room:created");
      assert.equal(created.payload.roomCode.length, 6);
      assert.ok(created.payload.joinToken.length >= 16);
      assert.ok(created.payload.memberToken.length >= 16);
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

test("rejects room:join with an invalid joinToken", async () => {
  const server = await startTestServer();
  try {
    const owner = await connectClient(server.url);
    const joiner = await connectClient(server.url);
    try {
      owner.send(JSON.stringify({ type: "room:create", payload: { displayName: "Alice" } }));
      const created = await waitForJsonMessage(owner);
      assert.equal(created.type, "room:created");
      joiner.send(
        JSON.stringify({
          type: "room:join",
          payload: {
            roomCode: created.payload.roomCode,
            joinToken: "invalid-join-token-123",
            displayName: "Bob"
          }
        })
      );
      const response = await waitForJsonMessage(joiner);
      assert.deepEqual(response, {
        type: "error",
        payload: {
          code: "join_token_invalid",
          message: "Join token is invalid."
        }
      });
    } finally {
      await closeClient(owner);
      await closeClient(joiner);
    }
  } finally {
    await server.close();
  }
});

test("rejects room messages when the memberToken is missing or invalid", async () => {
  const server = await startTestServer();
  try {
    const owner = await connectClient(server.url);
    try {
      owner.send(JSON.stringify({ type: "room:create", payload: { displayName: "Alice" } }));
      const created = await waitForJsonMessage(owner);
      assert.equal(created.type, "room:created");

      owner.send(
        JSON.stringify({
          type: "video:share",
          payload: {
            memberToken: "wrong-member-token-123",
            video: {
              videoId: "BV1xx411c7mD",
              url: "https://www.bilibili.com/video/BV1xx411c7mD",
              title: "Video"
            }
          }
        })
      );
      const response = await waitForJsonMessage(owner);
      assert.deepEqual(response, {
        type: "error",
        payload: {
          code: "member_token_invalid",
          message: "Member token is invalid."
        }
      });
    } finally {
      await closeClient(owner);
    }
  } finally {
    await server.close();
  }
});

test("overwrites spoofed actorId in playback:update", async () => {
  const server = await startTestServer();
  try {
    const owner = await connectClient(server.url);
    const ownerCollector = createMessageCollector(owner);
    try {
      owner.send(JSON.stringify({ type: "room:create", payload: { displayName: "Alice" } }));
      const ownerCreated = await ownerCollector.next("room:created");
      assert.equal(ownerCreated.type, "room:created");
      await ownerCollector.next("room:state");

      owner.send(
        JSON.stringify({
          type: "video:share",
          payload: {
            memberToken: ownerCreated.payload.memberToken,
            video: {
              videoId: "BV1xx411c7mD",
              url: "https://www.bilibili.com/video/BV1xx411c7mD",
              title: "Video"
            }
          }
        })
      );
      await ownerCollector.next("room:state");

      owner.send(
        JSON.stringify({
          type: "playback:update",
          payload: {
            memberToken: ownerCreated.payload.memberToken,
            playback: {
              url: "https://www.bilibili.com/video/BV1xx411c7mD",
              currentTime: 15,
              playState: "paused",
              playbackRate: 1,
              updatedAt: Date.now(),
              serverTime: 0,
              actorId: "spoofed-actor",
              seq: 2
            }
          }
        })
      );

      const ownerState = await ownerCollector.next("room:state");
      assert.equal(ownerState.type, "room:state");
      assert.equal(ownerState.payload.playback?.actorId, ownerCreated.payload.memberId);
      assert.notEqual(ownerState.payload.playback?.actorId, "spoofed-actor");
    } finally {
      await closeClient(owner);
    }
  } finally {
    await server.close();
  }
});

test("rate limits sync:ping bursts by dropping extra requests", async () => {
  const server = await startTestServer({
    rateLimits: {
      ...getDefaultSecurityConfig().rateLimits,
      syncPingPerSecond: 1,
      syncPingBurst: 1
    }
  });
  try {
    const socket = await connectClient(server.url);
    try {
      socket.send(JSON.stringify({ type: "sync:ping", payload: { clientSendTime: 1 } }));
      socket.send(JSON.stringify({ type: "sync:ping", payload: { clientSendTime: 2 } }));
      const first = await waitForJsonMessage(socket);
      assert.equal(first.type, "sync:pong");

      const maybeSecond = await Promise.race([
        once(socket, "message").then(([raw]) => JSON.parse(raw.toString()) as ServerMessage),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 200))
      ]);
      assert.equal(maybeSecond, null);
    } finally {
      await closeClient(socket);
    }
  } finally {
    await server.close();
  }
});

test("rate limits room:create and room:join requests", async () => {
  const server = await startTestServer({
    rateLimits: {
      ...getDefaultSecurityConfig().rateLimits,
      roomCreatePerMinute: 1,
      roomJoinPerMinute: 1
    }
  });
  try {
    const owner = await connectClient(server.url);
    const joiner = await connectClient(server.url);
    try {
      owner.send(JSON.stringify({ type: "room:create", payload: { displayName: "Alice" } }));
      const created = await waitForJsonMessages(owner, 2);
      assert.equal(created[0]?.type, "room:created");

      owner.send(JSON.stringify({ type: "room:create", payload: { displayName: "Alice" } }));
      const createLimitError = await waitForJsonMessage(owner);
      assert.deepEqual(createLimitError, {
        type: "error",
        payload: {
          code: "rate_limited",
          message: "Too many requests."
        }
      });

      joiner.send(
        JSON.stringify({
          type: "room:join",
          payload: {
            roomCode: created[0].payload.roomCode,
            joinToken: created[0].payload.joinToken,
            displayName: "Bob"
          }
        })
      );
      await waitForJsonMessages(joiner, 2);

      joiner.send(
        JSON.stringify({
          type: "room:join",
          payload: {
            roomCode: created[0].payload.roomCode,
            joinToken: created[0].payload.joinToken,
            displayName: "Bob"
          }
        })
      );
      const joinLimitError = await waitForJsonMessage(joiner);
      assert.deepEqual(joinLimitError, {
        type: "error",
        payload: {
          code: "rate_limited",
          message: "Too many requests."
        }
      });
    } finally {
      await closeClient(owner);
      await closeClient(joiner);
    }
  } finally {
    await server.close();
  }
});

test("does not trust X-Forwarded-For unless proxy trust is explicitly enabled", async () => {
  const server = await startTestServer({
    maxConnectionsPerIp: 1
  });
  try {
    const first = await connectClientWithHeaders(server.url, {
      origin: ALLOWED_ORIGIN,
      headers: { "x-forwarded-for": "203.0.113.10" }
    });
    try {
      await assert.rejects(
        connectClientWithHeaders(server.url, {
          origin: ALLOWED_ORIGIN,
          headers: { "x-forwarded-for": "198.51.100.7" }
        }),
        /Unexpected server response: 429/
      );
    } finally {
      await closeClient(first);
    }
  } finally {
    await server.close();
  }
});

test("uses X-Forwarded-For for connection limiting only when proxy trust is enabled", async () => {
  const server = await startTestServer({
    trustProxyHeaders: true,
    maxConnectionsPerIp: 1
  });
  try {
    const first = await connectClientWithHeaders(server.url, {
      origin: ALLOWED_ORIGIN,
      headers: { "x-forwarded-for": "203.0.113.10" }
    });
    const second = await connectClientWithHeaders(server.url, {
      origin: ALLOWED_ORIGIN,
      headers: { "x-forwarded-for": "198.51.100.7" }
    });
    try {
      assert.equal(first.readyState, WebSocket.OPEN);
      assert.equal(second.readyState, WebSocket.OPEN);
    } finally {
      await closeClient(first);
      await closeClient(second);
    }
  } finally {
    await server.close();
  }
});

test("records auth_failed logs for member token validation errors", async () => {
  const server = await startTestServer();
  try {
    const { logs } = await captureStructuredLogs(async () => {
      const owner = await connectClient(server.url);
      const collector = createMessageCollector(owner);
      try {
        owner.send(JSON.stringify({ type: "room:create", payload: { displayName: "Alice" } }));
        await collector.next("room:created");
        await collector.next("room:state");

        owner.send(
          JSON.stringify({
            type: "video:share",
            payload: {
              memberToken: "wrong-member-token-123",
              video: {
                videoId: "BV1xx411c7mD",
                url: "https://www.bilibili.com/video/BV1xx411c7mD",
                title: "Video"
              }
            }
          })
        );
        await collector.next("error");
      } finally {
        await closeClient(owner);
      }
    });

    assert.equal(
      logs.some((entry) => entry.event === "auth_failed" && entry.reason === "member_token_invalid" && entry.messageType === "video:share"),
      true
    );
  } finally {
    await server.close();
  }
});

test("records auth_failed logs when a client sends room messages before joining", async () => {
  const server = await startTestServer();
  try {
    const { logs } = await captureStructuredLogs(async () => {
      const socket = await connectClient(server.url);
      const collector = createMessageCollector(socket);
      try {
        socket.send(
          JSON.stringify({
            type: "sync:request",
            payload: {
              memberToken: "valid-member-token-123"
            }
          })
        );
        await collector.next("error");
      } finally {
        await closeClient(socket);
      }
    });

    assert.equal(
      logs.some((entry) => entry.event === "auth_failed" && entry.reason === "not_in_room" && entry.messageType === "sync:request"),
      true
    );
  } finally {
    await server.close();
  }
});
