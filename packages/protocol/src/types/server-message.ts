import type { ErrorCode, RoomCode } from "./common.js";
import type { RoomMember, RoomState } from "./domain.js";

export interface RoomCreatedMessage {
  type: "room:created";
  payload: {
    roomCode: RoomCode;
    memberId: string;
    joinToken: string;
    memberToken: string;
    serverProtocolVersion?: number;
  };
}

export interface RoomJoinedMessage {
  type: "room:joined";
  payload: {
    roomCode: RoomCode;
    memberId: string;
    memberToken: string;
    serverProtocolVersion?: number;
  };
}

/**
 * `room:state` payload: the room state, plus how stale its playback snapshot
 * already was when the server sent it.
 *
 * `playbackAgeMs` deliberately lives here rather than inside `PlaybackState`,
 * and is deliberately a *duration* rather than a timestamp:
 *
 * - A duration is safe to send across two disagreeing clocks — the receiver
 *   only ever adds it to an anchor of its own. A timestamp is not: subtracting
 *   a server timestamp from a local one measures the clock disagreement, which
 *   is not a duration and drifts on its own.
 * - The age is only true at the instant of sending, so it must be computed per
 *   send and must never be stored in the room state. Keeping it off
 *   `PlaybackState` — the shape the server persists and the shape clients send
 *   in `playback:update` — makes storing it structurally impossible instead of
 *   a rule someone has to remember.
 *
 * Optional for backward compatibility: legacy servers omit it, and receivers
 * treat a missing value as 0 (the pre-#212 behaviour of assuming a freshly
 * arrived snapshot is current).
 */
export interface RoomStatePayload extends RoomState {
  playbackAgeMs?: number;
}

export interface RoomStateMessage {
  type: "room:state";
  payload: RoomStatePayload;
}

export interface RoomMemberJoinedMessage {
  type: "room:member-joined";
  payload: {
    roomCode: RoomCode;
    member: RoomMember;
  };
}

export interface RoomMemberLeftMessage {
  type: "room:member-left";
  payload: {
    roomCode: RoomCode;
    member: RoomMember;
  };
}

export interface ErrorMessage {
  type: "error";
  payload: {
    code: ErrorCode;
    message: string;
  };
}

export interface SyncPongMessage {
  type: "sync:pong";
  payload: {
    clientSendTime: number;
    serverReceiveTime: number;
    serverSendTime: number;
  };
}

export type ServerMessage =
  | RoomCreatedMessage
  | RoomJoinedMessage
  | RoomStateMessage
  | RoomMemberJoinedMessage
  | RoomMemberLeftMessage
  | ErrorMessage
  | SyncPongMessage;
