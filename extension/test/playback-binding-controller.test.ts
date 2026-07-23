import assert from "node:assert/strict";
import test from "node:test";
import type { SharedVideo } from "@bili-syncplay/protocol";
import { createContentRuntimeState } from "../src/content/runtime-state";
import { createPlaybackBindingController } from "../src/content/playback-binding-controller";
import { createRoomStateController } from "../src/content/room-state-controller";
import { createToastCoordinatorState } from "../src/content/toast";

type ListenerMap = Map<string, EventListener>;

function installDomStub() {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const listeners: ListenerMap = new Map();

  const video = {
    paused: false,
    addEventListener(type: string, listener: EventListener) {
      listeners.set(type, listener);
    },
  } as unknown as HTMLVideoElement;

  Object.assign(globalThis, {
    document: {
      querySelector(selector: string) {
        return selector === "video" ? video : null;
      },
    },
    window: {
      setTimeout() {
        return 1;
      },
      setInterval() {
        return 1;
      },
      clearInterval() {
        return undefined;
      },
      clearTimeout() {
        return undefined;
      },
    },
  });

  return {
    video,
    listeners,
    restore() {
      Object.assign(globalThis, {
        document: originalDocument,
        window: originalWindow,
      });
    },
  };
}

test("playback binding controller forwards ratechange event source", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 1_000;
  const events: string[] = [];

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_100,
  });

  try {
    controller.attachPlaybackListeners();
    const listener = dom.listeners.get("ratechange");
    assert.notEqual(listener, undefined);

    listener!(new Event("ratechange"));

    await Promise.resolve();

    assert.deepEqual(events, ["ratechange"]);
    assert.deepEqual(runtimeState.lastExplicitUserAction, {
      kind: "ratechange",
      at: 1_100,
    });
  } finally {
    dom.restore();
  }
});

test("playback binding controller cancels active soft apply on pause and seek", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 1_000;
  const reasons: string[] = [];

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: (_video, reason) => {
      reasons.push(reason);
    },
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_100,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("pause")?.(new Event("pause"));
    dom.listeners.get("seeking")?.(new Event("seeking"));
    dom.listeners.get("seeked")?.(new Event("seeked"));

    assert.deepEqual(reasons, ["pause", "seek", "seek"]);
  } finally {
    dom.restore();
  }
});

test("playback binding controller does not cancel active soft apply for programmatic pause and seek events", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 0;
  const reasons: string[] = [];

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: (_video, reason) => {
      reasons.push(reason);
    },
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 2_500,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("pause")?.(new Event("pause"));
    dom.listeners.get("seeking")?.(new Event("seeking"));
    dom.listeners.get("seeked")?.(new Event("seeked"));

    assert.deepEqual(reasons, []);
  } finally {
    dom.restore();
  }
});

test("playback binding controller preserves explicit seek intent across immediate playing follow-up", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 1_000;
  let now = 1_100;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("seeking")?.(new Event("seeking"));
    now = 1_150;
    dom.listeners.get("playing")?.(new Event("playing"));

    assert.deepEqual(runtimeState.lastExplicitUserAction, {
      kind: "seek",
      at: 1_100,
    });
  } finally {
    dom.restore();
  }
});

test("playback binding controller does not mark programmatic ratechange as explicit user action", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 1_000;
  runtimeState.programmaticApplyUntil = 1_800;
  runtimeState.programmaticApplySignature = {
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "playing",
    currentTime: 12.4,
    playbackRate: 1.11,
  };
  dom.video.playbackRate = 1.11;
  const events: string[] = [];

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BV1xx411c7mD:p1",
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      title: "Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_100,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("ratechange")?.(new Event("ratechange"));

    await Promise.resolve();

    assert.deepEqual(events, ["ratechange"]);
    assert.equal(runtimeState.lastExplicitUserAction, null);
  } finally {
    dom.restore();
  }
});

