import {
  parseBilibiliVideoRef,
  type PlaybackState,
  PROTOCOL_VERSION,
  type SharedVideo,
} from "@bili-syncplay/protocol";
import { t } from "../shared/i18n";
import {
  createPendingLocalShareExpiry,
  getActivePendingLocalShareUrl,
  PENDING_LOCAL_SHARE_TIMEOUT_MS,
  preparePendingLocalShareCleanup,
} from "./room-state";
import type {
  ConnectionState,
  RoomSessionState,
  ShareState,
} from "./runtime-state";
import { isSocketWritable } from "./socket-manager";

export interface ActiveVideoPayloadResult {
  ok: boolean;
  payload: { video: SharedVideo; playback: PlaybackState | null } | null;
  tabId: number | null;
  error?: string;
}

export type ShareVideoResult = { ok: true } | { ok: false; error: string };

export interface ShareController {
  getActiveVideoPayload(): Promise<ActiveVideoPayloadResult>;
  getVideoPayloadFromTab(
    tab: Pick<chrome.tabs.Tab, "id" | "url"> | null | undefined,
  ): Promise<ActiveVideoPayloadResult>;
  queueOrSendSharedVideo(
    payload: { video: SharedVideo; playback: PlaybackState | null },
    tabId: number | null,
  ): Promise<ShareVideoResult>;
  clearPendingLocalShare(reason: string): void;
  expirePendingLocalShareIfNeeded(): void;
  setPendingLocalShare(url: string): void;
  /**
   * Whether an explicit local share is still awaiting server confirmation. Used
   * to stop a stale auto-share from overwriting a manual share the user just
   * made (which only sets a pending local share; `roomState.sharedVideo` still
   * holds the previous video until the server confirms).
   */
  hasActivePendingLocalShare(): boolean;
}

