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
  }) => void;
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
    lastObservedPageUrl = nextPageUrl;
    lastObservedNormalizedPageUrl = nextNormalizedPageUrl;
    args.clearFestivalSnapshot();
    args.runtimeState.pendingPlaybackApplication = null;
    args.runtimeState.explicitNonSharedPlaybackUrl = null;

    if (
      !args.runtimeState.activeRoomCode ||
      !args.isSupportedVideoPage(nextPageUrl)
    ) {
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
      const navigatedFromSharedVideo =
        previousNormalizedPageUrl !== null &&
        previousNormalizedPageUrl === activeSharedUrl;
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
        args.scheduleAutoShareNextVideo?.({
          previousSharedUrl: activeSharedUrl,
          nextNormalizedPageUrl,
        });
      } else if (shouldPauseNonSharerAutoplay) {
        args.runtimeState.intendedPlayState = "paused";
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
      args.debugLog(
        shouldPauseNonSharerAutoplay
          ? `Detected non-sharer autoplay to ${nextPageUrl}, holding paused state`
          : `Detected in-room navigation to non-shared video ${nextPageUrl}, skipping autoplay suppression`,
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