test("playback binding controller re-pauses seek-triggered autoplay when intended state is paused", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeSharedUrl =
    "https://www.bilibili.com/video/BV1xx411c7mD?p=1";
  runtimeState.intendedPlayState = "paused";
  runtimeState.lastUserGestureAt = 1_000;
  let now = 1_100;
  let pausedByGuard = 0;
  const originalSetTimeout = globalThis.window.setTimeout;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BV1xx411c7mD:p1",
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      title: "Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  const originalPause = dom.video.pause;
  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("seeking")?.(new Event("seeking"));
    now = 1_150;
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    assert.equal(pausedByGuard, 1);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller keeps hydration pause guard when shared url is unknown", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.pendingRoomStateHydration = true;
  runtimeState.activeSharedUrl = null;
  runtimeState.lastUserGestureAt = 1_000;
  let pausedByGuard = 0;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BV1xx411c7mD:p1",
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      title: "Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_100,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    assert.equal(pausedByGuard, 1);
    assert.equal(runtimeState.explicitNonSharedPlaybackUrl, null);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller keeps hydration guard after direct room switch clears stale shared url", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  const staleSharedUrl = "https://www.bilibili.com/video/BVold?p=1";
  const currentUrl = "https://www.bilibili.com/video/BVnew?p=1";
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.activeSharedUrl = staleSharedUrl;
  runtimeState.explicitNonSharedPlaybackUrl = currentUrl;
  runtimeState.lastNonSharedGuardUrl = currentUrl;
  runtimeState.postNavigationAnchorSharedUrl = staleSharedUrl;
  runtimeState.postNavigationAnchorSetAt = 1_000;
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.hasReceivedInitialRoomState = true;
  runtimeState.hydrationReady = true;
  runtimeState.lastUserGestureAt = 1_000;
  let pausedByGuard = 0;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;
  const hydrationRetries: number[] = [];

  const roomStateController = createRoomStateController({
    runtimeState,
    toastState: createToastCoordinatorState(),
    toastPresenter: {
      resetMountTarget: () => {},
      show: () => {},
    },
    getSharedVideo: () => null,
    normalizeUrl: (url) => url ?? null,
    debugLog: () => {},
    resetPlaybackSyncState: () => {},
    scheduleHydrationRetry: (delayMs) => {
      hydrationRetries.push(delayMs ?? 0);
    },
  });

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    getSharedVideo: () => ({
      videoId: "BVnew:p1",
      url: currentUrl,
      title: "New room shared video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_100,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    roomStateController.handleSyncStatus({
      roomCode: "ROOM02",
      connected: true,
      memberId: "member-2",
      rttMs: 20,
    });
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    assert.equal(runtimeState.activeRoomCode, "ROOM02");
    assert.equal(runtimeState.activeSharedUrl, null);
    assert.equal(runtimeState.explicitNonSharedPlaybackUrl, null);
    assert.equal(runtimeState.lastNonSharedGuardUrl, null);
    assert.equal(runtimeState.postNavigationAnchorSharedUrl, null);
    assert.equal(runtimeState.postNavigationAnchorSetAt, 0);
    assert.equal(runtimeState.pendingRoomStateHydration, true);
    assert.equal(runtimeState.hasReceivedInitialRoomState, false);
    assert.equal(runtimeState.hydrationReady, false);
    assert.deepEqual(hydrationRetries, [150]);
    assert.equal(pausedByGuard, 1);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller keeps hydration pause guard for unstable festival identity", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.pendingRoomStateHydration = true;
  runtimeState.activeSharedUrl =
    "https://www.bilibili.com/video/BVfestival?cid=123";
  runtimeState.lastUserGestureAt = 1_000;
  let pausedByGuard = 0;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "/festival/demo",
      url: "https://www.bilibili.com/festival/demo",
      title: "Festival",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_100,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    assert.equal(pausedByGuard, 1);
    assert.equal(runtimeState.explicitNonSharedPlaybackUrl, null);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller reapplies pause hold for unstable identity after hydration", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.activeSharedUrl =
    "https://www.bilibili.com/video/BVfestival?cid=123";
  runtimeState.intendedPlayState = "paused";
  runtimeState.pauseHoldUntil = 4_000;
  runtimeState.lastUserGestureAt = 1_050;
  runtimeState.explicitNonSharedPlaybackUrl =
    "https://www.bilibili.com/video/BVold";
  runtimeState.lastNonSharedGuardUrl = "https://www.bilibili.com/video/BVold";
  let pausedByGuard = 0;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    getSharedVideo: () => ({
      videoId: "/festival/demo",
      url: "https://www.bilibili.com/festival/demo",
      title: "Festival",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_100,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    assert.equal(pausedByGuard, 1);
    assert.equal(runtimeState.lastForcedPauseAt, 1_100);
    assert.equal(runtimeState.explicitNonSharedPlaybackUrl, null);
    assert.equal(runtimeState.lastNonSharedGuardUrl, null);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller reapplies pause hold for unstable room shared url", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.activeSharedUrl =
    "https://www.bilibili.com/bangumi/play/ss73077";
  runtimeState.intendedPlayState = "paused";
  runtimeState.pauseHoldUntil = 4_000;
  runtimeState.lastUserGestureAt = 1_050;
  runtimeState.explicitNonSharedPlaybackUrl =
    "https://www.bilibili.com/video/BVold";
  runtimeState.lastNonSharedGuardUrl = "https://www.bilibili.com/video/BVold";
  let pausedByGuard = 0;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    getSharedVideo: () => ({
      videoId: "ep1231523",
      url: "https://www.bilibili.com/bangumi/play/ep1231523",
      title: "Bangumi",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_100,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    assert.equal(pausedByGuard, 1);
    assert.equal(runtimeState.lastForcedPauseAt, 1_100);
    assert.equal(runtimeState.explicitNonSharedPlaybackUrl, null);
    assert.equal(runtimeState.lastNonSharedGuardUrl, null);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller clears explicit seek intent after seek-triggered autoplay is blocked", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeSharedUrl =
    "https://www.bilibili.com/video/BV1xx411c7mD?p=1";
  runtimeState.intendedPlayState = "paused";
  runtimeState.lastUserGestureAt = 1_000;
  let now = 1_100;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BV1xx411c7mD:p1",
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      title: "Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;
  dom.video.pause = () => {
    dom.video.paused = true;
    return Promise.resolve();
  };

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("seeking")?.(new Event("seeking"));
    now = 1_150;
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    assert.equal(runtimeState.lastExplicitUserAction, null);
    assert.equal(runtimeState.lastExplicitPlaybackAction, null);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller allows manual play after a newer gesture follows seek", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeSharedUrl =
    "https://www.bilibili.com/video/BV1xx411c7mD?p=1";
  runtimeState.intendedPlayState = "paused";
  runtimeState.lastUserGestureAt = 1_000;
  let now = 1_100;
  const events: string[] = [];

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BV1xx411c7mD:p1",
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      title: "Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("seeking")?.(new Event("seeking"));
    runtimeState.lastUserGestureAt = 1_180;
    now = 1_200;
    dom.listeners.get("play")?.(new Event("play"));

    await Promise.resolve();

    assert.deepEqual(events, ["seeking", "play"]);
    assert.deepEqual(runtimeState.lastExplicitUserAction, {
      kind: "play",
      at: 1_200,
    });
  } finally {
    dom.restore();
  }
});

test("playback binding controller holds a page-load autoplay authorized only by a stray document gesture, then honors an in-player play", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  // Load-paused arrival on the resolved non-shared page: hold + marker armed.
  runtimeState.intendedPlayState = "paused";
  runtimeState.pauseHoldUntil = 25_000;
  runtimeState.nonSharerAutoplayHoldUrl =
    "https://www.bilibili.com/video/BVother?p=1";
  runtimeState.lastForcedPauseAt = 19_000;
  // The user clicked blank space / dismissed a popup — a document-level gesture
  // that is NOT inside the player.
  runtimeState.lastUserGestureAt = 20_000;
  let pausedByGuard = 0;
  let now = 20_050;
  const events: string[] = [];
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVother:p1",
      url: "https://www.bilibili.com/video/BVother?p=1",
      title: "Other Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();

    // The page-load autoplay fires while only a stray (non-player) gesture is
    // recent. It must NOT be treated as a manual play: the marker holds it and no
    // explicit authorization is recorded.
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));
    await Promise.resolve();
    assert.equal(pausedByGuard, 1);
    assert.equal(runtimeState.explicitNonSharedPlaybackUrl, null);
    assert.equal(
      runtimeState.nonSharerAutoplayHoldUrl,
      "https://www.bilibili.com/video/BVother?p=1",
    );

    // Now the user actually presses play inside the player: it is authorized.
    now = 21_000;
    runtimeState.lastUserGestureAt = 21_000;
    runtimeState.lastUserGestureInPlayerAt = 21_000;
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));
    await Promise.resolve();
    assert.equal(pausedByGuard, 1);
    assert.equal(
      runtimeState.explicitNonSharedPlaybackUrl,
      "https://www.bilibili.com/video/BVother?p=1",
    );
    assert.equal(runtimeState.nonSharerAutoplayHoldUrl, null);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller still holds the delayed autoplay when the only in-player gesture predates the forced pause", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.intendedPlayState = "paused";
  runtimeState.pauseHoldUntil = 0;
  runtimeState.nonSharerAutoplayHoldUrl =
    "https://www.bilibili.com/video/BVother?p=1";
  // The user pressed play inside the player while the bridge was still resolving;
  // the unconfirmed-context hold force-paused right after, so this in-player
  // gesture PRE-dates the forced pause. Once the bridge resolves and the same
  // click triggers the delayed play, it must not be treated as a fresh play
  // intent — otherwise the non-shared video would start without a second click.
  runtimeState.lastUserGestureInPlayerAt = 19_500;
  runtimeState.lastForcedPauseAt = 19_800;
  let pausedByGuard = 0;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVother:p1",
      url: "https://www.bilibili.com/video/BVother?p=1",
      title: "Other Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 20_000,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));
    await Promise.resolve();

    // Stale (pre-pause) in-player gesture → still held, marker kept, no auth.
    assert.equal(pausedByGuard, 1);
    assert.equal(runtimeState.explicitNonSharedPlaybackUrl, null);
    assert.equal(
      runtimeState.nonSharerAutoplayHoldUrl,
      "https://www.bilibili.com/video/BVother?p=1",
    );
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller holds a seek-triggered non-shared autoplay, then authorizes a distinct play press", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.intendedPlayState = "paused";
  runtimeState.nonSharerAutoplayHoldUrl =
    "https://www.bilibili.com/video/BVother?p=1";
  // A page-bridge hold paused the page at 19_800. Then an in-player gesture at
  // 20_500 drags the progress bar (a SEEK, not a play press): we cannot tell it
  // apart from a play click preceded by a restore seek, so a seek-triggered
  // autoplay must stay held — only a genuine play press releases.
  runtimeState.lastForcedPauseAt = 19_800;
  runtimeState.lastUserGestureAt = 20_500;
  runtimeState.lastUserGestureInPlayerAt = 20_500;
  let now = 20_500;
  let pausedByGuard = 0;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVother:p1",
      url: "https://www.bilibili.com/video/BVother?p=1",
      title: "Other Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: (durationMs = 3_000) => {
      runtimeState.pauseHoldUntil = now + durationMs;
    },
    debugLog: () => {},
    getNow: () => now,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    // The seek belongs to the current in-player gesture (no newer gesture after
    // it), so the post-seek autoplay is held, not authorized.
    dom.listeners.get("seeking")?.(new Event("seeking"));
    dom.listeners.get("play")?.(new Event("play"));
    await Promise.resolve();

    assert.equal(pausedByGuard, 1);
    assert.equal(runtimeState.explicitNonSharedPlaybackUrl, null);

    // A DISTINCT in-player play press afterwards (a fresh gesture postdating the
    // seek) is authorized and releases the hold.
    now = 21_000;
    runtimeState.lastUserGestureAt = 21_000;
    runtimeState.lastUserGestureInPlayerAt = 21_000;
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));
    await Promise.resolve();

    assert.equal(pausedByGuard, 1);
    assert.equal(
      runtimeState.explicitNonSharedPlaybackUrl,
      "https://www.bilibili.com/video/BVother?p=1",
    );
    assert.equal(runtimeState.nonSharerAutoplayHoldUrl, null);
    assert.equal(runtimeState.pauseHoldUntil, 0);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller allows explicit play on a non-shared page", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  // A genuine play press inside the player authorizes the non-shared playback.
  runtimeState.lastUserGestureAt = 1_000;
  runtimeState.lastUserGestureInPlayerAt = 1_000;
  const events: string[] = [];

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVother:p1",
      url: "https://www.bilibili.com/video/BVother?p=1",
      title: "Other Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_100,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("play")?.(new Event("play"));

    await Promise.resolve();

    assert.deepEqual(events, ["play"]);
    assert.deepEqual(runtimeState.lastExplicitPlaybackAction, {
      playState: "playing",
      at: 1_100,
    });
    assert.equal(
      runtimeState.explicitNonSharedPlaybackUrl,
      "https://www.bilibili.com/video/BVother?p=1",
    );
  } finally {
    dom.restore();
  }
});

