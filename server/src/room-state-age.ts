import type { RoomState, RoomStatePayload } from "@bili-syncplay/protocol";

/**
 * Stamp a `room:state` payload with how stale its playback snapshot is.
 *
 * Both operands are the server's own clock — `playback.serverTime` was written
 * by `now()` when the update was accepted — so this subtraction stays inside
 * one clock. What crosses to the client is the resulting *duration*, which is
 * what makes it safe: the receiver adds it to an anchor of its own instead of
 * comparing our timestamps against its own (see `RoomStatePayload`).
 *
 * This must be called at each send, never stored: an age is only true at the
 * instant it is sent, and a stored one is just a timestamp in disguise.
 *
 * The clamp covers the one case where the two timestamps are not from the same
 * clock after all: in a multi-node deployment the snapshot may have been
 * stamped by another node, whose clock can sit slightly behind this one's. A
 * negative result is meaningless as a duration (and rejected by the protocol
 * guard), so report the snapshot as current instead.
 */
export function withPlaybackAge(
  state: RoomState,
  sentAtMs: number,
): RoomStatePayload {
  if (!state.playback) {
    return state;
  }
  return {
    ...state,
    playbackAgeMs: Math.max(0, sentAtMs - state.playback.serverTime),
  };
}
