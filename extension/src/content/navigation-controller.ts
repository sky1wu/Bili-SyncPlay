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

    args.runtimeState.hasReceivedInitialRoomState = false;
    args.runtimeState.pendingRoomStateHydration = true;
    args.runtimeState.intendedPlayState = "paused";
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
    if (
      args.runtimeState.activeSharedUrl &&
      nextNormalizedPageUrl !== args.runtimeState.activeSharedUrl
    ) {
      args.runtimeState.postNavigationAnchorSharedUrl =
        args.runtimeState.activeSharedUrl;
      args.runtimeState.postNavigationAnchorSetAt = nowOf();
    } else {
      args.runtimeState.postNavigationAnchorSharedUrl = null;
      args.runtimeState.postNavigationAnchorSetAt = 0;
    }
    resetUserGestureState(args.runtimeState);
    args.activatePauseHold(args.initialRoomStatePauseHoldMs);
    args.debugLog(
      `Detected in-room navigation to ${nextPageUrl}, waiting for room state`,
    );
    args.attachPlaybackListeners();
    const video = args.getVideoElement();
    // Pause an already-playing video immediately unless we can positively
    // confirm the navigated page is a *different* video. Confirmation requires
    // the room's shared URL and the navigated page URL to both be present,
    // stable (not a festival / bangumi-season identity), and different. In
    // every other case the page may still be the shared video and we must
    // suppress autoplay through the navigation/hydration window:
    //   - page URL equals the shared URL — it is the shared video;
    //   - either URL is still an unstable identity (e.g. a paused shared season
    //     `.../play/ss73077` whose page resolved to `.../play/ep...`, or a
    //     festival route) — we cannot tell whether it is the shared video;
    //   - the shared URL is not yet known (just joined/switched room before the
    //     initial room state arrives) — the page may well be the shared video.
    // Waiting for a later `play` event is not enough: it never fires for a
    // video that is already playing when navigation completes.
    const activeSharedUrl = args.runtimeState.activeSharedUrl;
    const canConfirmDifferentVideo =
      activeSharedUrl !== null &&
      !isUnstableSharedVideoUrl(activeSharedUrl) &&
      nextNormalizedPageUrl !== null &&
      !isUnstableSharedVideoUrl(nextNormalizedPageUrl) &&
      nextNormalizedPageUrl !== activeSharedUrl;
    if (video && !video.paused && !canConfirmDifferentVideo) {
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
