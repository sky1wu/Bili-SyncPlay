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
 * The clamp exists to satisfy the protocol, not to correct clocks: a negative
 * duration is meaningless and the guard rejects it, so the floor keeps a
 * malformed frame off the wire. It is deliberately not a skew filter — bounding
 * an implausibly *large* age is the receiver's call, since only the receiver
 * knows what its own extrapolation is worth (`MAX_TRUSTED_PLAYBACK_AGE_MS`).
 *
 * Known limitation, multi-node only: `serverTime` may have been stamped by a
 * different node, so the two readings can come from two clocks after all. A
 * peer node running behind makes the age negative and the floor reports the
 * snapshot as current; a peer running ahead inflates it, and only the receiver's
 * bound catches that. Cluster nodes are NTP-synced to within milliseconds, which
 * is orders of magnitude below the ~2.1s staleness this recovers, so the trade
 * is worth taking — closing it properly needs a cluster-wide time source for
 * `serverTime` itself, which is a change to the playback write path rather than
 * to this function.
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
