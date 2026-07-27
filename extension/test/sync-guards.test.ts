import assert from "node:assert/strict";
import test from "node:test";
import type { PlaybackState } from "@bili-syncplay/protocol";
import {
  evaluateNonSharedPageGuard,
  hasRecentRemoteStopIntent,
  rememberRemoteAppliedPlayback,
  rememberRemotePlaybackForSuppression,
  shouldApplySelfPlayback,
  shouldForcePauseWhileWaitingForInitialRoomState,
  shouldSuppressRemoteFollowupBroadcast,
  shouldSuppressLeakedEchoByOwnership,
  shouldSuppressLocalEcho,
  shouldSuppressProgrammaticEvent,
  shouldSuppressRemotePlayTransition,
} from "../src/content/sync-guards";
import type { RemoteAppliedPlayback } from "../src/content/runtime-state";

function createPlayback(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    currentTime: 12,
    playState: "paused",
    playbackRate: 1,
    updatedAt: 1,
    serverTime: 1,
    actorId: "remote-member",
    seq: 1,
    ...overrides,
  };
}

test("suppresses autoplay while waiting for initial hydration", () => {
  assert.equal(
    shouldForcePauseWhileWaitingForInitialRoomState({
      activeRoomCode: "ROOM01",
      pendingRoomStateHydration: true,
      videoPaused: false,
    }),
    true,
  );
});

test("forces pause during initial hydration regardless of user gesture", () => {
  assert.equal(
    shouldForcePauseWhileWaitingForInitialRoomState({
      activeRoomCode: "ROOM01",
      pendingRoomStateHydration: true,
      videoPaused: false,
    }),
    true,
  );
});

test("flags non-shared playback unless the user explicitly started playback", () => {
  const blocked = evaluateNonSharedPageGuard({
    activeRoomCode: "ROOM01",
    activeSharedUrl: "https://www.bilibili.com/video/BV1shared?p=1",
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1other?p=1",
    videoPaused: false,
    explicitNonSharedPlaybackUrl: null,
    lastExplicitPlaybackAction: null,
    now: 8_000,
    userGestureGraceMs: 1_200,
  });
  assert.deepEqual(blocked, {
    shouldPause: true,
    nextExplicitNonSharedPlaybackUrl: null,
  });

  const allowed = evaluateNonSharedPageGuard({
    activeRoomCode: "ROOM01",
    activeSharedUrl: "https://www.bilibili.com/video/BV1shared?p=1",
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1other?p=1",
    videoPaused: false,
    explicitNonSharedPlaybackUrl: null,
    lastExplicitPlaybackAction: {
      playState: "playing",
      at: 7_400,
    },
    now: 8_000,
    userGestureGraceMs: 1_200,
  });
  assert.deepEqual(allowed, {
    shouldPause: false,
    nextExplicitNonSharedPlaybackUrl:
      "https://www.bilibili.com/video/BV1other?p=1",
  });
});

test("suppresses local echo for matching remote playback within the guard window", () => {
  const memory = rememberRemotePlaybackForSuppression({
    playback: createPlayback({
      playState: "paused",
      currentTime: 25,
    }),
    normalizedUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    now: 10_000,
    remoteEchoSuppressionMs: 700,
    remotePlayTransitionGuardMs: 1_800,
  });

  const decision = shouldSuppressLocalEcho({
    suppressedRemotePlayback: memory.suppressedRemotePlayback,
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "paused",
    currentTime: 25.05,
    playbackRate: 1,
    now: 10_100,
  });

  assert.equal(decision.shouldSuppress, true);
  assert.deepEqual(
    decision.nextSuppressedRemotePlayback,
    memory.suppressedRemotePlayback,
  );
});

test("treats buffering after remote playing as the same local echo chain", () => {
  const memory = rememberRemotePlaybackForSuppression({
    playback: createPlayback({
      playState: "playing",
      currentTime: 25,
    }),
    normalizedUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    now: 10_000,
    remoteEchoSuppressionMs: 700,
    remotePlayTransitionGuardMs: 1_800,
  });

  const decision = shouldSuppressLocalEcho({
    suppressedRemotePlayback: memory.suppressedRemotePlayback,
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "buffering",
    currentTime: 25.05,
    playbackRate: 1,
    now: 10_100,
  });

  assert.equal(decision.shouldSuppress, true);
  assert.deepEqual(
    decision.nextSuppressedRemotePlayback,
    memory.suppressedRemotePlayback,
  );
});

