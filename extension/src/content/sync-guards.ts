import type { PlaybackState } from "@bili-syncplay/protocol";
import type {
  ExplicitPlaybackAction,
  ExplicitUserAction,
  ExplicitUserActionKind,
  LocalPlaybackEventSource,
  ProgrammaticApplyScope,
  ProgrammaticPlaybackSignature,
  RecentRemotePlayingIntent,
  RemoteAppliedPlayback,
  SuppressedRemotePlayback,
} from "./runtime-state";

export interface HydrationAutoplayGuardInput {
  activeRoomCode: string | null;
  pendingRoomStateHydration: boolean;
  videoPaused: boolean;
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

export interface RemoteOwnershipEchoGuardInput {
  remoteAppliedPlayback: RemoteAppliedPlayback | null;
  normalizedCurrentUrl: string | null;
  playState: PlaybackState["playState"];
  currentTime: number;
  playbackRate: number;
  lastUserGestureInPlayerAt: number;
  now: number;
  maxAgeMs: number;
  positionToleranceSeconds: number;
}

export type RemoteOwnershipReleaseReason =
  "user-gesture" | "left-state" | "url-changed" | "backstop-age";

export interface RemoteOwnershipEchoDecision {
  shouldSuppress: boolean;
  nextRemoteAppliedPlayback: RemoteAppliedPlayback | null;
  releaseReason: RemoteOwnershipReleaseReason | null;
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
  /** When the current programmatic-apply window opened. */
  programmaticApplyAt: number;
  /** Which event sources the open window is allowed to explain. */
  programmaticApplyScope: ProgrammaticApplyScope;
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

function isProgrammaticPlaybackStateCompatible(args: {
  eventPlayState: PlaybackState["playState"];
  signaturePlayState: PlaybackState["playState"];
}): boolean {
  return (
    args.eventPlayState === args.signaturePlayState ||
    (args.eventPlayState === "buffering" &&
      args.signaturePlayState === "playing")
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

  return true;
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

/**
 * Recognise a local event as the echo of a stop-like state the room asked this
 * side to apply, in the window where [[shouldSuppressLocalEcho]] can no longer
 * tell: its 700ms wall clock has run out, but the transport event it was meant
 * to cover has only just arrived (a cross-video hard seek has to buffer first).
 *
 * Ownership is released, rather than consulted, whenever something proves the
 * state is no longer the room's:
 *
 * - `user-gesture` — a gesture *inside the player* postdating the apply. This is
 *   checked first and deliberately reads the in-player timestamp, not the
 *   document-level one: a stray click on blank page area must not hand the state
 *   back, while a real interaction always must, or the user's own pause would be
 *   swallowed silently.
 * - `left-state` — the local player reached `playing`. It moved on its own, so
 *   nothing that follows is this apply's echo. (`paused` ⇄ `buffering` is not a
 *   departure: both are the same stop-like state mid-transition, and treating
 *   the flicker as a departure would reopen the leak.)
 * - `url-changed` — a different video is on screen; the ownership belonged to
 *   the old one.
 * - `backstop-age` — pure defence against a contamination source that was not
 *   enumerated. Reaching it means one of the conditions above should have fired
 *   and did not, so callers log it as a warning rather than treating it as
 *   routine.
 *
 * A non-matching position or rate suppresses nothing but does *not* release:
 * the player may still be settling toward the target, and releasing on the first
 * intermediate sample would put the leak back.
 */
export function shouldSuppressLeakedEchoByOwnership(
  input: RemoteOwnershipEchoGuardInput,
): RemoteOwnershipEchoDecision {
  const owned = input.remoteAppliedPlayback;
  if (!owned) {
    return {
      shouldSuppress: false,
      nextRemoteAppliedPlayback: null,
      releaseReason: null,
    };
  }

  const release = (
    reason: RemoteOwnershipReleaseReason,
  ): RemoteOwnershipEchoDecision => ({
    shouldSuppress: false,
    nextRemoteAppliedPlayback: null,
    releaseReason: reason,
  });

  if (input.lastUserGestureInPlayerAt > owned.appliedAtLocal) {
    return release("user-gesture");
  }

  if (input.normalizedCurrentUrl !== owned.url) {
    return release("url-changed");
  }

  if (input.playState === "playing") {
    return release("left-state");
  }

  if (input.now - owned.appliedAtLocal >= input.maxAgeMs) {
    return release("backstop-age");
  }

  const matchesState = input.playState === owned.playState;
  const matchesRate = Math.abs(input.playbackRate - owned.playbackRate) <= 0.01;
  const matchesPosition =
    Math.abs(input.currentTime - owned.currentTime) <=
    input.positionToleranceSeconds;

  return {
    shouldSuppress: matchesState && matchesRate && matchesPosition,
    nextRemoteAppliedPlayback: owned,
    releaseReason: null,
  };
}

/**
 * Take ownership of a stop-like state this side is about to apply on the room's
 * behalf. A `playing` state is never owned — see [[RemoteAppliedPlayback]].
 */
export function rememberRemoteAppliedPlayback(input: {
  playback: PlaybackState;
  normalizedUrl: string | null;
  now: number;
}): RemoteAppliedPlayback | null {
  if (!input.normalizedUrl) {
    return null;
  }
  if (
    input.playback.playState !== "paused" &&
    input.playback.playState !== "buffering"
  ) {
    return null;
  }
  return {
    url: input.normalizedUrl,
    playState: input.playback.playState,
    currentTime: input.playback.currentTime,
    playbackRate: input.playback.playbackRate,
    actorId: input.playback.actorId,
    seq: input.playback.seq,
    appliedAtLocal: input.now,
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

  // A ratechange-scoped window was opened by the soft-apply cancel restoring
  // its snapshot rate, and a rate write produces exactly one DOM event. Any
  // other transport event inside it belongs to whatever triggered the cancel —
  // usually the user's own seek or pause, which must still reach the room.
  // The window stays armed so the `ratechange` it exists for is still caught.
  if (
    input.programmaticApplyScope === "ratechange" &&
    input.eventSource !== "ratechange"
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
  // The bypass exists so a genuine user action DURING an apply is not mistaken
  // for our own echo. An action recorded BEFORE the window opened is not
  // evidence about anything happening inside it: the user may have seeked
  // moments before a remote state arrived, and honouring that stale record here
  // lets the apply's own `seeking`/`play` echo pass as an explicit action and be
  // broadcast straight back to the room.
  if (
    matchedExplicitAction &&
    input.lastExplicitUserAction?.kind === matchedExplicitAction &&
    input.lastExplicitUserAction.at >= input.programmaticApplyAt &&
    input.now - input.lastExplicitUserAction.at < input.userGestureGraceMs
  ) {
    return {
      shouldSuppress: false,
      nextProgrammaticApplyUntil: input.programmaticApplyUntil,
      nextProgrammaticApplySignature: input.programmaticApplySignature,
    };
  }

  if (
    !isProgrammaticPlaybackStateCompatible({
      eventPlayState: input.playState,
      signaturePlayState: input.programmaticApplySignature.playState,
    }) ||
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
      shouldSuppress:
        input.eventSource === "waiting" || input.eventSource === "stalled",
      nextRemoteFollowPlayingUntil: input.remoteFollowPlayingUntil,
      nextRemoteFollowPlayingUrl: input.remoteFollowPlayingUrl,
    };
  }

  const matchedExplicitAction = mapEventSourceToExplicitAction(
    input.eventSource,
  );
  const hasRecentExplicitSeek =
    input.lastExplicitUserAction?.kind === "seek" &&
    input.now - input.lastExplicitUserAction.at < input.userGestureGraceMs;
  if (
    (matchedExplicitAction &&
      input.lastExplicitUserAction?.kind === matchedExplicitAction &&
      input.now - input.lastExplicitUserAction.at < input.userGestureGraceMs) ||
    (hasRecentExplicitSeek &&
      (input.eventSource === "play" ||
        input.eventSource === "playing" ||
        input.eventSource === "canplay"))
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

  if (input.intendedPlayState === "paused") {
    return true;
  }

  if (
    !input.suppressedRemotePlayback ||
    input.normalizedCurrentUrl !== input.suppressedRemotePlayback.url
  ) {
    return false;
  }

  return input.suppressedRemotePlayback.playState === "paused";
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
