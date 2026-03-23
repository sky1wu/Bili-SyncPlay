import type { PlaybackState } from "@bili-syncplay/protocol";
import type {
  ExplicitPlaybackAction,
  ExplicitUserAction,
  ExplicitUserActionKind,
  LocalPlaybackEventSource,
  ProgrammaticPlaybackSignature,
  RecentRemotePlayingIntent,
  SuppressedRemotePlayback,
} from "./runtime-state";

export interface HydrationAutoplayGuardInput {
  activeRoomCode: string | null;
  pendingRoomStateHydration: boolean;
  videoPaused: boolean;
  now: number;
  lastUserGestureAt: number;
  userGestureGraceMs: number;
}

export interface NonSharedPageGuardInput {
  activeRoomCode: string | null;
  activeSharedUrl: string | null;
  normalizedCurrentUrl: string | null;
  videoPaused: boolean;
  explicitNonSharedPlaybackUrl: string | null;
  lastExplicitPlaybackAction: ExplicitPlaybackAction | null;
  now: number;
  userGestureGraceMs: number;
}

export interface RemotePlaybackMemoryInput {
  playback: PlaybackState;
  normalizedUrl: string | null;
  now: number;
  remoteEchoSuppressionMs: number;
  remotePlayTransitionGuardMs: number;
}

export interface LocalEchoGuardInput {
  suppressedRemotePlayback: SuppressedRemotePlayback | null;
  normalizedCurrentUrl: string | null;
  playState: PlaybackState["playState"];
  currentTime: number;
  playbackRate: number;
  now: number;
}

export interface RecentRemoteStopIntentInput {
  now: number;
  pauseHoldUntil: number;
  normalizedCurrentUrl: string | null;
  activeSharedUrl: string | null;
  intendedPlayState: PlaybackState["playState"];
  suppressedRemotePlayback: SuppressedRemotePlayback | null;
}

export interface RemotePlayTransitionGuardInput {
  recentRemotePlayingIntent: RecentRemotePlayingIntent | null;
  normalizedCurrentUrl: string | null;
  playState: PlaybackState["playState"];
  currentTime: number;
  lastExplicitPlaybackAction: ExplicitPlaybackAction | null;
  now: number;
  userGestureGraceMs: number;
}

export interface ProgrammaticEventSuppressionInput {
  programmaticApplyUntil: number;
  programmaticApplySignature: ProgrammaticPlaybackSignature | null;
  normalizedCurrentUrl: string | null;
  playState: PlaybackState["playState"];
  currentTime: number;
  playbackRate: number;
  eventSource: LocalPlaybackEventSource;
  lastExplicitUserAction: ExplicitUserAction | null;
  now: number;
  userGestureGraceMs: number;
}

export interface RemoteFollowupBroadcastSuppressionInput {
  remoteFollowPlayingUntil: number;
  remoteFollowPlayingUrl: string | null;
  normalizedCurrentUrl: string | null;
  playState: PlaybackState["playState"];
  eventSource: LocalPlaybackEventSource;
  lastExplicitUserAction: ExplicitUserAction | null;
  now: number;
  userGestureGraceMs: number;
}

function isRemotePlaybackStateCompatibleForLocalEcho(args: {
  localPlayState: PlaybackState["playState"];
  remotePlayState: PlaybackState["playState"];
}): boolean {
  return (
    args.localPlayState === args.remotePlayState ||
    (args.localPlayState === "buffering" && args.remotePlayState === "playing")
  );
}

function getProgrammaticEventThreshold(
  eventSource: LocalPlaybackEventSource,
  playState: PlaybackState["playState"],
): number {
  if (eventSource === "seeking" || eventSource === "seeked") {
    return 0.6;
  }
  if (eventSource === "loadedmetadata" || eventSource === "canplay") {
    return 0.6;
  }
  if (eventSource === "timeupdate") {
    return 1;
  }
  if (eventSource === "ratechange") {
    return 1.2;
  }
  return playState === "playing" ? 0.9 : 0.25;
}

