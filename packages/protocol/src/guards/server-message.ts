import type {
  ErrorMessage,
  RoomCreatedMessage,
  RoomJoinedMessage,
  RoomStateMessage,
  ServerMessage,
  SyncPongMessage,
} from "../types/server-message.js";
import type { RoomMember, RoomState } from "../types/domain.js";
import {
  isFiniteNumber,
  isPlaybackPlayState,
  isRecord,
  isRoomCode,
  isString,
  isToken,
} from "./primitives.js";

const DISPLAY_NAME_MAX_LENGTH = 32;
const TITLE_MAX_LENGTH = 128;
const URL_MAX_LENGTH = 512;

function isBoundedString(value: unknown, maxLength: number): value is string {
  return isString(value) && value.length <= maxLength;
}

function isOptionalBoundedString(
  value: unknown,
  maxLength: number,
): value is string | undefined {
  return value === undefined || isBoundedString(value, maxLength);
}

function isPlaybackSyncIntent(value: unknown): boolean {
  return value === "explicit-seek";
}

function isSharedVideo(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedString(value.videoId, TITLE_MAX_LENGTH) &&
    isBoundedString(value.url, URL_MAX_LENGTH) &&
    isBoundedString(value.title, TITLE_MAX_LENGTH) &&
    isOptionalBoundedString(value.sharedByMemberId, DISPLAY_NAME_MAX_LENGTH)
  );
}

function isPlaybackState(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedString(value.url, URL_MAX_LENGTH) &&
    isFiniteNumber(value.currentTime) &&
    isPlaybackPlayState(value.playState) &&
    (value.syncIntent === undefined ||
      isPlaybackSyncIntent(value.syncIntent)) &&
    isFiniteNumber(value.playbackRate) &&
    isFiniteNumber(value.updatedAt) &&
    isFiniteNumber(value.serverTime) &&
    isString(value.actorId) &&
    isFiniteNumber(value.seq)
  );
}

export function isRoomMember(value: unknown): value is RoomMember {
  return (
    isRecord(value) &&
    isBoundedString(value.id, DISPLAY_NAME_MAX_LENGTH) &&
    isBoundedString(value.name, DISPLAY_NAME_MAX_LENGTH)
  );
}

export function isRoomState(value: unknown): value is RoomState {
  return (
    isRecord(value) &&
    isRoomCode(value.roomCode) &&
    (value.sharedVideo === null || isSharedVideo(value.sharedVideo)) &&
    (value.playback === null || isPlaybackState(value.playback)) &&
    Array.isArray(value.members) &&
    value.members.every((member) => isRoomMember(member))
  );
}

function isRoomCreatedMessage(value: unknown): value is RoomCreatedMessage {
  return (
    isRecord(value) &&
    value.type === "room:created" &&
    isRecord(value.payload) &&
    isRoomCode(value.payload.roomCode) &&
    isString(value.payload.memberId) &&
    isToken(value.payload.joinToken) &&
    isToken(value.payload.memberToken)
  );
}

function isRoomJoinedMessage(value: unknown): value is RoomJoinedMessage {
  return (
    isRecord(value) &&
    value.type === "room:joined" &&
    isRecord(value.payload) &&
    isRoomCode(value.payload.roomCode) &&
    isString(value.payload.memberId) &&
    isToken(value.payload.memberToken)
  );
}

function isRoomStateMessage(value: unknown): value is RoomStateMessage {
  return (
    isRecord(value) && value.type === "room:state" && isRoomState(value.payload)
  );
}

export function isErrorMessage(value: unknown): value is ErrorMessage {
  return (
    isRecord(value) &&
    value.type === "error" &&
    isRecord(value.payload) &&
    isBoundedString(value.payload.code, 32) &&
    isBoundedString(value.payload.message, TITLE_MAX_LENGTH)
  );
}

function isSyncPongMessage(value: unknown): value is SyncPongMessage {
  return (
    isRecord(value) &&
    value.type === "sync:pong" &&
    isRecord(value.payload) &&
    isFiniteNumber(value.payload.clientSendTime) &&
    isFiniteNumber(value.payload.serverReceiveTime) &&
    isFiniteNumber(value.payload.serverSendTime)
  );
}

export function isServerMessage(value: unknown): value is ServerMessage {
  if (!isRecord(value) || !isString(value.type)) {
    return false;
  }

  switch (value.type) {
    case "room:created":
      return isRoomCreatedMessage(value);
    case "room:joined":
      return isRoomJoinedMessage(value);
    case "room:state":
      return isRoomStateMessage(value);
    case "error":
      return isErrorMessage(value);
    case "sync:pong":
      return isSyncPongMessage(value);
    default:
      return false;
  }
}
