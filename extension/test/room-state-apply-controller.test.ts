import assert from "node:assert/strict";
import test from "node:test";
import type { RoomState, SharedVideo } from "@bili-syncplay/protocol";
import type { RoomStateHydrationResponse } from "../src/shared/messages";
import { createContentRuntimeState } from "../src/content/runtime-state";
import { installClockStubs } from "./clock-stubs";
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
  /** Virtual monotonic clock for tests that need time to advance. */
  getMonotonicNow?: () => number;
  /**
   * Inject no clock at all, so the controller falls back to its default source.
   * Required by any test asking WHICH clock the default is: an injected one
   * answers that for free.
   */
  omitMonotonicClock?: boolean;
  userGestureGraceMs?: number;
  remotePauseDebounceMs?: number;
  normalizeUrl?: (url: string | undefined | null) => string | null;
  currentVideo?: SharedVideo | null;
  requestRoomStateHydration?: () => Promise<RoomStateHydrationResponse | null>;
  rememberRemotePlaybackForSuppression?: (
    playback: import("@bili-syncplay/protocol").PlaybackState,
  ) => void;
  applyPendingPlaybackApplication?: (video: HTMLVideoElement) => void;
  resetPlaybackSyncState?: (reason: string) => void;
}) {
  const runtimeState = overrides.runtimeState ?? createContentRuntimeState();
  const video = overrides.video ?? null;
  const defaultCurrentVideo: SharedVideo = {
    videoId: "BV1xx411c7mD:p1",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    title: "Video",
  };
  let _pauseHoldActivated = false;
  let _acceptedHydration = false;
  const logs: string[] = [];
  const lastAppliedVersionByActor = new Map<
    string,
    { serverTime: number; seq: number }
  >();

  const controller = createRoomStateApplyController({
    runtimeState,
    lastAppliedVersionByActor,
    ignoredSelfPlaybackLogState: { key: null, at: 0 },
    localIntentGuardMs: 1_200,
    pauseHoldMs: 800,
    initialRoomStatePauseHoldMs: 3_000,
    userGestureGraceMs: overrides.userGestureGraceMs ?? 1_200,
    remotePauseDebounceMs: overrides.remotePauseDebounceMs ?? 0,
    getMonotonicNow: overrides.omitMonotonicClock
      ? undefined
      : () => overrides.getMonotonicNow?.() ?? overrides.now ?? 10_000,
    debugLog: (msg) => logs.push(msg),
    shouldLogHeartbeat: () => true,
    requestRoomStateHydration:
      overrides.requestRoomStateHydration ?? (async () => null),
    getVideoElement: () => video,
    getSharedVideo: () =>
      overrides.currentVideo === undefined
        ? defaultCurrentVideo
        : overrides.currentVideo,
    normalizeUrl: overrides.normalizeUrl ?? ((url) => url ?? null),
    notifyRoomStateToasts: () => {},
    maybeShowSharedVideoToast: () => {},
    cancelActiveSoftApply: () => {},
    resetPlaybackSyncState: overrides.resetPlaybackSyncState ?? (() => {}),
    activatePauseHold: () => {
      _pauseHoldActivated = true;
    },
    clearRemoteFollowPlayingWindow: () => {},
    acceptInitialRoomStateHydration: () => {
      _acceptedHydration = true;
    },
    acceptInitialRoomStateHydrationIfPending: () => {},
    markInitialRoomStateReceived: () => {
      runtimeState.hasReceivedInitialRoomState = true;
    },
    logIgnoredRemotePlayback: () => {},
    getPendingLocalPlaybackOverrideDecision: () => ({ shouldIgnore: false }),
    shouldCancelActiveSoftApplyForPlayback: () => null,
    shouldApplySelfPlayback: () => false,
    shouldIgnoreRemotePlaybackApply: () => false,
    shouldSuppressRemotePlaybackByCooldown: () => false,
    rememberRemoteFollowPlayingWindow: () => {},
    rememberRemotePlaybackForSuppression:
      overrides.rememberRemotePlaybackForSuppression ?? (() => {}),
    armProgrammaticApplyWindow: () => {},
    applyPendingPlaybackApplication:
      overrides.applyPendingPlaybackApplication ?? (() => {}),
    formatPlaybackDiagnostic: (a) => `${a.result}`,
  });

  return {
    controller,
    runtimeState,
    lastAppliedVersionByActor,
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
  assert.equal(harness.runtimeState.lastForcedPauseAt, 10_000);
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

test("suppresses autoplay on a page younger than the gesture grace", async () => {
  const video = createStubVideo(false);
  // The tab was just navigated to the room's video, so the document's monotonic
  // clock still reads under `userGestureGraceMs` and no gesture has ever been
  // recorded. "Never" must not be confused with "just now": with a `0` sentinel
  // this reads as a fresh gesture and the page's load autoplay is waved through.
  const harness = createController({
    video,
    now: 800,
    userGestureGraceMs: 1_200,
  });

  harness.runtimeState.pendingRoomStateHydration = true;
  harness.runtimeState.intendedPlayState = "paused";

  await harness.controller.applyRoomState(createEmptyRoomState());

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

test("clears post-navigation anchor when room shared video changes to a different url", async () => {
  const video = createStubVideo(true);
  const harness = createController({ video, now: 10_000 });

  harness.runtimeState.activeSharedUrl =
    "https://www.bilibili.com/bangumi/play/ep1231523";
  harness.runtimeState.postNavigationAnchorSharedUrl =
    "https://www.bilibili.com/bangumi/play/ep1231523";

  await harness.controller.applyRoomState({
    roomCode: "ROOM01",
    sharedVideo: {
      videoId: "ep1231525",
      url: "https://www.bilibili.com/bangumi/play/ep1231525",
      title: "新番剧第1话",
    },
    playback: null,
    members: [],
  });

  assert.equal(harness.runtimeState.postNavigationAnchorSharedUrl, null);
});

test("keeps post-navigation anchor when room shared video remains on the anchor url", async () => {
  const video = createStubVideo(true);
  const harness = createController({ video, now: 10_000 });

  harness.runtimeState.activeSharedUrl =
    "https://www.bilibili.com/bangumi/play/ep1231523";
  harness.runtimeState.postNavigationAnchorSharedUrl =
    "https://www.bilibili.com/bangumi/play/ep1231523";

  await harness.controller.applyRoomState({
    roomCode: "ROOM01",
    sharedVideo: {
      videoId: "ep1231523",
      url: "https://www.bilibili.com/bangumi/play/ep1231523",
      title: "原番剧第1话",
    },
    playback: null,
    members: [],
  });

  assert.equal(
    harness.runtimeState.postNavigationAnchorSharedUrl,
    "https://www.bilibili.com/bangumi/play/ep1231523",
  );
});

test("clears post-navigation anchor when room becomes empty", async () => {
  const video = createStubVideo(true);
  const harness = createController({ video, now: 10_000 });

  harness.runtimeState.activeSharedUrl =
    "https://www.bilibili.com/bangumi/play/ep1231523";
  harness.runtimeState.postNavigationAnchorSharedUrl =
    "https://www.bilibili.com/bangumi/play/ep1231523";
  // A non-sharer autoplay hold from this room must not survive the teardown.
  harness.runtimeState.nonSharerAutoplayHoldUrl =
    "https://www.bilibili.com/video/BVother?p=1";

  await harness.controller.applyRoomState(createEmptyRoomState());

  assert.equal(harness.runtimeState.postNavigationAnchorSharedUrl, null);
  assert.equal(harness.runtimeState.nonSharerAutoplayHoldUrl, null);
});

test("syncs the cached shared url and sharer when the page bridge has no current video", async () => {
  const video = createStubVideo(true);
  const harness = createController({
    video,
    now: 10_000,
    // The page bridge briefly resolves no current video (e.g. mid-SPA), which
    // takes applyRoomState down the no-current-video branch.
    currentVideo: null,
  });

  // Stale cache: we were on shared video A as its sharer.
  harness.runtimeState.activeSharedUrl =
    "https://www.bilibili.com/bangumi/play/ep1111111";
  harness.runtimeState.activeSharedByMemberId = "member-1";
  harness.runtimeState.pendingRoomStateHydration = false;

  await harness.controller.applyRoomState({
    roomCode: "ROOM01",
    sharedVideo: {
      videoId: "ep1231523",
      url: "https://www.bilibili.com/bangumi/play/ep1231523",
      title: "原番剧第1话",
      // The room switched from A to B (re-shared by another member) while we had
      // no current video resolved.
      sharedByMemberId: "member-2",
    },
    playback: {
      url: "https://www.bilibili.com/bangumi/play/ep1231523",
      playState: "playing",
      currentTime: 0,
      playbackRate: 1,
      actorId: "member-2",
      seq: 1,
      serverTime: 1_000,
      updatedAt: 1_000,
    },
    members: [
      { id: "member-1", name: "Alice" },
      { id: "member-2", name: "Bob" },
    ],
  });

  // Both the shared URL and sharer identity must follow the room. A stale
  // `activeSharedUrl` (still A) would make the navigation controller miss a later
  // B→C autoplay; a stale sharer id would treat this no-longer-sharer user as the
  // local share source. Both would let local playback race ahead of the room.
  assert.equal(
    harness.runtimeState.activeSharedUrl,
    "https://www.bilibili.com/bangumi/play/ep1231523",
  );
  assert.equal(harness.runtimeState.activeSharedByMemberId, "member-2");
});

test("clears the pending auto-share target once the room confirms it", async () => {
  const video = createStubVideo(true);
  const harness = createController({ video, now: 10_000, currentVideo: null });

  harness.runtimeState.localMemberId = "member-1";
  harness.runtimeState.activeSharedByMemberId = "member-1";
  harness.runtimeState.activeSharedUrl =
    "https://www.bilibili.com/bangumi/play/ep1111111";
  // Our chain's in-flight target is the video the room is now confirming.
  harness.runtimeState.pendingAutoShareTargetUrl =
    "https://www.bilibili.com/bangumi/play/ep1231523";
  harness.runtimeState.pendingRoomStateHydration = false;

  await harness.controller.applyRoomState({
    roomCode: "ROOM01",
    sharedVideo: {
      videoId: "ep1231523",
      url: "https://www.bilibili.com/bangumi/play/ep1231523",
      title: "第2话",
      sharedByMemberId: "member-1",
    },
    playback: {
      url: "https://www.bilibili.com/bangumi/play/ep1231523",
      playState: "playing",
      currentTime: 0,
      playbackRate: 1,
      actorId: "member-1",
      seq: 1,
      serverTime: 1_000,
      updatedAt: 1_000,
    },
    members: [{ id: "member-1", name: "Alice" }],
  });

  assert.equal(harness.runtimeState.pendingAutoShareTargetUrl, null);
});

test("keeps the pending auto-share target while the room is still catching up the chain", async () => {
  const video = createStubVideo(true);
  const harness = createController({ video, now: 10_000, currentVideo: null });

  harness.runtimeState.localMemberId = "member-1";
  harness.runtimeState.activeSharedByMemberId = "member-1";
  harness.runtimeState.activeSharedUrl =
    "https://www.bilibili.com/bangumi/play/ep1111111";
  // The chain already advanced to C while the room is only now confirming B.
  harness.runtimeState.pendingAutoShareTargetUrl =
    "https://www.bilibili.com/bangumi/play/ep_C";
  harness.runtimeState.pendingRoomStateHydration = false;

  await harness.controller.applyRoomState({
    roomCode: "ROOM01",
    sharedVideo: {
      videoId: "ep1231523",
      url: "https://www.bilibili.com/bangumi/play/ep1231523",
      title: "第2话 B",
      sharedByMemberId: "member-1",
    },
    playback: {
      url: "https://www.bilibili.com/bangumi/play/ep1231523",
      playState: "playing",
      currentTime: 0,
      playbackRate: 1,
      actorId: "member-1",
      seq: 1,
      serverTime: 1_000,
      updatedAt: 1_000,
    },
    members: [{ id: "member-1", name: "Alice" }],
  });

  // Still ours and not yet the confirmed target → the chain marker survives so
  // the next B→C autoplay is still recognised.
  assert.equal(
    harness.runtimeState.pendingAutoShareTargetUrl,
    "https://www.bilibili.com/bangumi/play/ep_C",
  );
});

test("clears the pending auto-share target when another member takes over the share", async () => {
  const video = createStubVideo(true);
  const harness = createController({ video, now: 10_000, currentVideo: null });

  harness.runtimeState.localMemberId = "member-1";
  harness.runtimeState.activeSharedByMemberId = "member-1";
  harness.runtimeState.activeSharedUrl =
    "https://www.bilibili.com/bangumi/play/ep1111111";
  harness.runtimeState.pendingAutoShareTargetUrl =
    "https://www.bilibili.com/bangumi/play/ep_C";
  harness.runtimeState.pendingRoomStateHydration = false;

  await harness.controller.applyRoomState({
    roomCode: "ROOM01",
    sharedVideo: {
      videoId: "ep2222222",
      url: "https://www.bilibili.com/bangumi/play/ep2222222",
      title: "别人分享的",
      sharedByMemberId: "member-2",
    },
    playback: {
      url: "https://www.bilibili.com/bangumi/play/ep2222222",
      playState: "playing",
      currentTime: 0,
      playbackRate: 1,
      actorId: "member-2",
      seq: 1,
      serverTime: 1_000,
      updatedAt: 1_000,
    },
    members: [
      { id: "member-1", name: "Alice" },
      { id: "member-2", name: "Bob" },
    ],
  });

  assert.equal(harness.runtimeState.pendingAutoShareTargetUrl, null);
});

test("clears the resolved bare-route anchor when another member re-shares the same festival route", async () => {
  const harness = createController({ now: 10_000, currentVideo: null });

  // We are a follower; member-1 originally shared this festival page by its bare
  // route and our snapshot resolved its concrete video as the anchor.
  harness.runtimeState.localMemberId = "member-2";
  harness.runtimeState.activeSharedByMemberId = "member-1";
  harness.runtimeState.activeSharedUrl =
    "https://www.bilibili.com/festival/MyMuji";
  harness.runtimeState.resolvedSharedVideoUrl =
    "https://www.bilibili.com/video/BVa?cid=1";
  harness.runtimeState.pendingRoomStateHydration = false;

  await harness.controller.applyRoomState({
    roomCode: "ROOM01",
    // Same bare festival route, but a different member now owns the share.
    sharedVideo: {
      videoId: "MyMuji",
      url: "https://www.bilibili.com/festival/MyMuji",
      title: "别人重新分享的",
      sharedByMemberId: "member-2",
    },
    playback: {
      url: "https://www.bilibili.com/festival/MyMuji",
      playState: "playing",
      currentTime: 0,
      playbackRate: 1,
      actorId: "member-2",
      seq: 1,
      serverTime: 1_000,
      updatedAt: 1_000,
    },
    members: [
      { id: "member-1", name: "Alice" },
      { id: "member-2", name: "Bob" },
    ],
  });

  // The previous sharer's resolved `/video/A` anchor must not survive the
  // ownership transfer, or a later same-page A→B autoplay would be misclassified.
  assert.equal(harness.runtimeState.resolvedSharedVideoUrl, null);
});

test("keeps the resolved bare-route anchor when the same member re-applies the same festival route", async () => {
  const harness = createController({ now: 10_000, currentVideo: null });

  harness.runtimeState.localMemberId = "member-1";
  harness.runtimeState.activeSharedByMemberId = "member-1";
  harness.runtimeState.activeSharedUrl =
    "https://www.bilibili.com/festival/MyMuji";
  harness.runtimeState.resolvedSharedVideoUrl =
    "https://www.bilibili.com/video/BVa?cid=1";
  harness.runtimeState.pendingRoomStateHydration = false;

  await harness.controller.applyRoomState({
    roomCode: "ROOM01",
    sharedVideo: {
      videoId: "MyMuji",
      url: "https://www.bilibili.com/festival/MyMuji",
      title: "同一人的房间状态",
      sharedByMemberId: "member-1",
    },
    playback: {
      url: "https://www.bilibili.com/festival/MyMuji",
      playState: "playing",
      currentTime: 0,
      playbackRate: 1,
      actorId: "member-1",
      seq: 1,
      serverTime: 1_000,
      updatedAt: 1_000,
    },
    members: [{ id: "member-1", name: "Alice" }],
  });

  // Unchanged URL and owner: the anchor recorded for the still-active bare-route
  // share must survive so a same-page autoplay can still chain.
  assert.equal(
    harness.runtimeState.resolvedSharedVideoUrl,
    "https://www.bilibili.com/video/BVa?cid=1",
  );
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

function installWindowTimerStub() {
  const originalWindow = globalThis.window;
  const scheduled: Array<{ id: number; cb: () => void; ms: number }> = [];
  const cleared: number[] = [];
  let nextTimer = 1;

  const windowStub = {
    setTimeout(cb: () => void, ms?: number) {
      const id = nextTimer++;
      scheduled.push({ id, cb, ms: ms ?? 0 });
      return id;
    },
    clearTimeout(id: number) {
      cleared.push(id);
    },
  };
  Object.assign(globalThis, { window: windowStub });

  return {
    scheduled,
    cleared,
    restore() {
      Object.assign(globalThis, { window: originalWindow });
    },
  };
}

function createRoomStateWithPlayback(playback: {
  url: string;
  currentTime: number;
  playState: "playing" | "paused" | "buffering";
  actorId: string;
  seq?: number;
  userInitiated?: boolean;
}): RoomState {
  return {
    roomCode: "ROOM01",
    sharedVideo: {
      videoId: "BV1xx411c7mD:p1",
      url: playback.url,
      title: "Video",
    },
    playback: {
      url: playback.url,
      currentTime: playback.currentTime,
      playState: playback.playState,
      ...(playback.userInitiated !== undefined
        ? { userInitiated: playback.userInitiated }
        : {}),
      playbackRate: 1,
      updatedAt: 1,
      serverTime: 1,
      actorId: playback.actorId,
      seq: playback.seq ?? 1,
    },
    members: [],
  };
}

test("ignores non-shared paused room state without debouncing or pausing", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
      currentVideo: {
        videoId: "BVother:p1",
        url: "https://www.bilibili.com/video/BVother?p=1",
        title: "Other Video",
      },
    });
    harness.runtimeState.localMemberId = "local-member";
    harness.runtimeState.pendingRoomStateHydration = true;

    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "remote-member",
        seq: 5,
      }),
    );

    assert.equal(harness.runtimeState.deferredRemotePausedState, null);
    assert.equal(win.scheduled.length, 0);
    assert.equal(video.paused, false);
    assert.equal(harness.acceptedHydration, true);
    assert.equal(
      harness.logs.some((m) => m.includes("Ignored room state")),
      true,
    );
  } finally {
    win.restore();
  }
});

