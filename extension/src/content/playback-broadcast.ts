import type { PlaybackState, SharedVideo } from "@bili-syncplay/protocol";
import type { LocalPlaybackEventSource } from "./runtime-state";

const EXPLICIT_SEEK_BROADCAST_GRACE_MS = 2_500;

export function shouldSkipBroadcastWhileHydrating(args: {
  pendingRoomStateHydration: boolean;
  now: number;
  lastUserGestureAt: number;
  userGestureGraceMs: number;
}): boolean {
  if (!args.pendingRoomStateHydration) {
    return false;
  }

  return args.now - args.lastUserGestureAt >= args.userGestureGraceMs;
}

export function shouldPauseForNonSharedBroadcast(args: {
  activeRoomCode: string | null;
  activeSharedUrl: string | null;
  normalizedCurrentVideoUrl: string | null;
  explicitNonSharedPlaybackUrl: string | null;
  playState: PlaybackState["playState"];
  lastExplicitPlaybackAction: {
    playState: "playing" | "paused";
    at: number;
  } | null;
  now: number;
  userGestureGraceMs: number;
}): boolean {
  if (
    !args.activeRoomCode ||
    !args.activeSharedUrl ||
    args.normalizedCurrentVideoUrl === args.activeSharedUrl
  ) {
    return false;
  }

  if (
    args.playState !== "playing" ||
    args.explicitNonSharedPlaybackUrl === args.normalizedCurrentVideoUrl
  ) {
    return false;
  }

  return !(
    args.lastExplicitPlaybackAction &&
    args.lastExplicitPlaybackAction.playState === "playing" &&
    args.now - args.lastExplicitPlaybackAction.at < args.userGestureGraceMs
  );
}

export function createPlaybackBroadcastPayload(args: {
  currentVideo: SharedVideo;
  currentTime: number;
  playState: PlaybackState["playState"];
  syncIntent?: PlaybackState["syncIntent"];
  userInitiated?: boolean;
  naturalEnd?: boolean;
  playbackRate: number;
  actorId: string;
  seq: number;
  now: number;
}): PlaybackState {
  const payload: PlaybackState = {
    url: args.currentVideo.url,
    currentTime: args.currentTime,
    playState: args.playState,
    syncIntent: args.syncIntent,
    playbackRate: args.playbackRate,
    updatedAt: args.now,
    serverTime: 0,
    actorId: args.actorId,
    seq: args.seq,
  };
  // Omit these flags entirely (instead of serializing `false`) when not set, so
  // we stay byte-identical to legacy senders on the wire for non-user pauses.
  if (args.userInitiated) {
    payload.userInitiated = true;
  }
  if (args.naturalEnd) {
    payload.naturalEnd = true;
  }
  return payload;
}

/**
 * Returns `true` when this broadcast represents a true user-driven pause
 * (e.g. the user clicked pause on the player). False/undefined otherwise.
 *
 * The signal is consumed by peers to skip the remote-pause flicker debounce,
 * so it must be conservative: any pause that *could* be buffer-induced,
 * programmatic-apply-induced, or post-forced-pause must NOT be marked.
 */
export function deriveUserInitiatedPause(args: {
  eventSource: LocalPlaybackEventSource;
  playState: PlaybackState["playState"];
  lastExplicitUserAction: {
    kind: "play" | "pause" | "seek" | "ratechange";
    at: number;
  } | null;
  lastForcedPauseAt: number;
  programmaticApplyUntil: number;
  programmaticApplyPlayState: PlaybackState["playState"] | null;
  now: number;
  userGestureGraceMs: number;
}): boolean {
  if (args.eventSource !== "pause" || args.playState !== "paused") {
    return false;
  }
  if (
    !args.lastExplicitUserAction ||
    args.lastExplicitUserAction.kind !== "pause" ||
    args.lastExplicitUserAction.at <= args.lastForcedPauseAt ||
    args.now - args.lastExplicitUserAction.at >= args.userGestureGraceMs
  ) {
    return false;
  }
  // A programmatic remote-paused apply also fires a `pause` DOM event. Even
  // though we usually suppress that broadcast via the programmatic guard,
  // belt-and-braces: never tag the broadcast as user-initiated while a
  // matching paused-apply window is still open.
  if (
    args.programmaticApplyPlayState === "paused" &&
    args.now < args.programmaticApplyUntil
  ) {
    return false;
  }
  return true;
}

export function derivePlaybackSyncIntent(args: {
  eventSource: LocalPlaybackEventSource;
  lastExplicitUserAction: {
    kind: "play" | "pause" | "seek" | "ratechange";
    at: number;
  } | null;
  lastForcedPauseAt: number;
  now: number;
  userGestureGraceMs: number;
}): PlaybackState["syncIntent"] | undefined {
  const hasActiveExplicitUserAction =
    args.lastExplicitUserAction &&
    args.lastExplicitUserAction.at > args.lastForcedPauseAt;

  if (
    args.eventSource === "ratechange" &&
    hasActiveExplicitUserAction &&
    args.lastExplicitUserAction.kind === "ratechange" &&
    args.now - args.lastExplicitUserAction.at < args.userGestureGraceMs
  ) {
    return "explicit-ratechange";
  }

  if (
    (args.eventSource !== "seeking" &&
      args.eventSource !== "seeked" &&
      args.eventSource !== "play" &&
      args.eventSource !== "playing" &&
      args.eventSource !== "canplay" &&
      args.eventSource !== "timeupdate") ||
    !hasActiveExplicitUserAction ||
    args.lastExplicitUserAction.kind !== "seek" ||
    args.now - args.lastExplicitUserAction.at >=
      Math.max(args.userGestureGraceMs, EXPLICIT_SEEK_BROADCAST_GRACE_MS)
  ) {
    return undefined;
  }

  return "explicit-seek";
}