test("playback binding controller suppresses auto-resumed non-shared broadcast after browser seek", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.lastUserGestureAt = 1_000;
  let now = 1_050;
  let pausedByGuard = 0;
  const events: string[] = [];
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVother:p1",
      url: "https://www.bilibili.com/video/BVother?p=1",
      title: "Other Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    // Browser auto-seeks to resume point after user click
    dom.listeners.get("seeking")?.(new Event("seeking"));
    // Browser auto-plays after seek
    now = 1_080;
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    await Promise.resolve();

    // In a room the auto-resumed non-shared video is held paused: a stray
    // document-level click is not an in-player play intent, so this counts as an
    // unsolicited autoplay and is paused (load paused).
    assert.equal(pausedByGuard, 1);
    // The seeking event is broadcast (non-shared page), but play stays blocked.
    assert.deepEqual(events, ["seeking"]);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller pauses delayed non-sharer autoplay into a non-shared video while the pause hold is active", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  // The navigation controller armed a pause hold and recorded a paused intent
  // when it detected the non-sharer's player autoplaying into the next episode.
  // It also flagged the target page as a non-sharer autoplay page.
  runtimeState.intendedPlayState = "paused";
  runtimeState.nonSharerAutoplayHoldUrl =
    "https://www.bilibili.com/video/BVnext?p=1";
  runtimeState.pauseHoldUntil = 5_000;
  let pausedByGuard = 0;
  const events: string[] = [];
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVnext:p1",
      url: "https://www.bilibili.com/video/BVnext?p=1",
      title: "Next Episode",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_200,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    // The next-episode page settled first, then the player auto-played later.
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    await Promise.resolve();

    // The delayed autoplay must be actively paused, not merely un-broadcast.
    assert.equal(pausedByGuard, 1);
    assert.deepEqual(events, []);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller pauses delayed non-sharer autoplay even after the pause hold has expired", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.intendedPlayState = "paused";
  runtimeState.nonSharerAutoplayHoldUrl =
    "https://www.bilibili.com/video/BVnext?p=1";
  // A slow SPA load/ad delayed the autoplay past initialRoomStatePauseHoldMs, so
  // the pause hold window has already expired by the time `play` fires.
  runtimeState.pauseHoldUntil = 5_000;
  let pausedByGuard = 0;
  const events: string[] = [];
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVnext:p1",
      url: "https://www.bilibili.com/video/BVnext?p=1",
      title: "Next Episode",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    // Well past the expired pauseHoldUntil of 5_000.
    getNow: () => 20_000,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    await Promise.resolve();

    // The expired hold must not let the delayed autoplay slip through.
    assert.equal(pausedByGuard, 1);
    assert.deepEqual(events, []);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller lets the user watch an explicitly opened local video in a paused room", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  // The room video is paused; the user manually navigated to a local video, so
  // the navigation controller recorded it as explicit local playback. The
  // navigation cleared lastUserGestureAt, so there is no recent gesture now.
  runtimeState.intendedPlayState = "paused";
  runtimeState.explicitNonSharedPlaybackUrl =
    "https://www.bilibili.com/video/BVother?p=1";
  let pausedByGuard = 0;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVother:p1",
      url: "https://www.bilibili.com/video/BVother?p=1",
      title: "Other Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 20_000,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    await Promise.resolve();

    // Explicit local playback must not be force-paused, even with no recent
    // gesture and a paused room intent.
    assert.equal(pausedByGuard, 0);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller pauses an unmarked non-shared page reached by full-page navigation", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  // The user opened a different local video via a new tab / address bar / bookmark.
  // The content script reloaded, so there was no in-SPA navigation event to arm a
  // non-sharer autoplay marker (nonSharerAutoplayHoldUrl stays null) and no recent
  // in-page gesture. In a room every non-shared video must still load PAUSED, so
  // this autoplay is held even without the marker.
  runtimeState.intendedPlayState = "paused";
  let pausedByGuard = 0;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVother:p1",
      url: "https://www.bilibili.com/video/BVother?p=1",
      title: "Other Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: (durationMs = 3_000) => {
      runtimeState.pauseHoldUntil = 20_000 + durationMs;
    },
    debugLog: () => {},
    getNow: () => 20_000,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    await Promise.resolve();

    // Even without the SPA marker, a non-shared video that autoplays on a fresh
    // page load is paused (load paused) and the marker is armed for the held-page
    // machinery; its broadcast stays suppressed by the non-shared guard.
    assert.equal(pausedByGuard, 1);
    assert.equal(
      runtimeState.nonSharerAutoplayHoldUrl,
      "https://www.bilibili.com/video/BVother?p=1",
    );
    // The pause hold is armed too, so a transient bridge blip cannot resume it.
    assert.ok(runtimeState.pauseHoldUntil > 0);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller pauses a non-shared video even when room intent leaked as playing", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  // The room's own playing intent leaked onto this non-shared page. It must STILL
  // be held — the page is not the shared video — so the pause is not gated on
  // intendedPlayState.
  runtimeState.intendedPlayState = "playing";
  let pausedByGuard = 0;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVother:p1",
      url: "https://www.bilibili.com/video/BVother?p=1",
      title: "Other Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 20_000,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.listeners.get("playing")?.(new Event("playing"));

    await Promise.resolve();

    assert.equal(pausedByGuard, 1);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller periodic tick pauses a non-shared video already playing at hydration", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.intendedPlayState = "paused";
  let pausedByGuard = 0;
  let intervalCallback: (() => void) | null = null;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalSetInterval = globalThis.window.setInterval;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVother:p1",
      url: "https://www.bilibili.com/video/BVother?p=1",
      title: "Other Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 20_000,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;
  globalThis.window.setInterval = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      intervalCallback = callback as () => void;
    }
    return 1;
  }) as typeof globalThis.window.setInterval;

  try {
    // The video was already autoplaying when the room state hydrated, so its only
    // play/playing event fired before listeners were attached — the event-driven
    // hold never ran. The periodic tick must still pause it.
    dom.video.paused = false;
    controller.start();
    assert.equal(pausedByGuard, 0);

    assert.ok(intervalCallback, "expected the binding to register an interval");
    intervalCallback?.();
    await Promise.resolve();

    assert.equal(pausedByGuard, 1);
    assert.equal(
      runtimeState.nonSharerAutoplayHoldUrl,
      "https://www.bilibili.com/video/BVother?p=1",
    );
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    globalThis.window.setInterval = originalSetInterval;
    dom.video.pause = originalPause;
    controller.destroy();
    dom.restore();
  }
});

