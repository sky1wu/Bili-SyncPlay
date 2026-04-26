import type { PlaybackState } from "@bili-syncplay/protocol";
import {
  decidePlaybackReconcileMode,
  shouldTreatAsExplicitSeek,
} from "./playback-reconcile";
import type { ProgrammaticPlaybackSignature } from "./runtime-state";

const SOFT_APPLY_STEP_SECONDS = 0.22;
const SOFT_APPLY_MAX_STEP_SECONDS = 0.4;
const SOFT_APPLY_RATE_OFFSET = 0.12;

interface AppliedPlaybackAdjustment {
  mode: "ignore" | "rate-only" | "soft-apply" | "hard-seek";
  reason: ReturnType<typeof decidePlaybackReconcileMode>["reason"];
  delta: number;
  currentTime: number;
  playbackRate: number;
  targetTime: number;
  restorePlaybackRate: number;
  didWriteCurrentTime: boolean;
  didWritePlaybackRate: boolean;
  didChange: boolean;
}

export interface PlaybackApplicationResult {
  applied: boolean;
  didChange: boolean;
  adjustment: AppliedPlaybackAdjustment | null;
}

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

export function setVideoPlaybackRate(
  video: HTMLVideoElement,
  playbackRate: number,
): void {
  video.defaultPlaybackRate = playbackRate;
  video.playbackRate = playbackRate;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getSoftApplySignature(args: {
  localCurrentTime: number;
  targetTime: number;
  basePlaybackRate: number;
}): { currentTime: number; playbackRate: number } {
  const tuning = getPlaybackAdjustmentTuning(args.basePlaybackRate);
  const playbackRate = getRateAdjustedPlaybackRate({
    localCurrentTime: args.localCurrentTime,
    targetTime: args.targetTime,
    basePlaybackRate: args.basePlaybackRate,
  });
  const drift = args.targetTime - args.localCurrentTime;
  const stepLimit = Math.min(
    tuning.maxStepSeconds,
    Math.max(tuning.minStepSeconds, Math.abs(drift) * tuning.stepScale),
  );
  const steppedCurrentTime =
    args.localCurrentTime + clamp(drift, -stepLimit, stepLimit);

  return {
    currentTime: steppedCurrentTime,
    playbackRate,
  };
}

function getPlaybackAdjustmentTuning(basePlaybackRate: number): {
  rateOffsetLimit: number;
  minPlaybackRate: number;
  maxPlaybackRate: number;
  minStepSeconds: number;
  maxStepSeconds: number;
  stepScale: number;
} {
  const normalizedRate = Math.max(1, basePlaybackRate);
  const extraRate = normalizedRate - 1;
  const rateOffsetLimit = Math.min(
    0.26,
    SOFT_APPLY_RATE_OFFSET + extraRate * 0.1,
  );

  return {
    rateOffsetLimit,
    minPlaybackRate: Math.max(0.1, basePlaybackRate - rateOffsetLimit),
    maxPlaybackRate: basePlaybackRate + rateOffsetLimit,
    minStepSeconds: Math.max(0.16, SOFT_APPLY_STEP_SECONDS - extraRate * 0.03),
    maxStepSeconds: Math.max(
      0.28,
      SOFT_APPLY_MAX_STEP_SECONDS - extraRate * 0.08,
    ),
    stepScale: Math.max(0.3, 0.45 - extraRate * 0.08),
  };
}

function getRateAdjustedPlaybackRate(args: {
  localCurrentTime: number;
  targetTime: number;
  basePlaybackRate: number;
}): number {
  const tuning = getPlaybackAdjustmentTuning(args.basePlaybackRate);
  const drift = args.targetTime - args.localCurrentTime;
  const rateOffset = clamp(
    drift * 0.18,
    -tuning.rateOffsetLimit,
    tuning.rateOffsetLimit,
  );

  return clamp(
    args.basePlaybackRate + rateOffset,
    tuning.minPlaybackRate,
    tuning.maxPlaybackRate,
  );
}

export function syncPlaybackPosition(
  video: HTMLVideoElement,
  targetTime: number,
  playState: PlaybackState["playState"],
  syncIntent: PlaybackState["syncIntent"] | undefined,
  playbackRate: number,
): AppliedPlaybackAdjustment {
  const previousCurrentTime = video.currentTime;
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: previousCurrentTime,
    targetTime,
    playState,
    playbackRate,
    isExplicitSeek: shouldTreatAsExplicitSeek({
      syncIntent,
      playState,
    }),
  });

  if (decision.mode === "hard-seek") {
    const shouldWritePlaybackRate =
      Math.abs(video.playbackRate - playbackRate) > 0.01;
    video.currentTime = targetTime;
    if (shouldWritePlaybackRate) {
      setVideoPlaybackRate(video, playbackRate);
    }
    return {
      mode: "hard-seek",
      reason: decision.reason,
      delta: decision.delta,
      currentTime: targetTime,
      playbackRate,
      targetTime,
      restorePlaybackRate: playbackRate,
      didWriteCurrentTime: Math.abs(previousCurrentTime - targetTime) > 0.01,
      didWritePlaybackRate: shouldWritePlaybackRate,
      didChange:
        Math.abs(previousCurrentTime - targetTime) > 0.01 ||
        shouldWritePlaybackRate,
    };
  }

  if (decision.mode === "soft-apply") {
    const softApplied = getSoftApplySignature({
      localCurrentTime: video.currentTime,
      targetTime,
      basePlaybackRate: playbackRate,
    });
    const shouldWriteCurrentTime =
      Math.abs(video.currentTime - softApplied.currentTime) > 0.01;
    const shouldWritePlaybackRate =
      Math.abs(video.playbackRate - softApplied.playbackRate) > 0.01;
    if (shouldWriteCurrentTime) {
      video.currentTime = softApplied.currentTime;
    }
    if (shouldWritePlaybackRate) {
      setVideoPlaybackRate(video, softApplied.playbackRate);
    }
    return {
      mode: "soft-apply",
      reason: decision.reason,
      delta: decision.delta,
      currentTime: softApplied.currentTime,
      playbackRate: softApplied.playbackRate,
      targetTime,
      restorePlaybackRate: playbackRate,
      didWriteCurrentTime: shouldWriteCurrentTime,
      didWritePlaybackRate: shouldWritePlaybackRate,
      didChange: shouldWriteCurrentTime || shouldWritePlaybackRate,
    };
  }

  if (decision.mode === "rate-only") {
    const adjustedPlaybackRate = getRateAdjustedPlaybackRate({
      localCurrentTime: video.currentTime,
      targetTime,
      basePlaybackRate: playbackRate,
    });
    const shouldWritePlaybackRate =
      Math.abs(video.playbackRate - adjustedPlaybackRate) > 0.01;
    if (shouldWritePlaybackRate) {
      setVideoPlaybackRate(video, adjustedPlaybackRate);
    }
    return {
      mode: "rate-only",
      reason: decision.reason,
      delta: decision.delta,
      currentTime: video.currentTime,
      playbackRate: adjustedPlaybackRate,
      targetTime,
      restorePlaybackRate: playbackRate,
      didWriteCurrentTime: false,
      didWritePlaybackRate: shouldWritePlaybackRate,
      didChange: shouldWritePlaybackRate,
    };
  }

  const shouldWritePlaybackRate =
    Math.abs(video.playbackRate - playbackRate) > 0.01;
  if (shouldWritePlaybackRate) {
    setVideoPlaybackRate(video, playbackRate);
  }
  return {
    mode: "ignore",
    reason: decision.reason,
    delta: decision.delta,
    currentTime: video.currentTime,
    playbackRate,
    targetTime,
    restorePlaybackRate: playbackRate,
    didWriteCurrentTime: false,
    didWritePlaybackRate: shouldWritePlaybackRate,
    didChange: shouldWritePlaybackRate,
  };
}

