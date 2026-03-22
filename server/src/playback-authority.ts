import type { PlaybackState } from "@bili-syncplay/protocol";
import type { PlaybackAuthority } from "./types.js";

export type PlaybackAcceptanceDecision =
  | { decision: "accept"; reason: "same-actor" | "no-current" | "default" }
  | {
      decision: "ignore-as-follow";
      reason: "authority-window-follow";
    }
  | {
      decision: "ignore-stale-like";
      reason: "timeline-regression";
    };

export function decidePlaybackAcceptance(args: {
  currentPlayback: PlaybackState | null;
  authority: PlaybackAuthority | null;
  incomingPlayback: PlaybackState;
  currentTime: number;
}): PlaybackAcceptanceDecision {
  if (!args.currentPlayback) {
    return { decision: "accept", reason: "no-current" };
  }

  if (args.currentPlayback.actorId === args.incomingPlayback.actorId) {
    return { decision: "accept", reason: "same-actor" };
  }

  if (
    args.authority &&
    args.currentTime < args.authority.until &&
    args.authority.actorId !== args.incomingPlayback.actorId &&
    args.incomingPlayback.playState === "playing" &&
    Math.abs(
      args.incomingPlayback.currentTime - args.currentPlayback.currentTime,
    ) < 1.2
  ) {
    return {
      decision: "ignore-as-follow",
      reason: "authority-window-follow",
    };
  }

  if (
    args.incomingPlayback.playState === "playing" &&
    args.incomingPlayback.currentTime + 0.6 < args.currentPlayback.currentTime
  ) {
    return {
      decision: "ignore-stale-like",
      reason: "timeline-regression",
    };
  }

  return { decision: "accept", reason: "default" };
}