test("playback binding controller holds a play while the page bridge is resolving, then allows manual play once the video resolves", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  // A non-shared arrival armed the pause hold (load paused) and recorded the
  // target as a non-sharer autoplay hold. The page bridge has not produced
  // `currentVideo` yet, so the context still looks "unconfirmed".
  runtimeState.intendedPlayState = "paused";
  runtimeState.pauseHoldUntil = 25_000;
  runtimeState.nonSharerAutoplayHoldUrl =
    "https://www.bilibili.com/video/BVother?p=1";
  // A recent gesture that postdates the forced pause. In the bridge-resolving
  // window we cannot tell a real play press from a stray document-level gesture
  // followed by the page's own autoplay, so the play is still held.
  runtimeState.lastForcedPauseAt = 19_000;
  runtimeState.lastUserGestureAt = 19_500;
  let pausedByGuard = 0;
  let now = 20_000;
  let resolvedVideo: SharedVideo | null = null;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    // Page bridge not ready yet — current video is unknown until `resolvedVideo`.
    getSharedVideo: () => resolvedVideo,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));
    await Promise.resolve();

    // Bridge still resolving → the play is held regardless of the recent gesture.
    assert.equal(pausedByGuard, 1);
    assert.equal(
      runtimeState.nonSharerAutoplayHoldUrl,
      "https://www.bilibili.com/video/BVother?p=1",
    );

    // The bridge resolves the URL and the user clicks play again (a fresh gesture
    // after the hold's forced pause). Now there is a concrete non-shared video to
    // anchor the authorization, so the manual play is honored: explicit auth is
    // recorded, the autoplay hold is dropped and the pause hold released.
    resolvedVideo = {
      videoId: "BVother:p1",
      url: "https://www.bilibili.com/video/BVother?p=1",
      title: "Other Video",
    };
    now = 21_000;
    runtimeState.lastUserGestureAt = 21_000;
    runtimeState.lastUserGestureInPlayerAt = 21_000;
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));
    await Promise.resolve();

    assert.equal(pausedByGuard, 1);
    assert.equal(
      runtimeState.explicitNonSharedPlaybackUrl,
      "https://www.bilibili.com/video/BVother?p=1",
    );
    assert.equal(runtimeState.nonSharerAutoplayHoldUrl, null);
    assert.equal(runtimeState.pauseHoldUntil, 0);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller stops force-pausing an unresolved non-shared page once the pause hold has expired", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.intendedPlayState = "paused";
  // The pause hold has already expired and the page bridge has STILL not resolved
  // a current video (e.g. the bridge is stuck or failed). Holding forever would
  // trap the user with no way to manually play this local video, so the hold is
  // bounded: once `pauseHoldUntil` elapses we no longer force-pause the play.
  runtimeState.pauseHoldUntil = 10_000;
  runtimeState.nonSharerAutoplayHoldUrl =
    "https://www.bilibili.com/video/BVother?p=1";
  runtimeState.lastUserGestureAt = 0;
  let pausedByGuard = 0;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    // Page bridge still has not resolved the URL when the play arrives.
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 20_000,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));
    await Promise.resolve();

    // Hold expired + bridge still unresolved → the bounded hold lifts (escape
    // hatch), so the play is not force-paused.
    assert.equal(pausedByGuard, 0);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller does not re-pause an authorized non-shared play when the bridge briefly blips back to null", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.intendedPlayState = "paused";
  // Load-paused arrival: hold armed and the target marked as a non-sharer
  // autoplay hold.
  runtimeState.pauseHoldUntil = 25_000;
  runtimeState.nonSharerAutoplayHoldUrl =
    "https://www.bilibili.com/video/BVother?p=1";
  // The bridge has resolved the video and the user clicks play in the player
  // (fresh gesture after the forced pause).
  runtimeState.lastForcedPauseAt = 19_000;
  runtimeState.lastUserGestureAt = 20_000;
  runtimeState.lastUserGestureInPlayerAt = 20_000;
  const resolvedVideo: SharedVideo = {
    videoId: "BVother:p1",
    url: "https://www.bilibili.com/video/BVother?p=1",
    title: "Other Video",
  };
  let pausedByGuard = 0;
  let now = 20_000;
  let currentVideo: SharedVideo | null = resolvedVideo;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => currentVideo,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));
    await Promise.resolve();

    // Resolved + manual play → authorized: explicit recorded, autoplay-hold
    // marker dropped and the pause hold released.
    assert.equal(pausedByGuard, 0);
    assert.equal(
      runtimeState.explicitNonSharedPlaybackUrl,
      "https://www.bilibili.com/video/BVother?p=1",
    );
    assert.equal(runtimeState.nonSharerAutoplayHoldUrl, null);
    assert.equal(runtimeState.pauseHoldUntil, 0);

    // The player rebuilds / buffer recovers: the bridge briefly returns null and a
    // gesture-less `playing` fires. The released hold + cleared marker keep the
    // user's authorized playback alive — it is not re-paused.
    currentVideo = null;
    now = 23_000;
    dom.video.paused = false;
    dom.listeners.get("playing")?.(new Event("playing"));
    await Promise.resolve();

    assert.equal(pausedByGuard, 0);
    // The authorization survives the transient null so a later autoplay-next off
    // this video can still be classified as a user-driven local navigation.
    assert.equal(
      runtimeState.explicitNonSharedPlaybackUrl,
      "https://www.bilibili.com/video/BVother?p=1",
    );
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller preserves the explicit non-shared authorization at a natural end but clears it on a manual pause", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.intendedPlayState = "playing";
  // The user explicitly authorized this non-shared video earlier.
  runtimeState.explicitNonSharedPlaybackUrl =
    "https://www.bilibili.com/video/BVother?p=1";
  const currentVideo: SharedVideo = {
    videoId: "BVother:p1",
    url: "https://www.bilibili.com/video/BVother?p=1",
    title: "Other Video",
  };
  const originalSetTimeout = globalThis.window.setTimeout;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => currentVideo,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 20_000,
  });

  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();

    // Natural end: the browser fires `pause` with `ended === true` right before
    // autoplaying the next episode. The authorization must survive so the
    // navigation controller can classify that autoplay-next as user-driven.
    (dom.video as { ended?: boolean }).ended = true;
    dom.listeners.get("pause")?.(new Event("pause"));
    await Promise.resolve();
    assert.equal(
      runtimeState.explicitNonSharedPlaybackUrl,
      "https://www.bilibili.com/video/BVother?p=1",
    );

    // A genuine manual mid-video pause (not ended) still deauthorizes it.
    (dom.video as { ended?: boolean }).ended = false;
    dom.listeners.get("pause")?.(new Event("pause"));
    await Promise.resolve();
    assert.equal(runtimeState.explicitNonSharedPlaybackUrl, null);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.restore();
  }
});