test("does not pre-pause non-shared video during paused room hydration", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const roomState = createRoomStateWithPlayback({
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      currentTime: 42,
      playState: "paused",
      actorId: "remote-member",
      seq: 5,
    });
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
      currentVideo: {
        videoId: "BVother:p1",
        url: "https://www.bilibili.com/video/BVother?p=1",
        title: "Other Video",
      },
      requestRoomStateHydration: async () => ({
        ok: true,
        roomState,
        memberId: "local-member",
        roomCode: "ROOM01",
      }),
    });

    await harness.controller.hydrateRoomState();

    assert.equal(video.paused, false);
    assert.equal(harness.runtimeState.deferredRemotePausedState, null);
    assert.equal(win.scheduled.length, 0);
    assert.equal(harness.runtimeState.hydrationReady, true);
  } finally {
    win.restore();
  }
});

test("pauses during hydration when unstable shared url mismatch follows a recent gesture", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const roomState = createRoomStateWithPlayback({
      url: "https://www.bilibili.com/festival/demo?bvid=BVfestival&cid=123",
      currentTime: 42,
      playState: "paused",
      actorId: "remote-member",
      seq: 5,
    });
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
      currentVideo: {
        videoId: "/festival/demo",
        url: "https://www.bilibili.com/festival/demo",
        title: "Festival",
      },
      normalizeUrl: (url) => {
        if (
          url ===
          "https://www.bilibili.com/festival/demo?bvid=BVfestival&cid=123"
        ) {
          return "https://www.bilibili.com/video/BVfestival?cid=123";
        }
        return url ?? null;
      },
    });
    harness.runtimeState.localMemberId = "local-member";
    harness.runtimeState.pendingRoomStateHydration = true;
    harness.runtimeState.lastUserGestureAt = 29_500;

    await harness.controller.applyRoomState(roomState);

    assert.equal(video.paused, true);
    assert.equal(harness.runtimeState.lastForcedPauseAt, 30_000);
    assert.equal(harness.pauseHoldActivated, true);
    assert.equal(harness.acceptedHydration, true);
    assert.equal(harness.runtimeState.deferredRemotePausedState, null);
    assert.equal(win.scheduled.length, 0);
  } finally {
    win.restore();
  }
});

