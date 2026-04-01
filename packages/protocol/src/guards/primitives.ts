import type { PlaybackPlayState, RoomCode } from "../types/common.js";
import { parseBilibiliVideoRef } from "../video-ref.js";

const PLAYBACK_PLAY_STATES: PlaybackPlayState[] = [
  "playing",
  "paused",
  "buffering",
];
const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9:_-]{0,63})$/;
const VIDEO_ID_PATTERN =
  /^(?:BV[0-9A-Za-z]+|(?:av|ep|ss)\d+)(?::(?:p[1-9]\d*|[1-9]\d*))?$/;
const TOKEN_MIN_LENGTH = 16;
const TOKEN_MAX_LENGTH = 128;

function hasStringLengthInRange(
  value: string,
  minLength: number,
  maxLength: number,
): boolean {
  return value.length >= minLength && value.length <= maxLength;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isRoomCode(value: unknown): value is RoomCode {
  return isString(value) && ROOM_CODE_PATTERN.test(value);
}

export function isActorId(value: unknown): value is string {
  return isString(value) && ACTOR_ID_PATTERN.test(value);
}

export function isBilibiliUrl(value: unknown): value is string {
  return isString(value) && parseBilibiliVideoRef(value) !== null;
}

export function isVideoId(value: unknown): value is string {
  return isString(value) && VIDEO_ID_PATTERN.test(value);
}

export function isToken(value: unknown): value is string {
  return (
    isString(value) &&
    hasStringLengthInRange(value, TOKEN_MIN_LENGTH, TOKEN_MAX_LENGTH)
  );
}

export function isPlaybackPlayState(
  value: unknown,
): value is PlaybackPlayState {
  return (
    isString(value) && PLAYBACK_PLAY_STATES.includes(value as PlaybackPlayState)
  );
}