test("playback binding controller re-pauses a pre-pause stale gesture while the page bridge is resolving the video", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.intendedPlayState = "paused";
  runtimeState.pauseHoldUntil = 25_000;
  runtimeState.nonSharerAutoplayHoldUrl =
    "https://www.bilibili.com/video/BVother?p=1";
  // The gesture is within the grace window but PRE-dates the forced pause, so it
  // is not a fresh play intent — a browser auto-resume must not slip through.
  runtimeState.lastUserGestureAt = 19_500;
  runtimeState.lastForcedPauseAt = 19_800;
  let pausedByGuard = 0;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 20_000,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));
    await Promise.resolve();

    // No fresh post-pause play intent → still held, and the autoplay hold is kept.
    assert.equal(pausedByGuard, 1);
    assert.equal(
      runtimeState.nonSharerAutoplayHoldUrl,
      "https://www.bilibili.com/video/BVother?p=1",
    );
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller still holds an unsolicited autoplay while the page bridge is resolving the video", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.intendedPlayState = "paused";
  runtimeState.pauseHoldUntil = 25_000;
  // The navigation reset zeroed the gesture, so the page-load autoplay carries
  // none — it must still be held.
  runtimeState.lastUserGestureAt = 0;
  let pausedByGuard = 0;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 20_000,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    await Promise.resolve();

    // No gesture → unsolicited autoplay → still re-paused.
    assert.equal(pausedByGuard, 1);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller allows manual play on non-shared page after auto-resume was suppressed", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.lastUserGestureAt = 1_000;
  let now = 1_050;
  let pausedByGuard = 0;
  const events: string[] = [];
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVother:p1",
      url: "https://www.bilibili.com/video/BVother?p=1",
      title: "Other Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    // Browser auto-seeks to resume point after user click
    dom.listeners.get("seeking")?.(new Event("seeking"));
    // Browser auto-plays after seek — should be suppressed from sync only.
    now = 1_080;
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    await Promise.resolve();
    // The auto-resume (no in-player gesture) is held paused in a room.
    assert.equal(pausedByGuard, 1);

    // User manually clicks play (in the player) after the held auto-resume.
    runtimeState.lastUserGestureAt = 1_500;
    runtimeState.lastUserGestureInPlayerAt = 1_500;
    now = 1_550;
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    await Promise.resolve();

    // Manual play should NOT be blocked — it's a fresh in-player gesture after the
    // held auto-resume, so no additional pause beyond the first.
    assert.equal(pausedByGuard, 1);
    assert.ok(events.includes("play"));
    // The first play event should come from the manual click, not the auto-resume
    const playIndex = events.indexOf("play");
    const eventsBeforePlay = events.slice(0, playIndex);
    assert.deepEqual(eventsBeforePlay, ["seeking"]);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller suppresses non-shared autoplay replayed after a forced pause from the same gesture", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.intendedPlayState = "paused";
  runtimeState.lastUserGestureAt = 1_000;
  runtimeState.lastForcedPauseAt = 1_050;
  const events: string[] = [];
  let pausedByGuard = 0;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVother:p1",
      url: "https://www.bilibili.com/video/BVother?p=1",
      title: "Other Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_100,
  });

  dom.video.pause = () => {
    pausedByGuard += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.video.currentTime = 18;
    dom.listeners.get("play")?.(new Event("play"));

    await Promise.resolve();

    // The same-gesture replay after the forced pause is not a fresh in-player play
    // intent, so the non-shared autoplay is held paused (and not broadcast).
    assert.deepEqual(events, []);
    assert.equal(pausedByGuard, 1);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller holds a non-sharer at the shared video natural end", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.localMemberId = "member-2";
  runtimeState.intendedPlayState = "playing";
  let pauseCalls = 0;
  let pauseHoldCalls = 0;
  let maintainCalls = 0;
  const events: string[] = [];
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    getSharedVideo: () => ({
      videoId: "BVshared:p1",
      url: "https://www.bilibili.com/video/BVshared?p=1",
      title: "Shared Video",
      sharedByMemberId: "member-1",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 8_000,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {
      maintainCalls += 1;
    },
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: (durationMs = 3_000) => {
      pauseHoldCalls += 1;
      runtimeState.pauseHoldUntil = 10_000 + durationMs;
    },
    debugLog: () => {},
    getNow: () => 10_000,
  });

  dom.video.pause = () => {
    pauseCalls += 1;
    dom.video.paused = true;
  };

  try {
    controller.attachPlaybackListeners();
    dom.video.duration = 120;
    dom.video.currentTime = 120;
    dom.video.paused = true;
    dom.listeners.get("ended")?.(new Event("ended"));

    assert.equal(pauseCalls, 1);
    assert.equal(pauseHoldCalls, 1);
    assert.equal(maintainCalls, 0);
    assert.equal(runtimeState.intendedPlayState, "paused");
    assert.equal(runtimeState.lastForcedPauseAt, 10_000);
    assert.equal(runtimeState.pauseHoldUntil, 13_000);
    assert.equal(
      runtimeState.suppressedLocalEndPauseUrl,
      "https://www.bilibili.com/video/BVshared?p=1",
    );
    assert.equal(runtimeState.suppressedLocalEndPauseUntil, 13_000);
    assert.deepEqual(events, []);
  } finally {
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller does not pause the sharer at the shared video end", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.localMemberId = "member-1";
  runtimeState.intendedPlayState = "playing";
  let pauseCalls = 0;
  let pauseHoldCalls = 0;
  let maintainCalls = 0;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    getSharedVideo: () => ({
      videoId: "BVshared:p1",
      url: "https://www.bilibili.com/video/BVshared?p=1",
      title: "Shared Video",
      sharedByMemberId: "member-1",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 9_500,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {
      maintainCalls += 1;
    },
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {
      pauseHoldCalls += 1;
    },
    debugLog: () => {},
    getNow: () => 10_000,
  });

  dom.video.pause = () => {
    pauseCalls += 1;
    dom.video.paused = true;
  };

  try {
    controller.attachPlaybackListeners();
    dom.video.duration = 120;
    dom.video.currentTime = 120;
    dom.video.paused = true;
    dom.listeners.get("ended")?.(new Event("ended"));

    assert.equal(pauseCalls, 0);
    assert.equal(pauseHoldCalls, 0);
    assert.equal(maintainCalls, 0);
    assert.equal(runtimeState.intendedPlayState, "playing");
  } finally {
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller does not pause a non-sharer before the shared video naturally ends", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.localMemberId = "member-2";
  runtimeState.intendedPlayState = "playing";
  let pauseCalls = 0;
  let pauseHoldCalls = 0;
  let maintainCalls = 0;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    getSharedVideo: () => ({
      videoId: "BVshared:p1",
      url: "https://www.bilibili.com/video/BVshared?p=1",
      title: "Shared Video",
      sharedByMemberId: "member-1",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 8_000,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {
      maintainCalls += 1;
    },
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {
      pauseHoldCalls += 1;
    },
    debugLog: () => {},
    getNow: () => 10_000,
  });

  dom.video.pause = () => {
    pauseCalls += 1;
    dom.video.paused = true;
  };

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = false;
    dom.video.duration = 120;
    // Within the old 0.45s pre-end threshold, but the video has not ended yet:
    // the non-sharer must keep playing so it does not miss the final moments.
    dom.video.currentTime = 119.7;
    dom.listeners.get("timeupdate")?.(new Event("timeupdate"));

    assert.equal(pauseCalls, 0);
    assert.equal(pauseHoldCalls, 0);
    assert.equal(maintainCalls, 1);
    assert.equal(runtimeState.intendedPlayState, "playing");
  } finally {
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller re-pauses non-sharer multi-part autoplay after the shared video natural end", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.localMemberId = "member-2";
  runtimeState.intendedPlayState = "playing";
  runtimeState.lastUserGestureAt = 0;
  let pauseCalls = 0;
  const originalPause = dom.video.pause;
  const originalSetTimeout = globalThis.window.setTimeout;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    getSharedVideo: () => ({
      videoId: "BVshared:p1",
      url: "https://www.bilibili.com/video/BVshared?p=1",
      title: "Shared Video",
      sharedByMemberId: "member-1",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 8_000,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: (durationMs = 3_000) => {
      runtimeState.pauseHoldUntil = 10_000 + durationMs;
    },
    debugLog: () => {},
    getNow: () => 10_000,
  });

  dom.video.pause = () => {
    pauseCalls += 1;
    dom.video.paused = true;
  };
  globalThis.window.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1;
  }) as typeof globalThis.window.setTimeout;

  try {
    controller.attachPlaybackListeners();
    // The shared video reaches its natural end and the non-sharer is held.
    dom.video.duration = 120;
    dom.video.currentTime = 120;
    dom.video.paused = true;
    dom.listeners.get("ended")?.(new Event("ended"));
    assert.equal(pauseCalls, 1);
    assert.equal(runtimeState.intendedPlayState, "paused");

    // Bilibili autoplay continues the next part in the same element (no URL
    // change), so the navigation controller never sees it. The resume guard
    // must re-pause it while the end hold is still active.
    dom.video.paused = false;
    dom.listeners.get("playing")?.(new Event("playing"));

    assert.equal(pauseCalls, 2);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller classifies pause as buffer when waiting fired recently", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 0;
  let now = 5_000;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("waiting")?.(new Event("waiting"));
    assert.equal(runtimeState.lastBufferSignalAt, 5_000);

    now = 5_120;
    dom.video.paused = true;
    dom.listeners.get("pause")?.(new Event("pause"));

    assert.equal(runtimeState.pauseClassifiedAsBuffer, true);
    assert.equal(runtimeState.pauseStartedAt, 5_120);
  } finally {
    dom.restore();
  }
});

test("playback binding controller treats pause as user-initiated when fresh gesture preceded it", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  let now = 5_000;
  runtimeState.lastUserGestureAt = 4_950; // fresh gesture
  runtimeState.lastForcedPauseAt = 0;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();
    // A waiting event fires shortly before the pause, but since the user
    // also just clicked, classification should fall back to user pause.
    dom.listeners.get("waiting")?.(new Event("waiting"));
    now = 5_120;
    dom.video.paused = true;
    dom.listeners.get("pause")?.(new Event("pause"));

    assert.equal(runtimeState.pauseClassifiedAsBuffer, false);
    assert.equal(runtimeState.pauseStartedAt, 5_120);
  } finally {
    dom.restore();
  }
});

test("playback binding controller clears buffer-pause classification on resume", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 0;
  let now = 5_000;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("waiting")?.(new Event("waiting"));
    now = 5_100;
    dom.video.paused = true;
    dom.listeners.get("pause")?.(new Event("pause"));
    assert.equal(runtimeState.pauseClassifiedAsBuffer, true);

    now = 5_800;
    dom.video.paused = false;
    dom.listeners.get("playing")?.(new Event("playing"));

    assert.equal(runtimeState.pauseClassifiedAsBuffer, false);
    assert.equal(runtimeState.pauseStartedAt, 0);
  } finally {
    dom.restore();
  }
});

test("playback binding controller does not classify pause as buffer-induced inside a programmatic paused-apply window", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 0;
  // Programmatic paused-apply is in flight: matches signature path used by
  // room-state-apply-controller when applying a remote `paused`. Without the
  // guard, the synthetic `waiting` event from the hard-seek would tag the
  // following `pause` as buffer-induced and let it broadcast as `buffering`,
  // which then blocks the peer's next `playing` via local-intent-guard.
  runtimeState.programmaticApplyUntil = 5_500;
  runtimeState.programmaticApplySignature = {
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "paused",
    currentTime: 11.12,
    playbackRate: 1,
  };
  let now = 5_000;
  const originalSetTimeout = globalThis.window.setTimeout;
  const scheduledTimers: Array<{ cb: () => void; ms: number }> = [];
  globalThis.window.setTimeout = ((callback: TimerHandler, ms?: number) => {
    if (typeof callback === "function") {
      scheduledTimers.push({ cb: callback as () => void, ms: ms ?? 0 });
    }
    return scheduledTimers.length;
  }) as typeof globalThis.window.setTimeout;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    getSharedVideo: () => ({
      videoId: "BV1xx411c7mD:p1",
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      title: "Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();
    // Synthetic waiting from hard-seek, then synthetic pause from video.pause().
    dom.listeners.get("waiting")?.(new Event("waiting"));
    assert.equal(runtimeState.lastBufferSignalAt, 5_000);
    now = 5_120;
    dom.video.paused = true;
    dom.listeners.get("pause")?.(new Event("pause"));

    assert.equal(runtimeState.pauseClassifiedAsBuffer, false);
    assert.equal(runtimeState.pauseStartedAt, 5_120);
    // No buffer-pause upgrade timer should have been armed.
    assert.equal(
      scheduledTimers.some((t) => t.ms === 1_500),
      false,
    );
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.restore();
  }
});