test("hydrates paused room state while page bridge is not ready", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const roomState = createRoomStateWithPlayback({
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      currentTime: 42,
      playState: "paused",
      actorId: "remote-member",
      seq: 5,
    });
    const harness = createController({
      video,
      now: 30_000,
      currentVideo: null,
      requestRoomStateHydration: async () => ({
        ok: true,
        roomState,
        memberId: "local-member",
        roomCode: "ROOM01",
      }),
    });
    harness.runtimeState.pendingRoomStateHydration = true;
    harness.runtimeState.lastUserGestureAt = 29_500;

    await harness.controller.hydrateRoomState();

    assert.equal(video.paused, true);
    assert.equal(harness.runtimeState.lastForcedPauseAt, 30_000);
    assert.equal(harness.pauseHoldActivated, true);
    assert.equal(harness.acceptedHydration, false);
    assert.equal(harness.runtimeState.pendingRoomStateHydration, true);
    assert.equal(harness.runtimeState.hydrationReady, true);
    assert.equal(
      harness.runtimeState.activeSharedUrl,
      "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    );
    assert.equal(harness.runtimeState.intendedPlayState, "paused");
    assert.equal(win.scheduled.length, 1);
    assert.equal(win.scheduled[0].ms, 350);
  } finally {
    win.restore();
  }
});

