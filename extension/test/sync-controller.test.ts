import assert from "node:assert/strict";
import test from "node:test";
import type {
  PlaybackState,
  RoomState,
  SharedVideo,
} from "@bili-syncplay/protocol";
import { createContentRuntimeState } from "../src/content/runtime-state";
import { createSyncController } from "../src/content/sync-controller";

function installWindowStub() {
  const originalWindow = globalThis.window;
  const scheduled: Array<() => void> = [];
  let nextTimer = 1;

  const windowStub = {
    setTimeout(callback: () => void) {
      scheduled.push(callback);
      return nextTimer++;
    },
    clearTimeout(_timer: number) {},
  };

  Object.assign(globalThis, { window: windowStub });

  return {
    scheduled,
    restore() {
      Object.assign(globalThis, { window: originalWindow });
    },
  };
}

function createControllerHarness() {
  const runtimeState = createContentRuntimeState();
  const lastAppliedVersionByActor = new Map<
    string,
    { serverTime: number; seq: number }
  >();
  const debugLogs: string[] = [];
  const runtimeMessages: Array<unknown> = [];
  let hydrateRetryTimer: number | null = null;
  let now = 10_000;
  let currentPlaybackVideo: SharedVideo | null = null;
  let sharedVideo: SharedVideo | null = null;
  let videoElement: HTMLVideoElement | null = null;

  const controller = createSyncController({
    runtimeState,
    lastAppliedVersionByActor,
    broadcastLogState: { key: null, at: 0 },
    ignoredSelfPlaybackLogState: { key: null, at: 0 },
    localIntentGuardMs: 500,
    pauseHoldMs: 1_000,
    initialRoomStatePauseHoldMs: 1_500,
    remoteEchoSuppressionMs: 800,
    remotePlayTransitionGuardMs: 500,
    remoteFollowPlayingWindowMs: 3_000,
    programmaticApplyWindowMs: 700,
    userGestureGraceMs: 300,
    bufferPauseUpgradeMs: 1_500,
    remotePauseDebounceMs: 0,
    nextSeq: () => 1,
    markBroadcastAt: () => {},
    getNow: () => now,
    debugLog: (message) => {
      debugLogs.push(message);
    },
    shouldLogHeartbeat: () => true,
    runtimeSendMessage: async (message) => {
      runtimeMessages.push(message);
      return null;
    },
    getHydrateRetryTimer: () => hydrateRetryTimer,
    setHydrateRetryTimer: (timer) => {
      hydrateRetryTimer = timer;
    },
    getVideoElement: () => videoElement,
    getCurrentPlaybackVideo: async () => currentPlaybackVideo,
    getSharedVideo: () => sharedVideo,
    normalizeUrl: (url) => url?.trim() ?? null,
    notifyRoomStateToasts: () => {},
    maybeShowSharedVideoToast: () => {},
  });

  return {
    runtimeState,
    controller,
    debugLogs,
    runtimeMessages,
    setNow(value: number) {
      now = value;
    },
    setCurrentPlaybackVideo(video: SharedVideo | null) {
      currentPlaybackVideo = video;
    },
    setSharedVideo(video: SharedVideo | null) {
      sharedVideo = video;
    },
    setVideoElement(video: HTMLVideoElement | null) {
      videoElement = video;
    },
    get hydrateRetryTimer() {
      return hydrateRetryTimer;
    },
  };
}

function createPlaybackState(
  overrides: Partial<PlaybackState> = {},
): PlaybackState {
  return {
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    currentTime: 24,
    playState: "playing",
    playbackRate: 1,
    updatedAt: 1,
    serverTime: 1,
    actorId: "remote-member",
    seq: 1,
    ...overrides,
  };
}

function createRoomState(
  playbackOverrides: Partial<PlaybackState> = {},
): RoomState {
  const playback = createPlaybackState(playbackOverrides);
  return {
    roomCode: "ROOM01",
    sharedVideo: {
      videoId: "BV1xx411c7mD",
      url: playback.url,
      title: "Video",
    },
    playback,
    members: [],
  };
}

function createVideo(
  overrides: Partial<HTMLVideoElement> = {},
): HTMLVideoElement {
  return {
    paused: false,
    readyState: 4,
    duration: 120,
    currentTime: 24,
    playbackRate: 1,
    pause() {},
    play: async () => undefined,
    ...overrides,
  } as HTMLVideoElement;
}

test("sync controller skips playback broadcast before hydration becomes ready", async () => {
  const harness = createControllerHarness();
  const video = {
    paused: false,
    readyState: 4,
    currentTime: 12,
    playbackRate: 1,
  } as HTMLVideoElement;

  await harness.controller.broadcastPlayback(video);

  assert.equal(harness.runtimeMessages.length, 0);
  assert.equal(
    harness.debugLogs.includes("Skip broadcast before hydration ready"),
    true,
  );
});

test("sync controller accepts empty room hydration and clears active shared url", async () => {
  const harness = createControllerHarness();
  harness.runtimeState.activeSharedUrl =
    "https://www.bilibili.com/video/BV1xx411c7mD";
  harness.runtimeState.pendingRoomStateHydration = true;

  await harness.controller.applyRoomState({
    roomCode: "ROOM01",
    sharedVideo: null,
    playback: null,
    members: [],
  });

  assert.equal(harness.runtimeState.activeSharedUrl, null);
  assert.equal(harness.runtimeState.pendingRoomStateHydration, false);
  assert.equal(harness.runtimeState.hasReceivedInitialRoomState, true);
});

test("sync controller schedules hydration retry when room exists but initial room state is still unavailable", async () => {
  const windowHarness = installWindowStub();
  const harness = createControllerHarness();
  harness.runtimeState.activeRoomCode = "ROOM02";

  harness.controller = createSyncController({
    runtimeState: harness.runtimeState,
    lastAppliedVersionByActor: new Map(),
    broadcastLogState: { key: null, at: 0 },
    ignoredSelfPlaybackLogState: { key: null, at: 0 },
    localIntentGuardMs: 500,
    pauseHoldMs: 1_000,
    initialRoomStatePauseHoldMs: 1_500,
    remoteEchoSuppressionMs: 800,
    remotePlayTransitionGuardMs: 500,
    remoteFollowPlayingWindowMs: 3_000,
    programmaticApplyWindowMs: 700,
    userGestureGraceMs: 300,
    nextSeq: () => 1,
    markBroadcastAt: () => {},
    getNow: () => 10_000,
    debugLog: (message) => {
      harness.debugLogs.push(message);
    },
    shouldLogHeartbeat: () => true,
    runtimeSendMessage: async () => ({
      memberId: "member-2",
      roomCode: "ROOM02",
    }),
    getHydrateRetryTimer: () => harness.hydrateRetryTimer,
    setHydrateRetryTimer: (_timer) => {},
    getVideoElement: () => null,
    getCurrentPlaybackVideo: async () => null,
    getSharedVideo: () => null,
    normalizeUrl: (url) => url?.trim() ?? null,
    notifyRoomStateToasts: () => {},
    maybeShowSharedVideoToast: () => {},
  });

  try {
    await harness.controller.hydrateRoomState();

    assert.equal(windowHarness.scheduled.length, 1);
    assert.equal(
      harness.debugLogs.some((message) =>
        message.includes("Hydrate pending for ROOM02"),
      ),
      true,
    );
    assert.equal(harness.runtimeState.hydrationReady, false);
  } finally {
    windowHarness.restore();
  }
});