test("playback binding controller still classifies pause as buffer-induced when programmatic apply window has expired", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 0;
  runtimeState.programmaticApplyUntil = 4_500; // already expired vs now=5_000
  runtimeState.programmaticApplySignature = {
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "paused",
    currentTime: 11.12,
    playbackRate: 1,
  };
  let now = 5_000;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    getSharedVideo: () => ({
      videoId: "BV1xx411c7mD:p1",
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      title: "Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("waiting")?.(new Event("waiting"));
    now = 5_120;
    dom.video.paused = true;
    dom.listeners.get("pause")?.(new Event("pause"));

    assert.equal(runtimeState.pauseClassifiedAsBuffer, true);
  } finally {
    dom.restore();
  }
});

test("playback binding controller re-broadcasts paused after buffer-pause upgrade threshold", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 0;
  let now = 5_000;
  const broadcasts: string[] = [];
  const originalSetTimeout = globalThis.window.setTimeout;
  const scheduledTimers: Array<{ cb: () => void; ms: number }> = [];
  globalThis.window.setTimeout = ((callback: TimerHandler, ms?: number) => {
    if (typeof callback === "function") {
      scheduledTimers.push({ cb: callback as () => void, ms: ms ?? 0 });
    }
    return scheduledTimers.length;
  }) as typeof globalThis.window.setTimeout;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      broadcasts.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("waiting")?.(new Event("waiting"));
    now = 5_100;
    dom.video.paused = true;
    dom.listeners.get("pause")?.(new Event("pause"));

    await Promise.resolve();
    // Initial broadcasts from pause + 120ms followup (captured but not fired here)
    assert.equal(broadcasts.includes("pause"), true);
    assert.equal(runtimeState.pauseClassifiedAsBuffer, true);
    const upgradeTimer = scheduledTimers.find((t) => t.ms === 1_500);
    assert.notEqual(upgradeTimer, undefined);

    // Fire the upgrade timer: video still paused, should re-broadcast and clear classification
    now = 6_600;
    broadcasts.length = 0;
    upgradeTimer?.cb();
    await Promise.resolve();

    assert.equal(runtimeState.pauseClassifiedAsBuffer, false);
    assert.equal(broadcasts.includes("pause"), true);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.restore();
  }
});

test("playback binding controller suppresses the natural-end pause for a non-sharer", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared";
  runtimeState.pendingRoomStateHydration = false;
  // The local member is NOT the sharer, so its end-of-video pause must not be
  // broadcast (it would flip the room to paused and disrupt the sharer's
  // autoplay-next advance).
  runtimeState.localMemberId = "member-2";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.intendedPlayState = "playing";
  const events: string[] = [];
  let pauseCalls = 0;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVshared",
      url: "https://www.bilibili.com/video/BVshared",
      title: "Shared Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 5_000,
  });

  dom.video.pause = () => {
    pauseCalls += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };

  try {
    controller.attachPlaybackListeners();
    // The browser dispatches `pause` (with `ended` already true) right before
    // `ended` at the natural end of the shared video.
    (dom.video as { ended?: boolean }).ended = true;
    dom.video.paused = true;
    dom.listeners.get("pause")?.(new Event("pause"));

    await Promise.resolve();

    // The end-pause is suppressed and the end-hold protection is armed before any
    // broadcast leaks out.
    assert.deepEqual(events, []);
    assert.equal(pauseCalls, 1);
    assert.equal(
      runtimeState.suppressedLocalEndPauseUrl,
      "https://www.bilibili.com/video/BVshared",
    );
    assert.equal(runtimeState.intendedPlayState, "paused");
  } finally {
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller suppresses the natural-end pause broadcast for the sharer without pausing it", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared";
  runtimeState.pendingRoomStateHydration = false;
  // The local member IS the sharer. Its own end-of-video pause must not be
  // broadcast (it would relay a misleading "paused"/"jumped to 0:00" against the
  // old video before the auto-share of the next video lands) — but unlike a
  // non-sharer the sharer is NOT paused, so autoplay-next can continue.
  runtimeState.localMemberId = "member-1";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.intendedPlayState = "playing";
  const events: string[] = [];
  let pauseCalls = 0;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVshared",
      url: "https://www.bilibili.com/video/BVshared",
      title: "Shared Video",
      sharedByMemberId: "member-1",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 5_000,
  });

  dom.video.pause = () => {
    pauseCalls += 1;
    dom.video.paused = true;
    return Promise.resolve();
  };

  try {
    controller.attachPlaybackListeners();
    // The browser dispatches `pause` (with `ended` already true) right before
    // `ended` at the natural end of the sharer's own shared video.
    (dom.video as { ended?: boolean }).ended = true;
    dom.video.paused = true;
    dom.listeners.get("pause")?.(new Event("pause"));

    await Promise.resolve();

    // The end-pause is suppressed, the sharer is not force-paused, and broadcast
    // suppression for the ended shared URL is armed for the autoplay-next handoff.
    assert.deepEqual(events, []);
    assert.equal(pauseCalls, 0);
    assert.equal(runtimeState.intendedPlayState, "playing");
    assert.equal(
      runtimeState.sharerEndedSuppressionUrl,
      "https://www.bilibili.com/video/BVshared",
    );
    assert.equal(runtimeState.sharerEndedSuppressionUntil, 8_000);
    assert.equal(runtimeState.sharerEndedSuppressionArmedAt, 5_000);
    // The durable natural-end timestamp is recorded so the navigation controller
    // can recognise the autoplay-next even after the suppression marker above is
    // cleared by the broadcast gate.
    assert.equal(
      runtimeState.sharedVideoNaturalEndUrl,
      "https://www.bilibili.com/video/BVshared",
    );
    assert.equal(runtimeState.sharedVideoNaturalEndAt, 5_000);
    // No seek preceded this end, so the seek-to-end flag stays false.
    assert.equal(runtimeState.sharedVideoNaturalEndAfterSeek, false);
  } finally {
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller records the seek-to-end flag when a seek preceded the natural end", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  const sharedUrl = "https://www.bilibili.com/video/BVshared";
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = sharedUrl;
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.localMemberId = "member-1";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.intendedPlayState = "playing";
  // The sharer seeked to the last seconds (the most recent gesture is that seek,
  // no newer gesture since), then the video played out to its natural end.
  runtimeState.lastUserGestureAt = 4_800;
  runtimeState.lastExplicitUserAction = { kind: "seek", at: 4_850 };
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVshared",
      url: sharedUrl,
      title: "Shared Video",
      sharedByMemberId: "member-1",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 5_000,
  });

  dom.video.pause = () => {
    dom.video.paused = true;
    return Promise.resolve();
  };

  try {
    controller.attachPlaybackListeners();
    (dom.video as { ended?: boolean }).ended = true;
    dom.video.paused = true;
    dom.listeners.get("pause")?.(new Event("pause"));
    await Promise.resolve();

    assert.equal(runtimeState.sharedVideoNaturalEndUrl, sharedUrl);
    assert.equal(runtimeState.sharedVideoNaturalEndAfterSeek, true);
  } finally {
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller flushes the sharer's terminal paused state when no autoplay-next follows", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  const sharedUrl = "https://www.bilibili.com/video/BVshared";
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = sharedUrl;
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.localMemberId = "member-1";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.intendedPlayState = "playing";
  const events: string[] = [];
  const scheduled: Array<{ cb: () => void; ms: number }> = [];
  const originalSetTimeout = globalThis.window.setTimeout;
  // Capture the deferred flush timer instead of letting it fire on a real clock.
  globalThis.window.setTimeout = ((cb: () => void, ms?: number) => {
    scheduled.push({ cb, ms: ms ?? 0 });
    return scheduled.length;
  }) as unknown as typeof globalThis.window.setTimeout;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVshared",
      url: sharedUrl,
      title: "Shared Video",
      sharedByMemberId: "member-1",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource, naturalEnd) => {
      events.push(
        `${eventSource ?? "manual"}:${naturalEnd ? "natural-end" : "none"}`,
      );
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 5_000,
  });

  try {
    controller.attachPlaybackListeners();
    (dom.video as { ended?: boolean }).ended = true;
    dom.video.paused = true;
    dom.listeners.get("pause")?.(new Event("pause"));
    await Promise.resolve();

    // The end-pause was suppressed and a flush timer armed.
    assert.deepEqual(events, []);
    const flush = scheduled.find((entry) => entry.ms === 3_000);
    assert.ok(
      flush,
      "a flush timer should be scheduled for the suppression window",
    );

    // The window elapses with the player still parked at the end (no
    // autoplay-next): the terminal paused state is flushed (tagged as a natural
    // end so peers stay quiet) and the marker cleared.
    flush?.cb();
    await Promise.resolve();

    assert.deepEqual(events, ["pause:natural-end"]);
    assert.equal(runtimeState.sharerEndedSuppressionUrl, null);
    assert.equal(runtimeState.sharerEndedSuppressionUntil, 0);
    assert.equal(runtimeState.sharerEndedSuppressionArmedAt, 0);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.restore();
  }
});

