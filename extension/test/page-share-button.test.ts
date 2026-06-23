import assert from "node:assert/strict";
import test from "node:test";
import type {
  ActiveVideoResponsePayload,
  ContentToBackgroundMessage,
} from "../src/shared/messages";
import {
  clampPageShareButtonPosition,
  createPageSharePopoverViewModel,
  getDefaultPageShareButtonPosition,
  getPageSharePopoverPosition,
  hasPageShareButtonDragMoved,
  shareCurrentPageVideoFromContent,
} from "../src/content/page-share-button";
import { resolvePageShareButtonSettingsHydration } from "../src/content/page-share-button-settings";
import { setLocaleForTests } from "../src/shared/i18n";

const currentPayload: ActiveVideoResponsePayload = {
  video: {
    videoId: "BV199W9zEEcH",
    url: "https://www.bilibili.com/video/BV199W9zEEcH",
    title: "New Video",
  },
  playback: null,
};

function createHarness(args: {
  payload?: ActiveVideoResponsePayload | null;
  contextResponse?: unknown;
  shareResponse?: unknown;
  confirmResult?: boolean;
}) {
  const sentMessages: ContentToBackgroundMessage[] = [];
  const confirmMessages: string[] = [];
  const toastMessages: string[] = [];

  return {
    sentMessages,
    confirmMessages,
    toastMessages,
    run: () =>
      shareCurrentPageVideoFromContent({
        resolveCurrentSharePayload: async () =>
          args.payload === undefined ? currentPayload : args.payload,
        runtimeSendMessage: async (message) => {
          sentMessages.push(message);
          if (message.type === "content:get-share-context") {
            return args.contextResponse;
          }
          if (message.type === "content:share-current-video") {
            return args.shareResponse ?? { ok: true };
          }
          return null;
        },
        confirm: (message) => {
          confirmMessages.push(message);
          return args.confirmResult ?? true;
        },
        showToast: (message) => {
          toastMessages.push(message);
        },
      }),
  };
}

test("page share action confirms room creation before sharing outside a room", async () => {
  setLocaleForTests("zh-CN");
  const harness = createHarness({
    contextResponse: {
      ok: true,
      roomCode: null,
      memberCount: null,
      sharedVideo: null,
    },
    confirmResult: true,
  });

  const result = await harness.run();

  assert.equal(result, "shared");
  assert.deepEqual(harness.confirmMessages, [
    "当前未加入房间。是否创建房间并同步当前页视频？",
  ]);
  assert.deepEqual(
    harness.sentMessages.map((message) => message.type),
    ["content:get-share-context", "content:share-current-video"],
  );
  assert.deepEqual(harness.sentMessages[1], {
    type: "content:share-current-video",
  });
  assert.deepEqual(harness.toastMessages, ["已同步当前页视频"]);
});

test("page share action stops when room creation is cancelled", async () => {
  setLocaleForTests("zh-CN");
  const harness = createHarness({
    contextResponse: {
      ok: true,
      roomCode: null,
      memberCount: null,
      sharedVideo: null,
    },
    confirmResult: false,
  });

  const result = await harness.run();

  assert.equal(result, "cancelled");
  assert.deepEqual(harness.confirmMessages, [
    "当前未加入房间。是否创建房间并同步当前页视频？",
  ]);
  assert.deepEqual(
    harness.sentMessages.map((message) => message.type),
    ["content:get-share-context"],
  );
  assert.deepEqual(harness.toastMessages, []);
});

test("page share action confirms replacement when the room shares another video", async () => {
  setLocaleForTests("zh-CN");
  const harness = createHarness({
    contextResponse: {
      ok: true,
      roomCode: "ROOM01",
      memberCount: 2,
      sharedVideo: {
        videoId: "BV1xx411c7mD",
        url: "https://www.bilibili.com/video/BV1xx411c7mD",
        title: "Current Video",
      },
    },
  });

  const result = await harness.run();

  assert.equal(result, "shared");
  assert.deepEqual(harness.confirmMessages, [
    "当前房间正在同步《Current Video》。\n是否替换为《New Video》？",
  ]);
  assert.deepEqual(
    harness.sentMessages.map((message) => message.type),
    ["content:get-share-context", "content:share-current-video"],
  );
});

test("page share action skips replacement confirmation for the current shared video", async () => {
  setLocaleForTests("zh-CN");
  const harness = createHarness({
    contextResponse: {
      ok: true,
      roomCode: "ROOM01",
      memberCount: 1,
      sharedVideo: currentPayload.video,
    },
  });

  const result = await harness.run();

  assert.equal(result, "shared");
  assert.deepEqual(harness.confirmMessages, []);
  assert.deepEqual(
    harness.sentMessages.map((message) => message.type),
    ["content:get-share-context", "content:share-current-video"],
  );
});

