import assert from "node:assert/strict";
import test from "node:test";
import type { RoomState } from "@bili-syncplay/protocol";
import { createContentRuntimeState } from "../src/content/runtime-state";
import { createRoomStateApplyController } from "../src/content/room-state-apply-controller";

function createEmptyRoomState(roomCode = "ROOM01"): RoomState {
  return {
    roomCode,
    sharedVideo: null,
    playback: null,
    members: [],
  };
}

function createStubVideo(paused: boolean) {
  return {
    paused,
    currentTime: 10,
    playbackRate: 1,
    pause() {
      this.paused = true;
    },
  } as unknown as HTMLVideoElement;
}

function createController(overrides: {
  runtimeState?: ReturnType<typeof createContentRuntimeState>;
  video?: HTMLVideoElement | null;
  now?: number;
  userGestureGraceMs?: number;
}) {
  const runtimeState = overrides.runtimeState ?? createContentRuntimeState();
  const video = overrides.video ?? null;
  let _pauseHoldActivated = false;
  let _acceptedHydration = false;
  const logs: string[] = [];

  const controller = createRoomStateApplyController({
    runtimeState,
    lastAppliedVersionByActor: new Map(),
    ignoredSelfPlaybackLogState: { key: null, at: 0 },
    localIntentGuardMs: 1_200,
    pauseHoldMs: 800,
    initialRoomStatePauseHoldMs: 3_000,
    userGestureGraceMs: overrides.userGestureGraceMs ?? 1_200,
    getNow: () => overrides.now ?? 10_000,
    debugLog: (msg) => logs.push(msg),
    shouldLogHeartbeat: () => true,
    runtimeSendMessage: async () => null,
    getHydrateRetryTimer: () => null,
    setHydrateRetryTimer: () => {},
    getVideoElement: () => video,
    getSharedVideo: () => null,
    normalizeUrl: (url) => url ?? null,
    notifyRoomStateToasts: () => {},
    maybeShowSharedVideoToast: () => {},
    cancelActiveSoftApply: () => {},
    resetPlaybackSyncState: () => {},
    activatePauseHold: () => {
      _pauseHoldActivated = true;
    },
    clearRemoteFollowPlayingWindow: () => {},
    acceptInitialRoomStateHydration: () => {
      _acceptedHydration = true;
    },
    acceptInitialRoomStateHydrationIfPending: () => {},
    logIgnoredRemotePlayback: () => {},
    getPendingLocalPlaybackOverrideDecision: () => ({ shouldIgnore: false }),
    shouldCancelActiveSoftApplyForPlayback: () => null,
    shouldApplySelfPlayback: () => false,
    shouldIgnoreRemotePlaybackApply: () => false,
    shouldSuppressRemotePlaybackByCooldown: () => false,
    rememberRemoteFollowPlayingWindow: () => {},
    rememberRemotePlaybackForSuppression: () => {},
    armProgrammaticApplyWindow: () => {},
    applyPendingPlaybackApplication: () => {},
    formatPlaybackDiagnostic: (a) => `${a.result}`,
  });

  return {
    controller,
    runtimeState,
    get pauseHoldActivated() {
      return _pauseHoldActivated;
    },
    get acceptedHydration() {
      return _acceptedHydration;
    },
    logs,
  };
}

test("suppresses autoplay for empty room when intendedPlayState is paused", async () => {
  const video = createStubVideo(false);
  const harness = createController({ video, now: 10_000 });

  harness.runtimeState.pendingRoomStateHydration = true;
  harness.runtimeState.intendedPlayState = "paused";

  await harness.controller.applyRoomState(createEmptyRoomState());

  assert.equal(harness.runtimeState.intendedPlayState, "paused");
  assert.equal(harness.pauseHoldActivated, true);
  assert.equal(harness.acceptedHydration, true);
  assert.equal(video.paused, true);
});

test("does not suppress playback for empty room when intendedPlayState is playing", async () => {
  const video = createStubVideo(false);
  const harness = createController({ video, now: 10_000 });

  harness.runtimeState.pendingRoomStateHydration = true;
  harness.runtimeState.intendedPlayState = "playing";

  await harness.controller.applyRoomState(createEmptyRoomState());

  assert.equal(harness.runtimeState.intendedPlayState, "playing");
  assert.equal(harness.pauseHoldActivated, false);
  assert.equal(harness.acceptedHydration, true);
  assert.equal(video.paused, false);
});

test("suppresses autoplay for empty room after navigation resets gesture state", async () => {
  const video = createStubVideo(false);
  const harness = createController({
    video,
    now: 10_000,
    userGestureGraceMs: 1_200,
  });

  harness.runtimeState.pendingRoomStateHydration = true;
  harness.runtimeState.intendedPlayState = "paused";
  harness.runtimeState.lastUserGestureAt = 0;
  harness.runtimeState.lastExplicitPlaybackAction = null;
  harness.runtimeState.lastExplicitUserAction = null;

  await harness.controller.applyRoomState(createEmptyRoomState());

  assert.equal(harness.runtimeState.intendedPlayState, "paused");
  assert.equal(harness.pauseHoldActivated, true);
  assert.equal(video.paused, true);
});

test("skips pauseVideo when a recent user gesture is within the grace window", async () => {
  const video = createStubVideo(false);
  const harness = createController({
    video,
    now: 10_000,
    userGestureGraceMs: 1_200,
  });

  harness.runtimeState.pendingRoomStateHydration = true;
  harness.runtimeState.intendedPlayState = "paused";
  harness.runtimeState.lastUserGestureAt = 9_500;

  await harness.controller.applyRoomState(createEmptyRoomState());

  assert.equal(harness.runtimeState.intendedPlayState, "paused");
  assert.equal(harness.pauseHoldActivated, true);
  assert.equal(harness.acceptedHydration, true);
  assert.equal(video.paused, false);
});

test("pauses video when gesture age exactly equals the grace window boundary", async () => {
  const video = createStubVideo(false);
  const harness = createController({
    video,
    now: 10_000,
    userGestureGraceMs: 1_200,
  });

  harness.runtimeState.pendingRoomStateHydration = true;
  harness.runtimeState.intendedPlayState = "paused";
  harness.runtimeState.lastUserGestureAt = 8_800;

  await harness.controller.applyRoomState(createEmptyRoomState());

  assert.equal(harness.runtimeState.intendedPlayState, "paused");
  assert.equal(harness.pauseHoldActivated, true);
  assert.equal(harness.acceptedHydration, true);
  assert.equal(video.paused, true);
});
