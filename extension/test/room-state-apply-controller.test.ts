import assert from "node:assert/strict";
import test from "node:test";
import type { RoomState, SharedVideo } from "@bili-syncplay/protocol";
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
  remotePauseDebounceMs?: number;
  normalizeUrl?: (url: string | undefined | null) => string | null;
  currentVideo?: SharedVideo | null;
  runtimeSendMessage?: <T>(message: unknown) => Promise<T | null>;
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
    getNow: () => overrides.now ?? 10_000,
    debugLog: (msg) => logs.push(msg),
    shouldLogHeartbeat: () => true,
    runtimeSendMessage: overrides.runtimeSendMessage ?? (async () => null),
    getHydrateRetryTimer: () => null,
    setHydrateRetryTimer: () => {},
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

  await harness.controller.applyRoomState(createEmptyRoomState());

  assert.equal(harness.runtimeState.postNavigationAnchorSharedUrl, null);
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
}) {
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
  } as const;
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
      }) as never,
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
    }) as RoomState;
    const harness = createController({
      video,
      now: 30_000,
      remotePauseDebounceMs: 250,
      currentVideo: {
        videoId: "BVother:p1",
        url: "https://www.bilibili.com/video/BVother?p=1",
        title: "Other Video",
      },
      runtimeSendMessage: async () =>
        ({
          ok: true,
          roomState,
          memberId: "local-member",
          roomCode: "ROOM01",
        }) as never,
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
    }) as RoomState;
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
    }) as RoomState;
    const harness = createController({
      video,
      now: 30_000,
      currentVideo: null,
      runtimeSendMessage: async () =>
        ({
          ok: true,
          roomState,
          memberId: "local-member",
          roomCode: "ROOM01",
        }) as never,
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
    }) as RoomState;
    const resetReasons: string[] = [];
    const harness = createController({
      video,
      now: 30_000,
      currentVideo: null,
      resetPlaybackSyncState: (reason) => resetReasons.push(reason),
      runtimeSendMessage: async () =>
        ({
          ok: true,
          roomState,
          memberId: "local-member",
          roomCode: "ROOM01",
        }) as never,
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
      }) as never,
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
      }) as never,
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
      }) as never,
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
      }) as never,
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
      }) as never,
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
      }) as never,
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
      }) as never,
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
      }) as never,
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
      }) as never,
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
      }) as never,
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
      }) as never,
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
      }) as never,
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
      }) as never,
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
      }) as never,
    );
    assert.equal(
      (
        harness.runtimeState.deferredRemotePausedState as never as {
          playback: { seq: number };
        }
      )?.playback.seq,
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
      }) as never,
    );

    assert.equal(applyPending, 0);
    // Deferred slot must still point to the newer snapshot — same reference,
    // same seq.
    assert.equal(
      harness.runtimeState.deferredRemotePausedState,
      newerDeferredRef,
    );
    assert.equal(
      (
        harness.runtimeState.deferredRemotePausedState as never as {
          playback: { seq: number };
        }
      )?.playback.seq,
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
      }) as never,
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
      }) as never,
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
      }) as never,
    );

    // Legacy senders omit the field → backward-compatible behavior preserved.
    assert.notEqual(harness.runtimeState.deferredRemotePausedState, null);
    assert.equal(win.scheduled.length, 1);
    assert.equal(win.scheduled[0].ms, 250);
  } finally {
    win.restore();
  }
});