test("sync controller suppresses follow-up local broadcast after applying a late remote playback state", async () => {
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: false,
    currentTime: 24.1,
  });

  harness.runtimeState.hydrationReady = true;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  await harness.controller.applyRoomState(
    createRoomState({
      actorId: "remote-member",
      seq: 8,
      serverTime: 19_900,
      currentTime: 24,
      playState: "playing",
    }),
  );

  harness.setNow(22_050);
  await harness.controller.broadcastPlayback(video, "timeupdate");

  assert.equal(harness.runtimeMessages.length, 0);
  assert.equal(harness.runtimeState.remoteFollowPlayingUntil > 22_050, true);
});

test("sync controller uses rate-only reconcile for medium playing drift", async () => {
  const windowHarness = installWindowStub();
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: false,
    currentTime: 24,
    playbackRate: 1,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  try {
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 10,
        serverTime: 19_900,
        currentTime: 24.8,
        playState: "playing",
        playbackRate: 1,
      }),
    );

    assert.ok(Math.abs(video.currentTime - 24) < 0.001);
    assert.ok(Math.abs(video.playbackRate - 1.12) < 0.001);
    assert.equal(
      harness.debugLogs.some(
        (message) =>
          message.includes("Playback reconcile") &&
          message.includes("mode=rate-only") &&
          message.includes("wroteTime=false") &&
          message.includes("wroteRate=true"),
      ),
      true,
    );
    // The rate bump must register a self-restoring session so the elevated
    // catch-up rate cannot persist when no corrective remote update follows.
    assert.equal(
      harness.debugLogs.some((message) =>
        message.includes("Started soft apply"),
      ),
      true,
    );

    // Reaching the stale snapshot target must NOT restore the base rate early:
    // the remote head keeps advancing, so converging on the old target would
    // leave residual drift. The drift (0.8s) at a 0.12x offset needs ~6.7s to
    // close, well beyond the moment the playhead passes the snapshot target.
    video.currentTime = 24.8;
    harness.setNow(20_500);
    harness.controller.maintainActiveSoftApply(video);
    assert.ok(Math.abs(video.playbackRate - 1.12) < 0.001);

    // Once enough real time has elapsed for the rate offset to absorb the drift,
    // the base rate is restored instead of running ahead forever.
    harness.setNow(27_500);
    harness.controller.maintainActiveSoftApply(video);
    assert.ok(Math.abs(video.playbackRate - 1) < 0.001);
    assert.equal(
      harness.debugLogs.some(
        (message) =>
          message.includes("Cancelled soft apply") &&
          message.includes("result=drift-closed"),
      ),
      true,
    );
    // A rate-only catch-up must NOT arm the soft-apply cooldown, otherwise the
    // next genuine remote reconcile would be suppressed and the residual drift
    // would persist.
    assert.equal(harness.runtimeState.softApplyCooldownUntil, 0);
  } finally {
    windowHarness.restore();
  }
});

test("sync controller does not downgrade explicit seek under rate-only thresholds", async () => {
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: false,
    currentTime: 24,
    playbackRate: 1,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  await harness.controller.applyRoomState(
    createRoomState({
      actorId: "remote-member",
      seq: 10,
      serverTime: 19_900,
      currentTime: 24.8,
      playState: "playing",
      playbackRate: 1,
      syncIntent: "explicit-seek",
    }),
  );

  assert.ok(Math.abs(video.currentTime - 24.8) < 0.001);
  assert.equal(
    harness.debugLogs.some(
      (message) =>
        message.includes("Playback reconcile") &&
        message.includes("mode=hard-seek") &&
        message.includes("reason=explicit-seek"),
    ),
    true,
  );
});

test("sync controller logs reconcile decisions for soft apply and ignore paths", async () => {
  const windowHarness = installWindowStub();
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: false,
    currentTime: 24,
    playbackRate: 1,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  try {
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 10,
        serverTime: 19_900,
        currentTime: 25.1,
        playState: "playing",
        playbackRate: 1,
      }),
    );

    video.currentTime = 25;
    harness.controller.maintainActiveSoftApply(video);

    video.currentTime = 24.92;
    harness.setNow(22_000);
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 11,
        serverTime: 21_900,
        currentTime: 25.05,
        playState: "playing",
        playbackRate: 1,
      }),
    );

    assert.equal(
      harness.debugLogs.some(
        (message) =>
          message.includes("Playback reconcile") &&
          message.includes("mode=soft-apply") &&
          message.includes("wroteTime=true") &&
          message.includes("wroteRate=true"),
      ),
      true,
    );
    assert.equal(
      harness.debugLogs.some(
        (message) =>
          message.includes("Ignored remote playback") &&
          message.includes("result=within-threshold-noop"),
      ),
      true,
    );
  } finally {
    windowHarness.restore();
  }
});

test("sync controller suppresses the waiting event chain triggered by soft apply", async () => {
  const windowHarness = installWindowStub();
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: false,
    readyState: 2,
    currentTime: 24,
    playbackRate: 1,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);

  try {
    harness.setNow(20_000);
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 10,
        serverTime: 19_900,
        currentTime: 25.1,
        playState: "playing",
        playbackRate: 1,
      }),
    );

    harness.setNow(20_050);
    await harness.controller.broadcastPlayback(video, "waiting");

    assert.equal(harness.runtimeMessages.length, 0);
    assert.equal(
      harness.debugLogs.some(
        (message) =>
          message.includes("Skip broadcast") &&
          message.includes("result=programmatic-waiting"),
      ),
      true,
    );
  } finally {
    windowHarness.restore();
  }
});

test("sync controller keeps the remote follow window through buffering and suppresses the later playing event", async () => {
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: false,
    readyState: 2,
    currentTime: 24.05,
  });

  harness.runtimeState.hydrationReady = true;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  await harness.controller.applyRoomState(
    createRoomState({
      actorId: "remote-member",
      seq: 8,
      serverTime: 19_900,
      currentTime: 24,
      playState: "playing",
    }),
  );

  harness.setNow(20_100);
  await harness.controller.broadcastPlayback(video, "waiting");

  video.readyState = 4;
  harness.setNow(20_900);
  await harness.controller.broadcastPlayback(video, "playing");

  assert.equal(harness.runtimeMessages.length, 0);
  assert.equal(harness.runtimeState.remoteFollowPlayingUntil > 20_900, true);
});

