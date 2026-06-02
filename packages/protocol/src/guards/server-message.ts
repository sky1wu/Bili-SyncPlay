import type {
  ErrorMessage,
  RoomCreatedMessage,
  RoomJoinedMessage,
  RoomMemberJoinedMessage,
  RoomMemberLeftMessage,
  RoomStateMessage,
  ServerMessage,
  SyncPongMessage,
  VoiceAccessGrantedMessage,
  ServerVoiceStateMessage,
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
const LIVEKIT_TOKEN_MIN_LENGTH = 16;
const LIVEKIT_TOKEN_MAX_LENGTH = 4096;
const LIVEKIT_ROOM_NAME_MAX_LENGTH = 128;

function isBoundedString(value: unknown, maxLength: number): value is string {
  return isString(value) && value.length <= maxLength;
}

function isLiveKitUrl(value: unknown): value is string {
  if (!isBoundedString(value, URL_MAX_LENGTH)) {
    return false;
  }
  try {
    const parsedUrl = new URL(value);
    return parsedUrl.protocol === "ws:" || parsedUrl.protocol === "wss:";
  } catch {
    return false;
  }
}

function isLiveKitToken(value: unknown): value is string {
  return (
    isString(value) &&
    value.length >= LIVEKIT_TOKEN_MIN_LENGTH &&
    value.length <= LIVEKIT_TOKEN_MAX_LENGTH
  );
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
    (value.userInitiated === undefined ||
      typeof value.userInitiated === "boolean") &&
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

function isRoomMemberJoinedMessage(
  value: unknown,
): value is RoomMemberJoinedMessage {
  return (
    isRecord(value) &&
    value.type === "room:member-joined" &&
    isRecord(value.payload) &&
    isRoomCode(value.payload.roomCode) &&
    isRoomMember(value.payload.member)
  );
}

function isRoomMemberLeftMessage(
  value: unknown,
): value is RoomMemberLeftMessage {
  return (
    isRecord(value) &&
    value.type === "room:member-left" &&
    isRecord(value.payload) &&
    isRoomCode(value.payload.roomCode) &&
    isRoomMember(value.payload.member)
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

function isVoiceAccessGrantedMessage(
  value: unknown,
): value is VoiceAccessGrantedMessage {
  return (
    isRecord(value) &&
    value.type === "voice:access-granted" &&
    isRecord(value.payload) &&
    isLiveKitUrl(value.payload.livekitUrl) &&
    isLiveKitToken(value.payload.token) &&
    isBoundedString(value.payload.roomName, LIVEKIT_ROOM_NAME_MAX_LENGTH) &&
    isActorId(value.payload.participantIdentity) &&
    isFiniteNumber(value.payload.expiresAt)
  );
}

function isVoiceStateMessage(value: unknown): value is ServerVoiceStateMessage {
  return (
    isRecord(value) &&
    value.type === "voice:state" &&
    isRecord(value.payload) &&
    isRoomCode(value.payload.roomCode) &&
    isActorId(value.payload.memberId) &&
    typeof value.payload.connected === "boolean" &&
    typeof value.payload.muted === "boolean" &&
    (value.payload.speaking === undefined ||
      typeof value.payload.speaking === "boolean")
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
    case "room:member-joined":
      return isRoomMemberJoinedMessage(value);
    case "room:member-left":
      return isRoomMemberLeftMessage(value);
    case "error":
      return isErrorMessage(value);
    case "sync:pong":
      return isSyncPongMessage(value);
    case "voice:access-granted":
      return isVoiceAccessGrantedMessage(value);
    case "voice:state":
      return isVoiceStateMessage(value);
    default:
      return false;
  }
}
