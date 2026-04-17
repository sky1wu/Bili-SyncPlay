import {
  isPlaybackState,
  isSharedVideo,
  type PlaybackState,
  type RoomState,
  type SharedVideo,
} from "@bili-syncplay/protocol";

export interface SharedVideoToastPayload {
  key: string;
  actorId: string | null;
  title: string;
  videoUrl: string;
}

export type PopupToBackgroundMessage =
  | { type: "popup:create-room" }
  | { type: "popup:join-room"; roomCode: string; joinToken: string }
  | { type: "popup:leave-room" }
  | { type: "popup:debug-log"; message: string }
  | { type: "popup:get-state" }
  | { type: "popup:get-active-video" }
  | { type: "popup:share-current-video" }
  | { type: "popup:set-server-url"; serverUrl: string }
  | { type: "popup:open-shared-video" };

export type ContentToBackgroundMessage =
  | { type: "content:playback-update"; payload: PlaybackState }
  | { type: "content:report-user"; payload: { displayName: string } }
  | { type: "content:get-room-state" }
  | { type: "content:debug-log"; payload: { message: string } };

export interface DebugLogEntry {
  at: number;
  scope: "background" | "content" | "server" | "popup";
  message: string;
}

export type BackgroundToPopupMessage =
  | {
      type: "background:state";
      payload: {
        connected: boolean;
        roomCode: string | null;
        joinToken: string | null;
        memberId: string | null;
        displayName: string | null;
        roomState: RoomState | null;
        serverUrl: string;
        error: string | null;
        pendingCreateRoom: boolean;
        pendingJoinRoomCode: string | null;
        retryInMs: number | null;
        retryAttempt: number;
        retryAttemptMax: number;
        clockOffsetMs: number | null;
        rttMs: number | null;
        logs: DebugLogEntry[];
      };
    }
  | {
      type: "background:popup-connected";
      payload: {
        connectedAt: number;
      };
    };

export type BackgroundPopupState = Extract<
  BackgroundToPopupMessage,
  { type: "background:state" }
>["payload"];

export type BackgroundPopupStateMessage = Extract<
  BackgroundToPopupMessage,
  { type: "background:state" }
>;

export type BackgroundPopupConnected = Extract<
  BackgroundToPopupMessage,
  { type: "background:popup-connected" }
>["payload"];

export function isBackgroundPopupStateMessage(
  value: unknown,
): value is BackgroundPopupStateMessage {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { type?: unknown }).type !== "background:state"
  ) {
    return false;
  }
  const payload = (value as { payload?: unknown }).payload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { connected?: unknown }).connected === "boolean" &&
    typeof (payload as { serverUrl?: unknown }).serverUrl === "string"
  );
}

export interface ActiveVideoResponsePayload {
  video: SharedVideo;
  playback: PlaybackState | null;
}

export interface ActiveVideoResponse {
  ok: boolean;
  payload: ActiveVideoResponsePayload | null;
  tabId: number | null;
  error?: string;
}

export function isActiveVideoResponse(
  value: unknown,
): value is ActiveVideoResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as {
    ok?: unknown;
    payload?: unknown;
    tabId?: unknown;
    error?: unknown;
  };
  if (typeof record.ok !== "boolean") {
    return false;
  }
  if (record.tabId !== null && typeof record.tabId !== "number") {
    return false;
  }
  if (record.error !== undefined && typeof record.error !== "string") {
    return false;
  }
  if (record.payload === null) {
    return record.ok === false;
  }
  if (typeof record.payload !== "object") {
    return false;
  }
  const payload = record.payload as {
    video?: unknown;
    playback?: unknown;
  };
  if (!isSharedVideo(payload.video)) {
    return false;
  }
  if (payload.playback !== null && !isPlaybackState(payload.playback)) {
    return false;
  }
  return true;
}

export type BackgroundToContentMessage =
  | {
      type: "background:apply-room-state";
      payload: RoomState;
      shareToast?: SharedVideoToastPayload | null;
    }
  | {
      type: "background:sync-status";
      payload: {
        roomCode: string | null;
        connected: boolean;
        memberId: string | null;
        rttMs: number | null;
      };
    }
  | { type: "background:get-current-video" };