test("clears stale sync state when hydration switches shared video before page bridge is ready", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const roomState = createRoomStateWithPlayback({
      url: "https://www.bilibili.com/video/BVnew?p=1",
      currentTime: 42,
      playState: "paused",
      actorId: "remote-member",
      seq: 5,
    });
    const resetReasons: string[] = [];
    const harness = createController({
      video,
      now: 30_000,
      currentVideo: null,
      resetPlaybackSyncState: (reason) => resetReasons.push(reason),
      requestRoomStateHydration: async () => ({
        ok: true,
        roomState,
        memberId: "local-member",
        roomCode: "ROOM01",
      }),
    });
    // A previous shared video is still recorded; switching to a different
    // shared video while the page bridge is not ready must not strand its
    // playback sync state.
    harness.runtimeState.activeSharedUrl =
      "https://www.bilibili.com/video/BVold?p=1";
    harness.runtimeState.pendingRoomStateHydration = true;
    harness.runtimeState.lastUserGestureAt = 0;

    await harness.controller.hydrateRoomState();

    // Reset runs exactly once for the genuine shared-url change (the second
    // switch call during applyRoomState no-ops because the url already matches).
    assert.deepEqual(resetReasons, [
      "shared url changed to https://www.bilibili.com/video/BVnew?p=1",
    ]);
    assert.equal(
      harness.runtimeState.activeSharedUrl,
      "https://www.bilibili.com/video/BVnew?p=1",
    );
    assert.equal(video.paused, true);
    assert.equal(harness.runtimeState.intendedPlayState, "paused");
    assert.equal(harness.runtimeState.pendingRoomStateHydration, true);
  } finally {
    win.restore();
  }
});

test("defers remote paused room state when remotePauseDebounceMs > 0", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    let applyPending = 0;
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
      applyPendingPlaybackApplication: () => {
        applyPending += 1;
      },
    });
    harness.runtimeState.localMemberId = "local-member";

    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "remote-member",
        seq: 5,
      }),
    );

    assert.equal(
      harness.runtimeState.deferredRemotePausedState !== null,
      true,
      "paused room state should be captured for deferred apply",
    );
    assert.equal(win.scheduled.length, 1);
    assert.equal(win.scheduled[0].ms, 250);
    assert.equal(
      applyPending,
      0,
      "apply should be deferred, not run synchronously",
    );
  } finally {
    win.restore();
  }
});

test("deferring initial paused marks room state received but keeps hydration pending", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
    });
    harness.runtimeState.localMemberId = "local-member";
    // Simulate the in-room navigation / initial-hydration state: we are still
    // waiting to apply the first room state and have not marked it received.
    harness.runtimeState.pendingRoomStateHydration = true;
    harness.runtimeState.hasReceivedInitialRoomState = false;

    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "remote-member",
        seq: 5,
      }),
    );

    assert.equal(
      harness.runtimeState.deferredRemotePausedState !== null,
      true,
      "paused room state should be captured for deferred apply",
    );
    // The retry loop that floods the server with `sync:request` is gated on
    // `hasReceivedInitialRoomState`; deferring must flip it so retries stop.
    assert.equal(
      harness.runtimeState.hasReceivedInitialRoomState,
      true,
      "initial room state must be marked received once deferred",
    );
    // But hydration is not finished until the deferred snapshot applies, so the
    // longer initial pause hold / protection must still be armed.
    assert.equal(
      harness.runtimeState.pendingRoomStateHydration,
      true,
      "pending hydration must stay true until the deferred snapshot applies",
    );
  } finally {
    win.restore();
  }
});