test("suppresses programmatic play, pause, and seek events inside the apply window", () => {
  const playSignature = {
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "playing" as const,
    currentTime: 25,
    playbackRate: 1,
  };
  assert.equal(
    shouldSuppressProgrammaticEvent({
      programmaticApplyAt: 10_000,
      programmaticApplyUntil: 10_500,
      programmaticApplyScope: "all",
      programmaticApplySignature: playSignature,
      normalizedCurrentUrl: playSignature.url,
      playState: "playing",
      currentTime: 25.1,
      playbackRate: 1,
      eventSource: "play",
      lastExplicitUserAction: null,
      now: 10_100,
      userGestureGraceMs: 1_200,
    }).shouldSuppress,
    true,
  );

  const pauseSignature = {
    ...playSignature,
    playState: "paused" as const,
    currentTime: 30,
  };
  assert.equal(
    shouldSuppressProgrammaticEvent({
      programmaticApplyAt: 10_000,
      programmaticApplyUntil: 10_500,
      programmaticApplyScope: "all",
      programmaticApplySignature: pauseSignature,
      normalizedCurrentUrl: pauseSignature.url,
      playState: "paused",
      currentTime: 30.05,
      playbackRate: 1,
      eventSource: "pause",
      lastExplicitUserAction: null,
      now: 10_120,
      userGestureGraceMs: 1_200,
    }).shouldSuppress,
    true,
  );

  assert.equal(
    shouldSuppressProgrammaticEvent({
      programmaticApplyAt: 10_000,
      programmaticApplyUntil: 10_500,
      programmaticApplyScope: "all",
      programmaticApplySignature: pauseSignature,
      normalizedCurrentUrl: pauseSignature.url,
      playState: "paused",
      currentTime: 30.4,
      playbackRate: 1,
      eventSource: "seeked",
      lastExplicitUserAction: null,
      now: 10_140,
      userGestureGraceMs: 1_200,
    }).shouldSuppress,
    true,
  );
});

test("treats buffering after a programmatic playing apply as the same suppression chain", () => {
  const playSignature = {
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "playing" as const,
    currentTime: 25,
    playbackRate: 1.25,
  };

  assert.equal(
    shouldSuppressProgrammaticEvent({
      programmaticApplyAt: 10_000,
      programmaticApplyUntil: 10_500,
      programmaticApplyScope: "all",
      programmaticApplySignature: playSignature,
      normalizedCurrentUrl: playSignature.url,
      playState: "buffering",
      currentTime: 25.05,
      playbackRate: 1.25,
      eventSource: "waiting",
      lastExplicitUserAction: null,
      now: 10_120,
      userGestureGraceMs: 1_200,
    }).shouldSuppress,
    true,
  );
});

test("allows explicit user actions to bypass programmatic suppression", () => {
  assert.equal(
    shouldSuppressProgrammaticEvent({
      // Window opened at 9_800 (700ms), so the 10_000 action happened *during*
      // the apply — a genuine user seek that must not be suppressed.
      programmaticApplyAt: 9_800,
      programmaticApplyUntil: 10_500,
      programmaticApplyScope: "all",
      programmaticApplySignature: {
        url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
        playState: "paused",
        currentTime: 36,
        playbackRate: 1,
      },
      normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      playState: "paused",
      currentTime: 36.1,
      playbackRate: 1,
      eventSource: "seeked",
      lastExplicitUserAction: {
        kind: "seek",
        at: 10_000,
        inPlayerGestureAt: 10_000,
      },
      now: 10_100,
      userGestureGraceMs: 1_200,
    }).shouldSuppress,
    false,
  );
});

test("suppresses follow-up broadcasts while the remote playing window is active", () => {
  const decision = shouldSuppressRemoteFollowupBroadcast({
    remoteFollowPlayingUntil: 13_000,
    remoteFollowPlayingUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "playing",
    eventSource: "timeupdate",
    lastExplicitUserAction: null,
    now: 12_200,
    userGestureGraceMs: 1_200,
  });

  assert.equal(decision.shouldSuppress, true);
  assert.equal(
    decision.nextRemoteFollowPlayingUrl,
    "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
  );
});

