export type RoomCode = string;

export interface SharedVideo {
  videoId: string;
  url: string;
  title: string;
}

export interface PlaybackState {
  url: string;
  currentTime: number;
  playState: "playing" | "paused" | "buffering";
  playbackRate: number;
  updatedAt: number;
  serverTime: number;
  actorId: string;
  seq: number;
}

export interface RoomState {
  roomCode: RoomCode;
  sharedVideo: SharedVideo | null;
  playback: PlaybackState | null;
  members: string[];
}

export interface ClientHelloPayload {
  displayName?: string;
}

export interface CreateRoomMessage {
  type: "room:create";
  payload?: ClientHelloPayload;
}

export interface JoinRoomMessage {
  type: "room:join";
  payload: {
    roomCode: RoomCode;
    displayName?: string;
  };
}

export interface LeaveRoomMessage {
  type: "room:leave";
}

export interface ShareVideoMessage {
  type: "video:share";
  payload: SharedVideo;
}

export interface PlaybackUpdateMessage {
  type: "playback:update";
  payload: PlaybackState;
}

export interface SyncRequestMessage {
  type: "sync:request";
}

export interface SyncPingMessage {
  type: "sync:ping";
  payload: {
    clientSendTime: number;
  };
}

export type ClientMessage =
  | CreateRoomMessage
  | JoinRoomMessage
  | LeaveRoomMessage
  | ShareVideoMessage
  | PlaybackUpdateMessage
  | SyncRequestMessage
  | SyncPingMessage;

export interface RoomCreatedMessage {
  type: "room:created";
  payload: {
    roomCode: RoomCode;
    memberId: string;
  };
}

export interface RoomJoinedMessage {
  type: "room:joined";
  payload: {
    roomCode: RoomCode;
    memberId: string;
  };
}

export interface RoomStateMessage {
  type: "room:state";
  payload: RoomState;
}

export interface ErrorMessage {
  type: "error";
  payload: {
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

export function isClientMessage(value: unknown): value is ClientMessage {
  return typeof value === "object" && value !== null && "type" in value;
}
