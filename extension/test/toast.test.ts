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
