import type { SharedVideo } from "@bili-syncplay/protocol";
import {
  bindVideoElement,
  getVideoElement,
  pauseVideo,
} from "./player-binding";
import {
  evaluateNonSharedPageGuard,
  shouldForcePauseWhileWaitingForInitialRoomState,
} from "./sync-guards";
import type {
  ContentRuntimeState,
  ExplicitUserActionKind,
  LocalPlaybackEventSource,
} from "./runtime-state";
import {
  hasStableSharedVideoIdentity,
  isUnstableSharedVideoUrl,
} from "./video-identity";

export interface PlaybackBindingController {
  start(): void;
  attachPlaybackListeners(): void;
  destroy(): void;
}

export function createPlaybackBindingController(args: {
  runtimeState: ContentRuntimeState;
  videoBindIntervalMs: number;
  userGestureGraceMs: number;
  initialRoomStatePauseHoldMs: number;
  /**
   * Window after a `waiting`/`stalled` event during which a subsequent
   * `pause` event is presumed buffer-induced rather than user-initiated.
   */
  bufferSignalWindowMs: number;
  /**
   * Maximum duration to keep reporting a buffer-induced pause as
   * `buffering` to peers before re-broadcasting it as `paused`. Bounds the
   * worst-case desync if a buffer stall turns into a real stop.
   */
  bufferPauseUpgradeMs: number;
  getSharedVideo: () => SharedVideo | null;
  hasRecentRemoteStopIntent: (currentVideoUrl: string) => boolean;
  normalizeUrl: (url: string | undefined | null) => string | null;
  getLastBroadcastAt: () => number;
  broadcastPlayback: (
    video: HTMLVideoElement,
    eventSource?: LocalPlaybackEventSource,
  ) => Promise<void>;
  cancelActiveSoftApply: (
    video: HTMLVideoElement | null,
    reason: string,
  ) => void;
  maintainActiveSoftApply: (video: HTMLVideoElement) => void;
  applyPendingPlaybackApplication: (video: HTMLVideoElement) => void;
  activatePauseHold: (durationMs?: number) => void;
  debugLog: (message: string) => void;
  getNow?: () => number;
}): PlaybackBindingController {
  let videoBindingTimer: number | null = null;
  let pauseBufferUpgradeTimerId: number | null = null;
  let sharerEndedFlushTimerId: number | null = null;
  const nowOf = () => args.getNow?.() ?? Date.now();
  const scheduleUpgradeTimer = (cb: () => void, ms: number): number | null => {
    if (
      typeof globalThis.window !== "undefined" &&
      typeof globalThis.window.setTimeout === "function"
    ) {
      return globalThis.window.setTimeout(cb, ms) as unknown as number;
    }
    if (typeof globalThis.setTimeout === "function") {
      return globalThis.setTimeout(cb, ms) as unknown as number;
    }
    return null;
  };
  const cancelUpgradeTimer = (id: number): void => {
    if (
      typeof globalThis.window !== "undefined" &&
      typeof globalThis.window.clearTimeout === "function"
    ) {
      globalThis.window.clearTimeout(id);
      return;
    }
    if (typeof globalThis.clearTimeout === "function") {
      globalThis.clearTimeout(id);
    }
  };
  const clearBufferUpgradeTimer = () => {
    if (pauseBufferUpgradeTimerId !== null) {
      cancelUpgradeTimer(pauseBufferUpgradeTimerId);
      pauseBufferUpgradeTimerId = null;
    }
  };
  const clearSharerEndedFlushTimer = () => {
    if (sharerEndedFlushTimerId !== null) {
      cancelUpgradeTimer(sharerEndedFlushTimerId);
      sharerEndedFlushTimerId = null;
    }
  };
  const clearActivePauseClassification = () => {
    args.runtimeState.pauseStartedAt = 0;
    args.runtimeState.pauseClassifiedAsBuffer = false;
    clearBufferUpgradeTimer();
  };
  const hasRecentUserGesture = () =>
    nowOf() - args.runtimeState.lastUserGestureAt < args.userGestureGraceMs;
  // A genuine intent to control the player (pointer inside the player container
  // or a play-toggle key), as opposed to any document-level gesture. Authorizing
  // playback on a "load paused" non-shared page requires this stronger signal so
  // a stray click on blank space / a popup cannot wave the page-load autoplay
  // through.
  const hasRecentUserGestureInPlayer = () =>
    nowOf() - args.runtimeState.lastUserGestureInPlayerAt <
    args.userGestureGraceMs;
  // A FRESH in-player play intent: an in-player gesture that also postdates the
  // last forced pause. While the page bridge resolves, the unconfirmed-context
  // hold force-pauses (updating `lastForcedPauseAt`); the SAME click that
  // triggered that pause must not then authorize the delayed `play`/`playing`
  // once the bridge resolves — only a gesture made AFTER the forced pause counts
  // as a new play intent (mirrors `shouldPreRecordNonSharedExplicitPlay`).
  const hasFreshInPlayerPlayIntent = () =>
    hasRecentUserGestureInPlayer() &&
    args.runtimeState.lastUserGestureInPlayerAt >
      args.runtimeState.lastForcedPauseAt;
  const getRecentExplicitSeekWithoutNewGestureAt = (): number | null => {
    const explicitAction = args.runtimeState.lastExplicitUserAction;
    if (
      explicitAction?.kind !== "seek" ||
      nowOf() - explicitAction.at >= args.userGestureGraceMs
    ) {
      return null;
    }

    return args.runtimeState.lastUserGestureAt <= explicitAction.at
      ? explicitAction.at
      : null;
  };

  function scheduleBroadcast(
    video: HTMLVideoElement,
    eventSource: LocalPlaybackEventSource,
    followUpMs?: number,
  ) {
    void args.broadcastPlayback(video, eventSource);
    if (followUpMs) {
      window.setTimeout(() => {
        void args.broadcastPlayback(video, eventSource);
      }, followUpMs);
    }
  }

  function rememberExplicitPlaybackAction(playState: "playing" | "paused") {
    if (
      nowOf() - args.runtimeState.lastUserGestureAt < args.userGestureGraceMs &&
      args.runtimeState.lastUserGestureAt > args.runtimeState.lastForcedPauseAt
    ) {
      args.runtimeState.lastExplicitPlaybackAction = {
        playState,
        at: nowOf(),
      };
    }
  }

  function rememberExplicitUserAction(kind: ExplicitUserActionKind) {
    if (
      nowOf() - args.runtimeState.lastUserGestureAt < args.userGestureGraceMs &&
      args.runtimeState.lastUserGestureAt > args.runtimeState.lastForcedPauseAt
    ) {
      if (
        kind === "play" &&
        args.runtimeState.lastExplicitUserAction?.kind === "seek" &&
        nowOf() - args.runtimeState.lastExplicitUserAction.at <
          args.userGestureGraceMs &&
        args.runtimeState.lastUserGestureAt <=
          args.runtimeState.lastExplicitUserAction.at
      ) {
        return;
      }
      args.runtimeState.lastExplicitUserAction = {
        kind,
        at: nowOf(),
      };
    }
  }

  function shouldTreatRateChangeAsProgrammatic(
    video: HTMLVideoElement,
  ): boolean {
    const signature = args.runtimeState.programmaticApplySignature;
    if (!signature || nowOf() >= args.runtimeState.programmaticApplyUntil) {
      return false;
    }

    const currentVideo = args.getSharedVideo();
    const normalizedCurrentUrl = args.normalizeUrl(currentVideo?.url);
    if (!normalizedCurrentUrl || normalizedCurrentUrl !== signature.url) {
      return false;
    }

    return Math.abs(video.playbackRate - signature.playbackRate) <= 0.01;
  }

  function isCurrentVideoShared(currentVideo: SharedVideo | null): boolean {
    if (!currentVideo || !args.runtimeState.activeSharedUrl) {
      return false;
    }
    return (
      args.normalizeUrl(currentVideo.url) === args.runtimeState.activeSharedUrl
    );
  }

  /**
   * Record that the room's shared video reached its natural end on this page.
   * This durable timestamp (cleared only by a shared-url change / room teardown)
   * lets the navigation controller recognise the autoplay-next that follows,
   * independent of the broadcast-suppression markers it clears eagerly. Set for
   * both roles — the sharer uses it to auto-share, a non-sharer to hold.
   */
  function markSharedVideoNaturalEnd(): void {
    if (
      !args.runtimeState.activeRoomCode ||
      !args.runtimeState.activeSharedUrl ||
      !isCurrentVideoShared(args.getSharedVideo())
    ) {
      return;
    }
    args.runtimeState.sharedVideoNaturalEndUrl =
      args.runtimeState.activeSharedUrl;
    args.runtimeState.sharedVideoNaturalEndAt = nowOf();
    // Whether this end was reached right after an in-video seek (seek-to-end),
    // captured now while the old page's action state is still intact (the next
    // page's `play` has not yet overwritten it). The navigation controller only
    // relaxes the recent-gesture gate for this case — a manual click on another
    // episode does not record a fresh seek, so it stays a manual navigation.
    const lastAction = args.runtimeState.lastExplicitUserAction;
    args.runtimeState.sharedVideoNaturalEndAfterSeek = Boolean(
      lastAction?.kind === "seek" &&
      args.runtimeState.lastUserGestureAt <= lastAction.at,
    );
  }

  function isLocalSharedSource(): boolean {
    return Boolean(
      args.runtimeState.localMemberId &&
      args.runtimeState.activeSharedByMemberId &&
      args.runtimeState.localMemberId ===
        args.runtimeState.activeSharedByMemberId,
    );
  }

  function shouldHoldNonSharerAtSharedVideoEnd(): boolean {
    if (
      !args.runtimeState.activeRoomCode ||
      !args.runtimeState.activeSharedUrl ||
      !args.runtimeState.localMemberId ||
      !args.runtimeState.activeSharedByMemberId ||
      isLocalSharedSource()
    ) {
      return false;
    }

    return isCurrentVideoShared(args.getSharedVideo());
  }

  /**
   * Hold a non-sharer paused once the shared video reaches its natural end.
   *
   * We intentionally wait for the real `ended` event instead of pausing a fixed
   * margin before the end: pre-pausing stopped the non-sharer prematurely (and
   * cut off the final frames/audio) whenever no auto-advance actually followed —
   * e.g. Bilibili autoplay disabled or no next episode. By acting on `ended` the
   * viewer always sees the whole video, while the armed pause hold plus the
   * resume guard re-pause any local autoplay that continues in the same element
   * (multi-part videos); cross-video autoplay is handled by the navigation
   * controller.
   */
  function holdNonSharerAtSharedVideoEnd(video: HTMLVideoElement): boolean {
    if (!shouldHoldNonSharerAtSharedVideoEnd()) {
      return false;
    }

    args.runtimeState.intendedPlayState = "paused";
    args.runtimeState.lastForcedPauseAt = nowOf();
    args.runtimeState.suppressedLocalEndPauseUrl =
      args.runtimeState.activeSharedUrl;
    args.runtimeState.suppressedLocalEndPauseUntil =
      nowOf() + args.initialRoomStatePauseHoldMs;
    args.activatePauseHold(args.initialRoomStatePauseHoldMs);
    args.debugLog(
      `Held non-sharer at shared video natural end to block local autoplay-next`,
    );
    pauseVideo(video);
    return true;
  }

  /**
   * Arm broadcast suppression when the local *sharer's* own shared video reaches
   * its natural end. Unlike the non-sharer hold this does not pause the player —
   * the sharer must keep playing to autoplay into the next episode — it only
   * stops the end `pause` (and the next-episode seek-to-0 emitted while the page
   * URL still resolves the old video) from being broadcast as updates against
   * the still-shared old video. Without it every peer would briefly see
   * "{sharer} paused the video" and "{sharer} jumped to 0:00" right before the
   * auto-share of the next video lands. The suppression is released by
   * {@link createSyncController}'s broadcast gate once the next share confirms, a
   * fresh user gesture replays it, the page moves on, or the timeout elapses.
   *
   * When no autoplay-next actually follows (the last episode, or Bilibili
   * autoplay disabled) there is no later navigation/share/seek to drive the
   * gate's lazy clear, so a deferred flush re-broadcasts the terminal paused
   * state once the suppression window elapses; otherwise the room — and any
   * new joiners — would keep seeing the shared video as still playing.
   */
  function armSharerSharedVideoEndSuppression(): boolean {
    if (
      !args.runtimeState.activeRoomCode ||
      !args.runtimeState.activeSharedUrl ||
      !args.runtimeState.localMemberId ||
      !args.runtimeState.activeSharedByMemberId ||
      !isLocalSharedSource() ||
      !isCurrentVideoShared(args.getSharedVideo())
    ) {
      // DIAGNOSTIC: report which condition blocked arming so a missed
      // autoplay-next (e.g. a seek to the very end advancing without it) can be
      // traced. `currentVideoShared` is the common suspect when the page bridge
      // resolves the next part before the end fires.
      args.debugLog(
        `Sharer end-of-video suppression not armed (room=${Boolean(
          args.runtimeState.activeRoomCode,
        )} sharedUrl=${Boolean(
          args.runtimeState.activeSharedUrl,
        )} localMember=${Boolean(
          args.runtimeState.localMemberId,
        )} sharedBy=${Boolean(
          args.runtimeState.activeSharedByMemberId,
        )} localSharer=${isLocalSharedSource()} currentVideoShared=${isCurrentVideoShared(
          args.getSharedVideo(),
        )} resolved=${args.normalizeUrl(args.getSharedVideo()?.url)} active=${args.runtimeState.activeSharedUrl})`,
      );
      return false;
    }

    const armedUrl = args.runtimeState.activeSharedUrl;
    args.runtimeState.sharerEndedSuppressionUrl = armedUrl;
    args.runtimeState.sharerEndedSuppressionUntil =
      nowOf() + args.initialRoomStatePauseHoldMs;
    args.runtimeState.sharerEndedSuppressionArmedAt = nowOf();
    clearSharerEndedFlushTimer();
    sharerEndedFlushTimerId = scheduleUpgradeTimer(() => {
      sharerEndedFlushTimerId = null;
      flushSharerEndedSuppressionIfTerminal(armedUrl);
    }, args.initialRoomStatePauseHoldMs);
    args.debugLog(
      `Suppressed sharer end-of-video broadcasts to keep autoplay-next handoff quiet`,
    );
    return true;
  }

  /**
   * Resolve the armed sharer end-of-video suppression once its window elapses.
   * If the marker is still set for the same shared URL and the player is still
   * the sharer parked at the end of that video, no autoplay-next followed: clear
   * the marker and broadcast the terminal paused state so peers and new joiners
   * stop seeing the shared video as playing. If anything moved on (handoff,
   * navigation, ownership change) the gate/reset already cleared it, so this is
   * a no-op beyond tidying the marker.
   */
  function flushSharerEndedSuppressionIfTerminal(armedUrl: string): void {
    if (args.runtimeState.sharerEndedSuppressionUrl !== armedUrl) {
      return;
    }
    const video = getVideoElement();
    const currentVideo = args.getSharedVideo();
    // Require `ended` specifically: a genuine terminal end leaves the element
    // parked at `ended`, whereas any autoplay continuation (cross-video or
    // multi-part) clears it. This avoids flushing a spurious pause during a
    // slow handoff where the next episode is mid-load.
    const stillTerminalOnSameSharedVideo = Boolean(
      video &&
      video.ended &&
      isLocalSharedSource() &&
      isCurrentVideoShared(currentVideo) &&
      args.normalizeUrl(currentVideo?.url) === armedUrl,
    );
    args.runtimeState.sharerEndedSuppressionUrl = null;
    args.runtimeState.sharerEndedSuppressionUntil = 0;
    args.runtimeState.sharerEndedSuppressionArmedAt = 0;
    if (!video || !stillTerminalOnSameSharedVideo) {
      return;
    }
    args.debugLog(
      `Flushed sharer end-of-video paused state after no autoplay-next followed`,
    );
    void args.broadcastPlayback(video, "pause");
  }

  function shouldReapplyHoldAfterSharedVideoEnd(
    video: HTMLVideoElement,
    currentVideo: SharedVideo | null,
  ): boolean {
    return Boolean(
      currentVideo &&
      isCurrentVideoShared(currentVideo) &&
      args.runtimeState.intendedPlayState !== "playing" &&
      args.runtimeState.suppressedLocalEndPauseUrl !== null &&
      nowOf() < args.runtimeState.suppressedLocalEndPauseUntil &&
      args.normalizeUrl(currentVideo.url) ===
        args.runtimeState.suppressedLocalEndPauseUrl &&
      nowOf() - args.runtimeState.lastUserGestureAt >=
        args.userGestureGraceMs &&
      !video.paused,
    );
  }

  function isKnownNonSharedVideo(currentVideo: SharedVideo | null): boolean {
    const activeSharedUrl = args.runtimeState.activeSharedUrl;
    return Boolean(
      currentVideo &&
      hasStableSharedVideoIdentity(currentVideo) &&
      activeSharedUrl &&
      !isUnstableSharedVideoUrl(activeSharedUrl) &&
      !isCurrentVideoShared(currentVideo),
    );
  }

  function hasUnconfirmedSharedVideoContext(
    currentVideo: SharedVideo | null,
  ): boolean {
    return Boolean(
      !currentVideo ||
      !hasStableSharedVideoIdentity(currentVideo) ||
      isUnstableSharedVideoUrl(args.runtimeState.activeSharedUrl),
    );
  }

  function shouldPreRecordNonSharedExplicitPlay(): boolean {
    const currentVideo = args.getSharedVideo();
    // Require a FRESH in-player gesture (not just any document-level one, and one
    // that postdates the forced pause): this is what authorizes manual play of a
    // non-shared video on a load-paused page, so a stray click elsewhere followed
    // by the page-load autoplay is not mistaken for the user pressing play.
    if (!hasFreshInPlayerPlayIntent() || !isKnownNonSharedVideo(currentVideo)) {
      return false;
    }

    // When the browser auto-seeks to a resume point and then auto-plays,
    // the play event is browser-initiated, not an explicit user play gesture.
    // Only block when the seek belongs to the CURRENT gesture
    // (lastUserGestureAt <= seek time), meaning no newer user gesture
    // has occurred since the seek.
    const lastAction = args.runtimeState.lastExplicitUserAction;
    if (
      lastAction?.kind === "seek" &&
      nowOf() - lastAction.at < args.userGestureGraceMs &&
      args.runtimeState.lastUserGestureAt <= lastAction.at
    ) {
      return false;
    }

    return true;
  }

  function preAuthorizeExplicitNonSharedPlay(): void {
    const currentVideo = args.getSharedVideo();
    const normalizedCurrentUrl = args.normalizeUrl(currentVideo?.url);
    if (!normalizedCurrentUrl || !isKnownNonSharedVideo(currentVideo)) {
      return;
    }

    rememberExplicitPlaybackAction("playing");
    args.runtimeState.explicitNonSharedPlaybackUrl = normalizedCurrentUrl;
    // The user has taken control of this resolved non-shared video, so the
    // "load paused" hold has done its job. Drop the autoplay-hold marker for it
    // and release the pause hold so a later transient `currentVideo === null`
    // blip (player rebuild / buffer recovery) cannot re-pause the playback the
    // user just authorized.
    if (args.runtimeState.nonSharerAutoplayHoldUrl === normalizedCurrentUrl) {
      args.runtimeState.nonSharerAutoplayHoldUrl = null;
    }
    args.runtimeState.pauseHoldUntil = 0;
  }

  function forcePauseWhileWaitingForInitialRoomState(
    video: HTMLVideoElement,
  ): boolean {
    const currentVideo = args.getSharedVideo();
    if (isKnownNonSharedVideo(currentVideo)) {
      return false;
    }

    if (
      !shouldForcePauseWhileWaitingForInitialRoomState({
        activeRoomCode: args.runtimeState.activeRoomCode,
        pendingRoomStateHydration: args.runtimeState.pendingRoomStateHydration,
        videoPaused: video.paused,
      })
    ) {
      return false;
    }

    args.debugLog(
      `Suppressed page autoplay while waiting for initial room state of ${args.runtimeState.activeRoomCode}`,
    );
    args.runtimeState.intendedPlayState = "paused";
    args.runtimeState.lastForcedPauseAt = nowOf();
    window.setTimeout(() => {
      if (!video.paused) {
        pauseVideo(video);
      }
    }, 0);
    return true;
  }

  function shouldReapplyPauseHoldForUnconfirmedSharedVideo(
    currentVideo: SharedVideo | null,
  ): boolean {
    if (
      !args.runtimeState.activeRoomCode ||
      !args.runtimeState.activeSharedUrl ||
      nowOf() >= args.runtimeState.pauseHoldUntil
    ) {
      return false;
    }

    if (
      args.runtimeState.intendedPlayState !== "paused" &&
      args.runtimeState.intendedPlayState !== "buffering"
    ) {
      return false;
    }

    // While the page bridge has not yet produced `currentVideo`, every play —
    // including one carrying a fresh user gesture — is re-paused. We cannot
    // distinguish a real play-button press from a stray document-level gesture
    // (the tracker records any `pointerdown`/`click`/`keydown`) followed by the
    // page's own delayed autoplay, and there is no resolved video to anchor an
    // authorization on. So the "load paused" hold stays in force until the bridge
    // resolves the URL; manual play is honored only afterwards, via
    // `preAuthorizeExplicitNonSharedPlay`, which has a concrete
    // `isKnownNonSharedVideo` anchor.
    return hasUnconfirmedSharedVideoContext(currentVideo);
  }

  function forcePauseOnNonSharedPage(video: HTMLVideoElement): boolean {
    if (
      !args.runtimeState.activeRoomCode ||
      !args.runtimeState.activeSharedUrl
    ) {
      return false;
    }
    if (isUnstableSharedVideoUrl(args.runtimeState.activeSharedUrl)) {
      args.runtimeState.explicitNonSharedPlaybackUrl = null;
      args.runtimeState.lastNonSharedGuardUrl = null;
      return false;
    }

    const currentVideo = args.getSharedVideo();
    const normalizedCurrentUrl = args.normalizeUrl(currentVideo?.url);
    if (!currentVideo) {
      // The page bridge transiently returns no current video (player rebuild /
      // buffer recovery) without any real navigation. Do NOT clear
      // `explicitNonSharedPlaybackUrl` here: dropping the authorization on such a
      // blip would let a later autoplay-next off this manually-played video go
      // unclassified by the navigation controller (no
      // `previousExplicitNonSharedPlaybackUrl`), autoplaying the next episode. A
      // genuine navigation clears it via the navigation reset; a manual pause
      // clears it in `onPause`.
      return false;
    }
    if (!hasStableSharedVideoIdentity(currentVideo)) {
      args.runtimeState.explicitNonSharedPlaybackUrl = null;
      args.runtimeState.lastNonSharedGuardUrl = null;
      return false;
    }

    if (
      normalizedCurrentUrl &&
      normalizedCurrentUrl !== args.runtimeState.activeSharedUrl &&
      normalizedCurrentUrl !== args.runtimeState.lastNonSharedGuardUrl
    ) {
      args.runtimeState.lastNonSharedGuardUrl = normalizedCurrentUrl;
      args.runtimeState.lastExplicitPlaybackAction = null;
    } else if (
      !normalizedCurrentUrl ||
      normalizedCurrentUrl === args.runtimeState.activeSharedUrl
    ) {
      args.runtimeState.lastNonSharedGuardUrl = null;
    }

    const decision = evaluateNonSharedPageGuard({
      activeRoomCode: args.runtimeState.activeRoomCode,
      activeSharedUrl: args.runtimeState.activeSharedUrl,
      normalizedCurrentUrl,
      videoPaused: video.paused,
      explicitNonSharedPlaybackUrl:
        args.runtimeState.explicitNonSharedPlaybackUrl,
      lastExplicitPlaybackAction: args.runtimeState.lastExplicitPlaybackAction,
      now: nowOf(),
      userGestureGraceMs: args.userGestureGraceMs,
    });

    if (
      !normalizedCurrentUrl ||
      normalizedCurrentUrl === args.runtimeState.activeSharedUrl
    ) {
      args.runtimeState.explicitNonSharedPlaybackUrl = null;
      return false;
    }

    args.runtimeState.explicitNonSharedPlaybackUrl =
      decision.nextExplicitNonSharedPlaybackUrl;
    if (decision.shouldPause) {
      args.debugLog(
        `Ignored non-shared playback guard for ${currentVideo.url}`,
      );
    }
    return decision.shouldPause;
  }

  function attachPlaybackListeners(): void {
    const video = getVideoElement();
    if (!video) {
      return;
    }

    const guardUnexpectedResume = () => {
      const currentVideo = args.getSharedVideo();
      const recentSeekWithoutNewGestureAt =
        getRecentExplicitSeekWithoutNewGestureAt();
      const shouldBlockSeekTriggeredAutoplay =
        currentVideo &&
        isCurrentVideoShared(currentVideo) &&
        args.runtimeState.intendedPlayState !== "playing" &&
        recentSeekWithoutNewGestureAt !== null;

      if (shouldBlockSeekTriggeredAutoplay) {
        args.debugLog(
          `Forced pause reapplied after seek-triggered autoplay intended=${args.runtimeState.intendedPlayState}`,
        );
        args.runtimeState.lastExplicitUserAction = null;
        args.runtimeState.lastExplicitPlaybackAction = null;
        args.runtimeState.lastForcedPauseAt = nowOf();
        window.setTimeout(() => {
          pauseVideo(video);
        }, 0);
        return true;
      }

      if (shouldReapplyHoldAfterSharedVideoEnd(video, currentVideo)) {
        // The non-sharer's player resumed right after we held it at the shared
        // video's natural end. This is local multi-part autoplay continuing in
        // the same element (no URL change for the navigation controller to
        // catch), so re-pause it to keep the non-sharer from running ahead of
        // the room.
        args.debugLog(
          `Re-paused non-sharer multi-part autoplay after shared video natural end`,
        );
        args.runtimeState.lastForcedPauseAt = nowOf();
        window.setTimeout(() => {
          pauseVideo(video);
        }, 0);
        return true;
      }

      if (
        currentVideo &&
        isCurrentVideoShared(currentVideo) &&
        args.hasRecentRemoteStopIntent(currentVideo.url) &&
        args.runtimeState.intendedPlayState !== "playing" &&
        nowOf() - args.runtimeState.lastUserGestureAt >= args.userGestureGraceMs
      ) {
        args.debugLog(
          `Forced pause hold reapplied after unexpected resume intended=${args.runtimeState.intendedPlayState}`,
        );
        args.runtimeState.lastForcedPauseAt = nowOf();
        window.setTimeout(() => {
          pauseVideo(video);
        }, 0);
        return true;
      }

      if (shouldReapplyPauseHoldForUnconfirmedSharedVideo(currentVideo)) {
        args.debugLog(
          `Forced pause hold reapplied for unconfirmed shared video context intended=${args.runtimeState.intendedPlayState}`,
        );
        args.runtimeState.explicitNonSharedPlaybackUrl = null;
        args.runtimeState.lastNonSharedGuardUrl = null;
        args.runtimeState.lastForcedPauseAt = nowOf();
        window.setTimeout(() => {
          pauseVideo(video);
        }, 0);
        return true;
      }

      // While the page bridge has not resolved `currentVideo`, a play on a held
      // non-shared page is force-paused by
      // `shouldReapplyPauseHoldForUnconfirmedSharedVideo` — but only while the
      // pause hold (`pauseHoldUntil`, ~`initialRoomStatePauseHoldMs`) is still
      // active. We deliberately do NOT keep pausing past that bound: if the bridge
      // never produces a current video (script/ad stage stuck or bridge failure),
      // an unbounded hold would trap the user in "load paused" forever with no way
      // to manually play this local video. After the hold window elapses we stop
      // forcing pause on the still-unresolved page, accepting that a late
      // page-load autoplay may then start — that is the bounded escape hatch for a
      // genuine manual play the user makes once the hold has expired.

      if (forcePauseOnNonSharedPage(video)) {
        // `forcePauseOnNonSharedPage` only suppresses the broadcast; it does not
        // stop the local element. A play with a recent IN-PLAYER gesture is the
        // user's own non-shared playback and is left to run (broadcast still
        // suppressed). A play without one on a page the navigation controller
        // flagged as a non-sharer autoplay (`nonSharerAutoplayHoldUrl`) is
        // autoplay into the next episode: we must actually pause it, otherwise it
        // keeps playing while the room stays on the shared video. The gesture must
        // be in-player (not any document-level click) so a stray click on blank
        // space / a popup cannot leave the page-load autoplay running. Gate on the
        // marker rather than on the pause hold still being active, because a slow
        // SPA load/ad can delay the `play`/`playing` event past
        // `initialRoomStatePauseHoldMs`. Requiring the marker also avoids pausing
        // a non-shared video the user manually opened via full-page navigation
        // (address bar/bookmark/direct link): that page was never reached through
        // an in-SPA autoplay, so it carries no marker and is left playable.
        const normalizedCurrentUrl = args.normalizeUrl(
          args.getSharedVideo()?.url,
        );
        if (
          !hasFreshInPlayerPlayIntent() &&
          (args.runtimeState.intendedPlayState === "paused" ||
            args.runtimeState.intendedPlayState === "buffering") &&
          normalizedCurrentUrl !== null &&
          normalizedCurrentUrl === args.runtimeState.nonSharerAutoplayHoldUrl
        ) {
          args.debugLog(
            "Forced pause for delayed non-sharer autoplay into non-shared video",
          );
          args.runtimeState.lastForcedPauseAt = nowOf();
          window.setTimeout(() => {
            pauseVideo(video);
          }, 0);
        }
        return true;
      }
      if (forcePauseWhileWaitingForInitialRoomState(video)) {
        return true;
      }
      return false;
    };

    bindVideoElement({
      video,
      onPlay: () => {
        if (shouldPreRecordNonSharedExplicitPlay()) {
          preAuthorizeExplicitNonSharedPlay();
        }
        if (guardUnexpectedResume()) {
          return;
        }
        clearActivePauseClassification();
        rememberExplicitPlaybackAction("playing");
        rememberExplicitUserAction("play");
        scheduleBroadcast(video, "play", 180);
      },
      onPause: () => {
        const currentVideo = args.getSharedVideo();
        // At a natural end the browser dispatches `pause` immediately before
        // `ended`. Record the durable natural-end timestamp (for both roles)
        // before any early return, then arm the non-sharer end-hold here
        // (idempotent with the `ended` handler) and skip the broadcast:
        // otherwise this end `pause` is sent to the room before `onEnded`
        // establishes the suppression marker, flipping the room to paused and
        // disrupting the sharer's autoplay-next advance.
        if (video.ended) {
          markSharedVideoNaturalEnd();
        }
        if (video.ended && holdNonSharerAtSharedVideoEnd(video)) {
          return;
        }
        // Same natural-end window for the sharer: do not pause (autoplay-next
        // must continue) but suppress this end `pause` broadcast so peers are not
        // shown a spurious "paused"/"jumped to 0:00" against the old video before
        // the next auto-share lands. See armSharerSharedVideoEndSuppression.
        if (video.ended && armSharerSharedVideoEndSuppression()) {
          return;
        }
        if (hasRecentUserGesture()) {
          args.cancelActiveSoftApply(video, "pause");
        }
        const now = nowOf();
        const recentBufferSignal =
          args.runtimeState.lastBufferSignalAt > 0 &&
          now - args.runtimeState.lastBufferSignalAt <
            args.bufferSignalWindowMs;
        const userInitiatedPause =
          hasRecentUserGesture() &&
          args.runtimeState.lastUserGestureAt >
            args.runtimeState.lastForcedPauseAt;
        // When applying a remote `paused`, we hard-seek then call `video.pause()`.
        // The seek trips a `waiting` event milliseconds before the `pause`, so the
        // buffer-signal window will look "fresh" even though no real stall occurred.
        // Classifying this as buffer-induced would (a) escape the programmatic
        // suppression (signature=paused vs broadcast=buffering) and leak the
        // applied state back out, and (b) record lastLocalIntent=buffering,
        // which blocks the peer's next `playing` via local-intent-guard for up
        // to LOCAL_INTENT_GUARD_MS — the visible "resume takes a few seconds"
        // symptom after a remote pause→play.
        const programmaticSignature =
          args.runtimeState.programmaticApplySignature;
        const normalizedSharedUrl = args.normalizeUrl(currentVideo?.url);
        const insideProgrammaticPausedWindow =
          programmaticSignature !== null &&
          programmaticSignature.playState === "paused" &&
          now < args.runtimeState.programmaticApplyUntil &&
          normalizedSharedUrl !== null &&
          normalizedSharedUrl === programmaticSignature.url;
        const bufferInduced =
          !insideProgrammaticPausedWindow &&
          recentBufferSignal &&
          !userInitiatedPause;
        args.runtimeState.pauseStartedAt = now;
        args.runtimeState.pauseClassifiedAsBuffer = bufferInduced;
        clearBufferUpgradeTimer();
        if (bufferInduced) {
          pauseBufferUpgradeTimerId = scheduleUpgradeTimer(() => {
            pauseBufferUpgradeTimerId = null;
            if (!video.paused) {
              return;
            }
            args.runtimeState.pauseClassifiedAsBuffer = false;
            args.debugLog(
              `Buffer-pause upgraded to paused after ${args.bufferPauseUpgradeMs}ms, re-broadcasting`,
            );
            void args.broadcastPlayback(video, "pause");
          }, args.bufferPauseUpgradeMs);
        }
        rememberExplicitPlaybackAction("paused");
        rememberExplicitUserAction("pause");
        // Deauthorize the non-shared video the user paused — UNLESS this `pause`
        // is the natural end of the video (the browser fires `pause` immediately
        // before `ended`). At a natural end the player is about to autoplay the
        // next episode; the navigation controller classifies that autoplay-next as
        // a user-driven local navigation (load paused) via
        // `previousExplicitNonSharedPlaybackUrl`, but it only sees the SPA URL
        // change AFTER this handler runs. Clearing the authorization here would
        // make that classification fail and let the next episode autoplay, so keep
        // it until the navigation reset replaces it.
        if (
          !video.ended &&
          currentVideo &&
          args.normalizeUrl(currentVideo.url) ===
            args.runtimeState.explicitNonSharedPlaybackUrl
        ) {
          args.runtimeState.explicitNonSharedPlaybackUrl = null;
        }
        scheduleBroadcast(video, "pause", 120);
      },
      onWaiting: () => {
        args.runtimeState.lastBufferSignalAt = nowOf();
        scheduleBroadcast(video, "waiting");
      },
      onStalled: () => {
        args.runtimeState.lastBufferSignalAt = nowOf();
        scheduleBroadcast(video, "stalled");
      },
      onLoadedMetadata: () => {
        if (!forcePauseWhileWaitingForInitialRoomState(video)) {
          args.applyPendingPlaybackApplication(video);
        }
      },
      onCanPlay: () => {
        if (!forcePauseWhileWaitingForInitialRoomState(video)) {
          args.applyPendingPlaybackApplication(video);
        }
        scheduleBroadcast(video, "canplay", 120);
      },
      onPlaying: () => {
        if (shouldPreRecordNonSharedExplicitPlay()) {
          preAuthorizeExplicitNonSharedPlay();
        }
        if (guardUnexpectedResume()) {
          return;
        }
        clearActivePauseClassification();
        rememberExplicitPlaybackAction("playing");
        rememberExplicitUserAction("play");
        scheduleBroadcast(video, "playing", 180);
      },
      onSeeking: () => {
        if (hasRecentUserGesture()) {
          args.cancelActiveSoftApply(video, "seek");
        }
        rememberExplicitUserAction("seek");
        scheduleBroadcast(video, "seeking");
      },
      onSeeked: () => {
        if (hasRecentUserGesture()) {
          args.cancelActiveSoftApply(video, "seek");
        }
        rememberExplicitUserAction("seek");
        scheduleBroadcast(video, "seeked", 120);
      },
      onRateChange: () => {
        if (!shouldTreatRateChangeAsProgrammatic(video)) {
          rememberExplicitUserAction("ratechange");
        }
        scheduleBroadcast(video, "ratechange", 120);
      },
      onEnded: () => {
        // DIAGNOSTIC: confirm the natural-end event actually fires. A seek to
        // the very end can make Bilibili's multipart player advance to the next
        // part without an `ended`, so the end-suppression marker is never armed.
        args.debugLog(
          `onEnded fired (ended=${video.ended} currentTime=${video.currentTime.toFixed(2)} resolved=${args.normalizeUrl(args.getSharedVideo()?.url)})`,
        );
        markSharedVideoNaturalEnd();
        if (!holdNonSharerAtSharedVideoEnd(video)) {
          armSharerSharedVideoEndSuppression();
        }
      },
      onTimeUpdate: () => {
        args.maintainActiveSoftApply(video);
        if (nowOf() - args.getLastBroadcastAt() > 2000 && !video.paused) {
          void args.broadcastPlayback(video, "timeupdate");
        }
      },
    });
  }

  return {
    start() {
      attachPlaybackListeners();
      if (videoBindingTimer === null) {
        videoBindingTimer = window.setInterval(
          attachPlaybackListeners,
          args.videoBindIntervalMs,
        );
      }
    },
    attachPlaybackListeners,
    destroy() {
      if (videoBindingTimer !== null) {
        window.clearInterval(videoBindingTimer);
        videoBindingTimer = null;
      }
      clearBufferUpgradeTimer();
      clearSharerEndedFlushTimer();
    },
  };
}
