import assert from "node:assert/strict";
import test from "node:test";
import type { PlaybackState } from "@bili-syncplay/protocol";
import {
  evaluateNonSharedPageGuard,
  hasRecentRemoteStopIntent,
  rememberRemotePlaybackForSuppression,
  shouldApplySelfPlayback,
  shouldForcePauseWhileWaitingForInitialRoomState,
  shouldSuppressRemoteFollowupBroadcast,
  shouldSuppressLocalEcho,
  shouldSuppressProgrammaticEvent,
  shouldSuppressRemotePlayTransition,
} from "../src/content/sync-guards";

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

test("suppresses autoplay while waiting for initial hydration without a recent user gesture", () => {
  assert.equal(
    shouldForcePauseWhileWaitingForInitialRoomState({
      activeRoomCode: "ROOM01",
      pendingRoomStateHydration: true,
      videoPaused: false,
      now: 5_000,
      lastUserGestureAt: 2_000,
      userGestureGraceMs: 1_200,
    }),
    true,
  );
});

test("allows user-initiated playback during initial hydration grace window", () => {
  assert.equal(
    shouldForcePauseWhileWaitingForInitialRoomState({
      activeRoomCode: "ROOM01",
      pendingRoomStateHydration: true,
      videoPaused: false,
      now: 5_000,
      lastUserGestureAt: 4_400,
      userGestureGraceMs: 1_200,
    }),
    false,
  );
});

test("protects non-shared pages from remote autoplay unless the user explicitly started playback", () => {
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
      programmaticApplyUntil: 10_500,
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
      programmaticApplyUntil: 10_500,
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
      programmaticApplyUntil: 10_500,
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

test("allows explicit user actions to bypass programmatic suppression", () => {
  assert.equal(
    shouldSuppressProgrammaticEvent({
      programmaticApplyUntil: 10_500,
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
    },
    now: 12_300,
    userGestureGraceMs: 1_200,
  });

  assert.equal(decision.shouldSuppress, false);
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

  assert.equal(bufferingDecision.shouldSuppress, false);
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
