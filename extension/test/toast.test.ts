import assert from "node:assert/strict";
import test from "node:test";
import type { RoomState } from "@bili-syncplay/protocol";
import {
  getRoomStateToastMessages,
  getSharedVideoToastMessage,
} from "../src/content/toast";
import { setLocaleForTests } from "../src/shared/i18n";

function createRoomState(
  args: {
    members?: Array<{ id: string; name: string }>;
    sharedUrl?: string | null;
    playback?: RoomState["playback"];
  } = {},
): RoomState {
  return {
    roomCode: "ROOM01",
    sharedVideo: args.sharedUrl
      ? {
          videoId: "BV1xx411c7mD",
          url: args.sharedUrl,
          title: "Video",
        }
      : null,
    playback: args.playback ?? null,
    members: args.members ?? [],
  };
}

test("builds member join and leave toast messages", () => {
  setLocaleForTests("zh-CN");
  const previousState = createRoomState({
    members: [
      { id: "self", name: "Me" },
      { id: "a", name: "Alice" },
    ],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
  });
  const nextState = createRoomState({
    members: [
      { id: "self", name: "Me" },
      { id: "b", name: "Bob" },
    ],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
  });

  const result = getRoomStateToastMessages({
    previousState,
    nextState,
    localMemberId: "self",
    pendingRoomStateHydration: false,
    isCurrentPageShowingSharedVideo: false,
    now: 1000,
    elapsedSincePreviousStateMs: 1000,
    lastSeekToastByActor: new Map(),
  });

  assert.deepEqual(result.messages, ["Bob 加入了房间", "Alice 离开了房间"]);
});

test("keeps member join toasts during initial hydration", () => {
  setLocaleForTests("zh-CN");
  const previousState = createRoomState({
    members: [{ id: "self", name: "Me" }],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
  });
  const nextState = createRoomState({
    members: [
      { id: "self", name: "Me" },
      { id: "remote", name: "Alice" },
    ],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
  });

  const result = getRoomStateToastMessages({
    previousState,
    nextState,
    localMemberId: "self",
    pendingRoomStateHydration: true,
    isCurrentPageShowingSharedVideo: true,
    now: 1000,
    elapsedSincePreviousStateMs: 1000,
    lastSeekToastByActor: new Map(),
  });

  assert.deepEqual(result.messages, ["Alice 加入了房间"]);
});

test("builds seek and rate toast messages for remote playback changes", () => {
  setLocaleForTests("zh-CN");
  const previousState = createRoomState({
    members: [
      { id: "self", name: "Me" },
      { id: "remote", name: "Alice" },
    ],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
    playback: {
      url: "https://www.bilibili.com/video/BV1?p=1",
      currentTime: 10,
      playState: "paused",
      playbackRate: 1,
      updatedAt: 1,
      serverTime: 1,
      actorId: "remote",
      seq: 1,
    },
  });
  const nextState = createRoomState({
    members: [
      { id: "self", name: "Me" },
      { id: "remote", name: "Alice" },
    ],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
    playback: {
      url: "https://www.bilibili.com/video/BV1?p=1",
      currentTime: 42,
      playState: "paused",
      playbackRate: 1.5,
      updatedAt: 2,
      serverTime: 2,
      actorId: "remote",
      seq: 2,
    },
  });

  const result = getRoomStateToastMessages({
    previousState,
    nextState,
    localMemberId: "self",
    pendingRoomStateHydration: false,
    isCurrentPageShowingSharedVideo: true,
    now: 1000,
    elapsedSincePreviousStateMs: 1,
    lastSeekToastByActor: new Map(),
  });

  assert.deepEqual(result.messages, ["Alice 切换到 1.5x", "Alice 跳转到 0:42"]);
});

test("suppresses playback toasts for a natural-end paused state", () => {
  setLocaleForTests("zh-CN");
  const previousState = createRoomState({
    members: [
      { id: "self", name: "Me" },
      { id: "remote", name: "Alice" },
    ],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
    playback: {
      url: "https://www.bilibili.com/video/BV1?p=1",
      currentTime: 250,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 1,
      serverTime: 1000,
      actorId: "remote",
      seq: 1,
    },
  });
  // The sharer's shared video reached its natural end: a paused state parked at
  // the end, flagged natural-end. It must apply silently — no "paused" and no
  // "jumped to <end>" toast (the playing→paused jump would otherwise trip both).
  const nextState = createRoomState({
    members: [
      { id: "self", name: "Me" },
      { id: "remote", name: "Alice" },
    ],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
    playback: {
      url: "https://www.bilibili.com/video/BV1?p=1",
      currentTime: 262.5,
      playState: "paused",
      naturalEnd: true,
      playbackRate: 1,
      updatedAt: 2,
      serverTime: 7000,
      actorId: "remote",
      seq: 2,
    },
  });

  const result = getRoomStateToastMessages({
    previousState,
    nextState,
    localMemberId: "self",
    pendingRoomStateHydration: false,
    isCurrentPageShowingSharedVideo: true,
    now: 1000,
    elapsedSincePreviousStateMs: 6000,
    lastSeekToastByActor: new Map(),
  });

  assert.deepEqual(result.messages, []);
});

