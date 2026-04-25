import type { PlaybackPlayState, RoomCode } from "./common.js";

export const PLAYBACK_SYNC_INTENTS = [
  "explicit-seek",
  "explicit-ratechange",
] as const;

export type PlaybackSyncIntent = (typeof PLAYBACK_SYNC_INTENTS)[number];

export function isPlaybackSyncIntent(
  value: unknown,
): value is PlaybackSyncIntent {
  return (
    typeof value === "string" &&
    (PLAYBACK_SYNC_INTENTS as readonly string[]).includes(value)
  );
}

export function isExplicitControlSyncIntent(
  syncIntent: PlaybackSyncIntent | null | undefined,
): boolean {
  return syncIntent === "explicit-seek" || syncIntent === "explicit-ratechange";
}

export interface SharedVideo {
  videoId: string;
  url: string;
  title: string;
  sharedByMemberId?: string;
  sharedByDisplayName?: string;
}

export interface PlaybackState {
  url: string;
  currentTime: number;
  playState: PlaybackPlayState;
  syncIntent?: PlaybackSyncIntent;
  playbackRate: number;
  updatedAt: number;
  serverTime: number;
  actorId: string;
  seq: number;
}

export interface RoomMember {
  id: string;
  name: string;
}

export interface RoomState {
  roomCode: RoomCode;
  sharedVideo: SharedVideo | null;
  playback: PlaybackState | null;
  members: RoomMember[];
}
