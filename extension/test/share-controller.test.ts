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
  headingTitle?: string | null;
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
        // The heading is a separate element from the episode list's highlighted
        // item; answering the item for `h1` too would hand the title resolver the
        // same string twice and hide which source it actually picked.
        if (selector === "h1") {
          return args.headingTitle
            ? { textContent: args.headingTitle, getAttribute: () => null }
            : null;
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

test("share controller reports a paused video as paused once its buffer-pause window has elapsed", () => {
  // #258: the snapshot went out as `buffering` for a video that had been sitting
  // paused since page load, because the old `getPlayState` answered from
  // `intendedPlayState` (the last thing broadcast) instead of the element. A
  // receiver neither pauses for `buffering` nor lets its pause hold act on it,
  // so the joiner's fresh tab autoplayed and pulled the whole room into play.
  const dom = installDomStub({
    href: "https://www.bilibili.com/video/BV199W9zEEcH",
    pathname: "/video/BV199W9zEEcH",
    title: "New Video_哔哩哔哩",
    video: {
      currentTime: 6.01,
      playbackRate: 1,
      paused: true,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  // The load-time buffer pause was broadcast, so the intent latched to it.
  runtimeState.intendedPlayState = "buffering";
  runtimeState.pauseStartedAt = 8_000;
  runtimeState.pauseClassifiedAsBuffer = true;

  const controller = createShareController({
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    // 1.7s after the pause: past the window, so this is a real pause.
    getMonotonicNow: () => 9_700,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 7,
    getFestivalSnapshot: () => null,
    refreshFestivalBridge: async () => null,
    debugLog: () => {},
  });

  try {
    assert.equal(
      controller.getCurrentSharePayload()?.playback?.playState,
      "paused",
    );
  } finally {
    dom.restore();
  }
});

test("share controller still reports buffering inside the buffer-pause window", () => {
  // The other polarity: a genuine player hiccup must NOT be shared as `paused`,
  // or sharing mid-stall would stop the room.
  const dom = installDomStub({
    href: "https://www.bilibili.com/video/BV199W9zEEcH",
    pathname: "/video/BV199W9zEEcH",
    title: "New Video_哔哩哔哩",
    video: {
      currentTime: 6.01,
      playbackRate: 1,
      paused: true,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.intendedPlayState = "buffering";
  runtimeState.pauseStartedAt = 8_000;
  runtimeState.pauseClassifiedAsBuffer = true;

  const controller = createShareController({
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    // 0.5s after the pause: still inside the window.
    getMonotonicNow: () => 8_500,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 7,
    getFestivalSnapshot: () => null,
    refreshFestivalBridge: async () => null,
    debugLog: () => {},
  });

  try {
    assert.equal(
      controller.getCurrentSharePayload()?.playback?.playState,
      "buffering",
    );
  } finally {
    dom.restore();
  }
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
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
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
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
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
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
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
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
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
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
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
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
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
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
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
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
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
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
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

test("share controller reports the room's base rate while a catch-up is running", () => {
  // `video:share` is a second wire path that carries a playback rate, and the
  // server persists whatever it carries. During a catch-up `video.playbackRate`
  // is a temporary offset this client added to close its own drift, so
  // re-sharing mid-catch-up would write that temporary rate straight into room
  // state — the same pollution `playback:update` was fixed for (#238).
  const dom = installDomStub({
    href: "https://www.bilibili.com/video/BV199W9zEEcH",
    pathname: "/video/BV199W9zEEcH",
    title: "New Video_哔哩哔哩",
    video: {
      currentTime: 95.03,
      // The catch-up lowered the element to 0.84; the room is at 1.
      playbackRate: 0.84,
      paused: false,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BV1xx411c7mD";
  runtimeState.intendedPlayState = "playing";

  const requestedUrls: Array<string | undefined | null> = [];
  const controller = createShareController({
    getActiveCorrectionBaseRate: (url) => {
      requestedUrls.push(url);
      return 1;
    },
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 7,
    getFestivalSnapshot: () => null,
    refreshFestivalBridge: async () => null,
    debugLog: () => {},
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.ok(payload);
    assert.equal(payload?.playback?.playbackRate, 1);
    assert.notEqual(payload?.playback?.playbackRate, 0.84);
    // Asked about the video being shared, not some other url.
    assert.deepEqual(requestedUrls, [
      "https://www.bilibili.com/video/BV199W9zEEcH",
    ]);
  } finally {
    dom.restore();
  }
});

test("share controller falls back to the element rate with no catch-up running", () => {
  const dom = installDomStub({
    href: "https://www.bilibili.com/video/BV199W9zEEcH",
    pathname: "/video/BV199W9zEEcH",
    title: "New Video_哔哩哔哩",
    video: {
      currentTime: 95.03,
      playbackRate: 1.5,
      paused: false,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BV1xx411c7mD";
  runtimeState.intendedPlayState = "playing";

  const controller = createShareController({
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 7,
    getFestivalSnapshot: () => null,
    refreshFestivalBridge: async () => null,
    debugLog: () => {},
  });

  try {
    // The user's own 1.5x must still reach the room when nothing is correcting.
    assert.equal(
      controller.getCurrentSharePayload()?.playback?.playbackRate,
      1.5,
    );
  } finally {
    dom.restore();
  }
});

test("stops falling back to the frozen festival address bar once a snapshot has resolved", () => {
  const dom = installDomStub({
    href: "https://www.bilibili.com/festival/MyMuji?bvid=BVfrozen",
    pathname: "/festival/MyMuji",
    title: "MyMuji_哔哩哔哩",
  });
  const runtimeState = createContentRuntimeState();
  // The festival snapshot resolves the video actually playing, then goes away —
  // the navigation controller clears it on every autoplay-next so the bridge
  // re-resolves. During that window the address bar still names the video the
  // page was OPENED with, which is not what is playing.
  let snapshot: {
    videoId: string;
    url: string;
    title: string;
    updatedAt: number;
    pathname?: string;
    pageUrl?: string;
  } | null = {
    videoId: "BVplaying:2",
    url: "https://www.bilibili.com/video/BVplaying?cid=2",
    title: "Playing Video",
    updatedAt: 1_000,
    pathname: "/festival/MyMuji",
    pageUrl: "https://www.bilibili.com/festival/MyMuji?bvid=BVfrozen",
  };

  const controller = createShareController({
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 1,
    getFestivalSnapshot: () => snapshot,
    refreshFestivalBridge: async () => null,
    debugLog: () => {},
  });

  try {
    assert.equal(
      controller.getSharedVideo()?.url,
      "https://www.bilibili.com/video/BVplaying?cid=2",
    );

    snapshot = null;

    // Answering `null` ("not known yet") is what routes callers to their
    // unresolved-identity paths. Answering `/video/BVfrozen` instead reads as a
    // different, non-shared video and gets the page force-paused.
    assert.equal(controller.getSharedVideo(), null);
  } finally {
    dom.restore();
  }
});

test("still resolves the festival address bar before any snapshot has resolved", () => {
  const dom = installDomStub({
    href: "https://www.bilibili.com/festival/MyMuji?bvid=BVshared&cid=99",
    pathname: "/festival/MyMuji",
    title: "MyMuji_哔哩哔哩",
  });
  const runtimeState = createContentRuntimeState();

  const controller = createShareController({
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 1,
    getFestivalSnapshot: () => null,
    refreshFestivalBridge: async () => null,
    debugLog: () => {},
  });

  try {
    assert.equal(
      controller.getSharedVideo()?.url,
      "https://www.bilibili.com/video/BVshared?cid=99",
    );
  } finally {
    dom.restore();
  }
});

test("uses the festival address bar again after leaving and returning to the page", () => {
  const festivalUrl =
    "https://www.bilibili.com/festival/MyMuji?bvid=BVentry&cid=1";
  const dom = installDomStub({
    href: festivalUrl,
    pathname: "/festival/MyMuji",
    title: "MyMuji_哔哩哔哩",
  });
  const runtimeState = createContentRuntimeState();
  let snapshot: {
    videoId: string;
    url: string;
    title: string;
    updatedAt: number;
    pathname?: string;
    pageUrl?: string;
  } | null = {
    videoId: "BVplaying:2",
    url: "https://www.bilibili.com/video/BVplaying?cid=2",
    title: "Playing Video",
    updatedAt: 1_000,
    pathname: "/festival/MyMuji",
    pageUrl: festivalUrl,
  };

  const controller = createShareController({
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 1,
    getFestivalSnapshot: () => snapshot,
    refreshFestivalBridge: async () => null,
    debugLog: () => {},
  });

  try {
    assert.equal(
      controller.getSharedVideo()?.url,
      "https://www.bilibili.com/video/BVplaying?cid=2",
    );
    snapshot = null;
    assert.equal(controller.getSharedVideo(), null);

    // The navigation controller reports the departure immediately. This must
    // reset the visit even when no video lookup occurs on the page in between.
    controller.observePageVisit("https://www.bilibili.com/video/BVaway");
    Object.assign(window.location, {
      href: "https://www.bilibili.com/video/BVaway",
      pathname: "/video/BVaway",
    });

    // Returning through the exact same share link is a new page visit: before
    // its first snapshot, the entry bvid/cid is correct and must be usable.
    Object.assign(window.location, {
      href: festivalUrl,
      pathname: "/festival/MyMuji",
    });
    assert.equal(
      controller.getSharedVideo()?.url,
      "https://www.bilibili.com/video/BVentry?cid=1",
    );
  } finally {
    dom.restore();
  }
});

test("uses a new festival share URL before that page visit resolves a snapshot", () => {
  const dom = installDomStub({
    href: "https://www.bilibili.com/festival/MyMuji?bvid=BVold&cid=1",
    pathname: "/festival/MyMuji",
    title: "MyMuji_哔哩哔哩",
  });
  const runtimeState = createContentRuntimeState();
  const snapshot: {
    videoId: string;
    url: string;
    title: string;
    updatedAt: number;
    pathname?: string;
    pageUrl?: string;
  } = {
    videoId: "BVplaying:2",
    url: "https://www.bilibili.com/video/BVplaying?cid=2",
    title: "Playing Video",
    updatedAt: 1_000,
    pathname: "/festival/MyMuji",
    pageUrl: "https://www.bilibili.com/festival/MyMuji?bvid=BVold&cid=1",
  };

  const controller = createShareController({
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 1,
    getFestivalSnapshot: () => snapshot,
    refreshFestivalBridge: async () => null,
    debugLog: () => {},
  });

  try {
    assert.equal(
      controller.getSharedVideo()?.url,
      "https://www.bilibili.com/video/BVplaying?cid=2",
    );
    // Festival autoplay never changes location.href, so a different query on
    // the same pathname denotes a new share-link visit, not another video in the
    // old visit. Its entry identity is valid until the new snapshot resolves.
    Object.assign(window.location, {
      href: "https://www.bilibili.com/festival/MyMuji?bvid=BVnew&cid=3",
    });
    assert.equal(
      controller.getSharedVideo()?.url,
      "https://www.bilibili.com/video/BVnew?cid=3",
    );
  } finally {
    dom.restore();
  }
});

test("discards a festival snapshot refresh that resolves after the page visit changes", async () => {
  const festivalUrl =
    "https://www.bilibili.com/festival/MyMuji?bvid=BVold&cid=1";
  const dom = installDomStub({
    href: festivalUrl,
    pathname: "/festival/MyMuji",
    title: "MyMuji_哔哩哔哩",
  });
  const runtimeState = createContentRuntimeState();
  let resolveBridge!: (value: {
    videoId: string;
    url: string;
    title: string;
  }) => void;
  const bridgeResult = new Promise<{
    videoId: string;
    url: string;
    title: string;
  }>((resolve) => {
    resolveBridge = resolve;
  });

  const controller = createShareController({
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 1,
    getFestivalSnapshot: () => null,
    refreshFestivalBridge: async () => bridgeResult,
    debugLog: () => {},
  });

  try {
    const pendingRefresh = controller.refreshFestivalSnapshot(0);
    const awayUrl = "https://www.bilibili.com/video/BVaway";
    controller.observePageVisit(awayUrl);
    Object.assign(window.location, {
      href: awayUrl,
      pathname: "/video/BVaway",
    });
    resolveBridge({
      videoId: "BVold:1",
      url: "https://www.bilibili.com/video/BVold?cid=1",
      title: "Old Visit",
    });

    assert.equal(await pendingRefresh, null);
  } finally {
    dom.restore();
  }
});

// --- #274: `/bangumi/play/epNNN` names its episode in the address bar ---------
//
// Every bangumi case above uses a `ss` season page, whose address bar names no
// episode — there the page snapshot rightly outranks it. On an `ep` route the
// polarity flips, and these cover the `ep -> ep` SPA switch that has none.

const EP_PAGE_HREF =
  "https://www.bilibili.com/bangumi/play/ep396139?spm_id_from=333.337.0.0";

function installEpisodePageDomStub(args: {
  currentPartTitle?: string | null;
  currentPartEpId?: string | null;
  currentPartCid?: string | null;
}) {
  return installDomStub({
    href: EP_PAGE_HREF,
    pathname: "/bangumi/play/ep396139",
    title: "45 某话_番剧_bilibili",
    currentPartTitle: args.currentPartTitle,
    currentPartEpId: args.currentPartEpId,
    currentPartCid: args.currentPartCid,
    video: {
      currentTime: 0.27,
      playbackRate: 1,
      paused: true,
      readyState: 4,
    } as HTMLVideoElement,
  });
}

function makeEpisodePageController(overrides: {
  refreshFestivalBridge: () => Promise<{
    videoId: string;
    url: string;
    title: string;
  } | null>;
  getFestivalSnapshot?: () => {
    videoId: string;
    url: string;
    title: string;
    updatedAt: number;
    epId?: string;
    cid?: string;
    pathname?: string;
    pageUrl?: string;
  } | null;
}) {
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "V52NR6";
  runtimeState.intendedPlayState = "paused";
  return createShareController({
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 414,
    getFestivalSnapshot: overrides.getFestivalSnapshot ?? (() => null),
    refreshFestivalBridge: overrides.refreshFestivalBridge,
    debugLog: () => undefined,
  });
}

test("bangumi ep page must not share the previous episode while the address bar says ep396139", async () => {
  // The reported failure: the page globals stayed on ep396138 after the SPA
  // switch, and `video:share` went out as ep396138 carrying ep396139's t=0.27,
  // pinning the room to the previous episode until a page reload.
  const dom = installEpisodePageDomStub({
    currentPartTitle: "44 连影",
    currentPartEpId: "ep396138",
  });

  const controller = makeEpisodePageController({
    refreshFestivalBridge: async () => ({
      videoId: "ep396138",
      url: "https://www.bilibili.com/bangumi/play/ep396138",
      title: "44 连影",
    }),
  });

  try {
    const payload = await controller.resolveCurrentSharePayload();

    assert.notEqual(
      payload?.video.url,
      "https://www.bilibili.com/bangumi/play/ep396138",
      "shared the previous episode while the address bar was already on ep396139",
    );
    // Worst case degrades to the address bar rather than to "no identity".
    assert.equal(
      payload?.video.url,
      "https://www.bilibili.com/bangumi/play/ep396139",
    );
    assert.equal(payload?.video.videoId, "ep396139");
  } finally {
    dom.restore();
  }
});

test("bangumi ep page retry converges on the episode the address bar names", async () => {
  // The retry loop's exit condition is "got a non-null snapshot", so before the
  // gate the first read returned and the other seven attempts never ran — even
  // though Bilibili had already refreshed the page globals by the second read.
  const dom = installEpisodePageDomStub({
    currentPartTitle: "44 连影",
    currentPartEpId: "ep396138",
  });

  let reads = 0;
  const controller = makeEpisodePageController({
    refreshFestivalBridge: async () => {
      reads += 1;
      return reads === 1
        ? {
            videoId: "ep396138",
            url: "https://www.bilibili.com/bangumi/play/ep396138",
            title: "44 连影",
          }
        : {
            videoId: "ep396139",
            url: "https://www.bilibili.com/bangumi/play/ep396139",
            title: "45 某话",
          };
    },
  });

  try {
    const payload = await controller.resolveCurrentSharePayload();

    assert.equal(
      payload?.video.url,
      "https://www.bilibili.com/bangumi/play/ep396139",
      `settled after ${reads} read(s) on ${payload?.video.url}`,
    );
    assert.equal(payload?.video.title, "45 某话");
  } finally {
    dom.restore();
  }
});

test("bangumi ep page does not reuse a cached snapshot naming another episode", async () => {
  // The cached path reaches the same wrong answer by another route: the snapshot
  // was cached under this very pathname (the read happened after the switch), and
  // both its cid and its title match the equally stale highlighted list item.
  //
  // The list item deliberately carries no `data-ep-id` here — plenty of bangumi
  // episode lists expose only `data-cid`. That is the case the snapshot's own
  // gate is for: with no episode id in the DOM, nothing can tell the item is
  // stale, and only the snapshot's `ep396138` contradicts the address bar.
  const dom = installEpisodePageDomStub({
    currentPartTitle: "44 连影",
    currentPartCid: "1200334",
  });

  const controller = makeEpisodePageController({
    refreshFestivalBridge: async () => null,
    getFestivalSnapshot: () => ({
      videoId: "ep396138",
      url: "https://www.bilibili.com/bangumi/play/ep396138",
      title: "44 连影",
      updatedAt: Date.now(),
      epId: "ep396138",
      cid: "1200334",
      pathname: "/bangumi/play/ep396139",
      pageUrl: EP_PAGE_HREF,
    }),
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.equal(
      payload?.video.url,
      "https://www.bilibili.com/bangumi/play/ep396139",
    );
    assert.equal(payload?.video.videoId, "ep396139");
    // Refusing the snapshot is only half of it. The snapshot matched the list
    // item by cid and title, which is what proves the item names ep396138 too —
    // keeping its title would ship ep396139 labelled "44 连影".
    assert.equal(payload?.video.title, "45 某话");
  } finally {
    dom.restore();
  }
});

test("bangumi ep page drops the stale highlighted item's title, not just its id", async () => {
  // With no snapshot at all the address-bar identity is right but the title came
  // from the same lagging list item, so the room would show ep396139 labelled
  // "44 连影". The document title is the episode the address bar names.
  const dom = installEpisodePageDomStub({
    currentPartTitle: "44 连影",
    currentPartEpId: "ep396138",
  });

  const controller = makeEpisodePageController({
    refreshFestivalBridge: async () => null,
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.equal(payload?.video.videoId, "ep396139");
    assert.equal(payload?.video.title, "45 某话");
  } finally {
    dom.restore();
  }
});

test("bangumi ep page keeps the highlighted item once it agrees with the address bar", async () => {
  // The other polarity of the same gate: an agreeing list item is the best title
  // available and must not be thrown away with the stale ones.
  const dom = installEpisodePageDomStub({
    currentPartTitle: "45 某话 连影",
    currentPartEpId: "ep396139",
  });

  const controller = makeEpisodePageController({
    refreshFestivalBridge: async () => null,
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.equal(payload?.video.videoId, "ep396139");
    assert.equal(payload?.video.title, "45 某话 连影");
  } finally {
    dom.restore();
  }
});

test("bangumi ep page never refutes its own address bar after a snapshot resolves", async () => {
  // A resolved snapshot marks a *festival* address bar as proven stale. An `ep`
  // route must never earn that mark: its address bar is the fallback the gate
  // above degrades to, and refuting it would fix the wrong answer in place until
  // a reload — which is exactly the reported "F5 后才恢复".
  const dom = installEpisodePageDomStub({
    currentPartTitle: "45 某话",
    currentPartEpId: "ep396139",
  });

  let bridgeAnswers = true;
  const controller = makeEpisodePageController({
    refreshFestivalBridge: async () =>
      bridgeAnswers
        ? {
            videoId: "ep396139",
            url: "https://www.bilibili.com/bangumi/play/ep396139",
            title: "45 某话",
          }
        : null,
  });

  try {
    assert.equal(
      (await controller.resolveCurrentSharePayload())?.video.videoId,
      "ep396139",
    );

    bridgeAnswers = false;
    const payload = controller.getCurrentSharePayload();

    assert.equal(payload?.video.videoId, "ep396139");
    assert.equal(
      payload?.video.url,
      "https://www.bilibili.com/bangumi/play/ep396139",
    );
  } finally {
    dom.restore();
  }
});

test("bangumi ep page refuses a snapshot that names no episode at all", async () => {
  // The page bridge answers `bvid:cid` when a bangumi page's globals expose no
  // `epId` — and in the switch window those are the *previous* episode's ids,
  // indistinguishable from the current one's by inspection. Doubt has to be
  // enough here, because the address bar already names the episode completely.
  const dom = installEpisodePageDomStub({
    currentPartTitle: "44 连影",
    currentPartCid: "1200334",
  });

  let reads = 0;
  const controller = makeEpisodePageController({
    refreshFestivalBridge: async () => {
      reads += 1;
      return {
        videoId: "BVold:1200334",
        url: "https://www.bilibili.com/video/BVold?cid=1200334",
        title: "44 连影",
      };
    },
  });

  try {
    const payload = await controller.resolveCurrentSharePayload();

    assert.equal(
      payload?.video.url,
      "https://www.bilibili.com/bangumi/play/ep396139",
      `settled after ${reads} read(s) on ${payload?.video.url}`,
    );
    assert.equal(payload?.video.videoId, "ep396139");
    assert.ok(reads > 1, "gave up after the first unconfirmed read");
  } finally {
    dom.restore();
  }
});

test("bangumi season page still accepts a snapshot that names no episode", async () => {
  // The opposite polarity of the same gate, and the reason it is keyed on the
  // route rather than on "is this bangumi": a `ss` address bar names no episode,
  // so there is nothing to confirm against and a `bvid:cid` snapshot is the best
  // identity available. Widening the gate to all of `/bangumi/play/` would leave
  // season pages with no resolvable video at all.
  const dom = installDomStub({
    href: "https://www.bilibili.com/bangumi/play/ss357",
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
    getActiveCorrectionBaseRate: () => null,
    runtimeState,
    bufferPauseUpgradeMs: 1_500,
    getMonotonicNow: () => 10_000,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 8,
    getFestivalSnapshot: () => null,
    refreshFestivalBridge: async () => ({
      videoId: "BV1xx411c7mD:9527",
      url: "https://www.bilibili.com/video/BV1xx411c7mD?cid=9527",
      title: "第46话",
    }),
    debugLog: () => undefined,
  });

  try {
    const payload = await controller.resolveCurrentSharePayload();

    assert.equal(payload?.video.videoId, "BV1xx411c7mD:9527");
    assert.equal(
      payload?.video.url,
      "https://www.bilibili.com/video/BV1xx411c7mD?cid=9527",
    );
  } finally {
    dom.restore();
  }
});

test("bangumi ep page does not step from the refuted list item onto an equally stale h1", async () => {
  // Dropping the item's title accomplishes nothing if `h1` carries the same
  // string: the resolver walks straight onto the next lagging page global and
  // rebuilds the hybrid record — ep396139 wearing "44 连影".
  const dom = installDomStub({
    href: EP_PAGE_HREF,
    pathname: "/bangumi/play/ep396139",
    title: "45 某话_番剧_bilibili",
    currentPartTitle: "44 连影",
    currentPartEpId: "ep396138",
    headingTitle: "44 连影",
    video: {
      currentTime: 0.27,
      playbackRate: 1,
      paused: true,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const controller = makeEpisodePageController({
    refreshFestivalBridge: async () => null,
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.equal(payload?.video.videoId, "ep396139");
    assert.equal(payload?.video.title, "45 某话");
  } finally {
    dom.restore();
  }
});

test("bangumi ep page refutes a title proven stale by a snapshot, in every source", async () => {
  // Same hole reached the other way: the list item carries no episode id, so the
  // cached snapshot is what proves the title stale — and `h1` repeats it.
  const dom = installDomStub({
    href: EP_PAGE_HREF,
    pathname: "/bangumi/play/ep396139",
    title: "45 某话_番剧_bilibili",
    currentPartTitle: "44 连影",
    currentPartCid: "1200334",
    headingTitle: "44 连影",
    video: {
      currentTime: 0.27,
      playbackRate: 1,
      paused: true,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const controller = makeEpisodePageController({
    refreshFestivalBridge: async () => null,
    getFestivalSnapshot: () => ({
      videoId: "ep396138",
      url: "https://www.bilibili.com/bangumi/play/ep396138",
      title: "44 连影",
      updatedAt: Date.now(),
      epId: "ep396138",
      cid: "1200334",
      pathname: "/bangumi/play/ep396139",
      pageUrl: EP_PAGE_HREF,
    }),
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.equal(payload?.video.videoId, "ep396139");
    assert.equal(payload?.video.title, "45 某话");
  } finally {
    dom.restore();
  }
});

test("bangumi ep page labels itself with its episode id when every title is refuted", async () => {
  // The end of that chain: `document.title` lags too, so nothing truthful is
  // left. Blank would be worse than plain — `ep396139` says nothing false,
  // whereas the previous episode's name does.
  const dom = installDomStub({
    href: EP_PAGE_HREF,
    pathname: "/bangumi/play/ep396139",
    title: "44 连影",
    currentPartTitle: "44 连影",
    currentPartEpId: "ep396138",
    headingTitle: "44 连影",
    video: {
      currentTime: 0.27,
      playbackRate: 1,
      paused: true,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const controller = makeEpisodePageController({
    refreshFestivalBridge: async () => null,
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.equal(payload?.video.videoId, "ep396139");
    assert.equal(payload?.video.title, "ep396139");
  } finally {
    dom.restore();
  }
});

test("an agreeing list item keeps its title even when h1 repeats it", async () => {
  // Reverse polarity: nothing is refuted here, so a page whose `h1` happens to
  // match the list item must not lose its title.
  const dom = installDomStub({
    href: EP_PAGE_HREF,
    pathname: "/bangumi/play/ep396139",
    title: "45 某话_番剧_bilibili",
    currentPartTitle: "45 某话 连影",
    currentPartEpId: "ep396139",
    headingTitle: "45 某话 连影",
    video: {
      currentTime: 0.27,
      playbackRate: 1,
      paused: true,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const controller = makeEpisodePageController({
    refreshFestivalBridge: async () => null,
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.equal(payload?.video.videoId, "ep396139");
    assert.equal(payload?.video.title, "45 某话 连影");
  } finally {
    dom.restore();
  }
});
