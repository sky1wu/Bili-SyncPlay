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

export type ProgrammaticApplyScope = "all" | "ratechange";

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
  activeSharedByMemberId: string | null;
  activeRoomCode: string | null;
  hydrationReady: boolean;
  hasReceivedInitialRoomState: boolean;
  pendingRoomStateHydration: boolean;
  intendedPlayState: PlaybackState["playState"];
  intendedPlaybackRate: number;
  lastLocalIntentAt: number;
  lastLocalIntentPlayState: PlaybackState["playState"] | null;
  lastUserGestureAt: number;
  /**
   * Timestamp of the most recent user gesture that lands inside the video player
   * (a pointer/touch on the player container, or a play-toggle key) — a genuine
   * intent to control playback, as opposed to a stray click on blank space / a
   * popup that the document-level `lastUserGestureAt` also records. Used to
   * authorize manual playback of a non-shared video on a "load paused" page so a
   * stray gesture cannot wave the page-load autoplay through.
   */
  lastUserGestureInPlayerAt: number;
  lastExplicitPlaybackAction: ExplicitPlaybackAction | null;
  explicitNonSharedPlaybackUrl: string | null;
  suppressedLocalEndPauseUrl: string | null;
  suppressedLocalEndPauseUntil: number;
  /**
   * Normalized URL of a non-shared page that a non-sharer's player autoplayed
   * into via in-SPA navigation (set by the navigation controller's non-sharer
   * autoplay branch). The playback binding only force-pauses a gesture-less
   * play on a non-shared page when it matches this URL, so a manually opened
   * non-shared video reached by full-page navigation (no prior in-SPA event,
   * hence no marker) is left playable for the user.
   */
  nonSharerAutoplayHoldUrl: string | null;
  /**
   * Normalized URL the local sharer auto-shared as the next video but whose
   * authoritative `room:state` has not arrived yet (`activeSharedUrl` still lags
   * behind it). Lets chained autoplay (A→B→C) keep scheduling: when the player
   * advances B→C before B's `room:state` returns, `activeSharedUrl` is still A,
   * so the navigation guard would otherwise treat B→C as a local detour and not
   * auto-share C. Treating a navigation whose previous page equals this in-flight
   * target as a sharer autoplay re-arms the chain. Cleared once `room:state`
   * confirms it (or another member takes over the share) and on room teardown.
   */
  pendingAutoShareTargetUrl: string | null;
  /**
   * The resolved `/video/...` identity of the room's current shared video when
   * that share is an address-bar-opaque *route* (a festival page shared by its
   * bare `/festival/<id>` url because the page bridge failed to resolve a
   * `bvid`/`cid`). In that state `activeSharedUrl` is itself unstable, so a
   * same-page autoplay to the next video could not be classified or auto-shared.
   * The navigation controller records the resolved identity here when it first
   * discovers the bare-route share's concrete video, then uses it as the stable
   * "from" anchor for the subsequent autoplay. Cleared when the shared url changes
   * (the room confirmed a concrete next video), on leaving the page, and on room
   * teardown.
   */
  resolvedSharedVideoUrl: string | null;
  lastForcedPauseAt: number;
  pauseHoldUntil: number;
  pendingPlaybackApplication: PlaybackState | null;
  programmaticApplyUntil: number;
  /**
   * When the current programmatic-apply window opened. Applying a remote state
   * fires the same DOM events a user would, so distinguishing our own echo from
   * a real interaction needs the window's *start*: only a gesture made after it
   * can belong to the user.
   */
  programmaticApplyAt: number;
  /**
   * Which local events the open window is allowed to explain.
   *
   * `"all"` is a real apply of a remote state: it writes currentTime and/or
   * play/pause, so every transport event that follows may be its echo.
   * `"ratechange"` is the soft-apply cancel restoring its snapshot playback
   * rate — the only DOM event that write can produce. Scoping it matters
   * because that cancel is usually triggered BY the user (their `seeking` /
   * `pause` handler calls it): a window that also claimed their seek would
   * discard the very interaction that opened it.
   */
  programmaticApplyScope: ProgrammaticApplyScope;
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
  /**
   * Set when the local sharer's *own* shared video reaches its natural end.
   * While set, playback broadcasts for this (still the room's) shared URL are
   * suppressed so the autoplay-next handoff does not relay a misleading
   * "paused"/"jumped to 0:00" against the old video to every peer: at a natural
   * end the browser emits an end `pause`, and when Bilibili autoplays the next
   * episode into the same element before the page URL refreshes, a `seek` back
   * to 0 while the page bridge still resolves the old URL. The next auto-share
   * lands moments later; suppressing this transition keeps peers from seeing
   * those two spurious notifications before "shared a new video". Cleared when
   * the next share confirms (via [[resetPlaybackSyncState]]), a fresh user
   * gesture replays it, the page moves on, or [[sharerEndedSuppressionUntil]].
   */
  sharerEndedSuppressionUrl: string | null;
  sharerEndedSuppressionUntil: number;
  /**
   * Timestamp at which [[sharerEndedSuppressionUrl]] was armed. A user replay
   * gesture only releases the suppression when it postdates this; an older
   * gesture (e.g. the sharer dragging to the end or pressing play moments
   * before the natural end) must not be mistaken for a fresh replay, otherwise
   * the next-episode seek-to-0 it precedes would leak out as the very
   * "jumped to 0:00" noise this suppression exists to hide.
   */
  sharerEndedSuppressionArmedAt: number;
  /**
   * The shared video URL that most recently reached its natural end on this
   * page, and when. Unlike [[sharerEndedSuppressionUrl]] /
   * [[suppressedLocalEndPauseUrl]] (which the broadcast gate and
   * `resetUserGestureState` clear eagerly, often before the navigation watcher
   * runs), this pair is a durable "the shared video just ended here" signal that
   * only [[resetPlaybackSyncState]] / room teardown clears. The navigation
   * controller reads it to recognise an autoplay-next even when the address-bar
   * URL form differs (bangumi season pages) or a recent seek-to-the-end leaves
   * the gesture window warm — both of which would otherwise misclassify the
   * advance as a manual switch and skip the auto-share / non-sharer hold.
   */
  sharedVideoNaturalEndUrl: string | null;
  sharedVideoNaturalEndAt: number;
  /**
   * Whether the most recent shared-video natural end was preceded by a user
   * *seek* (the sharer dragging to the last seconds) rather than reached with no
   * recent interaction or a non-seek gesture. Captured at the natural end —
   * before the next page's `play` can overwrite the action state — so the
   * navigation controller can relax the recent-gesture gate *only* for a genuine
   * seek-to-end → autoplay, not for a manual click on another episode that the
   * watcher happens to poll just after the old video fires `ended`.
   */
  sharedVideoNaturalEndAfterSeek: boolean;
  festivalSnapshot: FestivalVideoSnapshot | null;
  /**
   * Timestamp of the most recent `waiting`/`stalled` event from the local
   * video element. Used to distinguish buffer-induced pauses (which should be
   * reported to peers as `buffering`) from user-initiated pauses.
   */
  lastBufferSignalAt: number;
  /**
   * Timestamp when playback listeners were most recently attached to a *new*
   * `<video>` element. Bilibili's player recreates its media element to recover
   * from a buffer stall, and the replacement element starts out paused — no
   * `pause` event ever fires for it, so the pause classifier below has no other
   * way to tell that stall apart from the user pressing pause.
   */
  lastVideoElementBoundAt: number;
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
  state.lastUserGestureInPlayerAt = 0;
  state.lastExplicitPlaybackAction = null;
  state.lastExplicitUserAction = null;
  state.lastNonSharedGuardUrl = null;
  state.lastForcedPauseAt = 0;
  state.suppressedLocalEndPauseUrl = null;
  state.suppressedLocalEndPauseUntil = 0;
  state.nonSharerAutoplayHoldUrl = null;
}