test("sync controller does not force-pause local playback after remote buffering", async () => {
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  let pauseCalls = 0;
  const video = createVideo({
    paused: false,
    readyState: 4,
    currentTime: 24.04,
    pause() {
      pauseCalls += 1;
    },
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.hasReceivedInitialRoomState = true;
  harness.runtimeState.localMemberId = "local-member";
  harness.runtimeState.activeRoomCode = "ROOM01";
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  await harness.controller.applyRoomState(
    createRoomState({
      actorId: "remote-member",
      seq: 8,
      serverTime: 19_900,
      currentTime: 24,
      playState: "buffering",
    }),
  );

  assert.equal(pauseCalls, 0);
  assert.equal(harness.runtimeState.intendedPlayState, "buffering");

  harness.setNow(20_050);
  await harness.controller.broadcastPlayback(video, "timeupdate");

  assert.equal(pauseCalls, 0);
  assert.notEqual(harness.runtimeState.intendedPlayState, "paused");
  assert.equal(
    harness.debugLogs.some((message) => message.includes("remote-stop-hold")),
    false,
  );
});

test("sync controller allows explicit user seek inside the silence window", async () => {
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: false,
    currentTime: 36.1,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.localMemberId = "local-member";
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  await harness.controller.applyRoomState(
    createRoomState({
      actorId: "remote-member",
      seq: 9,
      serverTime: 19_950,
      currentTime: 36,
      playState: "playing",
    }),
  );

  harness.runtimeState.lastExplicitUserAction = {
    kind: "seek",
    at: 21_950,
  };

  harness.setNow(22_000);
  await harness.controller.broadcastPlayback(video, "seeked");

  assert.equal(harness.runtimeMessages.length, 1);
  assert.deepEqual(harness.runtimeMessages[0], {
    type: "content:playback-update",
    payload: {
      url: sharedVideo.url,
      currentTime: 36.1,
      playState: "playing",
      syncIntent: "explicit-seek",
      playbackRate: 1,
      updatedAt: 22_000,
      serverTime: 0,
      actorId: "local-member",
      seq: 1,
    },
  });
  assert.equal(
    harness.debugLogs.some((message) =>
      message.includes("Allowed explicit user event"),
    ),
    true,
  );
});

test("sync controller does not treat a seek as explicit after a forced pause invalidates it", async () => {
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: true,
    currentTime: 30,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.localMemberId = "local-member";
  harness.runtimeState.lastExplicitUserAction = {
    kind: "seek",
    at: 21_950,
  };
  harness.runtimeState.lastForcedPauseAt = 21_975;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);

  harness.setNow(22_000);
  await harness.controller.broadcastPlayback(video, "seeked");

  assert.equal(harness.runtimeMessages.length, 1);
  assert.deepEqual(harness.runtimeMessages[0], {
    type: "content:playback-update",
    payload: {
      url: sharedVideo.url,
      currentTime: 30,
      playState: "paused",
      syncIntent: undefined,
      playbackRate: 1,
      updatedAt: 22_000,
      serverTime: 0,
      actorId: "local-member",
      seq: 1,
    },
  });
  assert.equal(
    harness.debugLogs.some((message) =>
      message.includes("Allowed explicit user event"),
    ),
    false,
  );
});

test("sync controller marks explicit user ratechange with explicit-ratechange intent", async () => {
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: false,
    currentTime: 36.1,
    playbackRate: 1.5,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.localMemberId = "local-member";
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.runtimeState.lastExplicitUserAction = {
    kind: "ratechange",
    at: 21_950,
  };

  harness.setNow(22_000);
  await harness.controller.broadcastPlayback(video, "ratechange");

  assert.equal(harness.runtimeMessages.length, 1);
  assert.deepEqual(harness.runtimeMessages[0], {
    type: "content:playback-update",
    payload: {
      url: sharedVideo.url,
      currentTime: 36.1,
      playState: "playing",
      syncIntent: "explicit-ratechange",
      playbackRate: 1.5,
      updatedAt: 22_000,
      serverTime: 0,
      actorId: "local-member",
      seq: 1,
    },
  });
});

test("sync controller ignores remote explicit seek while local explicit seek is still pending", async () => {
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: false,
    currentTime: 50.88,
    playbackRate: 1,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.localMemberId = "local-member";
  harness.runtimeState.activeSharedUrl = sharedVideo.url;
  harness.runtimeState.pendingLocalPlaybackOverride = {
    kind: "seek",
    url: sharedVideo.url,
    targetTime: 50.88,
    seq: 52,
    expiresAt: 25_000,
  };
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(23_500);

  await harness.controller.applyRoomState(
    createRoomState({
      actorId: "remote-member",
      seq: 75,
      serverTime: 23_400,
      currentTime: 250.75,
      playState: "playing",
      playbackRate: 1,
      syncIntent: "explicit-seek",
    }),
  );

  assert.notEqual(harness.runtimeState.pendingLocalPlaybackOverride, null);
  assert.equal(
    harness.debugLogs.some((message) =>
      message.includes("result=pending-local-explicit-seek"),
    ),
    true,
  );
  assert.equal(
    harness.debugLogs.some((message) =>
      message.includes("reason=incoming-explicit-seek"),
    ),
    false,
  );
  assert.equal(
    harness.debugLogs.some((message) => message.includes("Apply playback")),
    false,
  );
});

test("sync controller suppresses repeated apply during the soft-apply cooldown window", async () => {
  const windowHarness = installWindowStub();
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: false,
    currentTime: 24,
    playbackRate: 1,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);

  try {
    harness.setNow(20_000);
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 10,
        serverTime: 19_900,
        currentTime: 25.1,
        playState: "playing",
        playbackRate: 1,
      }),
    );

    assert.ok(Math.abs(video.currentTime - 24.4) < 0.001);
    assert.ok(Math.abs(video.playbackRate - 1.12) < 0.001);

    video.currentTime = 25;
    harness.controller.maintainActiveSoftApply(video);
    assert.ok(Math.abs(video.playbackRate - 1) < 0.001);
    assert.equal(harness.runtimeState.softApplyCooldownUntil > 20_000, true);

    harness.setNow(22_000);
    video.currentTime = 26;
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 11,
        serverTime: 21_900,
        currentTime: 27.1,
        playState: "playing",
        playbackRate: 1,
      }),
    );

    assert.ok(Math.abs(video.currentTime - 26) < 0.001);
    assert.ok(Math.abs(video.playbackRate - 1) < 0.001);

    const startedSoftApplyLogs = harness.debugLogs.filter((message) =>
      message.includes("Started soft apply"),
    );
    assert.equal(startedSoftApplyLogs.length, 1);
    assert.equal(
      harness.debugLogs.some(
        (message) =>
          message.includes("Cancelled soft apply") &&
          message.includes("result=converged"),
      ),
      true,
    );
    assert.equal(
      harness.debugLogs.some(
        (message) =>
          message.includes("Ignored remote playback") &&
          message.includes("result=cooldown-suppress"),
      ),
      true,
    );
  } finally {
    windowHarness.restore();
  }
});