function mapEventSourceToExplicitAction(
  eventSource: LocalPlaybackEventSource,
): ExplicitUserActionKind | null {
  if (eventSource === "play" || eventSource === "playing") {
    return "play";
  }
  if (eventSource === "pause") {
    return "pause";
  }
  if (eventSource === "seeking" || eventSource === "seeked") {
    return "seek";
  }
  if (eventSource === "ratechange") {
    return "ratechange";
  }
  return null;
}

export function shouldForcePauseWhileWaitingForInitialRoomState(
  input: HydrationAutoplayGuardInput,
): boolean {
  if (
    !input.activeRoomCode ||
    !input.pendingRoomStateHydration ||
    input.videoPaused
  ) {
    return false;
  }

  return input.now - input.lastUserGestureAt >= input.userGestureGraceMs;
}

export function evaluateNonSharedPageGuard(input: NonSharedPageGuardInput): {
  shouldPause: boolean;
  nextExplicitNonSharedPlaybackUrl: string | null;
} {
  if (!input.activeRoomCode || !input.activeSharedUrl) {
    return {
      shouldPause: false,
      nextExplicitNonSharedPlaybackUrl: input.explicitNonSharedPlaybackUrl,
    };
  }

  if (
    !input.normalizedCurrentUrl ||
    input.normalizedCurrentUrl === input.activeSharedUrl
  ) {
    return {
      shouldPause: false,
      nextExplicitNonSharedPlaybackUrl: null,
    };
  }

  if (input.videoPaused) {
    return {
      shouldPause: true,
      nextExplicitNonSharedPlaybackUrl: input.explicitNonSharedPlaybackUrl,
    };
  }

  if (input.explicitNonSharedPlaybackUrl === input.normalizedCurrentUrl) {
    return {
      shouldPause: false,
      nextExplicitNonSharedPlaybackUrl: input.explicitNonSharedPlaybackUrl,
    };
  }

  const hasRecentExplicitPlay =
    input.lastExplicitPlaybackAction?.playState === "playing" &&
    input.now - input.lastExplicitPlaybackAction.at < input.userGestureGraceMs;

  if (hasRecentExplicitPlay) {
    return {
      shouldPause: false,
      nextExplicitNonSharedPlaybackUrl: input.normalizedCurrentUrl,
    };
  }

  return {
    shouldPause: true,
    nextExplicitNonSharedPlaybackUrl: input.explicitNonSharedPlaybackUrl,
  };
}

export function rememberRemotePlaybackForSuppression(
  input: RemotePlaybackMemoryInput,
): {
  suppressedRemotePlayback: SuppressedRemotePlayback | null;
  recentRemotePlayingIntent: RecentRemotePlayingIntent | null;
} {
  if (!input.normalizedUrl) {
    return {
      suppressedRemotePlayback: null,
      recentRemotePlayingIntent: null,
    };
  }

  return {
    suppressedRemotePlayback: {
      until: input.now + input.remoteEchoSuppressionMs,
      url: input.normalizedUrl,
      playState: input.playback.playState,
      currentTime: input.playback.currentTime,
      playbackRate: input.playback.playbackRate,
    },
    recentRemotePlayingIntent:
      input.playback.playState === "playing"
        ? {
            until: input.now + input.remotePlayTransitionGuardMs,
            url: input.normalizedUrl,
            currentTime: input.playback.currentTime,
          }
        : null,
  };
}

export function shouldSuppressLocalEcho(input: LocalEchoGuardInput): {
  shouldSuppress: boolean;
  nextSuppressedRemotePlayback: SuppressedRemotePlayback | null;
} {
  if (!input.suppressedRemotePlayback) {
    return {
      shouldSuppress: false,
      nextSuppressedRemotePlayback: null,
    };
  }

  if (input.now >= input.suppressedRemotePlayback.until) {
    return {
      shouldSuppress: false,
      nextSuppressedRemotePlayback: null,
    };
  }

  if (
    input.normalizedCurrentUrl !== input.suppressedRemotePlayback.url ||
    !isRemotePlaybackStateCompatibleForLocalEcho({
      localPlayState: input.playState,
      remotePlayState: input.suppressedRemotePlayback.playState,
    }) ||
    Math.abs(input.playbackRate - input.suppressedRemotePlayback.playbackRate) >
      0.01
  ) {
    return {
      shouldSuppress: false,
      nextSuppressedRemotePlayback: input.suppressedRemotePlayback,
    };
  }

  const delta = Math.abs(
    input.currentTime - input.suppressedRemotePlayback.currentTime,
  );
  const threshold =
    input.playState === "playing" &&
    input.suppressedRemotePlayback.playState === "playing"
      ? 0.9
      : 0.2;
  return {
    shouldSuppress: delta <= threshold,
    nextSuppressedRemotePlayback: input.suppressedRemotePlayback,
  };
}