export function createShareController(args: {
  connectionState: ConnectionState;
  roomSessionState: RoomSessionState;
  shareState: ShareState;
  log: (scope: "background", message: string) => void;
  sendToServer: (message: {
    type: "video:share" | "room:create";
    payload:
      | {
          memberToken?: string;
          video?: SharedVideo;
          playback?: PlaybackState;
          displayName?: string;
          protocolVersion?: number;
        }
      | undefined;
  }) => void;
  connect: () => Promise<void>;
  persistState: () => Promise<void>;
  notifyAll: () => void;
  rememberSharedSourceTab: (tabId?: number, videoUrl?: string | null) => void;
}): ShareController {
  function clearPendingLocalShareTimer(): void {
    if (args.shareState.pendingLocalShareTimer !== null) {
      clearTimeout(args.shareState.pendingLocalShareTimer);
      args.shareState.pendingLocalShareTimer = null;
    }
  }

  async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab ?? null;
  }

  async function getVideoPayloadFromTab(
    tab: Pick<chrome.tabs.Tab, "id" | "url"> | null | undefined,
  ): Promise<ActiveVideoPayloadResult> {
    if (!tab?.id) {
      return {
        ok: false,
        payload: null,
        tabId: null,
        error: t("popupErrorNoActiveTab"),
      };
    }

    if (!tab.url || !parseBilibiliVideoRef(tab.url)) {
      return {
        ok: false,
        payload: null,
        tabId: tab.id,
        error: t("popupErrorOpenBilibiliVideo"),
      };
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "background:get-current-video",
      });
      if (!response?.ok || !response.payload?.video) {
        return {
          ok: false,
          payload: null,
          tabId: tab.id,
          error: t("popupErrorNoPlayableVideo"),
        };
      }
      return {
        ok: true,
        payload: response.payload,
        tabId: tab.id,
      };
    } catch {
      return {
        ok: false,
        payload: null,
        tabId: tab.id,
        error: t("popupErrorCannotAccessPage"),
      };
    }
  }

  async function getActiveVideoPayload(): Promise<ActiveVideoPayloadResult> {
    return getVideoPayloadFromTab(await getActiveTab());
  }

  async function queueOrSendSharedVideo(
    payload: { video: SharedVideo; playback: PlaybackState | null },
    tabId: number | null,
  ): Promise<ShareVideoResult> {
    args.rememberSharedSourceTab(tabId ?? undefined, payload.video.url);

    // Treat the live socket's `readyState` as the source of truth for whether we
    // can actually write a `video:share`. `connectionState.connected` is only
    // flipped to false by the socket's `close`/`error` events, so during the
    // micro-window where the socket has already moved to CLOSING/CLOSED but the
    // close event has not dispatched yet it still reads true. Sending in that
    // window returns `{ ok: true }` while `sendToServer` (which requires an OPEN
    // socket) silently drops the message, stranding the room on the old video.
    // (For the non-explicit auto-share path the message controller defers on the
    // same writability check *before* reaching here, so only explicit user
    // shares reach the CLOSING/offline queue below.)
    if (
      args.connectionState.connected &&
      isSocketWritable(args.connectionState.socket) &&
      args.roomSessionState.roomCode
    ) {
      if (!args.roomSessionState.memberToken) {
        const error = t("popupErrorMemberTokenMissing");
        args.connectionState.lastError = error;
        return { ok: false, error };
      }
      setPendingLocalShare(payload.video.url);
      args.sendToServer({
        type: "video:share",
        payload: {
          memberToken: args.roomSessionState.memberToken,
          video: payload.video,
          ...(payload.playback
            ? {
                playback: {
                  ...payload.playback,
                  serverTime: 0,
                  actorId:
                    args.roomSessionState.memberId ?? payload.playback.actorId,
                },
              }
            : {}),
        },
      });
      return { ok: true };
    }

    // CLOSING micro-window / reconnect in progress: the socket can no longer be
    // written but the session is otherwise valid (room + member token present).
    // This covers both the CLOSING window (`connected` still true, close event
    // not dispatched) and the window after a previous queued share already
    // swapped in a CONNECTING replacement socket (which clears `connected`); a
    // second manual share in that window must NOT fall through to the offline
    // branch and drop the member token. Queue the share for the reconnect flush
    // and open/await the replacement WITHOUT tearing down the session — keep the
    // member token so the rejoin re-attaches as the same member. Dropping it (as
    // the fully-offline branch below does) makes the server assign a new memberId
    // and can surface a duplicate member until the old socket leaves. The
    // superseded old socket's close is ignored by the socket controller, so this
    // marker survives (flagged as a re-flush) until the re-flushed share is
    // confirmed.
    const reconnectInProgress =
      args.connectionState.socket !== null &&
      args.connectionState.socket.readyState === WebSocket.CONNECTING;
    if (
      (args.connectionState.connected || reconnectInProgress) &&
      args.roomSessionState.roomCode &&
      args.roomSessionState.memberToken
    ) {
      setPendingLocalShare(payload.video.url);
      args.roomSessionState.pendingSharedVideo = payload.video;
      args.roomSessionState.pendingSharedPlayback = payload.playback
        ? {
            ...payload.playback,
            serverTime: 0,
            actorId: args.roomSessionState.memberId ?? payload.playback.actorId,
          }
        : null;
      args.roomSessionState.shareReflushPending = true;
      await args.connect();
      return { ok: true };
    }

    setPendingLocalShare(payload.video.url);
    args.roomSessionState.pendingSharedVideo = payload.video;
    args.roomSessionState.pendingSharedPlayback = payload.playback
      ? {
          ...payload.playback,
          serverTime: 0,
          actorId: args.roomSessionState.memberId ?? payload.playback.actorId,
        }
      : null;
    // The reconnect rejoin (or room:create) flushes this queued share, so the
    // marker is re-flush-backed: keep it across a superseded socket's late close.
    args.roomSessionState.shareReflushPending = true;

    if (args.roomSessionState.roomCode) {
      args.roomSessionState.memberToken = null;
      await args.connect();
      return { ok: true };
    }

    args.roomSessionState.roomCode = null;
    args.roomSessionState.joinToken = null;
    args.roomSessionState.memberToken = null;
    args.roomSessionState.memberId = null;
    args.roomSessionState.roomState = null;
    args.shareState.pendingShareToast = null;
    await args.persistState();
    await args.connect();
    if (args.connectionState.connected) {
      args.roomSessionState.pendingCreateRoom = false;
      args.sendToServer({
        type: "room:create",
        payload: {
          displayName: args.roomSessionState.displayName ?? undefined,
          protocolVersion: PROTOCOL_VERSION,
        },
      });
    } else {
      args.roomSessionState.pendingCreateRoom = true;
    }
    return { ok: true };
  }

  function clearPendingLocalShare(reason: string): void {
    // The marker is being torn down (confirmed, timed out, disconnect, etc.), so
    // no re-flush is pending against it any more and it no longer has an owner.
    args.roomSessionState.shareReflushPending = false;
    args.shareState.pendingLocalShareGeneration = null;
    const cleanup = preparePendingLocalShareCleanup({
      pendingLocalShareUrl: args.shareState.pendingLocalShareUrl,
      pendingLocalShareExpiresAt: args.shareState.pendingLocalShareExpiresAt,
      pendingLocalShareTimer: args.shareState.pendingLocalShareTimer,
    });
    if (!cleanup.hadPendingLocalShare) {
      return;
    }
    if (cleanup.shouldCancelTimer) {
      clearPendingLocalShareTimer();
    }
    args.log("background", `Cleared pending local share (${reason})`);
    ({
      pendingLocalShareUrl: args.shareState.pendingLocalShareUrl,
      pendingLocalShareExpiresAt: args.shareState.pendingLocalShareExpiresAt,
      pendingLocalShareTimer: args.shareState.pendingLocalShareTimer,
    } = cleanup.nextState);
  }

  function hasActivePendingLocalShare(): boolean {
    return (
      getActivePendingLocalShareUrl({
        pendingLocalShareUrl: args.shareState.pendingLocalShareUrl,
        pendingLocalShareExpiresAt: args.shareState.pendingLocalShareExpiresAt,
        now: Date.now(),
      }) !== null
    );
  }

  function expirePendingLocalShareIfNeeded(): void {
    const activePendingShare = getActivePendingLocalShareUrl({
      pendingLocalShareUrl: args.shareState.pendingLocalShareUrl,
      pendingLocalShareExpiresAt: args.shareState.pendingLocalShareExpiresAt,
      now: Date.now(),
    });
    if (args.shareState.pendingLocalShareUrl && activePendingShare === null) {
      clearPendingLocalShare(
        `share confirmation timed out after ${PENDING_LOCAL_SHARE_TIMEOUT_MS}ms`,
      );
    }
  }

  function setPendingLocalShare(url: string): void {
    clearPendingLocalShareTimer();
    // A fresh marker defaults to a plain direct send; the CLOSING/offline queue
    // branches set `shareReflushPending = true` afterwards when they queue a
    // re-flush. Reset it here so a direct send that reuses the marker is never
    // mistaken for a re-flush by a superseded socket's close.
    args.roomSessionState.shareReflushPending = false;
    // Record which connection owns this marker so a superseded socket's late
    // close only clears the marker it created, not one set by a newer connection.
    args.shareState.pendingLocalShareGeneration =
      args.connectionState.socketGeneration;
    args.shareState.pendingLocalShareUrl = url;
    args.shareState.pendingLocalShareExpiresAt = createPendingLocalShareExpiry(
      Date.now(),
    );
    args.log(
      "background",
      `Waiting up to ${PENDING_LOCAL_SHARE_TIMEOUT_MS}ms for share confirmation ${url}`,
    );
    args.shareState.pendingLocalShareTimer = self.setTimeout(() => {
      expirePendingLocalShareIfNeeded();
      args.notifyAll();
    }, PENDING_LOCAL_SHARE_TIMEOUT_MS);
  }

  return {
    getActiveVideoPayload,
    getVideoPayloadFromTab,
    queueOrSendSharedVideo,
    clearPendingLocalShare,
    expirePendingLocalShareIfNeeded,
    setPendingLocalShare,
    hasActivePendingLocalShare,
  };
}