test("drops deferred paused when matching playing arrives within debounce window", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
    });
    harness.runtimeState.localMemberId = "local-member";
    harness.runtimeState.hydrationReady = true;
    harness.runtimeState.activeSharedUrl =
      "https://www.bilibili.com/video/BV1xx411c7mD?p=1";

    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42.0,
        playState: "paused",
        actorId: "remote-member",
        seq: 5,
      }),
    );
    assert.equal(harness.runtimeState.deferredRemotePausedState !== null, true);

    // Same url, t-delta < 0.5 → should drop deferred paused
    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42.2,
        playState: "playing",
        actorId: "remote-member",
        seq: 6,
      }),
    );

    assert.equal(harness.runtimeState.deferredRemotePausedState, null);
    assert.equal(
      win.cleared.includes(win.scheduled[0].id),
      true,
      "deferred timer should be cleared",
    );
    assert.equal(
      harness.logs.some((m) => m.includes("Dropped flicker paused")),
      true,
    );
  } finally {
    win.restore();
  }
});

test("drops deferred paused when a newer-versioned state arrives even if t-delta is large", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
    });
    harness.runtimeState.localMemberId = "local-member";
    harness.runtimeState.hydrationReady = true;

    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42.0,
        playState: "paused",
        actorId: "remote-member",
        seq: 5,
      }),
    );
    assert.equal(harness.runtimeState.deferredRemotePausedState !== null, true);

    // t-delta = 5.0 (not a flicker shape), but the new state has a higher
    // version — letting the deferred fire later would clobber freshly applied
    // state via the unconditional activeSharedUrl reset, so drop it.
    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 47.0,
        playState: "playing",
        actorId: "remote-member",
        seq: 6,
      }),
    );

    assert.equal(harness.runtimeState.deferredRemotePausedState, null);
    assert.equal(
      harness.logs.some((m) => m.includes("Dropped stale deferred paused")),
      true,
    );
  } finally {
    win.restore();
  }
});

test("drops deferred paused when an empty-playback room state arrives", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
    });
    harness.runtimeState.localMemberId = "local-member";

    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "remote-member",
        seq: 5,
      }),
    );
    assert.equal(harness.runtimeState.deferredRemotePausedState !== null, true);

    // Empty room (no playback) — deferred snapshot's sharedVideo is now stale.
    await harness.controller.applyRoomState(createEmptyRoomState());

    assert.equal(harness.runtimeState.deferredRemotePausedState, null);
    assert.equal(
      harness.logs.some((m) => m.includes("superseded by empty playback")),
      true,
    );
  } finally {
    win.restore();
  }
});

test("deferred timer is a no-op when fire-time freshness check sees a newer applied version", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
    });
    harness.runtimeState.localMemberId = "local-member";

    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "remote-member",
        seq: 5,
      }),
    );
    assert.equal(win.scheduled.length, 1);
    const fired = win.scheduled[0];

    // Simulate that a newer (serverTime, seq) was applied for this actor
    // while the deferred was waiting — the apply layer writes this map on
    // every successful apply.
    harness.lastAppliedVersionByActor.set("remote-member", {
      serverTime: 1,
      seq: 8,
    });

    fired.cb();
    await Promise.resolve();

    assert.equal(
      harness.logs.some((m) =>
        m.includes("Dropped deferred paused seq=5 at fire time"),
      ),
      true,
      "fire-time freshness check should drop the stale snapshot",
    );
    assert.equal(harness.runtimeState.deferredRemotePausedState, null);
    assert.equal(harness.runtimeState.deferredRemotePausedTimerId, null);
  } finally {
    win.restore();
  }
});

test("does not debounce self-playback paused", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
    });
    harness.runtimeState.localMemberId = "local-member";

    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "local-member",
        seq: 5,
      }),
    );

    assert.equal(harness.runtimeState.deferredRemotePausedState, null);
    assert.equal(win.scheduled.length, 0);
  } finally {
    win.restore();
  }
});

test("debounce off when remotePauseDebounceMs is 0 — paused applies synchronously", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 0,
    });
    harness.runtimeState.localMemberId = "local-member";

    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "remote-member",
        seq: 5,
      }),
    );

    assert.equal(harness.runtimeState.deferredRemotePausedState, null);
    assert.equal(win.scheduled.length, 0);
  } finally {
    win.restore();
  }
});

test("deferred timer fires and applies paused when no playing arrives in window", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
    });
    harness.runtimeState.localMemberId = "local-member";

    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "remote-member",
        seq: 5,
      }),
    );

    assert.equal(win.scheduled.length, 1);

    // Fire the deferred timer; this re-enters applyRoomState with fromDebounce=true
    const fired = win.scheduled[0];
    fired.cb();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(harness.runtimeState.deferredRemotePausedState, null);
    assert.equal(harness.runtimeState.deferredRemotePausedTimerId, null);
  } finally {
    win.restore();
  }
});

test("applies remote paused immediately when peer marks it userInitiated, bypassing debounce", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
    });
    harness.runtimeState.localMemberId = "local-member";

    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "remote-member",
        seq: 5,
        userInitiated: true,
      }),
    );

    // No defer timer is scheduled; the paused state is applied synchronously
    // (the immediate apply path runs through to pendingPlaybackApplication).
    assert.equal(harness.runtimeState.deferredRemotePausedState, null);
    assert.equal(win.scheduled.length, 0);
  } finally {
    win.restore();
  }
});

test("userInitiated remote paused cancels any already-deferred paused snapshot", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
    });
    harness.runtimeState.localMemberId = "local-member";

    // First arrival: legacy peer (no userInitiated flag) → gets deferred.
    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "remote-member",
        seq: 5,
      }),
    );
    assert.notEqual(harness.runtimeState.deferredRemotePausedState, null);
    assert.equal(win.scheduled.length, 1);

    // Second arrival: same actor with a strictly newer seq, now marked
    // userInitiated. The upstream version-comparison block clears the
    // older deferred snapshot, and the short-circuit then applies the
    // newer state immediately so a stale timer can't fire later and
    // overwrite the freshly-applied state.
    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "remote-member",
        seq: 6,
        userInitiated: true,
      }),
    );

    assert.equal(harness.runtimeState.deferredRemotePausedState, null);
    assert.equal(harness.runtimeState.deferredRemotePausedTimerId, null);
  } finally {
    win.restore();
  }
});