test("builds shared video toast for another member only once", () => {
  setLocaleForTests("zh-CN");
  const state = createRoomState({
    members: [
      { id: "self", name: "Me" },
      { id: "remote", name: "Alice" },
    ],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
  });

  const first = getSharedVideoToastMessage({
    toast: {
      key: "toast-1",
      actorId: "remote",
      title: "New Video",
      videoUrl: "https://www.bilibili.com/video/BV1?p=1",
    },
    state,
    localMemberId: "self",
    lastSharedVideoToastKey: null,
    normalizedToastUrl: "https://www.bilibili.com/video/BV1?p=1",
    normalizedSharedUrl: "https://www.bilibili.com/video/BV1?p=1",
  });
  assert.equal(first.message, "Alice 共享了新视频：New Video");
  assert.equal(first.nextSharedVideoToastKey, "toast-1");

  const repeated = getSharedVideoToastMessage({
    toast: {
      key: "toast-1",
      actorId: "remote",
      title: "New Video",
      videoUrl: "https://www.bilibili.com/video/BV1?p=1",
    },
    state,
    localMemberId: "self",
    lastSharedVideoToastKey: "toast-1",
    normalizedToastUrl: "https://www.bilibili.com/video/BV1?p=1",
    normalizedSharedUrl: "https://www.bilibili.com/video/BV1?p=1",
  });
  assert.equal(repeated.message, null);
});

test("builds English toast messages when the UI language is English", () => {
  setLocaleForTests("en-US");
  const previousState = createRoomState({
    members: [
      { id: "self", name: "Me" },
      { id: "remote", name: "Alice" },
    ],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
    playback: {
      url: "https://www.bilibili.com/video/BV1?p=1",
      currentTime: 10,
      playState: "paused",
      playbackRate: 1,
      updatedAt: 1,
      serverTime: 1,
      actorId: "remote",
      seq: 1,
    },
  });
  const nextState = createRoomState({
    members: [
      { id: "self", name: "Me" },
      { id: "remote", name: "Alice" },
      { id: "new", name: "Bob" },
    ],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
    playback: {
      url: "https://www.bilibili.com/video/BV1?p=1",
      currentTime: 42,
      playState: "playing",
      playbackRate: 1.5,
      updatedAt: 2,
      serverTime: 2,
      actorId: "remote",
      seq: 2,
    },
  });

  const result = getRoomStateToastMessages({
    previousState,
    nextState,
    localMemberId: "self",
    pendingRoomStateHydration: false,
    isCurrentPageShowingSharedVideo: true,
    now: 1000,
    elapsedSincePreviousStateMs: 1,
    lastSeekToastByActor: new Map(),
  });

  assert.deepEqual(result.messages, [
    "Bob joined the room",
    "Alice switched to 1.5x",
    "Alice jumped to 0:42",
  ]);

  const sharedVideo = getSharedVideoToastMessage({
    toast: {
      key: "toast-en-1",
      actorId: "remote",
      title: "New Video",
      videoUrl: "https://www.bilibili.com/video/BV1?p=1",
    },
    state: nextState,
    localMemberId: "self",
    lastSharedVideoToastKey: null,
    normalizedToastUrl: "https://www.bilibili.com/video/BV1?p=1",
    normalizedSharedUrl: "https://www.bilibili.com/video/BV1?p=1",
  });

  assert.equal(sharedVideo.message, "Alice shared a new video: New Video");
  setLocaleForTests(null);
});

test("stays silent for the local member's own manual share", () => {
  setLocaleForTests("zh-CN");
  const state = createRoomState({
    members: [{ id: "self", name: "Me" }],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=2",
  });

  const result = getSharedVideoToastMessage({
    toast: {
      key: "toast-self-1",
      actorId: "self",
      title: "My Video",
      videoUrl: "https://www.bilibili.com/video/BV1?p=2",
    },
    state,
    localMemberId: "self",
    lastSharedVideoToastKey: null,
    normalizedToastUrl: "https://www.bilibili.com/video/BV1?p=2",
    normalizedSharedUrl: "https://www.bilibili.com/video/BV1?p=2",
    // No pending auto-share: a manual self-share must stay silent.
    localAutoShareTargetUrl: null,
  });

  assert.equal(result.message, null);
  assert.equal(result.nextSharedVideoToastKey, "toast-self-1");
  setLocaleForTests(null);
});

