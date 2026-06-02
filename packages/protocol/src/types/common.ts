export const PROTOCOL_VERSION = 3;

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
  | "voice_unavailable"
  | "voice_capacity_reached"
  | "voice_token_failed"
  | "internal_error";
