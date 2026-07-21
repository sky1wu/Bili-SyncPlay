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
/**
 * Ignore threshold while a catch-up is already running for this video.
 *
 * `PLAYING_IGNORE_THRESHOLD_SECONDS` is the threshold at which a correction
 * *starts*. Using the same value to decide when it stops gave the loop no
 * hysteresis: a catch-up was abandoned the instant the drift dipped back under
 * 0.45s, so every correction settled at the threshold rather than at zero and
 * each buffer hiccup ratcheted the residual offset up until playback sat
 * permanently ~0.45s away from the room. Once correcting, keep correcting until
 * the drift is genuinely closed.
 */
const PLAYING_CATCH_UP_IGNORE_THRESHOLD_SECONDS = 0.05;
const PLAYING_RATE_ONLY_THRESHOLD_SECONDS = 0.9;
const PLAYING_SOFT_APPLY_THRESHOLD_SECONDS = 1.2;

function getPlaybackRateMultiplier(playbackRate: number | undefined): number {
  return Math.max(1, playbackRate ?? 1);
}

function getAdaptivePlayingThresholds(
  playbackRate: number | undefined,
  hasActiveCatchUp: boolean,
): {
  ignoreThreshold: number;
  rateOnlyThreshold: number;
  softApplyThreshold: number;
} {
  const rateMultiplier = getPlaybackRateMultiplier(playbackRate);
  const extraRate = rateMultiplier - 1;
  const baseIgnoreThreshold = hasActiveCatchUp
    ? PLAYING_CATCH_UP_IGNORE_THRESHOLD_SECONDS
    : PLAYING_IGNORE_THRESHOLD_SECONDS;

  return {
    ignoreThreshold: baseIgnoreThreshold * (1 + extraRate * 0.35),
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
  /**
   * Whether a catch-up session is already running for this video. Lowers the
   * ignore threshold so the correction converges instead of stopping the moment
   * the drift falls back under the (much larger) threshold that started it.
   */
  hasActiveCatchUp?: boolean;
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

  const adaptiveThresholds = getAdaptivePlayingThresholds(
    args.playbackRate,
    args.hasActiveCatchUp ?? false,
  );

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