export function createContentRuntimeState(): ContentRuntimeState {
  return {
    localMemberId: null,
    rttMs: null,
    lastLocalPlaybackVersion: null,
    pendingLocalPlaybackOverride: null,
    activeSharedUrl: null,
    activeSharedByMemberId: null,
    activeRoomCode: null,
    hydrationReady: false,
    hasReceivedInitialRoomState: false,
    pendingRoomStateHydration: true,
    intendedPlayState: "paused",
    intendedPlaybackRate: 1,
    lastLocalIntentAt: 0,
    lastLocalIntentPlayState: null,
    lastUserGestureAt: 0,
    lastUserGestureInPlayerAt: 0,
    lastExplicitPlaybackAction: null,
    explicitNonSharedPlaybackUrl: null,
    suppressedLocalEndPauseUrl: null,
    suppressedLocalEndPauseUntil: 0,
    nonSharerAutoplayHoldUrl: null,
    pendingAutoShareTargetUrl: null,
    resolvedSharedVideoUrl: null,
    lastForcedPauseAt: 0,
    pauseHoldUntil: 0,
    pendingPlaybackApplication: null,
    programmaticApplyUntil: 0,
    programmaticApplyAt: 0,
    programmaticApplyScope: "all",
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
    sharerEndedSuppressionUrl: null,
    sharerEndedSuppressionUntil: 0,
    sharerEndedSuppressionArmedAt: 0,
    sharedVideoNaturalEndUrl: null,
    sharedVideoNaturalEndAt: 0,
    sharedVideoNaturalEndAfterSeek: false,
    festivalSnapshot: null,
    lastBufferSignalAt: 0,
    lastVideoElementBoundAt: 0,
    pauseStartedAt: 0,
    pauseClassifiedAsBuffer: false,
    deferredRemotePausedState: null,
    deferredRemotePausedTimerId: null,
  };
}
