/**
 * E2E smoke test — single-node, in-memory, no external dependencies.
 *
 * Covers the primary sync flow end-to-end:
 *   create room → join → share video → playback update → member leave
 *
 * All four protocol hops (owner→server, server→joiner broadcasts) are verified
 * at the WebSocket message level, making this the minimum viable regression
 * guard for the popup → background → server → content sync chain.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, type RawData } from "ws";
import { PROTOCOL_VERSION } from "@bili-syncplay/protocol";
import {
  createSyncServer,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
} from "../src/app.js";

const ALLOWED_ORIGIN = "chrome-extension://allowed-extension";

async function startSmokeServer() {
  const server = await createSyncServer(
    {
      ...getDefaultSecurityConfig(),
      allowedOrigins: [ALLOWED_ORIGIN],
    },
    getDefaultPersistenceConfig(),
    {
      logEvent: () => {},
      serviceVersion: "0.0.0-e2e-smoke",
      adminUiConfig: { enabled: false },
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.httpServer.listen(0, "127.0.0.1", () => resolve());
    server.httpServer.once("error", reject);
  });

  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address.");
  }

  return {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    close: () => server.close(),
  };
}

async function connect(wsUrl: string): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl, { origin: ALLOWED_ORIGIN });
  await once(socket, "open");
  return socket;
}

function collector(socket: WebSocket) {
  const queue: Array<Record<string, unknown>> = [];
  socket.on("message", (raw: RawData) => {
    queue.push(JSON.parse(raw.toString()) as Record<string, unknown>);
  });

  return {
    async next(type: string, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const i = queue.findIndex((m) => m.type === type);
        if (i >= 0) return queue.splice(i, 1)[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for "${type}". Queue: ${JSON.stringify(queue.map((m) => m.type))}`,
      );
    },
    async absent(type: string, windowMs = 200) {
      const deadline = Date.now() + windowMs;
      while (Date.now() < deadline) {
        if (queue.some((m) => m.type === type)) {
          throw new Error(`Unexpected message "${type}" appeared in queue`);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
}

async function closeSocket(socket: WebSocket) {
  if (
    socket.readyState === WebSocket.CLOSING ||
    socket.readyState === WebSocket.CLOSED
  )
    return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 300);
    socket.once("close", () => {
      clearTimeout(t);
      resolve();
    });
    socket.close();
  });
}

test("e2e smoke: create room → join → share video → playback update → member leave", async () => {
  const srv = await startSmokeServer();
  const ownerSocket = await connect(srv.wsUrl);
  const joinerSocket = await connect(srv.wsUrl);
  const ownerMsg = collector(ownerSocket);
  const joinerMsg = collector(joinerSocket);

  try {
    // ── 1. Owner creates a room ─────────────────────────────────────────────
    ownerSocket.send(
      JSON.stringify({
        type: "room:create",
        payload: { displayName: "Alice", protocolVersion: PROTOCOL_VERSION },
      }),
    );

    const created = await ownerMsg.next("room:created");
    const createdPayload = created.payload as {
      roomCode: string;
      joinToken: string;
      memberToken: string;
      memberId: string;
    };
    assert.ok(createdPayload.roomCode, "room:created must include roomCode");
    assert.ok(createdPayload.joinToken, "room:created must include joinToken");
    assert.ok(
      createdPayload.memberToken,
      "room:created must include memberToken",
    );
    await ownerMsg.next("room:state");

    // ── 2. Joiner joins the room ────────────────────────────────────────────
    joinerSocket.send(
      JSON.stringify({
        type: "room:join",
        payload: {
          roomCode: createdPayload.roomCode,
          joinToken: createdPayload.joinToken,
          displayName: "Bob",
          protocolVersion: PROTOCOL_VERSION,
        },
      }),
    );

    const joined = await joinerMsg.next("room:joined");
    const joinedPayload = joined.payload as { memberToken: string };
    assert.ok(
      joinedPayload.memberToken,
      "room:joined must include memberToken",
    );

    const joinerStateAfterJoin = await joinerMsg.next("room:state");
    assert.equal(
      (joinerStateAfterJoin.payload as { members: unknown[] }).members.length,
      2,
      "joiner's room:state must list 2 members",
    );

    const ownerStateAfterJoin = await ownerMsg.next("room:member-joined");
    assert.equal(
      (ownerStateAfterJoin.payload as { member: { name: string } }).member.name,
      "Bob",
      "owner must be notified of second member",
    );

    // ── 3. Owner shares a video ─────────────────────────────────────────────
    const videoUrl = "https://www.bilibili.com/video/BV1xx411c7mD?p=1";
    ownerSocket.send(
      JSON.stringify({
        type: "video:share",
        payload: {
          memberToken: createdPayload.memberToken,
          video: {
            videoId: "BV1xx411c7mD",
            url: videoUrl,
            title: "Test Episode",
          },
          playback: {
            url: videoUrl,
            currentTime: 0,
            playState: "paused",
            playbackRate: 1,
            updatedAt: Date.now(),
            serverTime: 0,
            actorId: createdPayload.memberId,
            seq: 1,
          },
        },
      }),
    );

    const ownerSharedState = await ownerMsg.next("room:state");
    assert.equal(
      (ownerSharedState.payload as { sharedVideo?: { title?: string } })
        .sharedVideo?.title,
      "Test Episode",
      "owner must see shared video title",
    );

    const joinerSharedState = await joinerMsg.next("room:state");
    assert.equal(
      (joinerSharedState.payload as { sharedVideo?: { title?: string } })
        .sharedVideo?.title,
      "Test Episode",
      "joiner must receive shared video broadcast",
    );
    assert.equal(
      (
        joinerSharedState.payload as {
          playback?: { actorId?: string };
        }
      ).playback?.actorId,
      createdPayload.memberId,
      "initial playback actorId must match the sharing member",
    );

    // ── 4. Owner sends a playback update ───────────────────────────────────
    ownerSocket.send(
      JSON.stringify({
        type: "playback:update",
        payload: {
          memberToken: createdPayload.memberToken,
          playback: {
            url: videoUrl,
            currentTime: 137,
            playState: "playing",
            playbackRate: 1,
            updatedAt: Date.now(),
            serverTime: 0,
            actorId: createdPayload.memberId,
            seq: 2,
          },
        },
      }),
    );

    // Both owner and joiner receive a room:state broadcast for the playback update
    await ownerMsg.next("room:state");
    const joinerPlaybackState = await joinerMsg.next("room:state");
    assert.equal(
      (
        joinerPlaybackState.payload as {
          playback?: { currentTime?: number; playState?: string };
        }
      ).playback?.currentTime,
      137,
      "joiner must receive updated currentTime",
    );
    assert.equal(
      (
        joinerPlaybackState.payload as {
          playback?: { playState?: string };
        }
      ).playback?.playState,
      "playing",
      "joiner must receive updated playState",
    );

    // ── 5. Joiner leaves the room ───────────────────────────────────────────
    joinerSocket.send(
      JSON.stringify({
        type: "room:leave",
        payload: { memberToken: joinedPayload.memberToken },
      }),
    );

    const ownerStateAfterLeave = await ownerMsg.next("room:member-left");
    assert.equal(
      (ownerStateAfterLeave.payload as { member: { name: string } }).member
        .name,
      "Bob",
      "owner must see member count drop to 1 after joiner leaves",
    );

    // No stray room:state messages after leave settles
    await ownerMsg.absent("room:state");
    await joinerMsg.absent("room:state");
  } finally {
    await closeSocket(ownerSocket);
    await closeSocket(joinerSocket);
    await srv.close();
  }
});
