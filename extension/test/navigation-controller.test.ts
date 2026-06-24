import assert from "node:assert/strict";
import test from "node:test";
import {
  createContentRuntimeState,
  type ExplicitPlaybackAction,
  type ExplicitUserAction,
} from "../src/content/runtime-state";
import { createNavigationController } from "../src/content/navigation-controller";

function normalizeTestVideoPageUrl(url: string): string | null {
  return url.match(/https:\/\/www\.bilibili\.com\/video\/[^/?]+/)?.[0] ?? null;
}

function installWindowStub() {
  const originalWindow = globalThis.window;
  const intervals: Array<() => void> = [];
  let nextTimer = 1;

  const windowStub = {
    setInterval(callback: () => void) {
      intervals.push(callback);
      return nextTimer++;
    },
  };

  Object.assign(globalThis, { window: windowStub });

  return {
    intervals,
    restore() {
      Object.assign(globalThis, { window: originalWindow });
    },
  };
}

test("navigation controller ignores same-video url variants during in-room navigation", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";

  let currentUrl = "https://www.bilibili.com/video/BV1Em421N7uU";
  let hydrateCalls = 0;
  let pauseCalls = 0;

  const controller = createNavigationController({
    runtimeState,
    intervalMs: 500,
    userGestureGraceMs: 300,
    initialRoomStatePauseHoldMs: 1_500,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    isSupportedVideoPage: (url) => url.includes("/video/"),
    clearFestivalSnapshot: () => {},
    attachPlaybackListeners: () => {},
    getVideoElement: () =>
      ({
        paused: false,
      }) as HTMLVideoElement,
    pauseVideo: () => {
      pauseCalls += 1;
    },
    hydrateRoomState: async () => {
      hydrateCalls += 1;
    },
    activatePauseHold: () => {},
    debugLog: () => {},
  });

  try {
    controller.start();
    currentUrl =
      "https://www.bilibili.com/video/BV1Em421N7uU/?vd_source=tracking";
    windowHarness.intervals[0]?.();

    assert.equal(hydrateCalls, 0);
    assert.equal(pauseCalls, 0);
    assert.equal(runtimeState.pendingRoomStateHydration, true);
  } finally {
    windowHarness.restore();
  }
});

test("navigation controller hydrates and suppresses autoplay when switching to another shared video", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BV1Em421N7uU";

  let currentUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  let hydrateCalls = 0;
  let pauseCalls = 0;

  const controller = createNavigationController({
    runtimeState,
    intervalMs: 500,
    userGestureGraceMs: 300,
    initialRoomStatePauseHoldMs: 1_500,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    isSupportedVideoPage: (url) => url.includes("/video/"),
    clearFestivalSnapshot: () => {},
    attachPlaybackListeners: () => {},
    getVideoElement: () =>
      ({
        paused: false,
      }) as HTMLVideoElement,
    pauseVideo: () => {
      pauseCalls += 1;
    },
    hydrateRoomState: async () => {
      hydrateCalls += 1;
    },
    activatePauseHold: () => {},
    debugLog: () => {},
  });

  try {
    controller.start();
    currentUrl = "https://www.bilibili.com/video/BV1Em421N7uU";
    windowHarness.intervals[0]?.();

    assert.equal(hydrateCalls, 1);
    assert.equal(pauseCalls, 1);
    assert.equal(runtimeState.pendingRoomStateHydration, true);
    assert.equal(runtimeState.intendedPlayState, "paused");
  } finally {
    windowHarness.restore();
  }
});

