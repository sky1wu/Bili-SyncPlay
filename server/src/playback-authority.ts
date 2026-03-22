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

  const currentIsStopLike =
    args.currentPlayback.playState === "paused" ||
    args.currentPlayback.playState === "buffering";
  const incomingIsPlaying = args.incomingPlayback.playState === "playing";
  const authority = args.authority;
  const withinAuthorityWindow =
    authority !== null && args.currentTime < authority.until;
  const closeInTimeline =
    Math.abs(
      args.incomingPlayback.currentTime - args.currentPlayback.currentTime,
    ) < 1.2;
  const driftsBackBehindCurrent =
    args.incomingPlayback.currentTime + 0.6 < args.currentPlayback.currentTime;

  if (
    withinAuthorityWindow &&
    authority.actorId !== args.incomingPlayback.actorId &&
    incomingIsPlaying &&
    (currentIsStopLike || closeInTimeline)
  ) {
    return {
      decision: "ignore-as-follow",
      reason: "authority-window-follow",
    };
  }

  if (incomingIsPlaying && driftsBackBehindCurrent) {
    return {
      decision: "ignore-stale-like",
      reason: "timeline-regression",
    };
  }

  return { decision: "accept", reason: "default" };
}
