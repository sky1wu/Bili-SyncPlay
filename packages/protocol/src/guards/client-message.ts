import type {
  ClientHelloPayload,
  ClientMessage,
  CreateRoomMessage,
  JoinRoomMessage,
  LeaveRoomMessage,
  PlaybackUpdateMessage,
  ProfileUpdateMessage,
  ShareVideoMessage,
  SyncPingMessage,
  SyncRequestMessage,
} from "../types/client-message.js";
import type { PlaybackState, SharedVideo } from "../types/domain.js";
import { isPlaybackSyncIntent } from "../types/domain.js";
import {
  isActorId,
  isBilibiliUrl,
  isFiniteNumber,
  isOptionalNonNegativeInteger,
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

function isOptionalBoundedString(
  value: unknown,
  maxLength: number,
): value is string | undefined {
  return value === undefined || isBoundedString(value, maxLength);
}

export function isClientHelloPayload(
  value: unknown,
): value is ClientHelloPayload {
  return (
    isRecord(value) &&
    isOptionalBoundedString(value.displayName, DISPLAY_NAME_MAX_LENGTH) &&
    isOptionalNonNegativeInteger(value.protocolVersion)
  );
}

export function isSharedVideo(value: unknown): value is SharedVideo {
  return (
    isRecord(value) &&
    isBoundedString(value.videoId, TITLE_MAX_LENGTH) &&
    isVideoId(value.videoId) &&
    isBoundedString(value.url, URL_MAX_LENGTH) &&
    isBilibiliUrl(value.url) &&
    isBoundedString(value.title, TITLE_MAX_LENGTH) &&
    isOptionalBoundedString(value.sharedByMemberId, DISPLAY_NAME_MAX_LENGTH) &&
    (value.sharedByMemberId === undefined ||
      isActorId(value.sharedByMemberId)) &&
    isOptionalBoundedString(value.sharedByDisplayName, DISPLAY_NAME_MAX_LENGTH)
  );
}

export function isPlaybackState(value: unknown): value is PlaybackState {
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

function isCreateRoomMessage(value: unknown): value is CreateRoomMessage {
  return (
    isRecord(value) &&
    value.type === "room:create" &&
    (value.payload === undefined || isClientHelloPayload(value.payload))
  );
}

function isJoinRoomPayload(
  value: unknown,
): value is JoinRoomMessage["payload"] {
  return (
    isRecord(value) &&
    isRoomCode(value.roomCode) &&
    isToken(value.joinToken) &&
    (value.memberToken === undefined || isToken(value.memberToken)) &&
    isOptionalBoundedString(value.displayName, DISPLAY_NAME_MAX_LENGTH) &&
    isOptionalNonNegativeInteger(value.protocolVersion)
  );
}

function isJoinRoomMessage(value: unknown): value is JoinRoomMessage {
  return (
    isRecord(value) &&
    value.type === "room:join" &&
    isJoinRoomPayload(value.payload)
  );
}

function isProfileUpdatePayload(
  value: unknown,
): value is ProfileUpdateMessage["payload"] {
  return (
    isRecord(value) &&
    isToken(value.memberToken) &&
    isBoundedString(value.displayName, DISPLAY_NAME_MAX_LENGTH)
  );
}

function isProfileUpdateMessage(value: unknown): value is ProfileUpdateMessage {
  return (
    isRecord(value) &&
    value.type === "profile:update" &&
    isProfileUpdatePayload(value.payload)
  );
}

function isLeaveRoomPayload(
  value: unknown,
): value is NonNullable<LeaveRoomMessage["payload"]> {
  return (
    isRecord(value) &&
    (value.memberToken === undefined || isToken(value.memberToken))
  );
}

function isLeaveRoomMessage(value: unknown): value is LeaveRoomMessage {
  return (
    isRecord(value) &&
    value.type === "room:leave" &&
    (value.payload === undefined || isLeaveRoomPayload(value.payload))
  );
}

function isShareVideoPayload(
  value: unknown,
): value is ShareVideoMessage["payload"] {
  return (
    isRecord(value) &&
    isToken(value.memberToken) &&
    isSharedVideo(value.video) &&
    (value.playback === undefined || isPlaybackState(value.playback))
  );
}

function isShareVideoMessage(value: unknown): value is ShareVideoMessage {
  return (
    isRecord(value) &&
    value.type === "video:share" &&
    isShareVideoPayload(value.payload)
  );
}

function isPlaybackUpdatePayload(
  value: unknown,
): value is PlaybackUpdateMessage["payload"] {
  return (
    isRecord(value) &&
    isToken(value.memberToken) &&
    isPlaybackState(value.playback)
  );
}

function isPlaybackUpdateMessage(
  value: unknown,
): value is PlaybackUpdateMessage {
  return (
    isRecord(value) &&
    value.type === "playback:update" &&
    isPlaybackUpdatePayload(value.payload)
  );
}

function isSyncRequestPayload(
  value: unknown,
): value is SyncRequestMessage["payload"] {
  return isRecord(value) && isToken(value.memberToken);
}

function isSyncRequestMessage(value: unknown): value is SyncRequestMessage {
  return (
    isRecord(value) &&
    value.type === "sync:request" &&
    isSyncRequestPayload(value.payload)
  );
}

function isSyncPingPayload(
  value: unknown,
): value is SyncPingMessage["payload"] {
  return isRecord(value) && isFiniteNumber(value.clientSendTime);
}

function isSyncPingMessage(value: unknown): value is SyncPingMessage {
  return (
    isRecord(value) &&
    value.type === "sync:ping" &&
    isSyncPingPayload(value.payload)
  );
}

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || !isString(value.type)) {
    return false;
  }

  switch (value.type) {
    case "room:create":
      return isCreateRoomMessage(value);
    case "room:join":
      return isJoinRoomMessage(value);
    case "profile:update":
      return isProfileUpdateMessage(value);
    case "room:leave":
      return isLeaveRoomMessage(value);
    case "video:share":
      return isShareVideoMessage(value);
    case "playback:update":
      return isPlaybackUpdateMessage(value);
    case "sync:request":
      return isSyncRequestMessage(value);
    case "sync:ping":
      return isSyncPingMessage(value);
    default:
      return false;
  }
}