export function applyPendingPlaybackApplication(args: {
  video: HTMLVideoElement;
  pendingPlaybackApplication: PlaybackState | null;
  clearPendingPlaybackApplication: () => void;
  onPlaybackAdjusted?: (
    adjustment: AppliedPlaybackAdjustment,
    playback: PlaybackState,
  ) => void;
  markProgrammaticApply?: (
    signature: ProgrammaticPlaybackSignature,
    playback: PlaybackState,
  ) => void;
  debugLog: (message: string) => void;
}): PlaybackApplicationResult {
  if (
    !args.pendingPlaybackApplication ||
    !canApplyPlaybackImmediately(args.video)
  ) {
    return {
      applied: false,
      didChange: false,
      adjustment: null,
    };
  }

  const playback = args.pendingPlaybackApplication;
  const wasPaused = args.video.paused;
  args.clearPendingPlaybackApplication();
  const appliedSignature = syncPlaybackPosition(
    args.video,
    playback.currentTime,
    playback.playState,
    playback.syncIntent,
    playback.playbackRate,
  );
  args.onPlaybackAdjusted?.(appliedSignature, playback);
  const needsPlayStateChange =
    (playback.playState === "playing" && wasPaused) ||
    (playback.playState === "paused" && !wasPaused);
  const didChange = appliedSignature.didChange || needsPlayStateChange;
  const signature = createProgrammaticPlaybackSignature({
    ...playback,
    currentTime: appliedSignature.currentTime,
    playbackRate: appliedSignature.playbackRate,
  });
  if (didChange) {
    args.markProgrammaticApply?.(signature, playback);
  }
  if (playback.playState === "playing") {
    void args.video.play().catch(() => {
      args.debugLog(
        `Skipped delayed play() after seek ${playback.url} t=${playback.currentTime.toFixed(2)} seq=${playback.seq}`,
      );
    });
    return {
      applied: true,
      didChange,
      adjustment: appliedSignature,
    };
  }

  if (playback.playState === "buffering") {
    return {
      applied: true,
      didChange,
      adjustment: appliedSignature,
    };
  }

  if (!args.video.paused) {
    args.video.pause();
  }
  return {
    applied: true,
    didChange,
    adjustment: appliedSignature,
  };
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
