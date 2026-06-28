import {
  resetUserGestureState,
  type ContentRuntimeState,
} from "./runtime-state";
import { isUnstableSharedVideoUrl } from "./video-identity";

export interface NavigationController {
  start(): void;
  destroy(): void;
}

export function createNavigationController(args: {
  runtimeState: ContentRuntimeState;
  intervalMs: number;
  userGestureGraceMs: number;
  initialRoomStatePauseHoldMs: number;
  getCurrentPageUrl: () => string;
  normalizeVideoPageUrl: (url: string) => string | null;
  isSupportedVideoPage: (url: string) => boolean;
  clearFestivalSnapshot: () => void;
  attachPlaybackListeners: () => void;
  getVideoElement: () => HTMLVideoElement | null;
  pauseVideo: (video: HTMLVideoElement) => void;
  hydrateRoomState: () => Promise<void>;
  activatePauseHold: (durationMs?: number) => void;
  scheduleAutoShareNextVideo?: (input: {
    previousSharedUrl: string;
    nextNormalizedPageUrl: string;
    /**
     * The sharer's own in-flight auto-share target this navigation advanced FROM
     * (the previous chain step), or `null` when this is not a chained step (it
     * came straight from the room's confirmed shared video). A `null` value marks
     * a fresh chain so the auto-share controller resets its sent-target lineage;
     * a non-null value continues the current chain.
     */
    previousAutoShareTargetUrl: string | null;
  }) => void;
  cancelAutoShareNextVideo?: () => void;
  debugLog: (message: string) => void;
  getNow?: () => number;
}): NavigationController {
  const nowOf = () => args.getNow?.() ?? Date.now();
  let navigationWatchTimer: number | null = null;
  let lastObservedPageUrl = args.getCurrentPageUrl();
  let lastObservedNormalizedPageUrl =
    args.normalizeVideoPageUrl(lastObservedPageUrl);

  function handlePotentialNavigation(): void {
    const nextPageUrl = args.getCurrentPageUrl();
    if (nextPageUrl === lastObservedPageUrl) {
      return;
    }

    const nextNormalizedPageUrl = args.normalizeVideoPageUrl(nextPageUrl);
    if (
      nextNormalizedPageUrl !== null &&
      nextNormalizedPageUrl === lastObservedNormalizedPageUrl
    ) {
      lastObservedPageUrl = nextPageUrl;
      return;
    }

    // The normalized video page the tab was showing *before* this navigation.
    // Used to confirm an autoplay actually started from the room's shared video
    // rather than from a local detour the user manually navigated to.
    const previousNormalizedPageUrl = lastObservedNormalizedPageUrl;
    // The local video the user was explicitly watching before this navigation
    // (if any). Captured before the reset below so an explicit local-playback
    // intent can be transferred across a detour that auto-advances.
    const previousExplicitNonSharedPlaybackUrl =
      args.runtimeState.explicitNonSharedPlaybackUrl;
    // The next video the local sharer auto-shared but the room has not yet
    // confirmed (`activeSharedUrl` still lags it). Captured before the reset so a
    // chained autoplay whose previous page is this in-flight target is still
    // recognised as a sharer autoplay below. Re-armed only when this navigation
    // is itself a sharer autoplay-next.
    const previousPendingAutoShareTargetUrl =
      args.runtimeState.pendingAutoShareTargetUrl;
    // End-of-shared-video markers, captured before `resetUserGestureState` below
    // clears the non-sharer one (`suppressedLocalEndPauseUrl`). They let the
    // autoplay-from-shared check recognise a season-page autoplay whose previous
    // page URL is the season URL rather than the shared episode URL.
    const previousSharerEndedSuppressionUrl =
      args.runtimeState.sharerEndedSuppressionUrl;
    const previousSuppressedLocalEndPauseUrl =
      args.runtimeState.suppressedLocalEndPauseUrl;
    lastObservedPageUrl = nextPageUrl;
    lastObservedNormalizedPageUrl = nextNormalizedPageUrl;
    args.clearFestivalSnapshot();
    args.runtimeState.pendingPlaybackApplication = null;
    args.runtimeState.explicitNonSharedPlaybackUrl = null;
    args.runtimeState.pendingAutoShareTargetUrl = null;
    // Any genuine navigation invalidates an auto-share scheduled by an earlier
    // autoplay. A manual detour — even one that returns to the same target — must
    // not let a stale settle timer fire and auto-share without the manual
    // confirmation. The local-sharer autoplay branch below re-schedules when this
    // navigation is itself a sharer autoplay-next.
    args.cancelAutoShareNextVideo?.();

    if (
      !args.runtimeState.activeRoomCode ||
      !args.isSupportedVideoPage(nextPageUrl)
    ) {
      // DIAGNOSTIC: this early bail runs *after* cancelAutoShareNextVideo above,
      // so a transient non-video URL (e.g. a mid-SPA redirect during bangumi
      // autoplay) silently cancels a still-pending auto-share without logging.
      // Surface it so we can confirm whether it is what drops the auto-share.
      args.debugLog(
        `Navigation to ${nextPageUrl} bailed early (activeRoom=${Boolean(
          args.runtimeState.activeRoomCode,
        )} supportedVideoPage=${args.isSupportedVideoPage(
          nextPageUrl,
        )}); any pending auto-share was cancelled`,
      );
      return;
    }

    const activeSharedUrl = args.runtimeState.activeSharedUrl;
    const now = nowOf();
    const hadRecentUserGesture =
      args.runtimeState.lastUserGestureAt > 0 &&
      now - args.runtimeState.lastUserGestureAt <= args.userGestureGraceMs;
    // We can only positively confirm the navigated page is a *different*
    // (non-shared) video when the room's shared URL and the navigated page URL
    // are both present, stable (not a festival / bangumi-season identity), and
    // different. In every other case the page may still be the shared video:
    //   - page URL equals the shared URL — it is the shared video;
    //   - either URL is still an unstable identity (e.g. a paused shared season
    //     `.../play/ss73077` whose page resolved to `.../play/ep...`, or a
    //     festival route) — we cannot tell whether it is the shared video;
    //   - the shared URL is not yet known (just joined/switched room before the
    //     initial room state arrives) — the page may well be the shared video.
    const canConfirmDifferentVideo =
      activeSharedUrl !== null &&
      !isUnstableSharedVideoUrl(activeSharedUrl) &&
      nextNormalizedPageUrl !== null &&
      !isUnstableSharedVideoUrl(nextNormalizedPageUrl) &&
      nextNormalizedPageUrl !== activeSharedUrl;

    // Anchor the previous shared URL so that broadcasts stay suppressed until
    // the page bridge resolves the new page to a different normalized URL or
    // a fresh shared-video room state arrives. This prevents stale
    // `__INITIAL_STATE__` data captured mid-SPA from being broadcast as
    // updates to the still-shared previous video.
    //
    // Skip the anchor when the user is navigating directly to the shared
    // video URL itself (e.g. coming back to the original episode after a
    // detour) — in that case the page-bridge will correctly resolve to that
    // URL and broadcasts are not at risk of leaking stale data.
    if (activeSharedUrl && nextNormalizedPageUrl !== activeSharedUrl) {
      args.runtimeState.postNavigationAnchorSharedUrl = activeSharedUrl;
      args.runtimeState.postNavigationAnchorSetAt = now;
    } else {
      args.runtimeState.postNavigationAnchorSharedUrl = null;
      args.runtimeState.postNavigationAnchorSetAt = 0;
    }
    resetUserGestureState(args.runtimeState);
    args.attachPlaybackListeners();

    if (canConfirmDifferentVideo) {
      const isLocalSharedSource =
        args.runtimeState.localMemberId !== null &&
        args.runtimeState.activeSharedByMemberId ===
          args.runtimeState.localMemberId;
      // Only treat this as a room-video autoplay when the tab actually
      // autoplayed *from* the shared video. If the page before this navigation
      // was a local detour (e.g. the sharer manually opened video X off the
      // shared A, then X auto-advanced to Y), this is not the room advancing:
      // auto-sharing Y with `previousSharedUrl=A` or pausing a non-sharer's own
      // detour would both be wrong.
      //
      // Also accept the previous page being the sharer's own in-flight auto-share
      // target: during chained autoplay (A→B→C) the player can advance B→C before
      // B's `room:state` returns, so `activeSharedUrl` is still A while the page
      // came from B. Without this the B→C step would look like a local detour and
      // C would never be shared, stranding the room behind the sharer. (The
      // background still defers/skips if the room is not actually behind our
      // share, so a stale target cannot force an out-of-turn share.)
      // A bangumi season page keeps the season URL (`/bangumi/play/ss<season>`)
      // in the address bar while it actually plays a resolved episode, and the
      // room shares the resolved episode URL (`/bangumi/play/ep<id>`). So the
      // previous *page* URL (the season URL) never equals `activeSharedUrl` (the
      // episode), and a season-page autoplay would be misclassified as a local
      // detour — the sharer would never auto-share the next episode, and a
      // non-sharer would never be held. The end-of-shared-video markers give a
      // URL-form-independent signal that the shared video just naturally ended on
      // this page: the sharer's broadcast-suppression marker, or the non-sharer's
      // end-pause hold marker, still pointing at `activeSharedUrl` means this
      // navigation is that video's autoplay-next. Both are cleared on a shared-url
      // change / room reset, so they cannot leak into an unrelated navigation.
      const navigatedFromSharedVideoEnd =
        activeSharedUrl !== null &&
        (previousSharerEndedSuppressionUrl === activeSharedUrl ||
          previousSuppressedLocalEndPauseUrl === activeSharedUrl);
      const navigatedFromSharedVideo =
        navigatedFromSharedVideoEnd ||
        (previousNormalizedPageUrl !== null &&
          (previousNormalizedPageUrl === activeSharedUrl ||
            previousNormalizedPageUrl === previousPendingAutoShareTargetUrl));
      const shouldTreatAsAutoplay =
        !hadRecentUserGesture &&
        navigatedFromSharedVideo &&
        activeSharedUrl !== null &&
        nextNormalizedPageUrl !== null;
      const shouldPauseNonSharerAutoplay =
        shouldTreatAsAutoplay && !isLocalSharedSource;
      // User-driven local browsing that lands on a non-shared video: either the
      // user manually navigated here (recent gesture), or a local detour the
      // user was already explicitly watching auto-advanced to the next video.
      // Mark the target as explicit local playback so the paused-room autoplay
      // guard lets the user watch it — the navigation reset above clears
      // `lastUserGestureAt`, so without this the later `play` event would look
      // like an autoplay and be paused.
      const isUserDrivenLocalNavigation =
        !shouldTreatAsAutoplay &&
        (hadRecentUserGesture ||
          (previousNormalizedPageUrl !== null &&
            previousNormalizedPageUrl ===
              previousExplicitNonSharedPlaybackUrl));

      if (shouldTreatAsAutoplay && isLocalSharedSource) {
        args.runtimeState.explicitNonSharedPlaybackUrl = nextNormalizedPageUrl;
        // Advance FROM the room's confirmed shared video (`activeSharedUrl`), not
        // the page we navigated from. A multi-part / chained autoplay that outruns
        // room confirmation (A→B→C→D before any `room:state` returns) can't replay
        // the intermediate videos — once the tab moves past B/C the background's
        // tab-resolution check rejects them — so the room must jump straight to the
        // latest video the sharer is actually on. The auto-share controller already
        // collapses rapid navigations to the latest target via supersede; pairing
        // that target with the room's confirmed video as `previousSharedUrl` lets
        // the background advance the room directly to it (room A → latest). In the
        // normal single-step case `navigatedFromSharedVideo` guarantees
        // `previousNormalizedPageUrl === activeSharedUrl`, so this is unchanged.
        //
        // `activeSharedUrl` is the anchor as of *now*. If a step our own chain
        // already sent confirms during the settle window, the room moves to it
        // while this anchor goes stale; the auto-share controller re-anchors to the
        // live shared video, but only when it is one of its own sent targets — so
        // an unrelated video the room moved to (e.g. a manual share confirmed in
        // the same window) is never adopted and the stale auto-share is correctly
        // skipped as moved-on. `previousPendingAutoShareTargetUrl` tells the
        // controller whether this is a chained step (continue the lineage) or a
        // fresh start (reset it).
        args.scheduleAutoShareNextVideo?.({
          previousSharedUrl: activeSharedUrl,
          nextNormalizedPageUrl,
          previousAutoShareTargetUrl: previousPendingAutoShareTargetUrl,
        });
        // Remember this target so the next chained autoplay (next → next+1) is
        // recognised as a sharer autoplay even before the room confirms it.
        args.runtimeState.pendingAutoShareTargetUrl = nextNormalizedPageUrl;
      } else if (shouldPauseNonSharerAutoplay) {
        args.runtimeState.intendedPlayState = "paused";
        // Mark this as a non-sharer autoplay page so the playback binding will
        // force-pause a delayed `play` here even after the pause hold expires.
        // Only pages reached through this in-SPA autoplay get the marker, so a
        // video the user manually opens via full-page navigation stays playable.
        args.runtimeState.nonSharerAutoplayHoldUrl = nextNormalizedPageUrl;
        args.activatePauseHold(args.initialRoomStatePauseHoldMs);
        const video = args.getVideoElement();
        if (video && !video.paused) {
          args.runtimeState.lastForcedPauseAt = now;
          args.debugLog(`Suppressed non-sharer autoplay to ${nextPageUrl}`);
          args.pauseVideo(video);
        }
      } else if (isUserDrivenLocalNavigation) {
        args.runtimeState.explicitNonSharedPlaybackUrl = nextNormalizedPageUrl;
      }
      // For manual non-shared navigation and local-sharer autoplay, clear any
      // pause hold inherited from the previously shared video. For non-sharer
      // autoplay, keep the freshly armed pause hold so a delayed play event is
      // still stopped.
      if (!shouldPauseNonSharerAutoplay) {
        args.runtimeState.pauseHoldUntil = 0;
      }
      // DIAGNOSTIC: the previous single message could not tell whether the
      // auto-share branch actually ran (it logged "skipping autoplay
      // suppression" for both the scheduled-auto-share case and the
      // user-driven/no-op case). Spell out the decision inputs so a failed
      // auto-continue can be traced to the exact false condition.
      const navOutcome = shouldPauseNonSharerAutoplay
        ? "holding paused state (non-sharer autoplay)"
        : shouldTreatAsAutoplay && isLocalSharedSource
          ? "scheduled auto-share"
          : isUserDrivenLocalNavigation
            ? "user-driven local navigation, no auto-share"
            : "no autoplay branch taken, no auto-share";
      args.debugLog(
        `Nav decision to ${nextPageUrl}: ${navOutcome} ` +
          `[autoplay=${shouldTreatAsAutoplay} localSharer=${isLocalSharedSource} ` +
          `navFromShared=${navigatedFromSharedVideo} navFromSharedEnd=${navigatedFromSharedVideoEnd} recentGesture=${hadRecentUserGesture} ` +
          `prevPage=${previousNormalizedPageUrl} activeShared=${activeSharedUrl} ` +
          `prevAutoShareTarget=${previousPendingAutoShareTargetUrl}]`,
      );
      void args.hydrateRoomState();
      return;
    }

    // The navigated page may be the shared video, so suppress autoplay through
    // the navigation/hydration window until room state confirms playback.
    // Pause an already-playing video immediately too: waiting for a later
    // `play` event is not enough because it never fires for a video that is
    // already playing when navigation completes.
    args.runtimeState.hasReceivedInitialRoomState = false;
    args.runtimeState.pendingRoomStateHydration = true;
    args.runtimeState.intendedPlayState = "paused";
    args.activatePauseHold(args.initialRoomStatePauseHoldMs);
    args.debugLog(
      `Detected in-room navigation to ${nextPageUrl}, waiting for room state`,
    );
    const video = args.getVideoElement();
    if (video && !video.paused) {
      args.debugLog(
        `Suppressed autoplay immediately after in-room navigation to ${nextPageUrl}`,
      );
      args.pauseVideo(video);
    }
    void args.hydrateRoomState();
  }

  return {
    start() {
      handlePotentialNavigation();
      if (navigationWatchTimer === null) {
        navigationWatchTimer = window.setInterval(
          handlePotentialNavigation,
          args.intervalMs,
        );
      }
    },
    destroy() {
      if (navigationWatchTimer !== null) {
        window.clearInterval(navigationWatchTimer);
        navigationWatchTimer = null;
      }
    },
  };
}
