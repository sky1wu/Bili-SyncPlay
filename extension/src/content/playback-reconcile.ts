import type { PlaybackState } from "@bili-syncplay/protocol";

export type PlaybackReconcileMode =
  "ignore" | "rate-only" | "soft-apply" | "hard-seek";

export interface PlaybackReconcileDecision {
  mode: PlaybackReconcileMode;
  delta: number;
  reason:
    | "within-threshold"
    | "paused-or-buffering"
    | "buffering-not-authoritative"
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

  // A buffering peer's `currentTime` is frozen wherever its player stalled, so
  // it is not an authoritative target — but the harm is one-directional. It is
  // still a valid *lower bound* on where the room has reached, so a receiver
  // that is BEHIND it (just joined, just finished loading, briefly lagging)
  // must still catch up: skipping the write there would strand the playhead at
  // the old position, and `applyPendingPlaybackApplication` neither seeks nor
  // pauses for `buffering`, so it would keep playing from there until the
  // stalled peer recovers.
  //
  // Only skip when we are AHEAD of the frozen target, which is the case that
  // drags healthy members backwards for a problem that is not theirs — the
  // longer the peer stalls, the further back it pulls them. The peer broadcasts
  // a fresh position the moment it recovers, and a stall outliving
  // `bufferPauseUpgradeMs` is upgraded to `paused`, which still aligns the room.
  // `explicit-seek` deliberately does NOT exempt this. The sender keeps tagging
  // broadcasts with that intent for up to EXPLICIT_SEEK_BROADCAST_GRACE_MS
  // (2.5s) after a seek — including `canplay`/`timeupdate`, which
  // getBroadcastPlayState does not force to `playing` — so a frozen `buffering`
  // snapshot can carry a stale seek tag long after the jump itself. Honouring it
  // would drag receivers back to the sender's old position and reintroduce
  // exactly the yank this branch exists to remove.
  //
  // Real seeks are unaffected, whether the sender was playing or already
  // stalled when it made them: `getBroadcastPlayState` forces `seeking`/`seeked`
  // to `playing`, so receivers follow the jump through the playing path and
  // being ahead of the frozen target is the evidence that they did. The stall
  // events that follow such a seek (`pause`/`waiting`/`stalled`) are NOT forced
  // when the seek began from a stall, so they keep arriving as `buffering` and
  // land here — which is what stops them from dragging those receivers back to
  // the still-frozen target (#198).
  if (
    args.playState === "buffering" &&
    args.localCurrentTime > args.targetTime
  ) {
    return {
      mode: "ignore",
      delta,
      reason: "buffering-not-authoritative",
    };
  }

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