export function shouldSuppressProgrammaticEvent(
  input: ProgrammaticEventSuppressionInput,
): {
  shouldSuppress: boolean;
  nextProgrammaticApplyUntil: number;
  nextProgrammaticApplySignature: ProgrammaticPlaybackSignature | null;
} {
  if (!input.programmaticApplySignature) {
    return {
      shouldSuppress: false,
      nextProgrammaticApplyUntil: 0,
      nextProgrammaticApplySignature: null,
    };
  }

  if (input.now >= input.programmaticApplyUntil) {
    return {
      shouldSuppress: false,
      nextProgrammaticApplyUntil: 0,
      nextProgrammaticApplySignature: null,
    };
  }

  if (
    !input.normalizedCurrentUrl ||
    input.normalizedCurrentUrl !== input.programmaticApplySignature.url
  ) {
    return {
      shouldSuppress: false,
      nextProgrammaticApplyUntil: input.programmaticApplyUntil,
      nextProgrammaticApplySignature: input.programmaticApplySignature,
    };
  }

  const matchedExplicitAction = mapEventSourceToExplicitAction(
    input.eventSource,
  );
  if (
    matchedExplicitAction &&
    input.lastExplicitUserAction?.kind === matchedExplicitAction &&
    input.now - input.lastExplicitUserAction.at < input.userGestureGraceMs
  ) {
    return {
      shouldSuppress: false,
      nextProgrammaticApplyUntil: input.programmaticApplyUntil,
      nextProgrammaticApplySignature: input.programmaticApplySignature,
    };
  }

  if (
    input.playState !== input.programmaticApplySignature.playState ||
    Math.abs(
      input.playbackRate - input.programmaticApplySignature.playbackRate,
    ) > 0.01
  ) {
    return {
      shouldSuppress: false,
      nextProgrammaticApplyUntil: input.programmaticApplyUntil,
      nextProgrammaticApplySignature: input.programmaticApplySignature,
    };
  }

  const delta = Math.abs(
    input.currentTime - input.programmaticApplySignature.currentTime,
  );
  return {
    shouldSuppress:
      delta <=
      getProgrammaticEventThreshold(input.eventSource, input.playState),
    nextProgrammaticApplyUntil: input.programmaticApplyUntil,
    nextProgrammaticApplySignature: input.programmaticApplySignature,
  };
}

export function shouldSuppressRemoteFollowupBroadcast(
  input: RemoteFollowupBroadcastSuppressionInput,
): {
  shouldSuppress: boolean;
  nextRemoteFollowPlayingUntil: number;
  nextRemoteFollowPlayingUrl: string | null;
} {
  if (!input.remoteFollowPlayingUrl || input.remoteFollowPlayingUntil <= 0) {
    return {
      shouldSuppress: false,
      nextRemoteFollowPlayingUntil: 0,
      nextRemoteFollowPlayingUrl: null,
    };
  }

  if (input.now >= input.remoteFollowPlayingUntil) {
    return {
      shouldSuppress: false,
      nextRemoteFollowPlayingUntil: 0,
      nextRemoteFollowPlayingUrl: null,
    };
  }

  if (
    !input.normalizedCurrentUrl ||
    input.normalizedCurrentUrl !== input.remoteFollowPlayingUrl
  ) {
    return {
      shouldSuppress: false,
      nextRemoteFollowPlayingUntil: 0,
      nextRemoteFollowPlayingUrl: null,
    };
  }

  if (input.playState === "paused") {
    return {
      shouldSuppress: false,
      nextRemoteFollowPlayingUntil: 0,
      nextRemoteFollowPlayingUrl: null,
    };
  }

  if (input.playState === "buffering") {
    return {
      shouldSuppress: false,
      nextRemoteFollowPlayingUntil: input.remoteFollowPlayingUntil,
      nextRemoteFollowPlayingUrl: input.remoteFollowPlayingUrl,
    };
  }

  const matchedExplicitAction = mapEventSourceToExplicitAction(
    input.eventSource,
  );
  if (
    matchedExplicitAction &&
    input.lastExplicitUserAction?.kind === matchedExplicitAction &&
    input.now - input.lastExplicitUserAction.at < input.userGestureGraceMs
  ) {
    return {
      shouldSuppress: false,
      nextRemoteFollowPlayingUntil: input.remoteFollowPlayingUntil,
      nextRemoteFollowPlayingUrl: input.remoteFollowPlayingUrl,
    };
  }

  return {
    shouldSuppress: true,
    nextRemoteFollowPlayingUntil: input.remoteFollowPlayingUntil,
    nextRemoteFollowPlayingUrl: input.remoteFollowPlayingUrl,
  };
}