test("older userInitiated remote paused neither short-circuits nor overwrites the newer in-flight deferred", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    let applyPending = 0;
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
      applyPendingPlaybackApplication: () => {
        applyPending += 1;
      },
    });
    harness.runtimeState.localMemberId = "local-member";

    // First arrival: newer seq, no userInitiated → enters debounce.
    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "remote-member",
        seq: 10,
      }),
    );
    assert.equal(
      harness.runtimeState.deferredRemotePausedState?.playback?.seq,
      10,
    );
    assert.equal(win.scheduled.length, 1);
    const newerDeferredRef = harness.runtimeState.deferredRemotePausedState;

    // Second arrival: SAME actor but OLDER seq, with userInitiated=true.
    // Models a delayed hydrate response landing after a newer realtime push.
    // The short-circuit must NOT fire (would lose the deferred via immediate
    // apply), AND the defer block must NOT overwrite the newer deferred
    // (would invert ordering and let the older state fire 250ms later).
    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "remote-member",
        seq: 8,
        userInitiated: true,
      }),
    );

    assert.equal(applyPending, 0);
    // Deferred slot must still point to the newer snapshot — same reference,
    // same seq.
    assert.equal(
      harness.runtimeState.deferredRemotePausedState,
      newerDeferredRef,
    );
    assert.equal(
      harness.runtimeState.deferredRemotePausedState?.playback?.seq,
      10,
    );
    // No additional debounce timer was scheduled by the older arrival.
    assert.equal(win.scheduled.length, 1);
  } finally {
    win.restore();
  }
});

test("older non-userInitiated remote paused does not overwrite the newer in-flight deferred", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
    });
    harness.runtimeState.localMemberId = "local-member";

    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "remote-member",
        seq: 10,
      }),
    );
    const newerDeferredRef = harness.runtimeState.deferredRemotePausedState;
    assert.equal(win.scheduled.length, 1);

    // Older paused without userInitiated must also be dropped, not be
    // allowed to silently replace the newer deferred snapshot.
    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "remote-member",
        seq: 8,
      }),
    );

    assert.equal(
      harness.runtimeState.deferredRemotePausedState,
      newerDeferredRef,
    );
    assert.equal(win.scheduled.length, 1);
  } finally {
    win.restore();
  }
});

test("legacy remote paused (no userInitiated field) still goes through the debounce", async () => {
  const win = installWindowTimerStub();
  try {
    const video = createStubVideo(false);
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
    });
    harness.runtimeState.localMemberId = "local-member";

    await harness.controller.applyRoomState(
      createRoomStateWithPlayback({
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        currentTime: 42,
        playState: "paused",
        actorId: "remote-member",
        seq: 5,
      }),
    );

    // Legacy senders omit the field → backward-compatible behavior preserved.
    assert.notEqual(harness.runtimeState.deferredRemotePausedState, null);
    assert.equal(win.scheduled.length, 1);
    assert.equal(win.scheduled[0].ms, 250);
  } finally {
    win.restore();
  }
});

test("backs off consecutive hydration retries instead of re-arming a flat delay", async () => {
  const win = installWindowTimerStub();
  try {
    // Regression for #229: a tab whose player never produces a `<video>`
    // element re-armed the hydration retry at a flat 350ms for the lifetime of
    // the tab. Each pass also forwarded a `sync:request`, which is how a single
    // stuck tab saturated the server's per-session limiter.
    const roomState = createRoomStateWithPlayback({
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      currentTime: 42,
      playState: "paused",
      actorId: "remote-member",
      seq: 5,
    });
    const harness = createController({
      video: createStubVideo(false),
      now: 30_000,
      currentVideo: null,
      requestRoomStateHydration: async () => ({
        ok: true,
        roomState,
        memberId: "local-member",
        roomCode: "ROOM01",
      }),
    });
    harness.runtimeState.pendingRoomStateHydration = true;
    harness.runtimeState.lastUserGestureAt = 29_500;

    // Six consecutive cycles that each re-arm the retry (the page bridge never
    // becomes ready). Driven through the timer, because only timer-driven
    // retries accumulate the streak — an externally initiated
    // `hydrateRoomState` is a fresh start and resets it.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    await harness.controller.hydrateRoomState();
    for (let i = 0; i < 5; i += 1) {
      win.scheduled[win.scheduled.length - 1].cb();
      await settle();
    }

    assert.deepEqual(
      win.scheduled.map((timer) => timer.ms),
      [350, 700, 1400, 2800, 5600, 10_000],
      "consecutive retries must double up to the ceiling",
    );
  } finally {
    win.restore();
  }
});

test("resets hydration retry backoff once a cycle completes without retrying", async () => {
  const win = installWindowTimerStub();
  try {
    const roomState = createRoomStateWithPlayback({
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      currentTime: 42,
      playState: "paused",
      actorId: "remote-member",
      seq: 5,
    });
    let bridgeReady = false;
    const harness = createController({
      video: createStubVideo(false),
      now: 30_000,
      // `currentVideo` null keeps the page bridge "not ready" and re-arms the
      // retry; returning the shared video lets the cycle complete cleanly.
      currentVideo: null,
      requestRoomStateHydration: async () =>
        bridgeReady
          ? null
          : {
              ok: true,
              roomState,
              memberId: "local-member",
              roomCode: "ROOM01",
            },
    });
    harness.runtimeState.pendingRoomStateHydration = true;
    harness.runtimeState.lastUserGestureAt = 29_500;

    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    await harness.controller.hydrateRoomState();
    win.scheduled[win.scheduled.length - 1].cb();
    await settle();
    assert.deepEqual(
      win.scheduled.map((timer) => timer.ms),
      [350, 700],
    );

    // A timer-driven cycle that arms no retry clears the streak...
    bridgeReady = true;
    win.scheduled[win.scheduled.length - 1].cb();
    await settle();
    assert.equal(win.scheduled.length, 2, "clean cycle must not arm a retry");

    // ...so the next retry starts from its caller's delay again.
    bridgeReady = false;
    harness.controller.scheduleHydrationRetry();
    assert.deepEqual(
      win.scheduled.map((timer) => timer.ms),
      [350, 700, 350],
    );
  } finally {
    win.restore();
  }
});

