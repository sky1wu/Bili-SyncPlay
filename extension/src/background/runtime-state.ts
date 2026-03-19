import type {
  PlaybackState,
  RoomState,
  SharedVideo,
} from "@bili-syncplay/protocol";
import type {
  DebugLogEntry,
  SharedVideoToastPayload,
} from "../shared/messages";

declare const __BILI_SYNCPLAY_DEFAULT_SERVER_URL__: string | undefined;

const LOCALHOST_SERVER_URL = "ws://localhost:8787";

export const DEFAULT_SERVER_URL =
  typeof __BILI_SYNCPLAY_DEFAULT_SERVER_URL__ === "string"
    ? __BILI_SYNCPLAY_DEFAULT_SERVER_URL__
    : LOCALHOST_SERVER_URL;
export const MAX_RECONNECT_ATTEMPTS = 5;
export const SHARE_TOAST_TTL_MS = 8000;
export const BILIBILI_VIDEO_URL_PATTERNS = [
  "https://www.bilibili.com/video/*",
  "https://www.bilibili.com/bangumi/play/*",
  "https://www.bilibili.com/festival/*",
  "https://www.bilibili.com/list/watchlater*",
  "https://www.bilibili.com/medialist/play/watchlater*",
];

export interface ConnectionState {
  socket: WebSocket | null;
  serverUrl: string;
  connected: boolean;
  lastError: string | null;
  connectProbe: Promise<void> | null;
  reconnectTimer: number | null;
  reconnectAttempt: number;
  reconnectDeadlineMs: number | null;
}

export interface RoomSessionState {
  roomCode: string | null;
  joinToken: string | null;
  memberToken: string | null;
  memberId: string | null;
  displayName: string | null;
  roomState: RoomState | null;
  pendingCreateRoom: boolean;
  pendingJoinRoomCode: string | null;
  pendingJoinToken: string | null;
  pendingJoinRequestSent: boolean;
  pendingSharedVideo: SharedVideo | null;
  pendingSharedPlayback: PlaybackState | null;
}

export interface ShareState {
  sharedTabId: number | null;
  lastOpenedSharedUrl: string | null;
  openingSharedUrl: string | null;
  pendingLocalShareUrl: string | null;
  pendingLocalShareExpiresAt: number | null;
  pendingLocalShareTimer: number | null;
  pendingShareToast:
    | (SharedVideoToastPayload & { expiresAt: number; roomCode: string })
    | null;
}

export interface ClockState {
  clockOffsetMs: number | null;
  rttMs: number | null;
  clockSyncTimer: number | null;
}

export interface DiagnosticsState {
  logs: DebugLogEntry[];
  lastPopupStateLogKey: string | null;
}

export interface BackgroundRuntimeState {
  connection: ConnectionState;
  room: RoomSessionState;
  share: ShareState;
  clock: ClockState;
  diagnostics: DiagnosticsState;
}

export function createBackgroundRuntimeState(): BackgroundRuntimeState {
  return {
    connection: {
      socket: null,
      serverUrl: DEFAULT_SERVER_URL,
      connected: false,
      lastError: null,
      connectProbe: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      reconnectDeadlineMs: null,
    },
    room: {
      roomCode: null,
      joinToken: null,
      memberToken: null,
      memberId: null,
      displayName: null,
      roomState: null,
      pendingCreateRoom: false,
      pendingJoinRoomCode: null,
      pendingJoinToken: null,
      pendingJoinRequestSent: false,
      pendingSharedVideo: null,
      pendingSharedPlayback: null,
    },
    share: {
      sharedTabId: null,
      lastOpenedSharedUrl: null,
      openingSharedUrl: null,
      pendingLocalShareUrl: null,
      pendingLocalShareExpiresAt: null,
      pendingLocalShareTimer: null,
      pendingShareToast: null,
    },
    clock: {
      clockOffsetMs: null,
      rttMs: null,
      clockSyncTimer: null,
    },
    diagnostics: {
      logs: [],
      lastPopupStateLogKey: null,
    },
  };
}
