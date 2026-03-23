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
        currentTime: 24.8,
        playState: "playing",
        playbackRate: 1,
      }),
    );

    video.currentTime = 24.78;
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
        currentTime: 24.8,
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

test("sync controller reproduces repeated soft apply after heartbeat-driven convergence", async () => {
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
        currentTime: 24.8,
        playState: "playing",
        playbackRate: 1,
      }),
    );

    assert.ok(Math.abs(video.currentTime - 24.48) < 0.001);
    assert.ok(Math.abs(video.playbackRate - 1.12) < 0.001);

    video.currentTime = 24.66;
    harness.controller.maintainActiveSoftApply(video);
    assert.ok(Math.abs(video.playbackRate - 1) < 0.001);

    harness.setNow(22_000);
    video.currentTime = 26;
    await harness.controller.applyRoomState(
      createRoomState({
        actorId: "remote-member",
        seq: 11,
        serverTime: 21_900,
        currentTime: 26.7,
        playState: "playing",
        playbackRate: 1,
      }),
    );

    assert.ok(Math.abs(video.currentTime - 26.42) < 0.001);
    assert.ok(Math.abs(video.playbackRate - 1.12) < 0.001);

    const startedSoftApplyLogs = harness.debugLogs.filter((message) =>
      message.includes("Started soft apply"),
    );
    assert.equal(startedSoftApplyLogs.length, 2);
    assert.equal(
      harness.debugLogs.some(
        (message) =>
          message.includes("Cancelled soft apply") &&
          message.includes("result=converged"),
      ),
      true,
    );
    assert.equal(
      harness.debugLogs.some((message) =>
        message.includes("Programmatic apply window armed"),
      ),
      true,
    );
  } finally {
    windowHarness.restore();
  }
});