test("video element binding ends the hydration wait instead of a retry timer", async () => {
  const win = installWindowTimerStub();
  try {
    // The retry that waits for a `<video>` element used to be a second poller
    // over the same `document.querySelector("video")` the binding loop already
    // runs — and every pass of it reached the server (#229). The element now
    // arrives as an event.
    const roomState = createRoomStateWithPlayback({
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      currentTime: 42,
      playState: "paused",
      actorId: "remote-member",
      seq: 5,
    });
    let hydrations = 0;
    const harness = createController({
      video: createStubVideo(false),
      now: 30_000,
      currentVideo: null,
      requestRoomStateHydration: async () => {
        hydrations += 1;
        return {
          ok: true,
          roomState,
          memberId: "local-member",
          roomCode: "ROOM01",
        };
      },
    });
    harness.runtimeState.pendingRoomStateHydration = true;
    harness.runtimeState.lastUserGestureAt = 29_500;

    await harness.controller.hydrateRoomState();
    assert.equal(hydrations, 1);
    assert.equal(win.scheduled.length, 1, "a retry is pending");

    // Binding cancels the pending retry and re-arms a near-immediate one.
    harness.controller.notifyVideoElementBound();
    assert.deepEqual(
      win.cleared,
      [win.scheduled[0].id],
      "the pending retry timer must be cancelled, not left to fire too",
    );
    assert.equal(win.scheduled.length, 2);
    assert.equal(
      win.scheduled[1].ms,
      50,
      "a first binding must not inherit the wait's backoff",
    );

    win.scheduled[1].cb();
    await Promise.resolve();
    assert.equal(hydrations, 2, "binding must drive the hydration");
  } finally {
    win.restore();
  }
});

test("video element binding is a no-op when no hydration is waiting", async () => {
  const win = installWindowTimerStub();
  try {
    // A player rebuild during ordinary playback also rebinds. Hydrating on every
    // rebind would put `sync:request` back on a timer.
    let hydrations = 0;
    const harness = createController({
      video: createStubVideo(false),
      now: 30_000,
      requestRoomStateHydration: async () => {
        hydrations += 1;
        return null;
      },
    });

    harness.controller.notifyVideoElementBound();
    await Promise.resolve();

    assert.equal(hydrations, 0);
    assert.equal(win.scheduled.length, 0);
  } finally {
    win.restore();
  }
});

test("a rebind storm cannot starve hydration by resetting the timer", async () => {
  const win = installWindowTimerStub();
  try {
    // Real timing, not hand-fired callbacks: a player rebuilding its element
    // reports a bind about every 250ms (the bind poll interval). A binding that
    // cancelled the pending timer and armed a longer one would be re-cancelled
    // before it ever fired, so hydration would never run at all and the pending
    // state would be held for as long as the rebuilding lasted (#229).
    const roomState = createRoomStateWithPlayback({
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      currentTime: 42,
      playState: "paused",
      actorId: "remote-member",
      seq: 5,
    });
    const startClock = 30_000;
    let clock = startClock;
    const hydrationClocks: number[] = [];
    const harness = createController({
      video: createStubVideo(false),
      getMonotonicNow: () => clock,
      currentVideo: null,
      requestRoomStateHydration: async () => {
        hydrationClocks.push(clock);
        return {
          ok: true,
          roomState,
          memberId: "local-member",
          roomCode: "ROOM01",
        };
      },
    });
    harness.runtimeState.pendingRoomStateHydration = true;
    harness.runtimeState.lastUserGestureAt = 0;

    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    // The stub records delays, not deadlines; pair each armed timer with the
    // clock reading it was armed at so the simulation can fire it on time.
    let armedCount = 0;
    let dueAt: number | null = null;
    let dueCb: (() => void) | null = null;
    const trackArming = () => {
      while (armedCount < win.scheduled.length) {
        const timer = win.scheduled[armedCount];
        armedCount += 1;
        dueAt = clock + timer.ms;
        dueCb = timer.cb;
      }
    };

    await harness.controller.hydrateRoomState();
    trackArming();
    assert.equal(hydrationClocks.length, 1);

    // 10 seconds of virtual time, stepping 50ms, rebinding every 250ms.
    for (let step = 0; step < 200; step += 1) {
      clock += 50;
      if (dueAt !== null && clock >= dueAt && dueCb) {
        const fire = dueCb;
        dueAt = null;
        dueCb = null;
        fire();
        await settle();
        trackArming();
      }
      if (step % 5 === 0) {
        harness.controller.notifyVideoElementBound();
        trackArming();
      }
    }

    // Counting alone cannot tell "few because it decayed" from "few because it
    // starved" — both are small. What distinguishes them is *when*: a starved
    // timer stops firing once the bind backoff passes the rebind interval, so
    // the tail of the window is empty.
    // The bind backoff passes the 250ms rebind interval within the first
    // second, which is when a cancel-and-re-arm implementation stops firing for
    // good (measured: its last hydration lands at +750ms). A decaying one keeps
    // going with growing gaps (measured: +6450ms and still counting), so any
    // hydration well past that first second separates the two.
    assert.ok(
      hydrationClocks.some((at) => at >= startClock + 3_000),
      `hydration must keep running in a rebind storm (ran at ${hydrationClocks.join(", ")})`,
    );
    // …but nowhere near one per rebind: 40 rebinds happened in this window.
    assert.ok(
      hydrationClocks.length < 15,
      `and must still back off rather than run per rebind (ran ${hydrationClocks.length}x)`,
    );
  } finally {
    win.restore();
  }
});

