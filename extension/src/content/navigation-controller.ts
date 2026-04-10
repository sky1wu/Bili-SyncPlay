import type { ContentRuntimeState } from "./runtime-state";

export interface NavigationController {
  start(): void;
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
}): NavigationController {
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
    args.activatePauseHold(args.initialRoomStatePauseHoldMs);
    args.debugLog(
      `Detected in-room navigation to ${nextPageUrl}, waiting for room state`,
    );
    args.attachPlaybackListeners();
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
  };
}