test("navigation controller hydrates without pausing or suppressing when switching to a non-shared video", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  // The user is actively watching this confirmed non-shared video.
  runtimeState.intendedPlayState = "playing";

  let currentUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  let hydrateCalls = 0;
  let pauseCalls = 0;
  let pauseHoldCalls = 0;

  const controller = createNavigationController({
    runtimeState,
    intervalMs: 500,
    userGestureGraceMs: 300,
    initialRoomStatePauseHoldMs: 1_500,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    isSupportedVideoPage: (url) => url.includes("/video/"),
    clearFestivalSnapshot: () => {},
    attachPlaybackListeners: () => {},
    getVideoElement: () =>
      ({
        paused: false,
      }) as HTMLVideoElement,
    pauseVideo: () => {
      pauseCalls += 1;
    },
    hydrateRoomState: async () => {
      hydrateCalls += 1;
    },
    activatePauseHold: () => {
      pauseHoldCalls += 1;
    },
    debugLog: () => {},
  });

  try {
    controller.start();
    currentUrl = "https://www.bilibili.com/video/BV1Em421N7uU";
    windowHarness.intervals[0]?.();

    assert.equal(hydrateCalls, 1);
    assert.equal(pauseCalls, 0);
    // A confirmed different, stable non-shared video must not engage autoplay
    // suppression. Otherwise the binding guards would re-pause it once it
    // autoplays while the page bridge has not yet produced `currentVideo`.
    assert.equal(pauseHoldCalls, 0);
    assert.equal(runtimeState.pendingRoomStateHydration, false);
    assert.equal(runtimeState.intendedPlayState, "playing");
  } finally {
    windowHarness.restore();
  }
});

test("navigation controller does not engage autoplay suppression for a non-shared video that is not playing yet", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";

  let currentUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  let hydrateCalls = 0;
  let pauseCalls = 0;
  let pauseHoldCalls = 0;

  const controller = createNavigationController({
    runtimeState,
    intervalMs: 500,
    userGestureGraceMs: 300,
    initialRoomStatePauseHoldMs: 1_500,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    isSupportedVideoPage: (url) => url.includes("/video/"),
    clearFestivalSnapshot: () => {},
    attachPlaybackListeners: () => {},
    // The element has not started playing yet at navigation detection time;
    // its autoplay fires later. The fix must not leave pending hydration /
    // pause-hold state that would force-pause that later autoplay.
    getVideoElement: () =>
      ({
        paused: true,
      }) as HTMLVideoElement,
    pauseVideo: () => {
      pauseCalls += 1;
    },
    hydrateRoomState: async () => {
      hydrateCalls += 1;
    },
    activatePauseHold: () => {
      pauseHoldCalls += 1;
    },
    debugLog: () => {},
  });

  try {
    controller.start();
    currentUrl = "https://www.bilibili.com/video/BV1Em421N7uU";
    windowHarness.intervals[0]?.();

    assert.equal(hydrateCalls, 1);
    assert.equal(pauseCalls, 0);
    assert.equal(pauseHoldCalls, 0);
    assert.equal(runtimeState.pendingRoomStateHydration, false);
  } finally {
    windowHarness.restore();
  }
});

test("navigation controller suppresses autoplay when navigating through an unstable shared route", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.activeSharedUrl =
    "https://www.bilibili.com/video/BVfestival?cid=123";

  let currentUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  let hydrateCalls = 0;
  let pauseCalls = 0;

  function normalizeFestival(url: string): string | null {
    if (url.includes("/festival/demo")) {
      return "https://www.bilibili.com/festival/demo";
    }
    return normalizeTestVideoPageUrl(url);
  }

  const controller = createNavigationController({
    runtimeState,
    intervalMs: 500,
    userGestureGraceMs: 300,
    initialRoomStatePauseHoldMs: 1_500,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeFestival,
    isSupportedVideoPage: (url) =>
      url.includes("/video/") || url.includes("/festival/"),
    clearFestivalSnapshot: () => {},
    attachPlaybackListeners: () => {},
    getVideoElement: () =>
      ({
        paused: false,
      }) as HTMLVideoElement,
    pauseVideo: () => {
      pauseCalls += 1;
    },
    hydrateRoomState: async () => {
      hydrateCalls += 1;
    },
    activatePauseHold: () => {},
    debugLog: () => {},
  });

  try {
    controller.start();
    currentUrl = "https://www.bilibili.com/festival/demo";
    windowHarness.intervals[0]?.();

    assert.equal(hydrateCalls, 1);
    assert.equal(pauseCalls, 1);
    assert.equal(runtimeState.pendingRoomStateHydration, true);
    assert.equal(runtimeState.intendedPlayState, "paused");
  } finally {
    windowHarness.restore();
  }
});

