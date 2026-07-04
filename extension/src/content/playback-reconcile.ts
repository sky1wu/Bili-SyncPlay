import type { PlaybackState } from "@bili-syncplay/protocol";

export type PlaybackReconcileMode =
  "ignore" | "rate-only" | "soft-apply" | "hard-seek";

export interface PlaybackReconcileDecision {
  mode: PlaybackReconcileMode;
  delta: number;
  reason:
    | "within-threshold"
    | "paused-or-buffering"
    | "playing-rate-adjust"
    | "playing-soft-drift"
    | "playing-hard-drift"
    | "explicit-seek";
}

export function formatPlaybackReconcileDecision(
  decision: PlaybackReconcileDecision,
): string {
  return `mode=${decision.mode} reason=${decision.reason} delta=${decision.delta.toFixed(2)}`;
}

const PAUSED_HARD_SEEK_THRESHOLD_SECONDS = 0.15;
const PLAYING_IGNORE_THRESHOLD_SECONDS = 0.45;
const PLAYING_RATE_ONLY_THRESHOLD_SECONDS = 0.9;
const PLAYING_SOFT_APPLY_THRESHOLD_SECONDS = 1.2;

function getPlaybackRateMultiplier(playbackRate: number | undefined): number {
  return Math.max(1, playbackRate ?? 1);
}

function getAdaptivePlayingThresholds(playbackRate: number | undefined): {
  ignoreThreshold: number;
  rateOnlyThreshold: number;
  softApplyThreshold: number;
} {
  const rateMultiplier = getPlaybackRateMultiplier(playbackRate);
  const extraRate = rateMultiplier - 1;

  return {
    ignoreThreshold: PLAYING_IGNORE_THRESHOLD_SECONDS * (1 + extraRate * 0.35),
    rateOnlyThreshold:
      PLAYING_RATE_ONLY_THRESHOLD_SECONDS * (1 + extraRate * 0.7),
    softApplyThreshold:
      PLAYING_SOFT_APPLY_THRESHOLD_SECONDS * (1 + extraRate * 0.55),
  };
}

export function shouldTreatAsExplicitSeek(args: {
  syncIntent?: PlaybackState["syncIntent"];
  playState: PlaybackState["playState"];
}): boolean {
  return args.playState === "playing" && args.syncIntent === "explicit-seek";
}

export function decidePlaybackReconcileMode(args: {
  localCurrentTime: number;
  targetTime: number;
  playState: PlaybackState["playState"];
  isExplicitSeek?: boolean;
  playbackRate?: number;
}): PlaybackReconcileDecision {
  const delta = Math.abs(args.targetTime - args.localCurrentTime);

  if (args.playState !== "playing") {
    return {
      mode: delta > PAUSED_HARD_SEEK_THRESHOLD_SECONDS ? "hard-seek" : "ignore",
      delta,
      reason:
        delta > PAUSED_HARD_SEEK_THRESHOLD_SECONDS
          ? "paused-or-buffering"
          : "within-threshold",
    };
  }

  if (args.isExplicitSeek) {
    return {
      mode: "hard-seek",
      delta,
      reason: "explicit-seek",
    };
  }

  const adaptiveThresholds = getAdaptivePlayingThresholds(args.playbackRate);

  return {
    mode:
      delta <= adaptiveThresholds.ignoreThreshold
        ? "ignore"
        : delta <= adaptiveThresholds.rateOnlyThreshold
          ? "rate-only"
          : delta <= adaptiveThresholds.softApplyThreshold
            ? "soft-apply"
            : "hard-seek",
    delta,
    reason:
      delta <= adaptiveThresholds.ignoreThreshold
        ? "within-threshold"
        : delta <= adaptiveThresholds.rateOnlyThreshold
          ? "playing-rate-adjust"
          : delta <= adaptiveThresholds.softApplyThreshold
            ? "playing-soft-drift"
            : "playing-hard-drift",
  };
}