test("surfaces an auto-continue toast for the local sharer's autoplay-next share", () => {
  setLocaleForTests("zh-CN");
  const state = createRoomState({
    members: [{ id: "self", name: "Me" }],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=2",
  });

  const result = getSharedVideoToastMessage({
    toast: {
      key: "toast-self-auto-1",
      actorId: "self",
      title: "第 2 集",
      videoUrl: "https://www.bilibili.com/video/BV1?p=2",
    },
    state,
    localMemberId: "self",
    lastSharedVideoToastKey: null,
    normalizedToastUrl: "https://www.bilibili.com/video/BV1?p=2",
    normalizedSharedUrl: "https://www.bilibili.com/video/BV1?p=2",
    // The room confirmed the very video this sharer auto-continued to.
    localAutoShareTargetUrl: "https://www.bilibili.com/video/BV1?p=2",
  });

  assert.equal(result.message, "已自动连播并共享下一个视频：第 2 集");
  assert.equal(result.nextSharedVideoToastKey, "toast-self-auto-1");
  setLocaleForTests(null);
});

test("does not auto-continue toast when the pending target is a different video", () => {
  setLocaleForTests("en");
  const state = createRoomState({
    members: [{ id: "self", name: "Me" }],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=2",
  });

  const result = getSharedVideoToastMessage({
    toast: {
      key: "toast-self-auto-2",
      actorId: "self",
      title: "Episode 2",
      videoUrl: "https://www.bilibili.com/video/BV1?p=2",
    },
    state,
    localMemberId: "self",
    lastSharedVideoToastKey: null,
    normalizedToastUrl: "https://www.bilibili.com/video/BV1?p=2",
    normalizedSharedUrl: "https://www.bilibili.com/video/BV1?p=2",
    // A stale pending target for a different episode must not trigger the toast.
    localAutoShareTargetUrl: "https://www.bilibili.com/video/BV1?p=3",
  });

  assert.equal(result.message, null);
  setLocaleForTests(null);
});

function playingPeerState(args: {
  currentTime: number;
  serverTime: number;
  playState?: "playing" | "paused";
  playbackRate?: number;
}): RoomState {
  return createRoomState({
    members: [
      { id: "self", name: "Me" },
      { id: "remote", name: "Alice" },
    ],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
    playback: {
      url: "https://www.bilibili.com/video/BV1?p=1",
      currentTime: args.currentTime,
      playState: args.playState ?? "playing",
      playbackRate: args.playbackRate ?? 1,
      updatedAt: args.serverTime,
      serverTime: args.serverTime,
      actorId: "remote",
      seq: args.serverTime,
    },
  });
}

function peerToastMessages(args: {
  previousState: RoomState;
  nextState: RoomState;
  elapsedSincePreviousStateMs: number;
}): string[] {
  return getRoomStateToastMessages({
    previousState: args.previousState,
    nextState: args.nextState,
    localMemberId: "self",
    pendingRoomStateHydration: false,
    isCurrentPageShowingSharedVideo: true,
    now: 10_000,
    elapsedSincePreviousStateMs: args.elapsedSincePreviousStateMs,
    lastSeekToastByActor: new Map(),
  }).messages;
}

test("reports a mid-playback seek when both time references agree", () => {
  setLocaleForTests("zh-CN");

  const messages = peerToastMessages({
    previousState: playingPeerState({ currentTime: 10, serverTime: 1_000 }),
    nextState: playingPeerState({ currentTime: 42, serverTime: 3_000 }),
    elapsedSincePreviousStateMs: 2_000,
  });

  assert.deepEqual(messages, ["Alice 跳转到 0:42"]);
});

test("stays silent when only the server's clock moved", () => {
  setLocaleForTests("zh-CN");
  // The reported false positive: the peer played steadily for 2.1s, but the
  // server's clock was stepped ~1.9s in between, so its timestamps claim 4s
  // passed. Nobody seeked.
  const messages = peerToastMessages({
    previousState: playingPeerState({ currentTime: 10, serverTime: 1_000 }),
    nextState: playingPeerState({ currentTime: 12.1, serverTime: 5_000 }),
    elapsedSincePreviousStateMs: 2_100,
  });

  assert.deepEqual(messages, []);
});