test("sync controller does not arm cooldown when soft apply times out", async () => {
  const windowHarness = installWindowStub();
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: false,
    currentTime: 24,
    playbackRate: 1,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);

  try {
    harness.setNow(20_000);
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 10,
        serverTime: 19_900,
        currentTime: 25.1,
        playState: "playing",
        playbackRate: 1,
      }),
    );

    harness.setNow(22_500);
    harness.controller.maintainActiveSoftApply(video);

    assert.equal(harness.runtimeState.softApplyCooldownUntil, 0);
    assert.equal(harness.runtimeState.softApplyCooldownUrl, null);
    assert.ok(Math.abs(video.playbackRate - 1) < 0.001);

    harness.setNow(22_600);
    video.currentTime = 26;
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 11,
        serverTime: 22_500,
        currentTime: 27.1,
        playState: "playing",
        playbackRate: 1,
      }),
    );

    assert.ok(Math.abs(video.currentTime - 26.4) < 0.001);
    assert.ok(Math.abs(video.playbackRate - 1.12) < 0.001);
    assert.equal(
      harness.debugLogs.some(
        (message) =>
          message.includes("Ignored remote playback") &&
          message.includes("result=cooldown-suppress"),
      ),
      false,
    );
    assert.equal(
      harness.debugLogs.filter((message) =>
        message.includes("Started soft apply"),
      ).length,
      2,
    );
  } finally {
    windowHarness.restore();
  }
});

test("sync controller cooldown still allows remote pause and resume control", async () => {
  const windowHarness = installWindowStub();
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  let pauseCalls = 0;
  let playCalls = 0;
  const video = createVideo({
    paused: false,
    currentTime: 24,
    playbackRate: 1,
  });
  video.pause = () => {
    pauseCalls += 1;
    video.paused = true;
  };
  video.play = async () => {
    playCalls += 1;
    video.paused = false;
  };

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);

  try {
    harness.setNow(20_000);
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 10,
        serverTime: 19_900,
        currentTime: 25.1,
        playState: "playing",
        playbackRate: 1,
      }),
    );

    video.currentTime = 25;
    harness.controller.maintainActiveSoftApply(video);
    assert.equal(harness.runtimeState.softApplyCooldownUntil > 20_000, true);
    pauseCalls = 0;
    playCalls = 0;

    harness.setNow(21_000);
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 11,
        serverTime: 20_900,
        currentTime: 25.1,
        playState: "paused",
        playbackRate: 1,
      }),
    );

    assert.equal(pauseCalls, 1);
    assert.equal(video.paused, true);

    harness.setNow(21_500);
    video.currentTime = 25.1;
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 12,
        serverTime: 21_400,
        currentTime: 25.7,
        playState: "playing",
        playbackRate: 1,
      }),
    );

    assert.equal(playCalls, 1);
    assert.equal(video.paused, false);
    assert.equal(
      harness.debugLogs.some((message) =>
        message.includes("result=cooldown-suppress"),
      ),
      false,
    );
  } finally {
    windowHarness.restore();
  }
});

test("sync controller cooldown does not suppress explicit seek or explicit ratechange", async () => {
  const windowHarness = installWindowStub();
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: false,
    currentTime: 24,
    playbackRate: 1,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);

  try {
    harness.setNow(20_000);
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 10,
        serverTime: 19_900,
        currentTime: 25.1,
        playState: "playing",
        playbackRate: 1,
      }),
    );

    video.currentTime = 25;
    harness.controller.maintainActiveSoftApply(video);
    assert.equal(harness.runtimeState.softApplyCooldownUntil > 20_000, true);

    harness.setNow(21_000);
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 11,
        serverTime: 20_900,
        currentTime: 40,
        playState: "playing",
        playbackRate: 1,
        syncIntent: "explicit-seek",
      }),
    );

    assert.ok(Math.abs(video.currentTime - 40) < 0.001);

    harness.setNow(21_500);
    video.currentTime = 40;
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 12,
        serverTime: 21_400,
        currentTime: 40.2,
        playState: "playing",
        playbackRate: 1.5,
        syncIntent: "explicit-ratechange",
      }),
    );

    assert.ok(Math.abs(video.playbackRate - 1.5) < 0.001);
    assert.equal(
      harness.debugLogs.some((message) =>
        message.includes("result=cooldown-suppress"),
      ),
      false,
    );
  } finally {
    windowHarness.restore();
  }
});

test("sync controller avoids repeated correction loops after a short 2x buffer", async () => {
  const windowHarness = installWindowStub();
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: false,
    currentTime: 24,
    playbackRate: 2,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);

  try {
    harness.setNow(20_000);
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 10,
        serverTime: 19_900,
        currentTime: 25.7,
        playState: "playing",
        playbackRate: 2,
      }),
    );

    assert.ok(video.currentTime > 24);
    assert.ok(video.currentTime < 24.4);
    assert.ok(video.playbackRate > 2.1);

    video.currentTime = 25.58;
    harness.controller.maintainActiveSoftApply(video);
    assert.ok(Math.abs(video.playbackRate - 2) < 0.001);
    assert.equal(harness.runtimeState.softApplyCooldownUntil > 20_000, true);

    harness.setNow(21_500);
    video.currentTime = 26.6;
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 11,
        serverTime: 21_400,
        currentTime: 27.9,
        playState: "playing",
        playbackRate: 2,
      }),
    );

    assert.ok(Math.abs(video.currentTime - 26.6) < 0.001);
    assert.ok(Math.abs(video.playbackRate - 2) < 0.001);
    assert.equal(
      harness.debugLogs.filter((message) =>
        message.includes("Started soft apply"),
      ).length,
      1,
    );
    assert.equal(
      harness.debugLogs.some((message) =>
        message.includes("result=cooldown-suppress"),
      ),
      true,
    );
  } finally {
    windowHarness.restore();
  }
});

test("sync controller blocks broadcast while post-navigation anchor still matches resolved url", async () => {
  const harness = createControllerHarness();
  const anchorUrl = "https://www.bilibili.com/bangumi/play/ep1231523";
  const sharedVideo: SharedVideo = {
    videoId: "ep1231523",
    url: anchorUrl,
    title: "Episode 1",
  };
  const video = createVideo({ paused: true, currentTime: 0.22 });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.activeRoomCode = "ROOM01";
  harness.runtimeState.activeSharedUrl = anchorUrl;
  harness.runtimeState.postNavigationAnchorSharedUrl = anchorUrl;
  harness.runtimeState.postNavigationAnchorSetAt = 19_000;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  await harness.controller.broadcastPlayback(video, "play");

  assert.equal(harness.runtimeMessages.length, 0);
  assert.equal(
    harness.runtimeState.postNavigationAnchorSharedUrl,
    anchorUrl,
    "anchor must remain set while resolved url matches it",
  );
  assert.equal(
    harness.debugLogs.some(
      (message) =>
        message.includes("post-navigation-stale-url") ||
        message.includes("result=post-navigation-stale-url"),
    ),
    true,
  );
});

test("sync controller releases post-navigation anchor after settle timeout for equivalent route", async () => {
  const harness = createControllerHarness();
  const anchorUrl = "https://www.bilibili.com/bangumi/play/ep1231523";
  const sharedVideo: SharedVideo = {
    videoId: "ep1231523",
    url: anchorUrl,
    title: "Episode 1",
  };
  const video = createVideo({ paused: false, currentTime: 8 });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.activeRoomCode = "ROOM01";
  harness.runtimeState.activeSharedUrl = anchorUrl;
  harness.runtimeState.postNavigationAnchorSharedUrl = anchorUrl;
  harness.runtimeState.postNavigationAnchorSetAt = 18_500;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  await harness.controller.broadcastPlayback(video, "play");

  assert.equal(harness.runtimeState.postNavigationAnchorSharedUrl, null);
  assert.equal(harness.runtimeMessages.length >= 1, true);
  assert.equal(
    harness.debugLogs.some((message) =>
      message.includes("Cleared post-navigation settle anchor after timeout"),
    ),
    true,
  );
});