test("navigation controller suppresses autoplay when shared url is an unstable season and page resolved to an episode", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;
  // Room shares an unstable bangumi season url; the page may belong to it even
  // though it has already resolved to a concrete episode url.
  runtimeState.activeSharedUrl =
    "https://www.bilibili.com/bangumi/play/ss73077";

  let currentUrl = "https://www.bilibili.com/bangumi/play/ss73077";
  let hydrateCalls = 0;
  let pauseCalls = 0;

  function normalizeBangumi(url: string): string | null {
    return (
      url.match(/https:\/\/www\.bilibili\.com\/bangumi\/play\/[^/?]+/)?.[0] ??
      null
    );
  }

  const controller = createNavigationController({
    runtimeState,
    intervalMs: 500,
    userGestureGraceMs: 300,
    initialRoomStatePauseHoldMs: 1_500,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeBangumi,
    isSupportedVideoPage: (url) => url.includes("/bangumi/play/"),
    clearFestivalSnapshot: () => {},
    attachPlaybackListeners: () => {},
    getVideoElement: () =>
      ({
        paused: false,
      }) as HTMLVideoElement,
    pauseVideo: () => {
      pauseCalls += 1;
    },
    hydrateRoomState: async () => {
      hydrateCalls += 1;
    },
    activatePauseHold: () => {},
    debugLog: () => {},
  });

  try {
    controller.start();
    currentUrl = "https://www.bilibili.com/bangumi/play/ep1231523";
    windowHarness.intervals[0]?.();

    assert.equal(hydrateCalls, 1);
    assert.equal(pauseCalls, 1);
    assert.equal(runtimeState.pendingRoomStateHydration, true);
    assert.equal(runtimeState.intendedPlayState, "paused");
  } finally {
    windowHarness.restore();
  }
});

test("navigation controller suppresses autoplay when shared url is not yet known", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;
  // In a room but the initial room state has not populated the shared url yet
  // (e.g. just joined/switched room before hydration completes). The page may
  // still be the shared video, so an already-playing video must be paused.
  runtimeState.activeSharedUrl = null;

  let currentUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  let hydrateCalls = 0;
  let pauseCalls = 0;

  const controller = createNavigationController({
    runtimeState,
    intervalMs: 500,
    userGestureGraceMs: 300,
    initialRoomStatePauseHoldMs: 1_500,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    isSupportedVideoPage: (url) => url.includes("/video/"),
    clearFestivalSnapshot: () => {},
    attachPlaybackListeners: () => {},
    getVideoElement: () =>
      ({
        paused: false,
      }) as HTMLVideoElement,
    pauseVideo: () => {
      pauseCalls += 1;
    },
    hydrateRoomState: async () => {
      hydrateCalls += 1;
    },
    activatePauseHold: () => {},
    debugLog: () => {},
  });

  try {
    controller.start();
    currentUrl = "https://www.bilibili.com/video/BV1Em421N7uU";
    windowHarness.intervals[0]?.();

    assert.equal(hydrateCalls, 1);
    assert.equal(pauseCalls, 1);
    assert.equal(runtimeState.pendingRoomStateHydration, true);
    assert.equal(runtimeState.intendedPlayState, "paused");
  } finally {
    windowHarness.restore();
  }
});

test("navigation controller anchors active shared url for post-navigation settle gate", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.activeSharedUrl =
    "https://www.bilibili.com/bangumi/play/ep1231523";

  let currentUrl = "https://www.bilibili.com/bangumi/play/ep1231523";
  const now = 40_000;

  function normalizeBangumi(url: string): string | null {
    return (
      url.match(/https:\/\/www\.bilibili\.com\/bangumi\/play\/[^/?]+/)?.[0] ??
      null
    );
  }

  const controller = createNavigationController({
    runtimeState,
    intervalMs: 500,
    userGestureGraceMs: 300,
    initialRoomStatePauseHoldMs: 1_500,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeBangumi,
    isSupportedVideoPage: (url) => url.includes("/bangumi/play/"),
    clearFestivalSnapshot: () => {},
    attachPlaybackListeners: () => {},
    getVideoElement: () =>
      ({
        paused: true,
      }) as HTMLVideoElement,
    pauseVideo: () => {},
    hydrateRoomState: async () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.start();
    currentUrl =
      "https://www.bilibili.com/bangumi/play/ss73077?from_spmid=666.25.recommend.0";
    windowHarness.intervals[0]?.();

    assert.equal(
      runtimeState.postNavigationAnchorSharedUrl,
      "https://www.bilibili.com/bangumi/play/ep1231523",
    );
    assert.equal(runtimeState.postNavigationAnchorSetAt, now);
  } finally {
    windowHarness.restore();
  }
});

