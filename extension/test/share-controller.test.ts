import assert from "node:assert/strict";
import test from "node:test";
import {
  createShareController,
  shouldIncludePlaybackInSharePayload,
} from "../src/content/share-controller";
import { createContentRuntimeState } from "../src/content/runtime-state";

function installDomStub(args: {
  href: string;
  pathname: string;
  title: string;
  currentPartTitle?: string | null;
  currentPartEpId?: string | null;
  currentPartCid?: string | null;
  video?: HTMLVideoElement | null;
}): { restore: () => void } {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  Object.assign(globalThis, {
    window: {
      location: {
        href: args.href,
        pathname: args.pathname,
      },
      setTimeout,
    },
    document: {
      title: args.title,
      querySelector(selector: string) {
        if (selector === "video") {
          return args.video ?? null;
        }
        if (
          args.currentPartTitle ||
          args.currentPartEpId ||
          args.currentPartCid
        ) {
          return {
            textContent: args.currentPartTitle ?? "",
            getAttribute(name: string) {
              if (name === "data-ep-id") {
                return args.currentPartEpId ?? null;
              }
              if (name === "data-cid") {
                return args.currentPartCid ?? null;
              }
              return null;
            },
          };
        }
        return null;
      },
    },
  });

  return {
    restore() {
      Object.assign(globalThis, {
        window: originalWindow,
        document: originalDocument,
      });
    },
  };
}

test("includes playback snapshot when not switching the room shared video", () => {
  assert.equal(
    shouldIncludePlaybackInSharePayload({
      activeRoomCode: "ROOM01",
      activeSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
      nextSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
    }),
    true,
  );
});

test("includes playback snapshot when switching to a different shared video in-room", () => {
  assert.equal(
    shouldIncludePlaybackInSharePayload({
      activeRoomCode: "ROOM01",
      activeSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
      nextSharedUrl: "https://www.bilibili.com/video/BV199W9zEEcH",
    }),
    true,
  );
});

test("keeps playback snapshot outside of a room", () => {
  assert.equal(
    shouldIncludePlaybackInSharePayload({
      activeRoomCode: null,
      activeSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
      nextSharedUrl: "https://www.bilibili.com/video/BV199W9zEEcH",
    }),
    true,
  );
});