test("sync controller releases post-navigation anchor and broadcasts once resolved url moves off it", async () => {
  const harness = createControllerHarness();
  const anchorUrl = "https://www.bilibili.com/bangumi/play/ep1231523";
  const newUrl = "https://www.bilibili.com/bangumi/play/ep1231525";
  const newSharedVideo: SharedVideo = {
    videoId: "ep1231525",
    url: newUrl,
    title: "Episode 1 - 新番剧",
  };
  const video = createVideo({ paused: false, currentTime: 5 });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.activeRoomCode = "ROOM01";
  harness.runtimeState.activeSharedUrl = newUrl;
  harness.runtimeState.postNavigationAnchorSharedUrl = anchorUrl;
  harness.runtimeState.postNavigationAnchorSetAt = 20_000;
  harness.setSharedVideo(newSharedVideo);
  harness.setCurrentPlaybackVideo(newSharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  await harness.controller.broadcastPlayback(video, "play");

  assert.equal(harness.runtimeState.postNavigationAnchorSharedUrl, null);
  assert.equal(
    harness.runtimeMessages.length >= 1,
    true,
    "broadcast should proceed once resolved url differs from the anchor",
  );
});

test("sync controller suppresses broadcast while sharer end-of-video marker matches the shared url", async () => {
  const harness = createControllerHarness();
  const sharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  const sharedVideo: SharedVideo = {
    videoId: "BVshared:p1",
    url: sharedUrl,
    title: "Shared Video",
  };
  const video = createVideo({ paused: false, currentTime: 0 });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.activeRoomCode = "ROOM01";
  harness.runtimeState.activeSharedUrl = sharedUrl;
  harness.runtimeState.localMemberId = "local-member";
  harness.runtimeState.activeSharedByMemberId = "local-member";
  harness.runtimeState.sharerEndedSuppressionUrl = sharedUrl;
  harness.runtimeState.sharerEndedSuppressionUntil = 23_000;
  harness.runtimeState.sharerEndedSuppressionArmedAt = 19_000;
  harness.runtimeState.lastUserGestureAt = 0;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  // The natural-end pause for the old shared video must not leak out as a
  // "paused the video" against it during the autoplay-next handoff.
  await harness.controller.broadcastPlayback(video, "pause");

  assert.equal(harness.runtimeMessages.length, 0);
  assert.equal(
    harness.runtimeState.sharerEndedSuppressionUrl,
    sharedUrl,
    "marker must remain set while still suppressing the ended shared url",
  );
  assert.equal(
    harness.debugLogs.some((message) =>
      message.includes("sharer-ended-handoff"),
    ),
    true,
  );
});

test("sync controller releases sharer end-of-video marker after timeout", async () => {
  const harness = createControllerHarness();
  const sharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  const sharedVideo: SharedVideo = {
    videoId: "BVshared:p1",
    url: sharedUrl,
    title: "Shared Video",
  };
  const video = createVideo({ paused: false, currentTime: 0 });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.activeRoomCode = "ROOM01";
  harness.runtimeState.activeSharedUrl = sharedUrl;
  harness.runtimeState.localMemberId = "local-member";
  harness.runtimeState.activeSharedByMemberId = "local-member";
  harness.runtimeState.sharerEndedSuppressionUrl = sharedUrl;
  harness.runtimeState.sharerEndedSuppressionUntil = 19_000;
  harness.runtimeState.sharerEndedSuppressionArmedAt = 16_000;
  harness.runtimeState.lastUserGestureAt = 0;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  await harness.controller.broadcastPlayback(video, "seeked");

  assert.equal(harness.runtimeState.sharerEndedSuppressionUrl, null);
  assert.equal(harness.runtimeState.sharerEndedSuppressionUntil, 0);
  assert.equal(harness.runtimeState.sharerEndedSuppressionArmedAt, 0);
  assert.equal(harness.runtimeMessages.length >= 1, true);
});

test("sync controller releases sharer end-of-video marker on a fresh user replay gesture", async () => {
  const harness = createControllerHarness();
  const sharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  const sharedVideo: SharedVideo = {
    videoId: "BVshared:p1",
    url: sharedUrl,
    title: "Shared Video",
  };
  const video = createVideo({ paused: false, currentTime: 0 });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.activeRoomCode = "ROOM01";
  harness.runtimeState.activeSharedUrl = sharedUrl;
  harness.runtimeState.localMemberId = "local-member";
  harness.runtimeState.activeSharedByMemberId = "local-member";
  harness.runtimeState.sharerEndedSuppressionUrl = sharedUrl;
  harness.runtimeState.sharerEndedSuppressionUntil = 23_000;
  // The suppression was armed before the replay gesture below.
  harness.runtimeState.sharerEndedSuppressionArmedAt = 19_000;
  // The sharer manually replays the ended video within the gesture grace window,
  // and the gesture postdates the arming, so it counts as a fresh replay.
  harness.runtimeState.lastUserGestureAt = 19_900;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  await harness.controller.broadcastPlayback(video, "seeked");

  assert.equal(harness.runtimeState.sharerEndedSuppressionUrl, null);
  assert.equal(harness.runtimeMessages.length >= 1, true);
});

test("sync controller keeps suppressing when a stale gesture predates the end-of-video arming", async () => {
  const harness = createControllerHarness();
  const sharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  const sharedVideo: SharedVideo = {
    videoId: "BVshared:p1",
    url: sharedUrl,
    title: "Shared Video",
  };
  const video = createVideo({ paused: false, currentTime: 0 });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.activeRoomCode = "ROOM01";
  harness.runtimeState.activeSharedUrl = sharedUrl;
  harness.runtimeState.localMemberId = "local-member";
  harness.runtimeState.activeSharedByMemberId = "local-member";
  harness.runtimeState.sharerEndedSuppressionUrl = sharedUrl;
  harness.runtimeState.sharerEndedSuppressionUntil = 23_000;
  // The suppression was armed AFTER the last gesture: the sharer dragged to the
  // end / pressed play moments before the natural end, then the video ended.
  harness.runtimeState.sharerEndedSuppressionArmedAt = 19_950;
  harness.runtimeState.lastUserGestureAt = 19_900;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  // The next-episode seek-to-0 must stay suppressed: the stale gesture is not a
  // replay, so it must not release the marker and leak a "jumped to 0:00".
  await harness.controller.broadcastPlayback(video, "seeked");

  assert.equal(harness.runtimeMessages.length, 0);
  assert.equal(harness.runtimeState.sharerEndedSuppressionUrl, sharedUrl);
});

test("sync controller releases end-of-video suppression once the local member is no longer the sharer", async () => {
  const harness = createControllerHarness();
  const sharedUrl = "https://www.bilibili.com/video/BVshared?p=1";
  const sharedVideo: SharedVideo = {
    videoId: "BVshared:p1",
    url: sharedUrl,
    title: "Shared Video",
  };
  const video = createVideo({ paused: false, currentTime: 5 });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.activeRoomCode = "ROOM01";
  harness.runtimeState.activeSharedUrl = sharedUrl;
  harness.runtimeState.localMemberId = "local-member";
  // Another member re-shared the same URL: the sharer id flips without a URL
  // change, so resetPlaybackSyncState never ran to clear the marker.
  harness.runtimeState.activeSharedByMemberId = "other-member";
  harness.runtimeState.sharerEndedSuppressionUrl = sharedUrl;
  harness.runtimeState.sharerEndedSuppressionUntil = 23_000;
  harness.runtimeState.sharerEndedSuppressionArmedAt = 19_000;
  harness.runtimeState.lastUserGestureAt = 0;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  await harness.controller.broadcastPlayback(video, "seeked");

  assert.equal(harness.runtimeState.sharerEndedSuppressionUrl, null);
  assert.equal(harness.runtimeState.sharerEndedSuppressionUntil, 0);
  assert.equal(harness.runtimeState.sharerEndedSuppressionArmedAt, 0);
  assert.equal(harness.runtimeMessages.length >= 1, true);
});

test("sync controller releases sharer end-of-video marker once the resolved url moves on", async () => {
  const harness = createControllerHarness();
  const oldUrl = "https://www.bilibili.com/video/BVshared?p=1";
  const newUrl = "https://www.bilibili.com/video/BVshared?p=2";
  const newSharedVideo: SharedVideo = {
    videoId: "BVshared:p2",
    url: newUrl,
    title: "Shared Video Part 2",
  };
  const video = createVideo({ paused: false, currentTime: 3 });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.activeRoomCode = "ROOM01";
  // The room has not confirmed the next share yet, so activeSharedUrl is still
  // the old video; the resolved page url already moved to the next episode.
  harness.runtimeState.activeSharedUrl = oldUrl;
  harness.runtimeState.localMemberId = "local-member";
  harness.runtimeState.activeSharedByMemberId = "local-member";
  harness.runtimeState.sharerEndedSuppressionUrl = oldUrl;
  harness.runtimeState.sharerEndedSuppressionUntil = 23_000;
  harness.runtimeState.sharerEndedSuppressionArmedAt = 19_000;
  harness.runtimeState.lastUserGestureAt = 0;
  harness.setSharedVideo(newSharedVideo);
  harness.setCurrentPlaybackVideo(newSharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  await harness.controller.broadcastPlayback(video, "seeked");

  // The marker is released; the broadcast for the new (not-yet-shared) url is
  // then handled by the existing non-shared-video guard, so no message leaks.
  assert.equal(harness.runtimeState.sharerEndedSuppressionUrl, null);
  assert.equal(harness.runtimeState.sharerEndedSuppressionUntil, 0);
});

test("sync controller broadcasts buffering when active pause is classified as buffer", async () => {
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: true,
    readyState: 4,
    currentTime: 40,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.localMemberId = "local-member";
  harness.runtimeState.intendedPlayState = "paused";
  harness.runtimeState.pauseStartedAt = 20_000;
  harness.runtimeState.pauseClassifiedAsBuffer = true;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);

  harness.controller = createSyncController({
    runtimeState: harness.runtimeState,
    lastAppliedVersionByActor: new Map(),
    broadcastLogState: { key: null, at: 0 },
    ignoredSelfPlaybackLogState: { key: null, at: 0 },
    localIntentGuardMs: 500,
    pauseHoldMs: 1_000,
    initialRoomStatePauseHoldMs: 1_500,
    remoteEchoSuppressionMs: 800,
    remotePlayTransitionGuardMs: 500,
    remoteFollowPlayingWindowMs: 3_000,
    programmaticApplyWindowMs: 700,
    userGestureGraceMs: 300,
    bufferPauseUpgradeMs: 1_500,
    remotePauseDebounceMs: 0,
    nextSeq: () => 1,
    markBroadcastAt: () => {},
    getNow: () => 20_400,
    debugLog: (message) => harness.debugLogs.push(message),
    shouldLogHeartbeat: () => true,
    runtimeSendMessage: async (message) => {
      harness.runtimeMessages.push(message);
      return null;
    },
    getVideoElement: () => video,
    getCurrentPlaybackVideo: async () => sharedVideo,
    getSharedVideo: () => sharedVideo,
    normalizeUrl: (url) => url?.trim() ?? null,
    notifyRoomStateToasts: () => {},
    maybeShowSharedVideoToast: () => {},
  });

  await harness.controller.broadcastPlayback(video, "pause");

  assert.equal(harness.runtimeMessages.length, 1);
  const payload = (
    harness.runtimeMessages[0] as { payload: { playState: string } }
  ).payload;
  assert.equal(payload.playState, "buffering");
});

test("sync controller broadcasts paused once buffer-pause upgrade window elapses", async () => {
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: true,
    readyState: 4,
    currentTime: 40,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.localMemberId = "local-member";
  harness.runtimeState.intendedPlayState = "paused";
  harness.runtimeState.pauseStartedAt = 20_000;
  harness.runtimeState.pauseClassifiedAsBuffer = true;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);

  harness.controller = createSyncController({
    runtimeState: harness.runtimeState,
    lastAppliedVersionByActor: new Map(),
    broadcastLogState: { key: null, at: 0 },
    ignoredSelfPlaybackLogState: { key: null, at: 0 },
    localIntentGuardMs: 500,
    pauseHoldMs: 1_000,
    initialRoomStatePauseHoldMs: 1_500,
    remoteEchoSuppressionMs: 800,
    remotePlayTransitionGuardMs: 500,
    remoteFollowPlayingWindowMs: 3_000,
    programmaticApplyWindowMs: 700,
    userGestureGraceMs: 300,
    bufferPauseUpgradeMs: 1_500,
    remotePauseDebounceMs: 0,
    nextSeq: () => 1,
    markBroadcastAt: () => {},
    getNow: () => 21_700, // 1700ms after pauseStartedAt, past upgrade threshold
    debugLog: (message) => harness.debugLogs.push(message),
    shouldLogHeartbeat: () => true,
    runtimeSendMessage: async (message) => {
      harness.runtimeMessages.push(message);
      return null;
    },
    getVideoElement: () => video,
    getCurrentPlaybackVideo: async () => sharedVideo,
    getSharedVideo: () => sharedVideo,
    normalizeUrl: (url) => url?.trim() ?? null,
    notifyRoomStateToasts: () => {},
    maybeShowSharedVideoToast: () => {},
  });

  await harness.controller.broadcastPlayback(video, "pause");

  assert.equal(harness.runtimeMessages.length, 1);
  const payload = (
    harness.runtimeMessages[0] as { payload: { playState: string } }
  ).payload;
  assert.equal(payload.playState, "paused");
});