test("a video binding after a long wait hydrates promptly, not at the ceiling", async () => {
  const win = installWindowTimerStub();
  try {
    // The wait streak and the rebind streak are different sequences. A page
    // bridge that stays unready for minutes drives the wait streak to
    // saturation; if the binding inherited it, `50 * 2**n` would clamp to the
    // 30s ceiling and the room state would sit unapplied for half a minute
    // AFTER the video became usable — with broadcasts suppressed and the
    // initial pause still held throughout.
    const roomState = createRoomStateWithPlayback({
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      currentTime: 42,
      playState: "paused",
      actorId: "remote-member",
      seq: 5,
    });
    const harness = createController({
      video: createStubVideo(false),
      now: 30_000,
      currentVideo: null,
      requestRoomStateHydration: async () => ({
        ok: true,
        roomState,
        memberId: "local-member",
        roomCode: "ROOM01",
      }),
    });
    harness.runtimeState.pendingRoomStateHydration = true;
    harness.runtimeState.lastUserGestureAt = 29_500;

    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    // Drive the wait to the ceiling: 350ms doubling clamps from the 6th on.
    await harness.controller.hydrateRoomState();
    for (let i = 0; i < 11; i += 1) {
      const armed = win.scheduled[win.scheduled.length - 1];
      armed.cb();
      await settle();
    }
    const saturated = win.scheduled[win.scheduled.length - 1];
    assert.equal(
      saturated.ms,
      10_000,
      "precondition: the wait streak must be saturated",
    );

    harness.controller.notifyVideoElementBound();
    const afterBind = win.scheduled[win.scheduled.length - 1];
    assert.equal(
      afterBind.ms,
      50,
      "the element arrived, so the wait's accumulated penalty is spent",
    );

    // If that hydration still cannot apply, what it is waiting for now is
    // something else (the page bridge here) — a new wait, which must start its
    // own backoff rather than resume the spent one at the ceiling.
    afterBind.cb();
    await settle();
    assert.equal(
      win.scheduled[win.scheduled.length - 1].ms,
      350,
      "the wait that follows a binding restarts its backoff",
    );
  } finally {
    win.restore();
  }
});

test("resetting hydration retry frees the timer slot for the new room", async () => {
  const win = installWindowTimerStub();
  try {
    // Clearing the streaks is only half of it. The single-timer guard in
    // `scheduleHydrationRetry` refuses to arm while one is pending, so a room
    // switch that left the old room's timer armed would silently drop the new
    // room's 150ms bootstrap retry entirely (#229).
    const roomState = createRoomStateWithPlayback({
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      currentTime: 42,
      playState: "paused",
      actorId: "remote-member",
      seq: 5,
    });
    const harness = createController({
      video: createStubVideo(false),
      now: 30_000,
      currentVideo: null,
      requestRoomStateHydration: async () => ({
        ok: true,
        roomState,
        memberId: "local-member",
        roomCode: "ROOM01",
      }),
    });
    harness.runtimeState.pendingRoomStateHydration = true;
    harness.runtimeState.lastUserGestureAt = 29_500;

    await harness.controller.hydrateRoomState();
    assert.equal(win.scheduled.length, 1, "the old room armed a retry");

    harness.controller.resetHydrationRetry();
    assert.deepEqual(
      win.cleared,
      [win.scheduled[0].id],
      "the pending timer must be cancelled, not just the streak",
    );

    harness.controller.scheduleHydrationRetry(150);
    assert.equal(win.scheduled.length, 2, "the new room's retry must arm");
    assert.equal(
      win.scheduled[1].ms,
      150,
      "and at its own delay, not the old room's backed-off one",
    );
  } finally {
    win.restore();
  }
});

test("an externally driven hydration drops the previous page's backoff", async () => {
  const win = installWindowTimerStub();
  try {
    // An SPA navigation within the same room calls `hydrateRoomState` directly
    // (`navigation-controller`). The streaks belong to the page that just went
    // away, and nothing would wake the new page early — Bilibili reuses the same
    // `<video>` element across such a navigation, so no bind is reported (#229).
    const roomState = createRoomStateWithPlayback({
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      currentTime: 42,
      playState: "paused",
      actorId: "remote-member",
      seq: 5,
    });
    const harness = createController({
      video: createStubVideo(false),
      now: 30_000,
      currentVideo: null,
      requestRoomStateHydration: async () => ({
        ok: true,
        roomState,
        memberId: "local-member",
        roomCode: "ROOM01",
      }),
    });
    harness.runtimeState.pendingRoomStateHydration = true;
    harness.runtimeState.lastUserGestureAt = 29_500;

    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    await harness.controller.hydrateRoomState();
    for (let i = 0; i < 5; i += 1) {
      win.scheduled[win.scheduled.length - 1].cb();
      await settle();
    }
    assert.equal(
      win.scheduled[win.scheduled.length - 1].ms,
      10_000,
      "precondition: the old page saturated the backoff",
    );

    await harness.controller.hydrateRoomState();

    assert.equal(
      win.scheduled[win.scheduled.length - 1].ms,
      350,
      "a navigation must start the new page's backoff over",
    );
  } finally {
    win.restore();
  }
});

test("the retry deadline is compared on a monotonic clock", async () => {
  const win = installWindowTimerStub();
  // Stub the GLOBALS and inject nothing: the question is which source the
  // controller's default reads, and an injected clock answers it for free.
  const clock = installClockStubs({
    wall: 1_700_000_000_000,
    monotonic: 100_000,
  });
  try {
    // The deadline is captured when the timer is armed. Read from `Date.now()`,
    // a backward step shrinks `now + delay` and makes a candidate look earlier
    // than a deadline it is not — so the comparison would preempt, cancel a
    // timer that was about to fire, and restart the full delay.
    const roomState = createRoomStateWithPlayback({
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      currentTime: 42,
      playState: "paused",
      actorId: "remote-member",
      seq: 5,
    });
    const harness = createController({
      video: createStubVideo(false),
      omitMonotonicClock: true,
      currentVideo: null,
      requestRoomStateHydration: async () => ({
        ok: true,
        roomState,
        memberId: "local-member",
        roomCode: "ROOM01",
      }),
    });
    harness.runtimeState.pendingRoomStateHydration = true;
    harness.runtimeState.lastUserGestureAt = 0;

    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    await harness.controller.hydrateRoomState();
    // Grow the bind streak so a preemption would cost a long re-wait.
    for (let i = 0; i < 6; i += 1) {
      harness.controller.notifyVideoElementBound();
      clock.clocks.monotonic += 1;
      if (win.scheduled[win.scheduled.length - 1].ms <= 1) break;
    }
    const armedBefore = win.scheduled.length;

    // Real time barely moved; the wall clock jumped an hour backwards.
    clock.clocks.monotonic += 5;
    clock.clocks.wall -= 3_600_000;
    harness.controller.notifyVideoElementBound();
    await settle();

    assert.equal(
      win.scheduled.length,
      armedBefore,
      "a backward wall-clock step must not preempt the pending retry",
    );
  } finally {
    clock.restore();
    win.restore();
  }
});