test("playback binding controller does not flush a sharer end state once autoplay-next has continued", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  const sharedUrl = "https://www.bilibili.com/video/BVshared";
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = sharedUrl;
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.localMemberId = "member-1";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.intendedPlayState = "playing";
  const events: string[] = [];
  const scheduled: Array<{ cb: () => void; ms: number }> = [];
  const originalSetTimeout = globalThis.window.setTimeout;
  globalThis.window.setTimeout = ((cb: () => void, ms?: number) => {
    scheduled.push({ cb, ms: ms ?? 0 });
    return scheduled.length;
  }) as unknown as typeof globalThis.window.setTimeout;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVshared",
      url: sharedUrl,
      title: "Shared Video",
      sharedByMemberId: "member-1",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 5_000,
  });

  try {
    controller.attachPlaybackListeners();
    (dom.video as { ended?: boolean }).ended = true;
    dom.video.paused = true;
    dom.listeners.get("pause")?.(new Event("pause"));
    await Promise.resolve();

    const flush = scheduled.find((entry) => entry.ms === 3_000);
    assert.ok(flush);

    // Autoplay-next started: the element resumed (no longer `ended`).
    (dom.video as { ended?: boolean }).ended = false;
    dom.video.paused = false;
    flush?.cb();
    await Promise.resolve();

    // No terminal pause is broadcast; the marker is just tidied.
    assert.deepEqual(events, []);
    assert.equal(runtimeState.sharerEndedSuppressionUrl, null);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.restore();
  }
});

test("playback binding controller does not arm sharer end suppression for a non-sharer", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.localMemberId = "member-2";
  runtimeState.activeSharedByMemberId = "member-1";
  runtimeState.intendedPlayState = "playing";
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BVshared",
      url: "https://www.bilibili.com/video/BVshared",
      title: "Shared Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 5_000,
  });

  dom.video.pause = () => {
    dom.video.paused = true;
    return Promise.resolve();
  };

  try {
    controller.attachPlaybackListeners();
    (dom.video as { ended?: boolean }).ended = true;
    dom.video.paused = true;
    dom.listeners.get("pause")?.(new Event("pause"));

    await Promise.resolve();

    // The non-sharer end-hold path handles this; the sharer marker stays unset.
    assert.equal(runtimeState.sharerEndedSuppressionUrl, null);
    assert.equal(runtimeState.sharerEndedSuppressionUntil, 0);
  } finally {
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller classifies a stall on a rebuilt element as buffering when no pause event fired", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 0;
  runtimeState.intendedPlayState = "playing";
  let now = 5_000;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    videoRebindBufferSignalMs: 1_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();

    // The player rebuilt its media element: it is already paused and no `pause`
    // event was ever dispatched, so only the restore transport events arrive.
    now = 5_400;
    dom.video.paused = true;
    dom.listeners.get("seeked")?.(new Event("seeked"));

    assert.equal(runtimeState.pauseClassifiedAsBuffer, true);
    assert.equal(runtimeState.pauseStartedAt, 5_400);
  } finally {
    dom.restore();
  }
});

test("playback binding controller does not reclassify a user pause when transport events follow it", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.intendedPlayState = "playing";
  runtimeState.lastUserGestureAt = 4_950;
  runtimeState.lastForcedPauseAt = 0;
  let now = 5_000;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    videoRebindBufferSignalMs: 1_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();
    dom.video.paused = true;
    dom.listeners.get("pause")?.(new Event("pause"));
    assert.equal(runtimeState.pauseClassifiedAsBuffer, false);

    // A `seeked`/`canplay` arriving long after the user's pause must not
    // relabel it as a buffer stall — the room would then never learn the video
    // is actually stopped.
    now = 9_000;
    dom.listeners.get("seeked")?.(new Event("seeked"));
    dom.listeners.get("canplay")?.(new Event("canplay"));

    assert.equal(runtimeState.pauseClassifiedAsBuffer, false);
    assert.equal(runtimeState.pauseStartedAt, 5_000);
  } finally {
    dom.restore();
  }
});

test("playback binding controller leaves an unobserved pause alone when the room intent is paused", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 0;
  runtimeState.intendedPlayState = "paused";
  let now = 5_000;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    videoRebindBufferSignalMs: 1_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();
    now = 5_400;
    dom.video.paused = true;
    dom.listeners.get("seeked")?.(new Event("seeked"));

    assert.equal(runtimeState.pauseClassifiedAsBuffer, false);
    assert.equal(runtimeState.pauseStartedAt, 0);
  } finally {
    dom.restore();
  }
});

test("playback binding controller classifies a pause right after a video rebind as buffer-induced", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 0;
  runtimeState.intendedPlayState = "playing";
  let now = 5_000;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    videoRebindBufferSignalMs: 1_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();
    assert.equal(runtimeState.lastVideoElementBoundAt, 5_000);

    // No `waiting`/`stalled` at all — the rebind is the only buffer evidence.
    now = 5_200;
    dom.video.paused = true;
    dom.listeners.get("pause")?.(new Event("pause"));

    assert.equal(runtimeState.pauseClassifiedAsBuffer, true);

    // Well past the rebind window the same pause is a real one again.
    runtimeState.pauseStartedAt = 0;
    runtimeState.pauseClassifiedAsBuffer = false;
    now = 6_500;
    dom.listeners.get("pause")?.(new Event("pause"));

    assert.equal(runtimeState.pauseClassifiedAsBuffer, false);
  } finally {
    dom.restore();
  }
});

test("playback binding controller upgrades an unobserved stall to paused after the threshold", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 0;
  runtimeState.intendedPlayState = "playing";
  let now = 5_000;
  const broadcasts: string[] = [];
  const originalSetTimeout = globalThis.window.setTimeout;
  const scheduledTimers: Array<{ cb: () => void; ms: number }> = [];
  globalThis.window.setTimeout = ((callback: TimerHandler, ms?: number) => {
    if (typeof callback === "function") {
      scheduledTimers.push({ cb: callback as () => void, ms: ms ?? 0 });
    }
    return scheduledTimers.length;
  }) as typeof globalThis.window.setTimeout;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    videoRebindBufferSignalMs: 1_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      broadcasts.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();
    now = 5_400;
    dom.video.paused = true;
    dom.listeners.get("seeked")?.(new Event("seeked"));

    await Promise.resolve();
    assert.equal(runtimeState.pauseClassifiedAsBuffer, true);

    const upgradeTimer = scheduledTimers.find((timer) => timer.ms === 1_500);
    assert.notEqual(upgradeTimer, undefined);

    now = 6_900;
    broadcasts.length = 0;
    upgradeTimer?.cb();
    await Promise.resolve();

    assert.equal(runtimeState.pauseClassifiedAsBuffer, false);
    assert.equal(broadcasts.includes("pause"), true);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.restore();
  }
});

function createEchoHarness(
  runtimeState: ReturnType<typeof createContentRuntimeState>,
  getNow: () => number,
) {
  return createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    videoRebindBufferSignalMs: 1_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow,
  });
}

test("playback binding controller does not record its own programmatic apply as a user action", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  const now = 5_100;
  // A remote state is being applied. The page gesture predates the window, so
  // the seek/pause events it produces are our own echo, not the user.
  runtimeState.programmaticApplyAt = 5_000;
  runtimeState.programmaticApplyUntil = 5_700;
  runtimeState.lastUserGestureAt = 4_900;

  const controller = createEchoHarness(runtimeState, () => now);

  try {
    controller.attachPlaybackListeners();

    dom.listeners.get("seeking")?.(new Event("seeking"));
    assert.equal(runtimeState.lastExplicitUserAction, null);

    dom.video.paused = true;
    dom.listeners.get("pause")?.(new Event("pause"));
    assert.equal(runtimeState.lastExplicitUserAction, null);
    assert.equal(runtimeState.lastExplicitPlaybackAction, null);
  } finally {
    dom.restore();
  }
});

test("playback binding controller still records a gesture made during a programmatic apply", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  const now = 5_100;
  runtimeState.programmaticApplyAt = 5_000;
  runtimeState.programmaticApplyUntil = 5_700;
  // The user grabbed the player AFTER the apply started — that is genuinely
  // them, and must not be discarded along with the echo. A real in-player
  // gesture refreshes both timestamps.
  runtimeState.lastUserGestureAt = 5_050;
  runtimeState.lastUserGestureInPlayerAt = 5_050;

  const controller = createEchoHarness(runtimeState, () => now);

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("seeking")?.(new Event("seeking"));

    assert.deepEqual(runtimeState.lastExplicitUserAction, {
      kind: "seek",
      at: 5_100,
    });
  } finally {
    dom.restore();
  }
});