test("stays silent when only this page stalled", () => {
  setLocaleForTests("zh-CN");
  // The mirror image: the two states were processed back to back after the main
  // thread stalled, so locally no time appears to have passed.
  const messages = peerToastMessages({
    previousState: playingPeerState({ currentTime: 10, serverTime: 1_000 }),
    nextState: playingPeerState({ currentTime: 12.1, serverTime: 3_100 }),
    elapsedSincePreviousStateMs: 0,
  });

  assert.deepEqual(messages, []);
});

test("does not report a seek when a peer resumes after a long pause", () => {
  setLocaleForTests("zh-CN");
  // Position unchanged across a 30s pause: crediting the elapsed time here would
  // report the pause itself as a 30s backwards jump.
  const messages = peerToastMessages({
    previousState: playingPeerState({
      currentTime: 10,
      serverTime: 1_000,
      playState: "paused",
    }),
    nextState: playingPeerState({ currentTime: 10, serverTime: 31_000 }),
    elapsedSincePreviousStateMs: 30_000,
  });

  assert.deepEqual(messages, ["Alice 开始播放"]);
});

test("reports a seek that lands together with a pause", () => {
  setLocaleForTests("zh-CN");

  const messages = peerToastMessages({
    previousState: playingPeerState({ currentTime: 10, serverTime: 1_000 }),
    nextState: playingPeerState({
      currentTime: 100,
      serverTime: 3_000,
      playState: "paused",
    }),
    elapsedSincePreviousStateMs: 2_000,
  });

  assert.deepEqual(messages, ["Alice 暂停了视频", "Alice 跳转到 1:40"]);
});

test("suppresses the paused toast for a buffer-upgrade paused state", () => {
  setLocaleForTests("zh-CN");
  // #286. A peer that opened the shared video but never got playing: the
  // extension held it paused, its load pause outlived the buffering
  // classification, and the upgrade re-broadcast the real `paused`. Nobody
  // pressed pause, so "Alice 暂停了视频" names an action that never happened.
  const previousState = createRoomState({
    members: [
      { id: "self", name: "Me" },
      { id: "remote", name: "Alice" },
    ],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
    playback: {
      url: "https://www.bilibili.com/video/BV1?p=1",
      currentTime: 0,
      playState: "buffering",
      playbackRate: 1,
      updatedAt: 1,
      serverTime: 1000,
      actorId: "remote",
      seq: 1,
    },
  });
  const nextState = createRoomState({
    members: [
      { id: "self", name: "Me" },
      { id: "remote", name: "Alice" },
    ],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
    playback: {
      url: "https://www.bilibili.com/video/BV1?p=1",
      currentTime: 0,
      playState: "paused",
      bufferUpgrade: true,
      playbackRate: 1,
      updatedAt: 2,
      serverTime: 2500,
      actorId: "remote",
      seq: 2,
    },
  });

  const result = getRoomStateToastMessages({
    previousState,
    nextState,
    localMemberId: "self",
    pendingRoomStateHydration: false,
    isCurrentPageShowingSharedVideo: true,
    now: 1000,
    elapsedSincePreviousStateMs: 1500,
    lastSeekToastByActor: new Map(),
  });

  assert.deepEqual(result.messages, []);
});

test("still shows the paused toast for an untagged buffering-to-paused transition", () => {
  setLocaleForTests("zh-CN");
  // Discriminating control for the test above: the SAME buffering→paused shape
  // without the tag is a peer who really did press pause while buffering. If
  // the suppression keyed on the transition instead of the tag, this toast
  // would disappear too and the room would stop reporting real pauses.
  const previousState = createRoomState({
    members: [
      { id: "self", name: "Me" },
      { id: "remote", name: "Alice" },
    ],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
    playback: {
      url: "https://www.bilibili.com/video/BV1?p=1",
      currentTime: 0,
      playState: "buffering",
      playbackRate: 1,
      updatedAt: 1,
      serverTime: 1000,
      actorId: "remote",
      seq: 1,
    },
  });
  const nextState = createRoomState({
    members: [
      { id: "self", name: "Me" },
      { id: "remote", name: "Alice" },
    ],
    sharedUrl: "https://www.bilibili.com/video/BV1?p=1",
    playback: {
      url: "https://www.bilibili.com/video/BV1?p=1",
      currentTime: 0,
      playState: "paused",
      playbackRate: 1,
      updatedAt: 2,
      serverTime: 2500,
      actorId: "remote",
      seq: 2,
    },
  });

  const result = getRoomStateToastMessages({
    previousState,
    nextState,
    localMemberId: "self",
    pendingRoomStateHydration: false,
    isCurrentPageShowingSharedVideo: true,
    now: 1000,
    elapsedSincePreviousStateMs: 1500,
    lastSeekToastByActor: new Map(),
  });

  assert.deepEqual(result.messages, ["Alice 暂停了视频"]);
});