test("share controller keeps playback snapshot while switching to another shared video in-room", () => {
  const dom = installDomStub({
    href: "https://www.bilibili.com/video/BV199W9zEEcH",
    pathname: "/video/BV199W9zEEcH",
    title: "New Video_哔哩哔哩",
    video: {
      currentTime: 95.03,
      playbackRate: 1.08,
      paused: false,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BV1xx411c7mD";
  runtimeState.intendedPlayState = "playing";

  const debugLogs: string[] = [];
  const controller = createShareController({
    runtimeState,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 7,
    getFestivalSnapshot: () => null,
    refreshFestivalBridge: async () => null,
    debugLog: (message) => {
      debugLogs.push(message);
    },
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.ok(payload);
    assert.equal(
      payload?.video.url,
      "https://www.bilibili.com/video/BV199W9zEEcH",
    );
    assert.equal(payload?.playback?.currentTime, 95.03);
    assert.equal(payload?.playback?.playbackRate, 1.08);
    assert.equal(payload?.playback?.playState, "playing");
    assert.equal(debugLogs.length, 0);
  } finally {
    dom.restore();
  }
});

test("share controller resolves bangumi season pages through page snapshot", async () => {
  const dom = installDomStub({
    href: "https://www.bilibili.com/bangumi/play/ss357?from_spmid=666.25.series.0",
    pathname: "/bangumi/play/ss357",
    title: "猫和老鼠_番剧_bilibili",
    video: {
      currentTime: 10.01,
      playbackRate: 1,
      paused: true,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const runtimeState = createContentRuntimeState();
  runtimeState.intendedPlayState = "paused";

  const controller = createShareController({
    runtimeState,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 3,
    getFestivalSnapshot: () => null,
    refreshFestivalBridge: async () => ({
      videoId: "ep508404",
      url: "https://www.bilibili.com/bangumi/play/ep508404",
      title: "第46话",
    }),
    debugLog: () => undefined,
  });

  try {
    const payload = await controller.resolveCurrentSharePayload();

    assert.ok(payload);
    assert.equal(
      payload.video.url,
      "https://www.bilibili.com/bangumi/play/ep508404",
    );
    assert.equal(payload.video.videoId, "ep508404");
    assert.equal(payload.playback?.url, payload.video.url);
    assert.equal(payload.playback?.currentTime, 10.01);
  } finally {
    dom.restore();
  }
});

test("share controller does not reuse cached bangumi snapshot synchronously", () => {
  const dom = installDomStub({
    href: "https://www.bilibili.com/bangumi/play/ss357?from_spmid=666.25.series.0",
    pathname: "/bangumi/play/ss357",
    title: "猫和老鼠_番剧_bilibili",
    video: {
      currentTime: 10.01,
      playbackRate: 1,
      paused: true,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const runtimeState = createContentRuntimeState();
  const controller = createShareController({
    runtimeState,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 4,
    getFestivalSnapshot: () => ({
      videoId: "ep-old",
      url: "https://www.bilibili.com/bangumi/play/ep-old",
      title: "上一话",
      updatedAt: Date.now(),
    }),
    refreshFestivalBridge: async () => null,
    debugLog: () => undefined,
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.ok(payload);
    assert.equal(payload.video.videoId, "ss357");
    assert.equal(
      payload.video.url,
      "https://www.bilibili.com/bangumi/play/ss357",
    );
  } finally {
    dom.restore();
  }
});

test("share controller reuses matching cached bangumi snapshot for current page identity", () => {
  const dom = installDomStub({
    href: "https://www.bilibili.com/bangumi/play/ss357?from_spmid=666.25.series.0",
    pathname: "/bangumi/play/ss357",
    title: "猫和老鼠_番剧_bilibili",
    currentPartTitle: "第46话",
    video: {
      currentTime: 10.01,
      playbackRate: 1,
      paused: true,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const runtimeState = createContentRuntimeState();
  const controller = createShareController({
    runtimeState,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 5,
    getFestivalSnapshot: () => ({
      videoId: "ep508404",
      url: "https://www.bilibili.com/bangumi/play/ep508404",
      title: "第46话",
      updatedAt: Date.now(),
      epId: "ep508404",
      pathname: "/bangumi/play/ss357",
      pageUrl:
        "https://www.bilibili.com/bangumi/play/ss357?from_spmid=666.25.series.0",
    }),
    refreshFestivalBridge: async () => null,
    debugLog: () => undefined,
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.ok(payload);
    assert.equal(payload.video.videoId, "ep508404");
    assert.equal(
      payload.video.url,
      "https://www.bilibili.com/bangumi/play/ep508404",
    );
  } finally {
    dom.restore();
  }
});

test("share controller reuses cached bangumi snapshot by active episode id without title", () => {
  const dom = installDomStub({
    href: "https://www.bilibili.com/bangumi/play/ss357",
    pathname: "/bangumi/play/ss357",
    title: "猫和老鼠_番剧_bilibili",
    currentPartEpId: "508404",
    video: {
      currentTime: 10.01,
      playbackRate: 1,
      paused: true,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const runtimeState = createContentRuntimeState();
  const controller = createShareController({
    runtimeState,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 6,
    getFestivalSnapshot: () => ({
      videoId: "ep508404",
      url: "https://www.bilibili.com/bangumi/play/ep508404",
      title: "第46话",
      updatedAt: Date.now(),
      epId: "ep508404",
      pathname: "/bangumi/play/ss357",
      pageUrl: "https://www.bilibili.com/bangumi/play/ss357",
    }),
    refreshFestivalBridge: async () => null,
    debugLog: () => undefined,
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.ok(payload);
    assert.equal(payload.video.videoId, "ep508404");
    assert.equal(
      payload.video.url,
      "https://www.bilibili.com/bangumi/play/ep508404",
    );
  } finally {
    dom.restore();
  }
});

test("share controller reuses cached bangumi snapshot by active cid without title", () => {
  const dom = installDomStub({
    href: "https://www.bilibili.com/bangumi/play/ss357",
    pathname: "/bangumi/play/ss357",
    title: "猫和老鼠_番剧_bilibili",
    currentPartCid: "987654",
    video: {
      currentTime: 10.01,
      playbackRate: 1,
      paused: true,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const runtimeState = createContentRuntimeState();
  const controller = createShareController({
    runtimeState,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 7,
    getFestivalSnapshot: () => ({
      videoId: "BV1abc:987654",
      url: "https://www.bilibili.com/video/BV1abc?cid=987654",
      title: "第46话",
      updatedAt: Date.now(),
      cid: "987654",
      pathname: "/bangumi/play/ss357",
      pageUrl: "https://www.bilibili.com/bangumi/play/ss357",
    }),
    refreshFestivalBridge: async () => null,
    debugLog: () => undefined,
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.ok(payload);
    assert.equal(payload.video.videoId, "BV1abc:987654");
    assert.equal(
      payload.video.url,
      "https://www.bilibili.com/video/BV1abc?cid=987654",
    );
  } finally {
    dom.restore();
  }
});

test("share controller rejects same-title cached bangumi snapshot from another page", () => {
  const dom = installDomStub({
    href: "https://www.bilibili.com/bangumi/play/ss39837",
    pathname: "/bangumi/play/ss39837",
    title: "另一部番剧_番剧_bilibili",
    currentPartTitle: "第1话",
    video: {
      currentTime: 10.01,
      playbackRate: 1,
      paused: true,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const runtimeState = createContentRuntimeState();
  const controller = createShareController({
    runtimeState,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 6,
    getFestivalSnapshot: () => ({
      videoId: "ep-old",
      url: "https://www.bilibili.com/bangumi/play/ep-old",
      title: "第1话",
      updatedAt: Date.now(),
      pathname: "/bangumi/play/ss357",
      pageUrl: "https://www.bilibili.com/bangumi/play/ss357",
    }),
    refreshFestivalBridge: async () => null,
    debugLog: () => undefined,
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.ok(payload);
    assert.equal(payload.video.videoId, "ss39837");
    assert.equal(
      payload.video.url,
      "https://www.bilibili.com/bangumi/play/ss39837",
    );
  } finally {
    dom.restore();
  }
});

test("share controller rejects cached bangumi snapshot on festival page", () => {
  const dom = installDomStub({
    href: "https://www.bilibili.com/festival/demo",
    pathname: "/festival/demo",
    title: "Festival_哔哩哔哩",
    video: {
      currentTime: 10.01,
      playbackRate: 1,
      paused: true,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const runtimeState = createContentRuntimeState();
  const controller = createShareController({
    runtimeState,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 8,
    getFestivalSnapshot: () => ({
      videoId: "ep508404",
      url: "https://www.bilibili.com/bangumi/play/ep508404",
      title: "第46话",
      updatedAt: Date.now(),
      epId: "ep508404",
      pathname: "/bangumi/play/ss357",
      pageUrl: "https://www.bilibili.com/bangumi/play/ss357",
    }),
    refreshFestivalBridge: async () => null,
    debugLog: () => undefined,
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.ok(payload);
    assert.equal(payload.video.videoId, "/festival/demo");
    assert.equal(payload.video.url, "https://www.bilibili.com/festival/demo");
  } finally {
    dom.restore();
  }
});

test("share controller reuses cached festival snapshot across trailing slash path variants", () => {
  const dom = installDomStub({
    href: "https://www.bilibili.com/festival/demo/",
    pathname: "/festival/demo/",
    title: "Festival_哔哩哔哩",
    video: {
      currentTime: 10.01,
      playbackRate: 1,
      paused: true,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const runtimeState = createContentRuntimeState();
  const controller = createShareController({
    runtimeState,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 9,
    getFestivalSnapshot: () => ({
      videoId: "BVfestival:123",
      url: "https://www.bilibili.com/festival/demo?bvid=BVfestival&cid=123",
      title: "Festival Episode",
      updatedAt: Date.now(),
      cid: "123",
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
    }),
    refreshFestivalBridge: async () => null,
    debugLog: () => undefined,
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.ok(payload);
    assert.equal(payload.video.videoId, "BVfestival:123");
    assert.equal(
      payload.video.url,
      "https://www.bilibili.com/festival/demo?bvid=BVfestival&cid=123",
    );
  } finally {
    dom.restore();
  }
});
