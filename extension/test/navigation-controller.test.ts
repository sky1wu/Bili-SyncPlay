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
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.localMemberId = "member-2";
  // The user is actively watching this confirmed non-shared video.
  runtimeState.intendedPlayState = "playing";
  runtimeState.lastUserGestureAt = 9_800;

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
    activatePauseHold: (durationMs = 1_500) => {
      pauseHoldCalls += 1;
      runtimeState.pauseHoldUntil = 10_000 + durationMs;
    },
    debugLog: () => {},
    getNow: () => 10_000,
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

test("navigation controller schedules auto-share when a shared source autoplays to a different video", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.localMemberId = "member-1";

  let currentUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  let hydrateCalls = 0;
  let pauseCalls = 0;
  const autoShareRequests: Array<{
    previousSharedUrl: string;
    nextNormalizedPageUrl: string;
  }> = [];

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
    scheduleAutoShareNextVideo: (input) => {
      autoShareRequests.push(input);
    },
    debugLog: () => {},
    getNow: () => 10_000,
  });

  try {
    controller.start();
    currentUrl = "https://www.bilibili.com/video/BV1Em421N7uU";
    windowHarness.intervals[0]?.();

    assert.equal(hydrateCalls, 1);
    assert.equal(pauseCalls, 0);
    assert.equal(
      runtimeState.explicitNonSharedPlaybackUrl,
      "https://www.bilibili.com/video/BV1Em421N7uU",
    );
    assert.deepEqual(autoShareRequests, [
      {
        previousSharedUrl: "https://www.bilibili.com/video/BV1DbiMBwEry",
        nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1Em421N7uU",
      },
    ]);
  } finally {
    windowHarness.restore();
  }
});

test("navigation controller does not auto-share a recent user-initiated navigation", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.localMemberId = "member-1";
  runtimeState.lastUserGestureAt = 9_800;

  let currentUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  const autoShareRequests: Array<{
    previousSharedUrl: string;
    nextNormalizedPageUrl: string;
  }> = [];

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
    pauseVideo: () => {},
    hydrateRoomState: async () => {},
    activatePauseHold: () => {},
    scheduleAutoShareNextVideo: (input) => {
      autoShareRequests.push(input);
    },
    debugLog: () => {},
    getNow: () => 10_000,
  });

  try {
    controller.start();
    currentUrl = "https://www.bilibili.com/video/BV1Em421N7uU";
    windowHarness.intervals[0]?.();

    assert.deepEqual(autoShareRequests, []);
  } finally {
    windowHarness.restore();
  }
});

test("navigation controller marks a manual navigation to a non-shared video as explicit local playback", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.localMemberId = "member-2";
  // The room video is paused and the user clicks an in-site link to a local
  // video (a recent gesture).
  runtimeState.intendedPlayState = "paused";
  runtimeState.lastUserGestureAt = 9_900;

  let currentUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  let pauseCalls = 0;
  const autoShareRequests: Array<{
    previousSharedUrl: string;
    nextNormalizedPageUrl: string;
  }> = [];

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
    hydrateRoomState: async () => {},
    activatePauseHold: () => {},
    scheduleAutoShareNextVideo: (input) => {
      autoShareRequests.push(input);
    },
    debugLog: () => {},
    getNow: () => 10_000,
  });

  try {
    controller.start();
    currentUrl = "https://www.bilibili.com/video/BV1Em421N7uU";
    windowHarness.intervals[0]?.();

    // It is not auto-shared (manual) and the non-sharer is not force-paused; the
    // target is recorded as explicit local playback so the user can watch it.
    assert.deepEqual(autoShareRequests, []);
    assert.equal(pauseCalls, 0);
    assert.equal(
      runtimeState.explicitNonSharedPlaybackUrl,
      "https://www.bilibili.com/video/BV1Em421N7uU",
    );
  } finally {
    windowHarness.restore();
  }
});