test("allows explicit user seek to bypass the remote playing window", () => {
  const decision = shouldSuppressRemoteFollowupBroadcast({
    remoteFollowPlayingUntil: 13_000,
    remoteFollowPlayingUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "playing",
    eventSource: "seeked",
    lastExplicitUserAction: {
      kind: "seek",
      at: 12_250,
      inPlayerGestureAt: 12_250,
    },
    now: 12_300,
    userGestureGraceMs: 1_200,
  });

  assert.equal(decision.shouldSuppress, false);
});

test("allows canplay and playing to bypass the remote playing window after an explicit seek", () => {
  const canplayDecision = shouldSuppressRemoteFollowupBroadcast({
    remoteFollowPlayingUntil: 13_000,
    remoteFollowPlayingUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "playing",
    eventSource: "canplay",
    lastExplicitUserAction: {
      kind: "seek",
      at: 12_250,
      inPlayerGestureAt: 12_250,
    },
    now: 12_300,
    userGestureGraceMs: 1_200,
  });
  const playingDecision = shouldSuppressRemoteFollowupBroadcast({
    remoteFollowPlayingUntil: 13_000,
    remoteFollowPlayingUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "playing",
    eventSource: "playing",
    lastExplicitUserAction: {
      kind: "seek",
      at: 12_250,
      inPlayerGestureAt: 12_250,
    },
    now: 12_300,
    userGestureGraceMs: 1_200,
  });

  assert.equal(canplayDecision.shouldSuppress, false);
  assert.equal(playingDecision.shouldSuppress, false);
});

test("clears the remote playing window on pause or url mismatch but keeps it through buffering", () => {
  const pausedDecision = shouldSuppressRemoteFollowupBroadcast({
    remoteFollowPlayingUntil: 13_000,
    remoteFollowPlayingUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "paused",
    eventSource: "pause",
    lastExplicitUserAction: null,
    now: 12_200,
    userGestureGraceMs: 1_200,
  });

  assert.equal(pausedDecision.shouldSuppress, false);
  assert.equal(pausedDecision.nextRemoteFollowPlayingUntil, 0);
  assert.equal(pausedDecision.nextRemoteFollowPlayingUrl, null);

  const bufferingDecision = shouldSuppressRemoteFollowupBroadcast({
    remoteFollowPlayingUntil: 13_000,
    remoteFollowPlayingUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "buffering",
    eventSource: "waiting",
    lastExplicitUserAction: null,
    now: 12_200,
    userGestureGraceMs: 1_200,
  });

  assert.equal(bufferingDecision.shouldSuppress, true);
  assert.equal(bufferingDecision.nextRemoteFollowPlayingUntil, 13_000);
  assert.equal(
    bufferingDecision.nextRemoteFollowPlayingUrl,
    "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
  );

  const mismatchDecision = shouldSuppressRemoteFollowupBroadcast({
    remoteFollowPlayingUntil: 13_000,
    remoteFollowPlayingUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1other?p=1",
    playState: "playing",
    eventSource: "playing",
    lastExplicitUserAction: null,
    now: 12_200,
    userGestureGraceMs: 1_200,
  });

  assert.equal(mismatchDecision.shouldSuppress, false);
  assert.equal(mismatchDecision.nextRemoteFollowPlayingUntil, 0);
  assert.equal(mismatchDecision.nextRemoteFollowPlayingUrl, null);
});

test("reapplies remote stop intent when an unexpected resume happens shortly after a remote pause", () => {
  const memory = rememberRemotePlaybackForSuppression({
    playback: createPlayback({
      playState: "paused",
      currentTime: 30,
    }),
    normalizedUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    now: 20_000,
    remoteEchoSuppressionMs: 700,
    remotePlayTransitionGuardMs: 1_800,
  });

  assert.equal(
    hasRecentRemoteStopIntent({
      now: 20_300,
      pauseHoldUntil: 21_000,
      normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      activeSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      intendedPlayState: "paused",
      suppressedRemotePlayback: memory.suppressedRemotePlayback,
    }),
    true,
  );
});

test("does not treat remote buffering as a stop intent", () => {
  const memory = rememberRemotePlaybackForSuppression({
    playback: createPlayback({
      playState: "buffering",
      currentTime: 30,
    }),
    normalizedUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    now: 20_000,
    remoteEchoSuppressionMs: 700,
    remotePlayTransitionGuardMs: 1_800,
  });

  assert.equal(
    hasRecentRemoteStopIntent({
      now: 20_300,
      pauseHoldUntil: 21_000,
      normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      activeSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      intendedPlayState: "buffering",
      suppressedRemotePlayback: memory.suppressedRemotePlayback,
    }),
    false,
  );
});

