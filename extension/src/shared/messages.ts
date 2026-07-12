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
  | { type: "popup:set-page-share-button-enabled"; enabled: boolean }
  | { type: "popup:open-shared-video" };

export interface ActiveVideoResponsePayload {
  video: SharedVideo;
  playback: PlaybackState | null;
}

export type ContentToBackgroundMessage =
  | { type: "content:playback-update"; payload: PlaybackState }
  | { type: "content:report-user"; payload: { displayName: string } }
  | { type: "content:get-room-state" }
  | { type: "content:get-share-context" }
  | { type: "content:share-current-video" }
  | {
      type: "content:auto-share-next-video";
      payload: { previousSharedUrl: string; targetNormalizedUrl: string };
    }
  | { type: "content:get-page-share-button-settings" }
  | { type: "content:set-page-share-button-enabled"; enabled: boolean }
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
        clockOffsetMs: number | null;
        rttMs: number | null;
        pageShareButtonEnabled: boolean;
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
    typeof (payload as { serverUrl?: unknown }).serverUrl === "string" &&
    typeof (payload as { pageShareButtonEnabled?: unknown })
      .pageShareButtonEnabled === "boolean"
  );
}

export interface ActiveVideoResponse {
  ok: boolean;
  payload: ActiveVideoResponsePayload | null;
  tabId: number | null;
  error?: string;
}

export interface ShareContextResponse {
  ok: boolean;
  roomCode: string | null;
  memberCount: number | null;
  sharedVideo: SharedVideo | null;
  error?: string;
}

export interface ShareCurrentVideoResponse {
  ok: boolean;
  error?: string;
  /**
   * Set on a retryable `{ ok: false }` auto-share response when the failure is a
   * transient connectivity deferral (the sharer is reconnecting) rather than the
   * page bridge not having resolved the next video yet. The content controller
   * keeps retrying these without consuming the short page-bridge attempt budget,
   * so a slow WebSocket reconnect does not make it give up before the room can
   * advance.
   */
  deferred?: boolean;
}

export interface PageShareButtonSettingsResponse {
  ok: boolean;
  enabled: boolean;
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

export function isShareContextResponse(
  value: unknown,
): value is ShareContextResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as {
    ok?: unknown;
    roomCode?: unknown;
    memberCount?: unknown;
    sharedVideo?: unknown;
    error?: unknown;
  };
  if (typeof record.ok !== "boolean") {
    return false;
  }
  if (record.roomCode !== null && typeof record.roomCode !== "string") {
    return false;
  }
  if (
    record.memberCount !== null &&
    (typeof record.memberCount !== "number" ||
      !Number.isInteger(record.memberCount) ||
      record.memberCount < 0)
  ) {
    return false;
  }
  if (record.sharedVideo !== null && !isSharedVideo(record.sharedVideo)) {
    return false;
  }
  if (record.error !== undefined && typeof record.error !== "string") {
    return false;
  }
  return true;
}

export function isShareCurrentVideoResponse(
  value: unknown,
): value is ShareCurrentVideoResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as {
    ok?: unknown;
    error?: unknown;
    deferred?: unknown;
  };
  return (
    typeof record.ok === "boolean" &&
    (record.error === undefined || typeof record.error === "string") &&
    (record.deferred === undefined || typeof record.deferred === "boolean")
  );
}

export function isPageShareButtonSettingsResponse(
  value: unknown,
): value is PageShareButtonSettingsResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as {
    ok?: unknown;
    enabled?: unknown;
    error?: unknown;
  };
  return (
    typeof record.ok === "boolean" &&
    typeof record.enabled === "boolean" &&
    (record.error === undefined || typeof record.error === "string")
  );
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
  | {
      type: "background:page-share-button-settings";
      payload: {
        enabled: boolean;
      };
    }
  | { type: "background:get-current-video" };
