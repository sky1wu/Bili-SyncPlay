import type {
  ErrorMessage,
  RoomCreatedMessage,
  RoomJoinedMessage,
  RoomStateMessage,
  ServerMessage,
  SyncPongMessage,
} from "../types/server-message.js";
import type {
  PlaybackState,
  RoomMember,
  RoomState,
  SharedVideo,
} from "../types/domain.js";
import { isPlaybackSyncIntent } from "../types/domain.js";
import {
  isActorId,
  isBilibiliUrl,
  isFiniteNumber,
  isOptionalString,
  isOptionalPositiveInteger,
  isPlaybackPlayState,
  isRecord,
  isRoomCode,
  isString,
  isToken,
  isVideoId,
} from "./primitives.js";

const DISPLAY_NAME_MAX_LENGTH = 32;
const TITLE_MAX_LENGTH = 128;
const URL_MAX_LENGTH = 512;

function isBoundedString(value: unknown, maxLength: number): value is string {
  return isString(value) && value.length <= maxLength;
}

function isSharedVideo(value: unknown): value is SharedVideo {
  return (
    isRecord(value) &&
    isBoundedString(value.videoId, TITLE_MAX_LENGTH) &&
    isVideoId(value.videoId) &&
    isBoundedString(value.url, URL_MAX_LENGTH) &&
    isBilibiliUrl(value.url) &&
    isBoundedString(value.title, TITLE_MAX_LENGTH) &&
    isOptionalString(value.sharedByMemberId) &&
    (value.sharedByMemberId === undefined ||
      isActorId(value.sharedByMemberId)) &&
    (value.sharedByDisplayName === undefined ||
      isBoundedString(value.sharedByDisplayName, DISPLAY_NAME_MAX_LENGTH))
  );
}

function isPlaybackState(value: unknown): value is PlaybackState {
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
    isActorId(value.actorId) &&
    isFiniteNumber(value.seq)
  );
}

export function isRoomMember(value: unknown): value is RoomMember {
  return (
    isRecord(value) &&
    isActorId(value.id) &&
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
    isActorId(value.payload.memberId) &&
    isToken(value.payload.joinToken) &&
    isToken(value.payload.memberToken) &&
    isOptionalPositiveInteger(value.payload.serverProtocolVersion)
  );
}

function isRoomJoinedMessage(value: unknown): value is RoomJoinedMessage {
  return (
    isRecord(value) &&
    value.type === "room:joined" &&
    isRecord(value.payload) &&
    isRoomCode(value.payload.roomCode) &&
    isActorId(value.payload.memberId) &&
    isToken(value.payload.memberToken) &&
    isOptionalPositiveInteger(value.payload.serverProtocolVersion)
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