test("suppresses pause echo right after a remote playing intent unless it was user initiated", () => {
  const memory = rememberRemotePlaybackForSuppression({
    playback: createPlayback({
      playState: "playing",
      currentTime: 48,
    }),
    normalizedUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    now: 30_000,
    remoteEchoSuppressionMs: 700,
    remotePlayTransitionGuardMs: 1_800,
  });

  const suppressed = shouldSuppressRemotePlayTransition({
    recentRemotePlayingIntent: memory.recentRemotePlayingIntent,
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "paused",
    currentTime: 48.4,
    lastExplicitPlaybackAction: null,
    now: 30_400,
    userGestureGraceMs: 1_200,
  });
  assert.equal(suppressed.shouldSuppress, true);

  const allowed = shouldSuppressRemotePlayTransition({
    recentRemotePlayingIntent: memory.recentRemotePlayingIntent,
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "paused",
    currentTime: 48.4,
    lastExplicitPlaybackAction: {
      playState: "paused",
      at: 30_100,
    },
    now: 30_400,
    userGestureGraceMs: 1_200,
  });
  assert.equal(allowed.shouldSuppress, false);
});

test("applies self playback only when paused state, timeline, or rate actually diverge", () => {
  assert.equal(
    shouldApplySelfPlayback({
      videoPaused: true,
      videoCurrentTime: 12,
      videoPlaybackRate: 1,
      playback: createPlayback({
        playState: "playing",
        currentTime: 12,
        playbackRate: 1,
      }),
    }),
    true,
  );

  assert.equal(
    shouldApplySelfPlayback({
      videoPaused: false,
      videoCurrentTime: 12.1,
      videoPlaybackRate: 1,
      playback: createPlayback({
        playState: "playing",
        currentTime: 12,
        playbackRate: 1,
      }),
    }),
    false,
  );
});

test("does not let an explicit action from before the apply window bypass suppression", () => {
  const decision = shouldSuppressProgrammaticEvent({
    // The user seeked at 9_700, then a remote state arrived and the apply
    // window opened at 9_800. The `seeked` echo the apply produces must not be
    // waved through by that earlier, unrelated action — doing so broadcasts the
    // state we just applied straight back to the room.
    programmaticApplyAt: 9_800,
    programmaticApplyUntil: 10_500,
    programmaticApplyScope: "all",
    programmaticApplySignature: {
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      playState: "paused",
      currentTime: 36,
      playbackRate: 1,
    },
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "paused",
    currentTime: 36.1,
    playbackRate: 1,
    eventSource: "seeked",
    lastExplicitUserAction: {
      kind: "seek",
      at: 9_700,
      inPlayerGestureAt: 9_700,
    },
    now: 10_100,
    userGestureGraceMs: 1_200,
  });

  assert.equal(decision.shouldSuppress, true);
});

test("a ratechange-scoped window does not swallow the seek that opened it", () => {
  // Reproduces the observed "seek gets pulled back": the user's `onSeeking`
  // handler cancels the active rate catch-up, the cancel restores the snapshot
  // rate and arms a window microseconds later, and the window then matched the
  // user's own `seeking` broadcast (same url, same time, same rate) and dropped
  // it. With no broadcast, the next peer heartbeat hard-seeked them back.
  const input = {
    programmaticApplyAt: 10_000,
    programmaticApplyUntil: 10_700,
    programmaticApplySignature: {
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      playState: "buffering" as const,
      currentTime: 119.49,
      playbackRate: 2,
    },
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "buffering" as const,
    currentTime: 119.49,
    playbackRate: 2,
    eventSource: "seeking" as const,
    // Swallowed by `isProgrammaticEventEcho`, so the record is still the stale
    // ratechange from before the seek and cannot bypass the guard.
    lastExplicitUserAction: {
      kind: "ratechange" as const,
      at: 9_000,
      inPlayerGestureAt: 9_000,
    },
    now: 10_005,
    userGestureGraceMs: 1_200,
  };

  assert.equal(
    shouldSuppressProgrammaticEvent({
      ...input,
      programmaticApplyScope: "ratechange",
    }).shouldSuppress,
    false,
  );
  // A real apply of a remote state still suppresses the identical echo.
  assert.equal(
    shouldSuppressProgrammaticEvent({ ...input, programmaticApplyScope: "all" })
      .shouldSuppress,
    true,
  );
});

