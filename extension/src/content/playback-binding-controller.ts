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
import { hasStableSharedVideoIdentity } from "./video-identity";

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
  const clearActivePauseClassification = () => {
    args.runtimeState.pauseStartedAt = 0;
    args.runtimeState.pauseClassifiedAsBuffer = false;
    clearBufferUpgradeTimer();
  };
  const hasRecentUserGesture = () =>
    nowOf() - args.runtimeState.lastUserGestureAt < args.userGestureGraceMs;
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

  function isKnownNonSharedVideo(currentVideo: SharedVideo | null): boolean {
    return Boolean(
      currentVideo &&
      hasStableSharedVideoIdentity(currentVideo) &&
      args.runtimeState.activeSharedUrl &&
      !isCurrentVideoShared(currentVideo),
    );
  }

  function shouldPreRecordNonSharedExplicitPlay(): boolean {
    const currentVideo = args.getSharedVideo();
    if (
      !hasRecentUserGesture() ||
      args.runtimeState.lastUserGestureAt <=
        args.runtimeState.lastForcedPauseAt ||
      !isKnownNonSharedVideo(currentVideo)
    ) {
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

  function shouldReapplyPauseHoldForUnstableVideoIdentity(
    currentVideo: SharedVideo | null,
  ): boolean {
    if (
      !currentVideo ||
      hasStableSharedVideoIdentity(currentVideo) ||
      !args.runtimeState.activeRoomCode ||
      !args.runtimeState.activeSharedUrl ||
      nowOf() >= args.runtimeState.pauseHoldUntil
    ) {
      return false;
    }

    return (
      args.runtimeState.intendedPlayState === "paused" ||
      args.runtimeState.intendedPlayState === "buffering"
    );
  }

  function forcePauseOnNonSharedPage(video: HTMLVideoElement): boolean {
    if (
      !args.runtimeState.activeRoomCode ||
      !args.runtimeState.activeSharedUrl
    ) {
      return false;
    }

    const currentVideo = args.getSharedVideo();
    const normalizedCurrentUrl = args.normalizeUrl(currentVideo?.url);
    if (!currentVideo) {
      args.runtimeState.explicitNonSharedPlaybackUrl = null;
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

      if (shouldReapplyPauseHoldForUnstableVideoIdentity(currentVideo)) {
        args.debugLog(
          `Forced pause hold reapplied for unstable video identity intended=${args.runtimeState.intendedPlayState}`,
        );
        args.runtimeState.explicitNonSharedPlaybackUrl = null;
        args.runtimeState.lastNonSharedGuardUrl = null;
        args.runtimeState.lastForcedPauseAt = nowOf();
        window.setTimeout(() => {
          pauseVideo(video);
        }, 0);
        return true;
      }

      if (forcePauseOnNonSharedPage(video)) {
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
        if (
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
    },
  };
}
