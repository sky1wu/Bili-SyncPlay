import type { PlaybackState, RoomState } from "@bili-syncplay/protocol";

export interface FestivalVideoSnapshot {
  videoId: string;
  url: string;
  title: string;
  updatedAt: number;
}

export interface ExplicitPlaybackAction {
  playState: "playing" | "paused";
  at: number;
}

export interface SuppressedRemotePlayback {
  until: number;
  url: string;
  playState: PlaybackState["playState"];
  currentTime: number;
  playbackRate: number;
}

export interface RecentRemotePlayingIntent {
  until: number;
  url: string;
  currentTime: number;
}

export type LocalPlaybackEventSource =
  | "play"
  | "pause"
  | "waiting"
  | "stalled"
  | "loadedmetadata"
  | "canplay"
  | "playing"
  | "seeking"
  | "seeked"
  | "ratechange"
  | "timeupdate"
  | "manual";

export type ExplicitUserActionKind = "play" | "pause" | "seek" | "ratechange";

export interface ExplicitUserAction {
  kind: ExplicitUserActionKind;
  at: number;
}

export interface ProgrammaticPlaybackSignature {
  url: string;
  playState: PlaybackState["playState"];
  currentTime: number;
  playbackRate: number;
}

export type PendingLocalPlaybackOverrideKind = "seek" | "ratechange";

export interface PendingLocalPlaybackOverride {
  kind: PendingLocalPlaybackOverrideKind;
  url: string;
  seq: number;
  expiresAt: number;
  targetTime?: number;
  playbackRate?: number;
}

export interface ContentRuntimeState {
  localMemberId: string | null;
  rttMs: number | null;
  lastLocalPlaybackVersion: { serverTime: number; seq: number } | null;
  pendingLocalPlaybackOverride: PendingLocalPlaybackOverride | null;
  activeSharedUrl: string | null;
  activeRoomCode: string | null;
  hydrationReady: boolean;
  hasReceivedInitialRoomState: boolean;
  pendingRoomStateHydration: boolean;
  intendedPlayState: PlaybackState["playState"];
  intendedPlaybackRate: number;
  lastLocalIntentAt: number;
  lastLocalIntentPlayState: PlaybackState["playState"] | null;
  lastUserGestureAt: number;
  lastExplicitPlaybackAction: ExplicitPlaybackAction | null;
  explicitNonSharedPlaybackUrl: string | null;
  lastForcedPauseAt: number;
  pauseHoldUntil: number;
  pendingPlaybackApplication: PlaybackState | null;
  programmaticApplyUntil: number;
  programmaticApplySignature: ProgrammaticPlaybackSignature | null;
  softApplyCooldownUntil: number;
  softApplyCooldownUrl: string | null;
  remoteFollowPlayingUntil: number;
  remoteFollowPlayingUrl: string | null;
  suppressedRemotePlayback: SuppressedRemotePlayback | null;
  recentRemotePlayingIntent: RecentRemotePlayingIntent | null;
  lastExplicitUserAction: ExplicitUserAction | null;
  lastNonSharedGuardUrl: string | null;
  /**
   * Captures `activeSharedUrl` at the moment in-room SPA navigation is
   * detected. Used as a "settle anchor": until the page bridge resolves the
   * new page to a normalized URL different from this anchor (or the room's
   * shared video changes), playback broadcasts are suppressed so that stale
   * page-bridge data captured during the SPA transition (typically from old
   * `__INITIAL_STATE__.epInfo` that has not yet been refreshed) cannot leak
   * out as bogus updates against the previously shared video.
   */
  postNavigationAnchorSharedUrl: string | null;
  postNavigationAnchorSetAt: number;
  festivalSnapshot: FestivalVideoSnapshot | null;
  /**
   * Timestamp of the most recent `waiting`/`stalled` event from the local
   * video element. Used to distinguish buffer-induced pauses (which should be
   * reported to peers as `buffering`) from user-initiated pauses.
   */
  lastBufferSignalAt: number;
  /**
   * Timestamp when the local video most recently transitioned to `paused`.
   * Reset to 0 once playback resumes. Together with
   * [[pauseClassifiedAsBuffer]] this powers the "buffer-pause → buffering"
   * remote broadcast classification and its upgrade-to-`paused` timeout.
   */
  pauseStartedAt: number;
  /**
   * Whether the active pause is currently classified as buffer-induced. Set
   * on the `pause` event when a `waiting`/`stalled` signal occurred very
   * recently and no fresh user gesture preceded the pause; cleared on
   * resume. The broadcast layer reports `buffering` instead of `paused`
   * while this flag is on and within the upgrade threshold.
   */
  pauseClassifiedAsBuffer: boolean;
  /**
   * When a remote `paused` room state arrives, we briefly hold off applying
   * it to absorb the common "buffer hiccup" pattern where the remote sends
   * `paused` then immediately `playing` within ~1s. While this field is set,
   * a matching `playing` arrival (same URL, |t-delta| < 0.5s) drops the
   * deferred paused entirely.
   */
  deferredRemotePausedState: RoomState | null;
  deferredRemotePausedTimerId: number | null;
}

/**
 * Clear stale user gesture and explicit action state.
 *
 * Call this when the playback context changes (e.g. in-room SPA navigation)
 * so that timestamps from the previous page cannot trick autoplay detection
 * into treating browser-initiated playback as a user action.
 */
export function resetUserGestureState(state: ContentRuntimeState): void {
  state.lastUserGestureAt = 0;
  state.lastExplicitPlaybackAction = null;
  state.lastExplicitUserAction = null;
  state.lastNonSharedGuardUrl = null;
  state.lastForcedPauseAt = 0;
}

export function createContentRuntimeState(): ContentRuntimeState {
  return {
    localMemberId: null,
    rttMs: null,
    lastLocalPlaybackVersion: null,
    pendingLocalPlaybackOverride: null,
    activeSharedUrl: null,
    activeRoomCode: null,
    hydrationReady: false,
    hasReceivedInitialRoomState: false,
    pendingRoomStateHydration: true,
    intendedPlayState: "paused",
    intendedPlaybackRate: 1,
    lastLocalIntentAt: 0,
    lastLocalIntentPlayState: null,
    lastUserGestureAt: 0,
    lastExplicitPlaybackAction: null,
    explicitNonSharedPlaybackUrl: null,
    lastForcedPauseAt: 0,
    pauseHoldUntil: 0,
    pendingPlaybackApplication: null,
    programmaticApplyUntil: 0,
    programmaticApplySignature: null,
    softApplyCooldownUntil: 0,
    softApplyCooldownUrl: null,
    remoteFollowPlayingUntil: 0,
    remoteFollowPlayingUrl: null,
    suppressedRemotePlayback: null,
    recentRemotePlayingIntent: null,
    lastExplicitUserAction: null,
    lastNonSharedGuardUrl: null,
    postNavigationAnchorSharedUrl: null,
    postNavigationAnchorSetAt: 0,
    festivalSnapshot: null,
    lastBufferSignalAt: 0,
    pauseStartedAt: 0,
    pauseClassifiedAsBuffer: false,
    deferredRemotePausedState: null,
    deferredRemotePausedTimerId: null,
  };
}
