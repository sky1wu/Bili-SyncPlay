/**
 * What the extension announces it implements. Deliberately one behind the
 * server's `CURRENT_PROTOCOL_VERSION` (5) until the extension consumes
 * `server:announcement` (#325, PR C): announcing 5 earlier would have the
 * server send announcements that a released extension silently ignores.
 */
export const PROTOCOL_VERSION = 4;

export type RoomCode = string;
export type PlaybackPlayState = "playing" | "paused" | "buffering";
export type ErrorCode =
  | "origin_not_allowed"
  | "room_not_found"
  | "join_token_invalid"
  | "member_token_invalid"
  | "not_in_room"
  | "rate_limited"
  | "invalid_message"
  | "payload_too_large"
  | "room_full"
  | "unsupported_protocol_version"
  | "internal_error";
