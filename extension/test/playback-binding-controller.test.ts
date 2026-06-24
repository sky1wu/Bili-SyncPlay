import assert from "node:assert/strict";
import test from "node:test";
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