test("navigation controller does not auto-share an autoplay that started from a local detour", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.localMemberId = "member-1";
  // A recent gesture for the first (manual) hop off the shared video.
  runtimeState.lastUserGestureAt = 9_900;

  let currentUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  const autoShareRequests: Array<{
    previousSharedUrl: string;
    nextNormalizedPageUrl: string;
  }> = [];

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
    pauseVideo: () => {},
    hydrateRoomState: async () => {},
    activatePauseHold: () => {},
    scheduleAutoShareNextVideo: (input) => {
      autoShareRequests.push(input);
    },
    debugLog: () => {},
    getNow: () => 10_000,
  });

  try {
    controller.start();
    // Manual detour off the shared video A → X (carries a gesture, so it is not
    // auto-shared but it does become the "previous" page).
    currentUrl = "https://www.bilibili.com/video/BV1Em421N7uU";
    windowHarness.intervals[0]?.();
    assert.deepEqual(autoShareRequests, []);

    // X autoplays on to Y with no gesture. Because the page before this hop was
    // the local detour X (not the shared video A), it must NOT be auto-shared.
    currentUrl = "https://www.bilibili.com/video/BV1NewerVideo";
    windowHarness.intervals[0]?.();

    assert.deepEqual(autoShareRequests, []);
  } finally {
    windowHarness.restore();
  }
});

test("navigation controller pauses non-sharer autoplay to a different video", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.localMemberId = "member-2";
  runtimeState.intendedPlayState = "playing";

  let currentUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  let hydrateCalls = 0;
  let pauseCalls = 0;
  let pauseHoldCalls = 0;
  const autoShareRequests: Array<{
    previousSharedUrl: string;
    nextNormalizedPageUrl: string;
  }> = [];

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
    activatePauseHold: (durationMs = 1_500) => {
      pauseHoldCalls += 1;
      runtimeState.pauseHoldUntil = 10_000 + durationMs;
    },
    scheduleAutoShareNextVideo: (input) => {
      autoShareRequests.push(input);
    },
    debugLog: () => {},
    getNow: () => 10_000,
  });

  try {
    controller.start();
    currentUrl = "https://www.bilibili.com/video/BV1Em421N7uU";
    windowHarness.intervals[0]?.();

    assert.equal(hydrateCalls, 1);
    assert.equal(pauseCalls, 1);
    assert.equal(pauseHoldCalls, 1);
    assert.equal(runtimeState.pauseHoldUntil, 11_500);
    assert.equal(runtimeState.intendedPlayState, "paused");
    assert.equal(runtimeState.lastForcedPauseAt > 0, true);
    assert.deepEqual(autoShareRequests, []);
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
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.localMemberId = "member-2";
  runtimeState.lastUserGestureAt = 9_800;

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
    getNow: () => 10_000,
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

test("navigation controller clears an inherited pause hold when switching to a non-shared video", () => {
  const windowHarness = installWindowStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.localMemberId = "member-2";
  // A pause hold is still live from the previously shared (paused) video.
  runtimeState.intendedPlayState = "paused";
  runtimeState.pauseHoldUntil = 99_999;
  runtimeState.lastUserGestureAt = 9_800;

  let currentUrl = "https://www.bilibili.com/video/BV1DbiMBwEry";
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
        paused: true,
      }) as HTMLVideoElement,
    pauseVideo: () => {
      pauseCalls += 1;
    },
    hydrateRoomState: async () => {},
    activatePauseHold: () => {
      pauseHoldCalls += 1;
    },
    debugLog: () => {},
    getNow: () => 10_000,
  });

  try {
    controller.start();
    currentUrl = "https://www.bilibili.com/video/BV1Em421N7uU";
    windowHarness.intervals[0]?.();

    // The inherited pause hold must be cleared so the binding guards do not
    // re-pause this confirmed non-shared video once it autoplays before the
    // page bridge produces `currentVideo`.
    assert.equal(runtimeState.pauseHoldUntil, 0);
    assert.equal(pauseHoldCalls, 0);
    assert.equal(pauseCalls, 0);
    assert.equal(runtimeState.pendingRoomStateHydration, false);
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
