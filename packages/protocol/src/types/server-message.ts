import type { ErrorCode, RoomCode } from "./common.js";
import type { RoomState } from "./domain.js";

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

export interface RoomStateMessage {
  type: "room:state";
  payload: RoomState;
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
  | ErrorMessage
  | SyncPongMessage;