test("playback binding controller records user actions normally once the apply window closes", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  const now = 6_000;
  runtimeState.programmaticApplyAt = 5_000;
  runtimeState.programmaticApplyUntil = 5_700; // already elapsed
  runtimeState.lastUserGestureAt = 5_900;
  runtimeState.lastUserGestureInPlayerAt = 5_900;

  const controller = createEchoHarness(runtimeState, () => now);

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("seeking")?.(new Event("seeking"));

    assert.deepEqual(runtimeState.lastExplicitUserAction, {
      kind: "seek",
      at: 6_000,
    });
  } finally {
    dom.restore();
  }
});

test("playback binding controller gives a same-tick gesture to the user, not the echo", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  const now = 5_100;
  // Date.now() resolution is coarsened by browsers, so a user grabbing the
  // player as the window opens can share its timestamp. That tie must resolve
  // in the user's favour: losing a real interaction would be a new harm, while
  // treating an echo as a user action is merely the pre-guard behaviour.
  runtimeState.programmaticApplyAt = 5_000;
  runtimeState.programmaticApplyUntil = 5_700;
  runtimeState.lastUserGestureAt = 5_000;
  runtimeState.lastUserGestureInPlayerAt = 5_000;

  const controller = createEchoHarness(runtimeState, () => now);

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("seeking")?.(new Event("seeking"));

    assert.deepEqual(runtimeState.lastExplicitUserAction, {
      kind: "seek",
      at: 5_100,
    });
  } finally {
    dom.restore();
  }
});

test("playback binding controller does not let a stray page click authorize apply echoes", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  const now = 5_100;
  runtimeState.programmaticApplyAt = 5_000;
  runtimeState.programmaticApplyUntil = 5_700;
  // A click on blank space / the danmaku box during the apply: the tracker is
  // document-level so it refreshes `lastUserGestureAt`, but it expresses no
  // intent to control the player and must not make the apply's own echoes look
  // like deliberate user actions.
  runtimeState.lastUserGestureAt = 5_050;
  runtimeState.lastUserGestureInPlayerAt = 4_900;

  const controller = createEchoHarness(runtimeState, () => now);

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("seeking")?.(new Event("seeking"));

    assert.equal(runtimeState.lastExplicitUserAction, null);
  } finally {
    dom.restore();
  }
});

test("a user seek that cancels an active rate catch-up is still recorded", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 1_000;
  runtimeState.lastUserGestureInPlayerAt = 1_000;
  const events: string[] = [];

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    // Mirror the real soft-apply cancel: restoring the snapshot rate arms a
    // programmatic window whose start (1_100) post-dates the gesture (1_000)
    // that triggered this very cancel.
    cancelActiveSoftApply: () => {
      runtimeState.programmaticApplyAt = 1_100;
      runtimeState.programmaticApplyUntil = 1_800;
      runtimeState.programmaticApplyScope = "ratechange";
      runtimeState.programmaticApplySignature = {
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        playState: "buffering",
        currentTime: 119.49,
        playbackRate: 2,
      };
    },
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_100,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("seeking")?.(new Event("seeking"));

    // Without this the action stays null, `derivePlaybackSyncIntent` cannot tag
    // the broadcast and the guard's explicit-action bypass has nothing to match,
    // so the seek never leaves this client and the room pulls it back.
    assert.deepEqual(runtimeState.lastExplicitUserAction, {
      kind: "seek",
      at: 1_100,
    });

    await Promise.resolve();
    assert.deepEqual(events, ["seeking"]);
  } finally {
    dom.restore();
  }
});

test("a user pause that cancels an active rate catch-up is still recorded", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 1_000;
  runtimeState.lastUserGestureInPlayerAt = 1_000;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {
      runtimeState.programmaticApplyAt = 1_100;
      runtimeState.programmaticApplyUntil = 1_800;
      runtimeState.programmaticApplyScope = "ratechange";
      runtimeState.programmaticApplySignature = {
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        playState: "paused",
        currentTime: 119.49,
        playbackRate: 2,
      };
    },
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_100,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("pause")?.(new Event("pause"));

    assert.deepEqual(runtimeState.lastExplicitUserAction, {
      kind: "pause",
      at: 1_100,
    });
    assert.deepEqual(runtimeState.lastExplicitPlaybackAction, {
      playState: "paused",
      at: 1_100,
    });
  } finally {
    dom.restore();
  }
});

test("a ratechange is enough to classify an unobserved pause as buffering", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  // The player stalled and silently reset the catch-up rate: the element is
  // paused, no `pause` event ever fired, and `ratechange` is the first handler
  // to see it. Reporting that as a hard `paused` makes every peer stop and
  // resume ~1s later, which is what the room observed.
  (dom.video as { paused: boolean }).paused = true;
  runtimeState.intendedPlayState = "playing";
  runtimeState.pauseStartedAt = 0;
  runtimeState.lastUserGestureAt = 0;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    videoRebindBufferSignalMs: 1_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 10_000,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("ratechange")?.(new Event("ratechange"));

    assert.equal(runtimeState.pauseClassifiedAsBuffer, true);
    assert.equal(runtimeState.pauseStartedAt, 10_000);
  } finally {
    dom.restore();
  }
});

test("a real user pause is not reclassified by the shared broadcast path", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  (dom.video as { paused: boolean }).paused = true;
  runtimeState.intendedPlayState = "playing";
  // A fresh in-player gesture accounts for this pause, so it is a real stop.
  runtimeState.lastUserGestureAt = 9_900;
  runtimeState.lastUserGestureInPlayerAt = 9_900;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    bufferSignalWindowMs: 300,
    bufferPauseUpgradeMs: 1_500,
    videoRebindBufferSignalMs: 1_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 10_000,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("pause")?.(new Event("pause"));

    assert.equal(runtimeState.pauseClassifiedAsBuffer, false);
  } finally {
    dom.restore();
  }
});

test("playback binding controller keeps the seek origin across seeking and seeked", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 1_000;
  // This side is already stalled when the user grabs the scrubber.
  runtimeState.intendedPlayState = "buffering";
  let now = 1_100;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {
      // Stand in for the real broadcast, which forces the `seeking` event to
      // `playing` and then writes that back onto `intendedPlayState`.
      runtimeState.intendedPlayState = "playing";
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();

    dom.listeners.get("seeking")?.(new Event("seeking"));
    await Promise.resolve();
    assert.equal(runtimeState.explicitSeekOriginPlayState, "buffering");

    // The `seeked` of the SAME gesture must not re-read the written-back
    // `intendedPlayState` and downgrade the origin to healthy playback.
    now = 1_180;
    dom.listeners.get("seeked")?.(new Event("seeked"));
    await Promise.resolve();
    assert.equal(runtimeState.explicitSeekOriginPlayState, "buffering");
  } finally {
    dom.restore();
  }
});

test("playback binding controller re-snapshots the origin for a new seek gesture", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 1_000;
  runtimeState.intendedPlayState = "buffering";
  let now = 1_100;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();

    dom.listeners.get("seeking")?.(new Event("seeking"));
    await Promise.resolve();
    assert.equal(runtimeState.explicitSeekOriginPlayState, "buffering");

    // A separate gesture, past the grace window and after recovery: its origin
    // is read fresh rather than inherited from the stalled one.
    now = 5_000;
    runtimeState.lastUserGestureAt = 4_900;
    runtimeState.intendedPlayState = "playing";
    dom.listeners.get("seeking")?.(new Event("seeking"));
    await Promise.resolve();
    assert.equal(runtimeState.explicitSeekOriginPlayState, "playing");
  } finally {
    dom.restore();
  }
});

test("playback binding controller re-samples the seek origin after a forced pause", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 1_000;
  runtimeState.intendedPlayState = "buffering";
  let now = 1_100;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();

    dom.listeners.get("seeking")?.(new Event("seeking"));
    await Promise.resolve();
    assert.equal(runtimeState.explicitSeekOriginPlayState, "buffering");

    // A forced pause invalidates that seek. The user then scrubs the now-paused
    // video, still inside the 1_200ms grace window of the first one.
    now = 1_200;
    runtimeState.lastForcedPauseAt = now;
    runtimeState.intendedPlayState = "paused";
    now = 1_300;
    runtimeState.lastUserGestureAt = 1_250;
    dom.listeners.get("seeking")?.(new Event("seeking"));
    await Promise.resolve();

    // Inheriting "buffering" here would force this scrub to `playing` and start
    // playback for the whole room.
    assert.equal(runtimeState.explicitSeekOriginPlayState, "paused");
  } finally {
    dom.restore();
  }
});