test("sync controller suppresses local end-pause broadcasts from non-sharer autoplay guard", async () => {
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: true,
    readyState: 4,
    currentTime: 119.7,
    duration: 120,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.activeRoomCode = "ROOM01";
  harness.runtimeState.activeSharedUrl = sharedVideo.url;
  harness.runtimeState.localMemberId = "member-2";
  harness.runtimeState.intendedPlayState = "paused";
  harness.runtimeState.lastForcedPauseAt = 20_000;
  harness.runtimeState.suppressedLocalEndPauseUrl = sharedVideo.url;
  harness.runtimeState.suppressedLocalEndPauseUntil = 21_500;
  harness.setNow(20_100);
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);

  await harness.controller.broadcastPlayback(video, "pause");

  assert.equal(harness.runtimeMessages.length, 0);
  assert.equal(
    harness.debugLogs.some((message) =>
      message.includes("result=local-end-pause-suppress"),
    ),
    true,
  );
});

test("sync controller tags broadcast with userInitiated:true on a fresh user pause", async () => {
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: true,
    readyState: 4,
    currentTime: 40,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.localMemberId = "local-member";
  harness.runtimeState.intendedPlayState = "paused";
  // Fresh user pause gesture: postdates lastForcedPauseAt and well within
  // the gesture grace window.
  harness.runtimeState.lastUserGestureAt = 20_350;
  harness.runtimeState.lastForcedPauseAt = 0;
  harness.runtimeState.lastExplicitUserAction = {
    kind: "pause",
    at: 20_350,
  };
  harness.runtimeState.pauseStartedAt = 20_350;
  harness.runtimeState.pauseClassifiedAsBuffer = false;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);

  harness.controller = createSyncController({
    runtimeState: harness.runtimeState,
    lastAppliedVersionByActor: new Map(),
    broadcastLogState: { key: null, at: 0 },
    ignoredSelfPlaybackLogState: { key: null, at: 0 },
    localIntentGuardMs: 500,
    pauseHoldMs: 1_000,
    initialRoomStatePauseHoldMs: 1_500,
    remoteEchoSuppressionMs: 800,
    remotePlayTransitionGuardMs: 500,
    remoteFollowPlayingWindowMs: 3_000,
    programmaticApplyWindowMs: 700,
    userGestureGraceMs: 300,
    bufferPauseUpgradeMs: 1_500,
    remotePauseDebounceMs: 0,
    nextSeq: () => 1,
    markBroadcastAt: () => {},
    getNow: () => 20_400,
    debugLog: (message) => harness.debugLogs.push(message),
    shouldLogHeartbeat: () => true,
    runtimeSendMessage: async (message) => {
      harness.runtimeMessages.push(message);
      return null;
    },
    getVideoElement: () => video,
    getCurrentPlaybackVideo: async () => sharedVideo,
    getSharedVideo: () => sharedVideo,
    normalizeUrl: (url) => url?.trim() ?? null,
    notifyRoomStateToasts: () => {},
    maybeShowSharedVideoToast: () => {},
  });

  await harness.controller.broadcastPlayback(video, "pause");

  assert.equal(harness.runtimeMessages.length, 1);
  const payload = (
    harness.runtimeMessages[0] as {
      payload: { playState: string; userInitiated?: boolean };
    }
  ).payload;
  assert.equal(payload.playState, "paused");
  assert.equal(payload.userInitiated, true);
});

