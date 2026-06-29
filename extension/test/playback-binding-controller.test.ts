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

test("playback binding controller allows explicit play on a non-shared page", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.lastUserGestureAt = 1_000;
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

    // The auto-played non-shared video should keep playing locally.
    assert.equal(pausedByGuard, 0);
    // The seeking event is broadcast (non-shared page), but play should be blocked.
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

test("playback binding controller does not pause an unmarked non-shared page reached by full-page navigation", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  // The user opened a different local video via the address bar/bookmark. The
  // content script reloaded, so there was no in-SPA navigation event to flag it
  // as a non-sharer autoplay page (nonSharerAutoplayHoldUrl stays null) and no
  // recent in-page gesture. Hydration reset the room intent to paused.
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

    // Without the non-sharer autoplay marker, the manually opened local video is
    // left playable (its broadcast is still suppressed by the non-shared guard).
    assert.equal(pausedByGuard, 0);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller allows a gesture-driven manual play and keeps it alive once the bridge resolves the video", async () => {
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
  // The user just clicked play (a fresh gesture, after the forced pause).
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

    // A fresh gesture marks this as the user's own manual play, not an autoplay
    // resume — it is not re-paused while the context is still unconfirmed, and the
    // autoplay hold is released so resolution cannot re-pause it later.
    assert.equal(pausedByGuard, 0);
    assert.equal(runtimeState.nonSharerAutoplayHoldUrl, null);

    // The bridge resolves the URL well past the gesture grace, then a delayed
    // `playing` fires. With the hold released, the user's playback survives.
    resolvedVideo = {
      videoId: "BVother:p1",
      url: "https://www.bilibili.com/video/BVother?p=1",
      title: "Other Video",
    };
    now = 25_000;
    dom.video.paused = false;
    dom.listeners.get("playing")?.(new Event("playing"));
    await Promise.resolve();

    assert.equal(pausedByGuard, 0);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
    dom.restore();
  }
});

test("playback binding controller keeps a manual play alive when a delayed playing fires while the bridge is still resolving past the gesture grace", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM42";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  runtimeState.pendingRoomStateHydration = false;
  runtimeState.intendedPlayState = "paused";
  runtimeState.pauseHoldUntil = 25_000;
  runtimeState.nonSharerAutoplayHoldUrl =
    "https://www.bilibili.com/video/BVother?p=1";
  // Fresh gesture, after the forced pause.
  runtimeState.lastForcedPauseAt = 19_000;
  runtimeState.lastUserGestureAt = 19_500;
  let pausedByGuard = 0;
  let now = 20_000;
  const originalSetTimeout = globalThis.window.setTimeout;
  const originalPause = dom.video.pause;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    // The page bridge never resolves during this test — `currentVideo` stays null
    // through both the play and the delayed playing.
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

    // Manual play within grace → allowed, hold released, durable marker recorded.
    assert.equal(pausedByGuard, 0);
    assert.equal(runtimeState.nonSharerAutoplayHoldUrl, null);
    assert.equal(runtimeState.manualNonSharedPlayWhileResolvingAt, 20_000);

    // A delayed `playing` arrives well past the gesture grace while the bridge is
    // STILL resolving (`currentVideo` null). The durable marker keeps the manual
    // play exempt, so it is not re-paused.
    now = 24_000;
    dom.video.paused = false;
    dom.listeners.get("playing")?.(new Event("playing"));
    await Promise.resolve();

    assert.equal(pausedByGuard, 0);
  } finally {
    globalThis.window.setTimeout = originalSetTimeout;
    dom.video.pause = originalPause;
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
    assert.equal(pausedByGuard, 0);

    // User manually clicks play after the suppressed auto-resume.
    runtimeState.lastUserGestureAt = 1_500;
    now = 1_550;
    dom.video.paused = false;
    dom.listeners.get("play")?.(new Event("play"));

    await Promise.resolve();

    // Manual play should NOT be blocked — it's a new gesture after the auto-resume.
    assert.equal(pausedByGuard, 0);
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

    assert.deepEqual(events, []);
    assert.equal(pausedByGuard, 0);
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

    // The end-pause was suppressed and a flush timer armed.
    assert.deepEqual(events, []);
    const flush = scheduled.find((entry) => entry.ms === 3_000);
    assert.ok(
      flush,
      "a flush timer should be scheduled for the suppression window",
    );

    // The window elapses with the player still parked at the end (no
    // autoplay-next): the terminal paused state is flushed and the marker cleared.
    flush?.cb();
    await Promise.resolve();

    assert.deepEqual(events, ["pause"]);
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