test("page share action reports when no playable video is available", async () => {
  setLocaleForTests("zh-CN");
  const harness = createHarness({
    payload: null,
    contextResponse: {
      ok: true,
      roomCode: "ROOM01",
      memberCount: 1,
      sharedVideo: null,
    },
  });

  const result = await harness.run();

  assert.equal(result, "no-video");
  assert.deepEqual(harness.sentMessages, []);
  assert.deepEqual(harness.confirmMessages, []);
  assert.deepEqual(harness.toastMessages, ["当前页面没有可播放的视频。"]);
});

test("page share action reports background share failures", async () => {
  setLocaleForTests("zh-CN");
  const harness = createHarness({
    contextResponse: {
      ok: true,
      roomCode: "ROOM01",
      memberCount: 1,
      sharedVideo: currentPayload.video,
    },
    shareResponse: {
      ok: false,
      error: "成员令牌缺失，请重新加入房间。",
    },
  });

  const result = await harness.run();

  assert.equal(result, "share-error");
  assert.deepEqual(harness.confirmMessages, []);
  assert.deepEqual(harness.toastMessages, [
    "同步失败：成员令牌缺失，请重新加入房间。",
  ]);
});

test("page share button settings hydration applies valid settings responses", () => {
  assert.deepEqual(
    resolvePageShareButtonSettingsHydration({ ok: true, enabled: false }, 1, 6),
    { action: "apply", enabled: false },
  );
});

test("page share button settings hydration retries failures before giving up", () => {
  assert.deepEqual(
    resolvePageShareButtonSettingsHydration(
      { ok: false, error: "booting" },
      1,
      6,
    ),
    { action: "retry" },
  );
  assert.deepEqual(resolvePageShareButtonSettingsHydration(null, 6, 6), {
    action: "give-up",
  });
});

test("page share button default position starts near the lower-right viewport", () => {
  assert.deepEqual(
    getDefaultPageShareButtonPosition({ width: 1200, height: 800 }),
    {
      x: 1144,
      y: 684,
    },
  );
});

test("page share button position is clamped inside the visible viewport", () => {
  assert.deepEqual(
    clampPageShareButtonPosition(
      { x: 5000, y: -20 },
      { width: 360, height: 240 },
    ),
    {
      x: 312,
      y: 12,
    },
  );
});

test("page share button position can recover after a temporary viewport shrink", () => {
  const desiredPosition = { x: 1144, y: 684 };

  assert.deepEqual(
    clampPageShareButtonPosition(desiredPosition, { width: 360, height: 800 }),
    {
      x: 312,
      y: 684,
    },
  );
  assert.deepEqual(desiredPosition, { x: 1144, y: 684 });
  assert.deepEqual(
    clampPageShareButtonPosition(desiredPosition, { width: 1200, height: 800 }),
    {
      x: 1144,
      y: 684,
    },
  );
});

test("page share button position rounds to whole pixels", () => {
  assert.deepEqual(
    clampPageShareButtonPosition(
      { x: 120.4, y: 220.6 },
      { width: 1200, height: 800 },
    ),
    {
      x: 120,
      y: 221,
    },
  );
});

test("page share button drag threshold distinguishes click from drag", () => {
  assert.equal(hasPageShareButtonDragMoved(2, 3), false);
  assert.equal(hasPageShareButtonDragMoved(3, 3), true);
});

test("page share popover view model displays current room info", () => {
  setLocaleForTests("zh-CN");

  assert.deepEqual(
    createPageSharePopoverViewModel({
      loading: false,
      error: null,
      context: {
        ok: true,
        roomCode: "ROOM01",
        memberCount: 2,
        sharedVideo: currentPayload.video,
      },
    }),
    {
      status: null,
      rows: [
        { label: "房间码", value: "ROOM01" },
        { label: "成员", value: "2人" },
        { label: "共享视频", value: "New Video" },
      ],
    },
  );
});

test("page share popover view model reports loading and no room states", () => {
  setLocaleForTests("zh-CN");

  assert.deepEqual(
    createPageSharePopoverViewModel({
      loading: true,
      error: null,
      context: null,
    }),
    {
      status: "读取房间信息...",
      rows: [],
    },
  );
  assert.deepEqual(
    createPageSharePopoverViewModel({
      loading: false,
      error: null,
      context: {
        ok: true,
        roomCode: null,
        memberCount: null,
        sharedVideo: null,
      },
    }),
    {
      status: "未加入房间",
      rows: [],
    },
  );
});

test("page share popover position stays inside the viewport", () => {
  assert.deepEqual(
    getPageSharePopoverPosition(
      { x: 1144, y: 684 },
      { width: 1200, height: 800 },
    ),
    {
      x: 906,
      y: 629,
    },
  );
  assert.deepEqual(
    getPageSharePopoverPosition({ x: 12, y: 12 }, { width: 1200, height: 800 }),
    {
      x: 58,
      y: 12,
    },
  );
});