export function hasRecentRemoteStopIntent(
  input: RecentRemoteStopIntentInput,
): boolean {
  if (input.now >= input.pauseHoldUntil || !input.normalizedCurrentUrl) {
    return false;
  }

  if (
    input.activeSharedUrl &&
    input.normalizedCurrentUrl !== input.activeSharedUrl
  ) {
    return false;
  }

  if (
    input.intendedPlayState === "paused" ||
    input.intendedPlayState === "buffering"
  ) {
    return true;
  }

  if (
    !input.suppressedRemotePlayback ||
    input.normalizedCurrentUrl !== input.suppressedRemotePlayback.url
  ) {
    return false;
  }

  return (
    input.suppressedRemotePlayback.playState === "paused" ||
    input.suppressedRemotePlayback.playState === "buffering"
  );
}

export function shouldSuppressRemotePlayTransition(
  input: RemotePlayTransitionGuardInput,
): {
  shouldSuppress: boolean;
  nextRecentRemotePlayingIntent: RecentRemotePlayingIntent | null;
} {
  if (!input.recentRemotePlayingIntent) {
    return {
      shouldSuppress: false,
      nextRecentRemotePlayingIntent: null,
    };
  }

  if (input.now >= input.recentRemotePlayingIntent.until) {
    return {
      shouldSuppress: false,
      nextRecentRemotePlayingIntent: null,
    };
  }

  if (
    input.normalizedCurrentUrl !== input.recentRemotePlayingIntent.url ||
    input.playState === "playing"
  ) {
    return {
      shouldSuppress: false,
      nextRecentRemotePlayingIntent: input.recentRemotePlayingIntent,
    };
  }

  const hasRecentExplicitPause =
    input.lastExplicitPlaybackAction?.playState === "paused" &&
    input.playState === "paused" &&
    input.now - input.lastExplicitPlaybackAction.at < input.userGestureGraceMs;

  if (hasRecentExplicitPause) {
    return {
      shouldSuppress: false,
      nextRecentRemotePlayingIntent: input.recentRemotePlayingIntent,
    };
  }

  return {
    shouldSuppress:
      Math.abs(
        input.currentTime - input.recentRemotePlayingIntent.currentTime,
      ) <= 1.5,
    nextRecentRemotePlayingIntent: input.recentRemotePlayingIntent,
  };
}

export function shouldApplySelfPlayback(args: {
  videoPaused: boolean;
  videoCurrentTime: number;
  videoPlaybackRate: number;
  playback: PlaybackState;
}): boolean {
  const timeDelta = Math.abs(args.videoCurrentTime - args.playback.currentTime);
  const rateDelta = Math.abs(
    args.videoPlaybackRate - args.playback.playbackRate,
  );

  if (
    (args.playback.playState === "paused" ||
      args.playback.playState === "buffering") &&
    !args.videoPaused
  ) {
    return true;
  }
  if (args.playback.playState === "playing" && args.videoPaused) {
    return true;
  }
  return timeDelta > 0.6 || rateDelta > 0.01;
}
