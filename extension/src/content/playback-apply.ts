import type {
  PlaybackState,
  RoomState,
  SharedVideo,
} from "@bili-syncplay/protocol";

export interface PlaybackApplyDecisionInput {
  roomState: RoomState;
  currentVideo: SharedVideo | null;
  normalizedSharedUrl: string | null;
  normalizedCurrentUrl: string | null;
  normalizedPlaybackUrl: string | null;
  pendingRoomStateHydration: boolean;
  explicitNonSharedPlaybackUrl: string | null;
  now: number;
  lastLocalIntentAt: number;
  lastLocalIntentPlayState: PlaybackState["playState"] | null;
  localIntentGuardMs: number;
  lastAppliedVersion: { serverTime: number; seq: number } | null;
  lastLocalPlaybackVersion: { serverTime: number; seq: number } | null;
  localMemberId: string | null;
}

export type PlaybackApplyDecision =
  | { kind: "empty-room"; acceptedHydration: boolean }
  | { kind: "no-current-video" }
  | {
      kind: "ignore-non-shared";
      acceptedHydration: boolean;
      shouldPauseNonSharedVideo: boolean;
    }
  | { kind: "ignore-local-guard" }
  | { kind: "ignore-stale-playback" }
  | { kind: "ignore-self-playback-version" }
  | {
      kind: "apply";
      isSelfPlayback: boolean;
      playback: PlaybackState;
    };

export function decidePlaybackApplication(
  input: PlaybackApplyDecisionInput,
): PlaybackApplyDecision {
  if (!input.roomState.sharedVideo || !input.roomState.playback) {
    return {
      kind: "empty-room",
      acceptedHydration: input.pendingRoomStateHydration,
    };
  }

  if (!input.currentVideo) {
    return { kind: "no-current-video" };
  }

  if (
    !input.normalizedSharedUrl ||
    input.normalizedCurrentUrl !== input.normalizedSharedUrl ||
    input.normalizedPlaybackUrl !== input.normalizedSharedUrl
  ) {
    return {
      kind: "ignore-non-shared",
      acceptedHydration: input.pendingRoomStateHydration,
      shouldPauseNonSharedVideo: false,
    };
  }

  if (
    input.lastLocalIntentPlayState &&
    input.now - input.lastLocalIntentAt < input.localIntentGuardMs &&
    (input.lastLocalIntentPlayState === "paused" ||
      input.lastLocalIntentPlayState === "buffering") &&
    input.roomState.playback.playState === "playing"
  ) {
    return { kind: "ignore-local-guard" };
  }

  if (
    input.lastAppliedVersion &&
    (input.roomState.playback.serverTime <
      input.lastAppliedVersion.serverTime ||
      (input.roomState.playback.serverTime ===
        input.lastAppliedVersion.serverTime &&
        input.roomState.playback.seq <= input.lastAppliedVersion.seq))
  ) {
    return { kind: "ignore-stale-playback" };
  }

  if (
    input.localMemberId &&
    input.roomState.playback.actorId === input.localMemberId &&
    input.lastLocalPlaybackVersion &&
    input.roomState.playback.seq <= input.lastLocalPlaybackVersion.seq
  ) {
    return { kind: "ignore-self-playback-version" };
  }

  return {
    kind: "apply",
    isSelfPlayback: Boolean(
      input.localMemberId &&
      input.roomState.playback.actorId === input.localMemberId,
    ),
    playback: input.roomState.playback,
  };
}
