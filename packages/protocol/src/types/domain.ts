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
  /**
   * Hint that this state transition was driven by an explicit user gesture
   * (e.g. clicking pause) rather than a buffer stall, hydration, or
   * remote-state application. Receivers may use this to skip flicker-defence
   * debounces and apply the transition without delay. Optional for
   * backward-compatibility: legacy senders omit it; legacy receivers ignore it.
   */
  userInitiated?: boolean;
  /**
   * Hint that this paused state was produced because the sharer's shared video
   * reached its *natural* end (the sharer flushes a terminal paused once no
   * autoplay-next followed within the suppression window, or it followed too
   * slowly — e.g. behind a recommend-autoplay countdown). Receivers apply the
   * paused state but must not surface a misleading "paused" / "jumped to <end>"
   * toast for it. Additive and optional: legacy senders omit it; legacy
   * receivers ignore the unknown field and keep their prior toast behaviour.
   */
  naturalEnd?: boolean;
  /**
   * Hint that this paused state is the correction of a load/stall pause, not a
   * pause anybody performed: the sender classified a pause as `buffering`, and
   * once that classification's window elapsed the element was still paused, so
   * it re-broadcast the real `paused` to stop the room sitting on a stale
   * `buffering`.
   *
   * It is produced on a timer far longer than every echo-suppression window, so
   * a receiver cannot recover the fact locally — by the time it arrives, the
   * windows that would have identified it as an echo have closed. Receivers
   * must apply the state (it is true — the sender really is paused) but must
   * neither surface a "<name> paused the video" toast for it nor let it pause a
   * peer that is playing. Additive and optional: legacy senders omit it; legacy
   * receivers ignore the unknown field and keep their prior behaviour.
   */
  bufferUpgrade?: boolean;
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
