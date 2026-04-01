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

export interface PlaybackBindingController {
  start(): void;
  attachPlaybackListeners(): void;
}

export function createPlaybackBindingController(args: {
  runtimeState: ContentRuntimeState;
  videoBindIntervalMs: number;
  userGestureGraceMs: number;
  initialRoomStatePauseHoldMs: number;
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
  const nowOf = () => args.getNow?.() ?? Date.now();
  const hasRecentUserGesture = () =>
    nowOf() - args.runtimeState.lastUserGestureAt < args.userGestureGraceMs;

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
      nowOf() - args.runtimeState.lastUserGestureAt <
      args.userGestureGraceMs
    ) {
      args.runtimeState.lastExplicitPlaybackAction = {
        playState,
        at: nowOf(),
      };
    }
  }

  function rememberExplicitUserAction(kind: ExplicitUserActionKind) {
    if (
      nowOf() - args.runtimeState.lastUserGestureAt <
      args.userGestureGraceMs
    ) {
      if (
        kind === "play" &&
        args.runtimeState.lastExplicitUserAction?.kind === "seek" &&
        nowOf() - args.runtimeState.lastExplicitUserAction.at <
          args.userGestureGraceMs
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

  function forcePauseWhileWaitingForInitialRoomState(
    video: HTMLVideoElement,
  ): boolean {
    if (
      !shouldForcePauseWhileWaitingForInitialRoomState({
        activeRoomCode: args.runtimeState.activeRoomCode,
        pendingRoomStateHydration: args.runtimeState.pendingRoomStateHydration,
        videoPaused: video.paused,
        now: nowOf(),
        lastUserGestureAt: args.runtimeState.lastUserGestureAt,
        userGestureGraceMs: args.userGestureGraceMs,
      })
    ) {
      if (
        args.runtimeState.activeRoomCode &&
        args.runtimeState.pendingRoomStateHydration &&
        !video.paused &&
        nowOf() - args.runtimeState.lastUserGestureAt < args.userGestureGraceMs
      ) {
        args.debugLog(
          `Allowed user-initiated playback while waiting for initial room state of ${args.runtimeState.activeRoomCode}`,
        );
      }
      return false;
    }

    if (
      nowOf() - args.runtimeState.lastUserGestureAt <
      args.userGestureGraceMs
    ) {
      args.debugLog(
        `Allowed user-initiated playback while waiting for initial room state of ${args.runtimeState.activeRoomCode}`,
      );
      return false;
    }

    args.debugLog(
      `Suppressed page autoplay while waiting for initial room state of ${args.runtimeState.activeRoomCode}`,
    );
    args.runtimeState.intendedPlayState = "paused";
    window.setTimeout(() => {
      if (!video.paused) {
        pauseVideo(video);
      }
    }, 0);
    return true;
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
    if (!decision.shouldPause) {
      return false;
    }

    args.runtimeState.intendedPlayState = "paused";
    args.activatePauseHold(args.initialRoomStatePauseHoldMs);
    window.setTimeout(() => {
      if (!video.paused) {
        pauseVideo(video);
      }
    }, 0);
    return true;
  }

  function attachPlaybackListeners(): void {
    const video = getVideoElement();
    if (!video) {
      return;
    }

    const guardUnexpectedResume = () => {
      const currentVideo = args.getSharedVideo();
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
        rememberExplicitPlaybackAction("playing");
        rememberExplicitUserAction("play");
        if (!guardUnexpectedResume()) {
          scheduleBroadcast(video, "play", 180);
        }
      },
      onPause: () => {
        const currentVideo = args.getSharedVideo();
        if (hasRecentUserGesture()) {
          args.cancelActiveSoftApply(video, "pause");
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
      onWaiting: () => scheduleBroadcast(video, "waiting"),
      onStalled: () => scheduleBroadcast(video, "stalled"),
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
        rememberExplicitPlaybackAction("playing");
        rememberExplicitUserAction("play");
        if (!guardUnexpectedResume()) {
          scheduleBroadcast(video, "playing", 180);
        }
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
  };
}
