import assert from "node:assert/strict";
import test from "node:test";
import {
  closeClient,
  connectClient,
  createMessageCollector,
  createMultiNodeTestKit,
} from "./multi-node-test-kit.js";

test("cross-node room broadcasts sync join, shared video, playback updates, and member leave", async (t) => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const kit = await createMultiNodeTestKit(redisUrl);
  const nodeA = await kit.startRoomNode("node-a");
  const nodeB = await kit.startRoomNode("node-b");
  const owner = await connectClient(nodeA.wsUrl);
  const joiner = await connectClient(nodeB.wsUrl);
  const ownerCollector = createMessageCollector(owner);
  const joinerCollector = createMessageCollector(joiner);

  try {
    owner.send(
      JSON.stringify({
        type: "room:create",
        payload: { displayName: "Alice" },
      }),
    );
    const created = await ownerCollector.next("room:created");
    await ownerCollector.next("room:state");

    joiner.send(
      JSON.stringify({
        type: "room:join",
        payload: {
          roomCode: (created.payload as { roomCode: string }).roomCode,
          joinToken: (created.payload as { joinToken: string }).joinToken,
          displayName: "Bob",
        },
      }),
    );

    const joined = await joinerCollector.next("room:joined");
    const joinerJoinedState = await joinerCollector.next("room:state");
    const ownerSawJoin = await ownerCollector.next("room:state");
    assert.equal(
      (joinerJoinedState.payload as { members: Array<unknown> }).members.length,
      2,
    );
    assert.equal(
      (ownerSawJoin.payload as { members: Array<unknown> }).members.length,
      2,
    );

    owner.send(
      JSON.stringify({
        type: "video:share",
        payload: {
          memberToken: (created.payload as { memberToken: string }).memberToken,
          video: {
            videoId: "BV1xx411c7mD",
            url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
            title: "Episode 2",
          },
          playback: {
            url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
            currentTime: 12,
            playState: "playing",
            playbackRate: 1,
            updatedAt: Date.now(),
            serverTime: 0,
            actorId: (created.payload as { memberId: string }).memberId,
            seq: 1,
          },
        },
      }),
    );

    const ownerSharedState = await ownerCollector.next("room:state");
    const joinerSharedState = await joinerCollector.next("room:state");
    assert.equal(
      (ownerSharedState.payload as { sharedVideo?: { title?: string } }).sharedVideo
        ?.title,
      "Episode 2",
    );
    assert.equal(
      (joinerSharedState.payload as { sharedVideo?: { title?: string } }).sharedVideo
        ?.title,
      "Episode 2",
    );
    assert.equal(
      (
        joinerSharedState.payload as {
          playback?: { actorId?: string; playState?: string };
        }
      ).playback?.actorId,
      (created.payload as { memberId: string }).memberId,
    );

    owner.send(
      JSON.stringify({
        type: "playback:update",
        payload: {
          memberToken: (created.payload as { memberToken: string }).memberToken,
          playback: {
            url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
            currentTime: 42,
            playState: "paused",
            playbackRate: 1.25,
            updatedAt: Date.now(),
            serverTime: 0,
            actorId: "spoofed-actor",
            seq: 2,
          },
        },
      }),
    );

    const ownerPlaybackState = await ownerCollector.next("room:state");
    const joinerPlaybackState = await joinerCollector.next("room:state");
    assert.equal(
      (
        ownerPlaybackState.payload as {
          playback?: { currentTime?: number; playState?: string };
        }
      ).playback?.currentTime,
      42,
    );
    assert.equal(
      (
        joinerPlaybackState.payload as {
          playback?: { currentTime?: number; playState?: string; playbackRate?: number };
        }
      ).playback?.playState,
      "paused",
    );
    assert.equal(
      (
        joinerPlaybackState.payload as {
          playback?: { playbackRate?: number };
        }
      ).playback?.playbackRate,
      1.25,
    );

    joiner.send(
      JSON.stringify({
        type: "room:leave",
        payload: {
          memberToken: (joined.payload as { memberToken: string }).memberToken,
        },
      }),
    );

    const ownerSawLeave = await ownerCollector.next("room:state");
    assert.equal(
      (ownerSawLeave.payload as { members: Array<unknown> }).members.length,
      1,
    );
    assert.equal(await ownerCollector.maybeNext("room:state", 150), null);
    assert.equal(await joinerCollector.maybeNext("room:state", 150), null);
  } finally {
    await closeClient(owner);
    await closeClient(joiner);
    await kit.closeAll();
  }
});
