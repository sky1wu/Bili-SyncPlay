import type { PlaybackState } from "@bili-syncplay/protocol";
import {
  decidePlaybackReconcileMode,
  shouldTreatAsExplicitSeek,
} from "./playback-reconcile";
import type { ProgrammaticPlaybackSignature } from "./runtime-state";

export function getVideoElement(): HTMLVideoElement | null {
  return document.querySelector("video");
}

export function pauseVideo(video: HTMLVideoElement): void {
  video.pause();
}

export function getPlayState(
  video: HTMLVideoElement,
  intendedPlayState: PlaybackState["playState"],
): PlaybackState["playState"] {
  if (!video.paused && video.readyState < 3) {
    return "buffering";
  }
  if (video.paused) {
    return intendedPlayState === "buffering" ? "buffering" : "paused";
  }
  return "playing";
}

export function canApplyPlaybackImmediately(video: HTMLVideoElement): boolean {
  return Number.isFinite(video.duration) && video.readyState >= 1;
}

export function createProgrammaticPlaybackSignature(
  playback: PlaybackState,
): ProgrammaticPlaybackSignature {
  return {
    url: playback.url,
    playState: playback.playState,
    currentTime: playback.currentTime,
    playbackRate: playback.playbackRate,
  };
}

export function syncPlaybackPosition(
  video: HTMLVideoElement,
  targetTime: number,
  playState: PlaybackState["playState"],
  syncIntent: PlaybackState["syncIntent"] | undefined,
  playbackRate: number,
): void {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: video.currentTime,
    targetTime,
    playState,
    isExplicitSeek: shouldTreatAsExplicitSeek({
      syncIntent,
      playState,
    }),
  });

  if (decision.mode === "hard-seek") {
    video.currentTime = targetTime;
  }
  if (Math.abs(video.playbackRate - playbackRate) > 0.01) {
    video.playbackRate = playbackRate;
  }
}

export function applyPendingPlaybackApplication(args: {
  video: HTMLVideoElement;
  pendingPlaybackApplication: PlaybackState | null;
  clearPendingPlaybackApplication: () => void;
  markProgrammaticApply?: (
    signature: ProgrammaticPlaybackSignature,
    playback: PlaybackState,
  ) => void;
  debugLog: (message: string) => void;
}): boolean {
  if (
    !args.pendingPlaybackApplication ||
    !canApplyPlaybackImmediately(args.video)
  ) {
    return false;
  }

  const playback = args.pendingPlaybackApplication;
  args.clearPendingPlaybackApplication();
  const signature = createProgrammaticPlaybackSignature(playback);
  args.markProgrammaticApply?.(signature, playback);

  syncPlaybackPosition(
    args.video,
    playback.currentTime,
    playback.playState,
    playback.syncIntent,
    playback.playbackRate,
  );
  if (playback.playState === "playing") {
    void args.video.play().catch(() => {
      args.debugLog(
        `Skipped delayed play() after seek ${playback.url} t=${playback.currentTime.toFixed(2)} seq=${playback.seq}`,
      );
    });
    return true;
  }

  if (!args.video.paused) {
    args.video.pause();
  }
  return true;
}

export function bindVideoElement(args: {
  video: HTMLVideoElement;
  onPlay: () => void;
  onPause: () => void;
  onWaiting: () => void;
  onStalled: () => void;
  onLoadedMetadata: () => void;
  onCanPlay: () => void;
  onPlaying: () => void;
  onSeeking: () => void;
  onSeeked: () => void;
  onRateChange: () => void;
  onTimeUpdate: () => void;
}): boolean {
  const boundVideo = args.video as HTMLVideoElement & {
    __biliSyncBound?: boolean;
  };
  if (boundVideo.__biliSyncBound) {
    return false;
  }

  boundVideo.__biliSyncBound = true;
  args.video.addEventListener("play", args.onPlay);
  args.video.addEventListener("pause", args.onPause);
  args.video.addEventListener("waiting", args.onWaiting);
  args.video.addEventListener("stalled", args.onStalled);
  args.video.addEventListener("loadedmetadata", args.onLoadedMetadata);
  args.video.addEventListener("canplay", args.onCanPlay);
  args.video.addEventListener("playing", args.onPlaying);
  args.video.addEventListener("seeking", args.onSeeking);
  args.video.addEventListener("seeked", args.onSeeked);
  args.video.addEventListener("ratechange", args.onRateChange);
  args.video.addEventListener("timeupdate", args.onTimeUpdate);
  return true;
}