test("a ratechange-scoped window still suppresses its own rate echo", () => {
  const decision = shouldSuppressProgrammaticEvent({
    programmaticApplyAt: 10_000,
    programmaticApplyUntil: 10_700,
    programmaticApplyScope: "ratechange",
    programmaticApplySignature: {
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      playState: "playing",
      currentTime: 119.49,
      playbackRate: 2,
    },
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "playing",
    currentTime: 119.49,
    playbackRate: 2,
    eventSource: "ratechange",
    lastExplicitUserAction: null,
    now: 10_005,
    userGestureGraceMs: 1_200,
  });

  assert.equal(decision.shouldSuppress, true);
  // The window must survive so a follow-up rate echo is caught too.
  assert.equal(decision.nextProgrammaticApplyUntil, 10_700);
});

function createOwnership(
  overrides: Partial<RemoteAppliedPlayback> = {},
): RemoteAppliedPlayback {
  return {
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
    playState: "paused",
    currentTime: 49,
    playbackRate: 1,
    actorId: "remote-member",
    seq: 12,
    appliedAtLocal: 1_000,
    appliedAtMonotonic: 1_000,
    ...overrides,
  };
}

function ownershipInput(
  overrides: Partial<
    Parameters<typeof shouldSuppressLeakedEchoByOwnership>[0]
  > = {},
): Parameters<typeof shouldSuppressLeakedEchoByOwnership>[0] {
  return {
    remoteAppliedPlayback: createOwnership(),
    normalizedCurrentUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
    playState: "paused",
    currentTime: 49,
    playbackRate: 1,
    lastExplicitActionInPlayerGestureAt: 0,
    now: 5_000,
    monotonicNow: 5_000,
    maxAgeMs: 30_000,
    positionToleranceSeconds: 0.2,
    ...overrides,
  };
}

test("ownership suppresses an apply echo that arrives long after the 700ms window", () => {
  // The incident: a cross-video hard seek buffers for seconds, so `seeked` lands
  // 4s after the apply — far outside every wall-clock window.
  const decision = shouldSuppressLeakedEchoByOwnership(ownershipInput());
  assert.equal(decision.shouldSuppress, true);
  assert.equal(decision.releaseReason, null);
  assert.notEqual(decision.nextRemoteAppliedPlayback, null);
});

test("ownership keeps suppressing the second report of the same applied state", () => {
  // `seeked` then `canplay` each report the same standstill; both leaked in the
  // incident, and the second one is what extended the server's veto window.
  const first = shouldSuppressLeakedEchoByOwnership(ownershipInput());
  const second = shouldSuppressLeakedEchoByOwnership(
    ownershipInput({
      remoteAppliedPlayback: first.nextRemoteAppliedPlayback,
      now: 5_120,
    }),
  );
  assert.equal(second.shouldSuppress, true);
});

test("a confirmed playback action releases ownership so the user's own pause broadcasts", () => {
  const decision = shouldSuppressLeakedEchoByOwnership(
    ownershipInput({ lastExplicitActionInPlayerGestureAt: 4_000 }),
  );
  assert.equal(decision.shouldSuppress, false);
  assert.equal(decision.releaseReason, "user-action");
  assert.equal(decision.nextRemoteAppliedPlayback, null);
});

test("an action predating the apply does not release ownership", () => {
  const decision = shouldSuppressLeakedEchoByOwnership(
    ownershipInput({ lastExplicitActionInPlayerGestureAt: 900 }),
  );
  assert.equal(decision.shouldSuppress, true);
  assert.equal(decision.releaseReason, null);
});

test("local playback releases ownership so a start-up is never swallowed", () => {
  // The sharer's autoplay-next start-up is exactly this: the room state was
  // paused, then this side genuinely begins playing.
  const decision = shouldSuppressLeakedEchoByOwnership(
    ownershipInput({ playState: "playing" }),
  );
  assert.equal(decision.shouldSuppress, false);
  assert.equal(decision.releaseReason, "left-state");
});

