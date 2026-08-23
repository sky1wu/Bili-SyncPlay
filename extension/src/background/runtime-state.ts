import type {
  PlaybackState,
  RoomState,
  SharedVideo,
} from "@bili-syncplay/protocol";
import type {
  DebugLogEntry,
  SharedVideoToastPayload,
} from "../shared/messages";
import type { ClockSample } from "./clock-sync";

declare const __BILI_SYNCPLAY_DEFAULT_SERVER_URL__: string | undefined;

const LOCALHOST_SERVER_URL = "ws://localhost:8787";

export const DEFAULT_SERVER_URL =
  typeof __BILI_SYNCPLAY_DEFAULT_SERVER_URL__ === "string"
    ? __BILI_SYNCPLAY_DEFAULT_SERVER_URL__
    : LOCALHOST_SERVER_URL;
export const SHARE_TOAST_TTL_MS = 8000;
/**
 * The list-playback segments the extension injects into. Match patterns support
 * only `*`, so the `ml<mlid>` / numeric-mid shape `parseBilibiliVideoRef`
 * accepts has to be spelled out as prefixes: `ml`, and one entry per leading
 * digit for a creator collection's numeric mid. A page these prefixes over-match
 * (`/list/mlfoo`) still normalizes to `null`, so it never matches a shared URL —
 * but keeping the prefixes narrow is what stops the content script from loading
 * on unrelated routes under `/list/`.
 */
const MEDIA_LIST_SEGMENT_PREFIXES = [
  "watchlater",
  "ml",
  ...Array.from({ length: 10 }, (_, digit) => String(digit)),
];

const MEDIA_LIST_PATH_PREFIXES = ["list", "medialist/play"];

/**
 * Must stay in sync with `content_scripts.matches` in `public/manifest.json`;
 * `manifest-matches.test.ts` asserts the two agree.
 */
export const BILIBILI_VIDEO_URL_PATTERNS = [
  "https://www.bilibili.com/video/*",
  "https://www.bilibili.com/bangumi/play/*",
  "https://www.bilibili.com/festival/*",
  ...MEDIA_LIST_PATH_PREFIXES.flatMap((pathPrefix) =>
    MEDIA_LIST_SEGMENT_PREFIXES.map(
      (segmentPrefix) =>
        `https://www.bilibili.com/${pathPrefix}/${segmentPrefix}*`,
    ),
  ),
];

export interface ConnectionState {
  socket: WebSocket | null;
  serverUrl: string;
  connected: boolean;
  lastError: string | null;
  connectProbe: Promise<void> | null;
  /**
   * Monotonic id incremented every time a new WebSocket is opened. The
   * pending-local-share marker records the generation that created it
   * (`ShareState.pendingLocalShareGeneration`) so a superseded socket's late
   * close only clears a direct-send marker it owns, never one a newer
   * connection set for a share it is still confirming.
   */
  socketGeneration: number;
  /**
   * Abort generation for the in-flight connect probe. `openSocketWithProbe`
   * awaits connection-check/healthcheck fetches before opening the socket; an
   * authoritative teardown during that window (admin session reset, or an
   * explicit leave via `disconnectSocket`) bumps this so the resuming probe
   * aborts instead of opening a room-less ghost connection that clears the
   * teardown's `lastError`.
   */
  connectEpoch: number;
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
  /**
   * Socket generation that owns the in-flight join request. A new connection
   * has a different generation and can therefore resend the durable join intent
   * without waiting for the dead socket's close event to mutate shared state.
   */
  pendingJoinRequestGeneration: number | null;
  /**
   * True while connected but the (re)join handshake has not yet delivered an
   * authoritative `room:state` for the current session. During this window the
   * locally cached `roomState`/`memberToken` may be stale (a reconnect re-sends
   * `room:join` but the server only acknowledges with `room:joined` then a
   * fresh `room:state`), so auto-share-next must defer rather than send a
   * `video:share` the server can still reject.
   */
  awaitingFreshRoomState: boolean;
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
  /**
   * `ConnectionState.socketGeneration` of the socket that was live when this
   * marker was set, i.e. which connection owns it. Lets a superseded socket's
   * late close clear only the direct-send marker it created, not one a newer
   * connection set for a share still awaiting confirmation. Null when no marker.
   */
  pendingLocalShareGeneration: number | null;
  /**
   * Whether the current pending local-share marker was set by an auto-share
   * (chained autoplay) rather than an explicit manual share. The auto-share
   * handler skips when a *manual* share is still awaiting confirmation (so it
   * does not clobber the user's deliberate share), but it must NOT skip on its
   * own previous in-flight auto-share — that is the chain it is advancing, and
   * skipping would strand the room one step behind. False when no marker.
   */
  pendingLocalShareIsAutoShare: boolean;
  pendingShareToast:
    (SharedVideoToastPayload & { expiresAt: number; roomCode: string }) | null;
}

export interface ClockState {
  clockOffsetMs: number | null;
  rttMs: number | null;
  /** Recent ping samples backing the robust offset estimate, oldest first. */
  clockSamples: ClockSample[];
  clockSyncTimer: number | null;
}

export interface DiagnosticsState {
  logs: DebugLogEntry[];
  lastPopupStateLogKey: string | null;
}

export interface SettingsState {
  pageShareButtonEnabled: boolean;
}

export interface BackgroundRuntimeState {
  connection: ConnectionState;
  room: RoomSessionState;
  share: ShareState;
  clock: ClockState;
  diagnostics: DiagnosticsState;
  settings: SettingsState;
}

export function createBackgroundRuntimeState(): BackgroundRuntimeState {
  return {
    connection: {
      socket: null,
      serverUrl: DEFAULT_SERVER_URL,
      connected: false,
      lastError: null,
      connectProbe: null,
      socketGeneration: 0,
      connectEpoch: 0,
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
      pendingJoinRequestGeneration: null,
      awaitingFreshRoomState: false,
      pendingSharedVideo: null,
      pendingSharedPlayback: null,
    },
    share: {
      sharedTabId: null,
      lastOpenedSharedUrl: null,
      openingSharedUrl: null,
      pendingLocalShareUrl: null,
      pendingLocalShareGeneration: null,
      pendingLocalShareIsAutoShare: false,
      pendingLocalShareExpiresAt: null,
      pendingLocalShareTimer: null,
      pendingShareToast: null,
    },
    clock: {
      clockOffsetMs: null,
      rttMs: null,
      clockSamples: [],
      clockSyncTimer: null,
    },
    diagnostics: {
      logs: [],
      lastPopupStateLogKey: null,
    },
    settings: {
      pageShareButtonEnabled: true,
    },
  };
}