test("navigation controller clears any anchor when user navigates back to the shared video url", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.activeSharedUrl =
    "https://www.bilibili.com/bangumi/play/ep1231523";
  runtimeState.postNavigationAnchorSharedUrl =
    "https://www.bilibili.com/bangumi/play/ep1231523";

  let currentUrl =
    "https://www.bilibili.com/bangumi/play/ss73077?from_spmid=666.25.recommend.0";

  function normalizeBangumi(url: string): string | null {
    return (
      url.match(/https:\/\/www\.bilibili\.com\/bangumi\/play\/[^/?]+/)?.[0] ??
      null
    );
  }

  const controller = createNavigationController({
    runtimeState,
    intervalMs: 500,
    userGestureGraceMs: 300,
    initialRoomStatePauseHoldMs: 1_500,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeBangumi,
    isSupportedVideoPage: (url) => url.includes("/bangumi/play/"),
    clearFestivalSnapshot: () => {},
    attachPlaybackListeners: () => {},
    getVideoElement: () =>
      ({
        paused: true,
      }) as HTMLVideoElement,
    pauseVideo: () => {},
    hydrateRoomState: async () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
  });

  try {
    controller.start();
    currentUrl = "https://www.bilibili.com/bangumi/play/ep1231523";
    windowHarness.intervals[0]?.();

    assert.equal(runtimeState.postNavigationAnchorSharedUrl, null);
  } finally {
    windowHarness.restore();
  }
});

test("navigation controller does not anchor when no shared video was active", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.activeSharedUrl = null;

  let currentUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";

  const controller = createNavigationController({
    runtimeState,
    intervalMs: 500,
    userGestureGraceMs: 300,
    initialRoomStatePauseHoldMs: 1_500,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    isSupportedVideoPage: (url) => url.includes("/video/"),
    clearFestivalSnapshot: () => {},
    attachPlaybackListeners: () => {},
    getVideoElement: () =>
      ({
        paused: true,
      }) as HTMLVideoElement,
    pauseVideo: () => {},
    hydrateRoomState: async () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
  });

  try {
    controller.start();
    currentUrl = "https://www.bilibili.com/video/BV1Em421N7uU";
    windowHarness.intervals[0]?.();

    assert.equal(runtimeState.postNavigationAnchorSharedUrl, null);
  } finally {
    windowHarness.restore();
  }
});

test("navigation controller clears stale gesture state on in-room navigation", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;

  runtimeState.lastUserGestureAt = 9999;
  runtimeState.lastExplicitPlaybackAction = {
    playState: "playing",
    at: 9999,
  } satisfies ExplicitPlaybackAction;
  runtimeState.lastExplicitUserAction = {
    kind: "play",
    at: 9999,
  } satisfies ExplicitUserAction;

  let currentUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";

  const controller = createNavigationController({
    runtimeState,
    intervalMs: 500,
    userGestureGraceMs: 300,
    initialRoomStatePauseHoldMs: 1_500,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    isSupportedVideoPage: (url) => url.includes("/video/"),
    clearFestivalSnapshot: () => {},
    attachPlaybackListeners: () => {},
    getVideoElement: () =>
      ({
        paused: true,
      }) as HTMLVideoElement,
    pauseVideo: () => {},
    hydrateRoomState: async () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
  });

  try {
    controller.start();
    currentUrl = "https://www.bilibili.com/video/BV1Em421N7uU";
    windowHarness.intervals[0]?.();

    assert.equal(runtimeState.lastUserGestureAt, 0);
    assert.equal(runtimeState.lastExplicitPlaybackAction, null);
    assert.equal(runtimeState.lastExplicitUserAction, null);
  } finally {
    windowHarness.restore();
  }
});