test("buffering and paused are the same owned standstill", () => {
  // The late `waiting`/`pause` chain a remote paused hard-seek produces is
  // classified as `buffering`. Letting it through would broadcast a playState
  // *change* — not a steady tick — and re-arm the server veto window.
  const decision = shouldSuppressLeakedEchoByOwnership(
    ownershipInput({ playState: "buffering" }),
  );
  assert.equal(decision.shouldSuppress, true);
  assert.equal(decision.releaseReason, null);
  assert.notEqual(decision.nextRemoteAppliedPlayback, null);
});

test("an owned buffering state also suppresses a paused report", () => {
  const decision = shouldSuppressLeakedEchoByOwnership(
    ownershipInput({
      remoteAppliedPlayback: createOwnership({ playState: "buffering" }),
      playState: "paused",
    }),
  );
  assert.equal(decision.shouldSuppress, true);
});

test("a diverged position suppresses nothing but keeps ownership while settling", () => {
  const decision = shouldSuppressLeakedEchoByOwnership(
    ownershipInput({ currentTime: 51 }),
  );
  assert.equal(decision.shouldSuppress, false);
  assert.equal(decision.releaseReason, null);
  assert.notEqual(decision.nextRemoteAppliedPlayback, null);
});

test("a different video releases ownership", () => {
  const decision = shouldSuppressLeakedEchoByOwnership(
    ownershipInput({
      normalizedCurrentUrl: "https://www.bilibili.com/video/BV1other",
    }),
  );
  assert.equal(decision.shouldSuppress, false);
  assert.equal(decision.releaseReason, "url-changed");
});

test("the backstop releases ownership that outlived every designed condition", () => {
  // Ages are measured on the monotonic clock, so that is the one to advance.
  const decision = shouldSuppressLeakedEchoByOwnership(
    ownershipInput({ now: 31_001, monotonicNow: 31_001 }),
  );
  assert.equal(decision.shouldSuppress, false);
  assert.equal(decision.releaseReason, "backstop-age");
  assert.equal(decision.nextRemoteAppliedPlayback, null);
});

test("ownership is only taken for stop-like states, never for playing", () => {
  const url = "https://www.bilibili.com/video/BV1xx411c7mD";
  assert.notEqual(
    rememberRemoteAppliedPlayback({
      playback: createPlayback({ playState: "paused" }),
      normalizedUrl: url,
      now: 1_000,
      monotonicNow: 1_000,
    }),
    null,
  );
  assert.notEqual(
    rememberRemoteAppliedPlayback({
      playback: createPlayback({ playState: "buffering" }),
      normalizedUrl: url,
      now: 1_000,
      monotonicNow: 1_000,
    }),
    null,
  );
  // Playing must not be owned: heartbeats broadcast every 2s while playing, and
  // an ownership covering them would mute the room's drift correction.
  assert.equal(
    rememberRemoteAppliedPlayback({
      playback: createPlayback({ playState: "playing" }),
      normalizedUrl: url,
      now: 1_000,
      monotonicNow: 1_000,
    }),
    null,
  );
  assert.equal(
    rememberRemoteAppliedPlayback({
      playback: createPlayback({ playState: "paused" }),
      normalizedUrl: null,
      now: 1_000,
      monotonicNow: 1_000,
    }),
    null,
  );
});

test("a backwards wall-clock jump does not freeze ownership forever", () => {
  // NTP (or the user) moves the system clock back after the apply. Measured on
  // the wall clock the age is negative, so a single-domain backstop would never
  // fire and a matching pause would be suppressed silently for good.
  const decision = shouldSuppressLeakedEchoByOwnership(
    ownershipInput({
      now: 500, // earlier than appliedAtLocal (1_000)
      monotonicNow: 31_001,
    }),
  );
  assert.equal(decision.shouldSuppress, false);
  assert.equal(decision.releaseReason, "backstop-age");
});

test("a forwards wall-clock jump does not release ownership early", () => {
  // The mirror case: the wall clock leaps ahead, which on a single-domain
  // backstop would drop the protection immediately and let the late echo leak.
  const decision = shouldSuppressLeakedEchoByOwnership(
    ownershipInput({
      now: 10_000_000,
      monotonicNow: 1_200,
    }),
  );
  assert.equal(decision.shouldSuppress, true);
  assert.equal(decision.releaseReason, null);
});
