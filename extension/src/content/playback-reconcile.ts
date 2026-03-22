import type { PlaybackState } from "@bili-syncplay/protocol";

export type PlaybackReconcileMode = "ignore" | "soft-apply" | "hard-seek";

export interface PlaybackReconcileDecision {
  mode: PlaybackReconcileMode;
  delta: number;
  reason:
    | "within-threshold"
    | "paused-or-buffering"
    | "playing-drift"
    | "explicit-seek";
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
}): PlaybackReconcileDecision {
  const delta = Math.abs(args.targetTime - args.localCurrentTime);

  if (args.playState !== "playing") {
    return {
      mode: delta > 0.15 ? "hard-seek" : "ignore",
      delta,
      reason: delta > 0.15 ? "paused-or-buffering" : "within-threshold",
    };
  }

  if (args.isExplicitSeek) {
    return {
      mode: "hard-seek",
      delta,
      reason: "explicit-seek",
    };
  }

  return {
    mode: delta <= 0.75 ? "ignore" : delta <= 2.5 ? "soft-apply" : "hard-seek",
    delta,
    reason: delta > 0.75 ? "playing-drift" : "within-threshold",
  };
}