test("sync controller omits userInitiated when a pause is buffer-induced", async () => {
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: true,
    readyState: 4,
    currentTime: 40,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.localMemberId = "local-member";
  harness.runtimeState.intendedPlayState = "paused";
  harness.runtimeState.pauseStartedAt = 20_000;
  // Mark this pause as buffer-induced: there's no recent user gesture and
  // pauseClassifiedAsBuffer is true → getBroadcastPlayState yields buffering.
  harness.runtimeState.pauseClassifiedAsBuffer = true;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);

  harness.controller = createSyncController({
    runtimeState: harness.runtimeState,
    lastAppliedVersionByActor: new Map(),
    broadcastLogState: { key: null, at: 0 },
    ignoredSelfPlaybackLogState: { key: null, at: 0 },
    localIntentGuardMs: 500,
    pauseHoldMs: 1_000,
    initialRoomStatePauseHoldMs: 1_500,
    remoteEchoSuppressionMs: 800,
    remotePlayTransitionGuardMs: 500,
    remoteFollowPlayingWindowMs: 3_000,
    programmaticApplyWindowMs: 700,
    userGestureGraceMs: 300,
    bufferPauseUpgradeMs: 1_500,
    remotePauseDebounceMs: 0,
    nextSeq: () => 1,
    markBroadcastAt: () => {},
    getNow: () => 20_400,
    debugLog: (message) => harness.debugLogs.push(message),
    shouldLogHeartbeat: () => true,
    runtimeSendMessage: async (message) => {
      harness.runtimeMessages.push(message);
      return null;
    },
    getVideoElement: () => video,
    getCurrentPlaybackVideo: async () => sharedVideo,
    getSharedVideo: () => sharedVideo,
    normalizeUrl: (url) => url?.trim() ?? null,
    notifyRoomStateToasts: () => {},
    maybeShowSharedVideoToast: () => {},
  });

  await harness.controller.broadcastPlayback(video, "pause");

  assert.equal(harness.runtimeMessages.length, 1);
  const payload = (
    harness.runtimeMessages[0] as {
      payload: { playState: string; userInitiated?: boolean };
    }
  ).payload;
  assert.equal(payload.playState, "buffering");
  assert.equal(payload.userInitiated, undefined);
});

test("sync controller omits userInitiated on buffer-pause upgrade re-broadcast", async () => {
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: true,
    readyState: 4,
    currentTime: 40,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.localMemberId = "local-member";
  harness.runtimeState.intendedPlayState = "paused";
  harness.runtimeState.pauseStartedAt = 20_000;
  harness.runtimeState.pauseClassifiedAsBuffer = false; // already upgraded
  // Original gesture, if any, is way past the gesture grace window — the
  // re-broadcast must not be mistaken for a fresh user pause.
  harness.runtimeState.lastExplicitUserAction = {
    kind: "pause",
    at: 19_900,
  };
  harness.runtimeState.lastUserGestureAt = 19_900;
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);

  harness.controller = createSyncController({
    runtimeState: harness.runtimeState,
    lastAppliedVersionByActor: new Map(),
    broadcastLogState: { key: null, at: 0 },
    ignoredSelfPlaybackLogState: { key: null, at: 0 },
    localIntentGuardMs: 500,
    pauseHoldMs: 1_000,
    initialRoomStatePauseHoldMs: 1_500,
    remoteEchoSuppressionMs: 800,
    remotePlayTransitionGuardMs: 500,
    remoteFollowPlayingWindowMs: 3_000,
    programmaticApplyWindowMs: 700,
    userGestureGraceMs: 300,
    bufferPauseUpgradeMs: 1_500,
    remotePauseDebounceMs: 0,
    nextSeq: () => 1,
    markBroadcastAt: () => {},
    getNow: () => 21_700,
    debugLog: (message) => harness.debugLogs.push(message),
    shouldLogHeartbeat: () => true,
    runtimeSendMessage: async (message) => {
      harness.runtimeMessages.push(message);
      return null;
    },
    getVideoElement: () => video,
    getCurrentPlaybackVideo: async () => sharedVideo,
    getSharedVideo: () => sharedVideo,
    normalizeUrl: (url) => url?.trim() ?? null,
    notifyRoomStateToasts: () => {},
    maybeShowSharedVideoToast: () => {},
  });

  await harness.controller.broadcastPlayback(video, "pause");

  assert.equal(harness.runtimeMessages.length, 1);
  const payload = (
    harness.runtimeMessages[0] as {
      payload: { playState: string; userInitiated?: boolean };
    }
  ).payload;
  assert.equal(payload.playState, "paused");
  assert.equal(payload.userInitiated, undefined);
});

test("sync controller keeps non-shared authorization on reset while still on that local video", () => {
  const harness = createControllerHarness();
  const localUrl = "https://www.bilibili.com/video/BVlocal?p=1";
  harness.setSharedVideo({
    videoId: "BVlocal:p1",
    url: localUrl,
    title: "Local Video",
  });
  harness.runtimeState.explicitNonSharedPlaybackUrl = localUrl;
  harness.runtimeState.nonSharerAutoplayHoldUrl = localUrl;

  // A remote member switches the room's shared video while the user is still
  // watching their manually-started local video. Its authorization must survive,
  // otherwise the periodic load-pause guard would re-pause an active local watch.
  harness.controller.resetPlaybackSyncState("shared url changed");

  assert.equal(harness.runtimeState.explicitNonSharedPlaybackUrl, localUrl);
});

test("sync controller clears non-shared authorization on reset when no longer on that video", () => {
  const harness = createControllerHarness();
  harness.setSharedVideo({
    videoId: "BVcurrent:p1",
    url: "https://www.bilibili.com/video/BVcurrent?p=1",
    title: "Current Video",
  });
  // The user left the previously-authorized local video, so the stale
  // authorization for a different URL is cleared by the reset.
  harness.runtimeState.explicitNonSharedPlaybackUrl =
    "https://www.bilibili.com/video/BVother?p=1";
  harness.runtimeState.nonSharerAutoplayHoldUrl =
    "https://www.bilibili.com/video/BVother?p=1";

  harness.controller.resetPlaybackSyncState("shared url changed");

  assert.equal(harness.runtimeState.explicitNonSharedPlaybackUrl, null);
  assert.equal(harness.runtimeState.nonSharerAutoplayHoldUrl, null);
});

test("sync controller abandons a rate-only catch-up to broadcast a real stall with the base rate", async () => {
  const windowHarness = installWindowStub();
  const harness = createControllerHarness();
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  const video = createVideo({
    paused: false,
    readyState: 4,
    currentTime: 24,
    playbackRate: 1,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.hasReceivedInitialRoomState = true;
  harness.runtimeState.localMemberId = "local-member";
  harness.setSharedVideo(sharedVideo);
  harness.setCurrentPlaybackVideo(sharedVideo);
  harness.setVideoElement(video);
  harness.setNow(20_000);

  try {
    // A medium drift registers a pure rate-only catch-up (rate bumped to 1.12)
    // and arms the remote-follow window by following the remote playing state.
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 10,
        serverTime: 19_900,
        currentTime: 24.8,
        playState: "playing",
        playbackRate: 1,
      }),
    );
    assert.ok(Math.abs(video.playbackRate - 1.12) < 0.001);

    // A genuine stall interrupts the catch-up after the 700ms programmatic
    // window (so it is not mistaken for the rate-apply echo) but well within the
    // ~6.7s relative-drift window and the 3s remote-follow window.
    harness.setNow(21_000);
    video.readyState = 2;
    await harness.controller.broadcastPlayback(video, "waiting");

    assert.equal(harness.runtimeMessages.length, 1);
    const payload = (
      harness.runtimeMessages[0] as {
        payload: { playState: string; playbackRate: number };
      }
    ).payload;
    // The real buffering reaches peers, carrying the base rate (not 1.12), and
    // the catch-up is abandoned (rate restored, no rate-suppress).
    assert.equal(payload.playState, "buffering");
    assert.ok(
      Math.abs(payload.playbackRate - 1) < 0.001,
      `expected base rate in payload, got ${payload.playbackRate}`,
    );
    assert.ok(Math.abs(video.playbackRate - 1) < 0.001);
    assert.equal(
      harness.debugLogs.some((message) =>
        message.includes("Abandoned rate-only catch-up"),
      ),
      true,
    );
    assert.equal(harness.runtimeState.softApplyCooldownUntil, 0);
  } finally {
    windowHarness.restore();
  }
});

test("programmatic apply signature stores the normalized url for mismatched (festival) shares", async () => {
  const windowHarness = installWindowStub();
  const harness = createControllerHarness();
  // A festival/watchlater-style share whose raw url normalizes to /video/...
  const rawUrl = "https://www.bilibili.com/festival/x?bvid=BV1xx411c7mD&cid=2";
  const normalizedUrl = "https://www.bilibili.com/video/BV1xx411c7mD";
  const normalizeUrl = (url: string | undefined | null) =>
    url == null
      ? null
      : url.includes("bvid=BV1xx411c7mD")
        ? normalizedUrl
        : url;
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: rawUrl,
    title: "Video",
  };
  const video = createVideo({
    paused: false,
    readyState: 4,
    currentTime: 24,
    playbackRate: 1,
  });

  harness.runtimeState.hydrationReady = true;
  harness.runtimeState.pendingRoomStateHydration = false;
  harness.runtimeState.hasReceivedInitialRoomState = true;
  harness.runtimeState.localMemberId = "local-member";

  harness.controller = createSyncController({
    runtimeState: harness.runtimeState,
    lastAppliedVersionByActor: new Map(),
    broadcastLogState: { key: null, at: 0 },
    ignoredSelfPlaybackLogState: { key: null, at: 0 },
    localIntentGuardMs: 500,
    pauseHoldMs: 1_000,
    initialRoomStatePauseHoldMs: 1_500,
    remoteEchoSuppressionMs: 800,
    remotePlayTransitionGuardMs: 500,
    remoteFollowPlayingWindowMs: 3_000,
    programmaticApplyWindowMs: 700,
    userGestureGraceMs: 300,
    bufferPauseUpgradeMs: 1_500,
    remotePauseDebounceMs: 0,
    nextSeq: () => 1,
    markBroadcastAt: () => {},
    getNow: () => 20_000,
    debugLog: (message) => harness.debugLogs.push(message),
    shouldLogHeartbeat: () => true,
    runtimeSendMessage: async (message) => {
      harness.runtimeMessages.push(message);
      return null;
    },
    getHydrateRetryTimer: () => null,
    setHydrateRetryTimer: () => {},
    getVideoElement: () => video,
    getCurrentPlaybackVideo: async () => sharedVideo,
    getSharedVideo: () => sharedVideo,
    normalizeUrl,
    notifyRoomStateToasts: () => {},
    maybeShowSharedVideoToast: () => {},
  });

  try {
    await harness.controller.applyRoomState({
      roomCode: "ROOM01",
      sharedVideo,
      playback: {
        url: rawUrl,
        currentTime: 24.8,
        playState: "playing",
        playbackRate: 1,
        updatedAt: 1,
        serverTime: 19_900,
        actorId: "remote-member",
        seq: 10,
      },
      members: [],
    });

    // The armed signature must carry the normalized url, so our own programmatic
    // rate/seek echoes are not misclassified as genuine user actions.
    assert.equal(
      harness.runtimeState.programmaticApplySignature?.url,
      normalizedUrl,
    );
  } finally {
    windowHarness.restore();
  }
});
