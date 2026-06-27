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
    isAutoShare?: boolean,
  ): Promise<ShareVideoResult>;
  clearPendingLocalShare(reason: string): void;
  expirePendingLocalShareIfNeeded(): void;
  setPendingLocalShare(url: string, isAutoShare?: boolean): void;
  /**
   * Whether an explicit local share is still awaiting server confirmation. Used
   * to stop a stale auto-share from overwriting a manual share the user just
   * made (which only sets a pending local share; `roomState.sharedVideo` still
   * holds the previous video until the server confirms).
   */
  hasActivePendingLocalShare(): boolean;
  /**
   * Whether a *manual* (non-auto-share) local share is still awaiting server
   * confirmation. The auto-share handler skips on this so it does not clobber a
   * deliberate user share, but it must keep advancing past its own in-flight
   * auto-share (which this returns false for).
   */
  hasActivePendingManualShare(): boolean;
  /**
   * The URL of the share still awaiting server confirmation (the pending
   * local-share marker), or null. This is the video this client last shared but
   * whose authoritative `room:state` has not arrived yet — i.e. our own share
   * still in flight. Used to tell a chained auto-share that the room simply has
   * not caught up to the previous share yet (retry) from one where the room has
   * genuinely moved on (skip).
   */
  getActivePendingLocalShareUrl(): string | null;
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
    isAutoShare = false,
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
      setPendingLocalShare(payload.video.url, isAutoShare);
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
      // A prior CLOSING-window share may still be queued for re-flush on a
      // pending rejoin (replacement socket `open` flips `connected` true and the
      // socket writable before `room:joined` returns to flush the queue). We just
      // direct-sent a newer video, so replace the queued payload with it;
      // otherwise the post-rejoin flush would re-send the stale video and roll
      // back the share the user just made.
      if (args.roomSessionState.pendingSharedVideo !== null) {
        args.roomSessionState.pendingSharedVideo = payload.video;
        args.roomSessionState.pendingSharedPlayback = payload.playback
          ? {
              ...payload.playback,
              serverTime: 0,
              actorId:
                args.roomSessionState.memberId ?? payload.playback.actorId,
            }
          : null;
      }
      return { ok: true };
    }

    // Reconnect window: a live socket reference still exists but it can no longer
    // be cleanly written, while the session is otherwise valid (room + member
    // token present). This covers the CLOSING window (`connected` still true,
    // close event not dispatched), the window after a previous queued share
    // swapped in a CONNECTING replacement socket (which clears `connected`), and
    // the error-before-close window (the `error` handler flips `connected` false
    // but the socket lingers in CLOSING/CLOSED until its `close` event). A manual
    // share in any of these must NOT fall through to the offline branch and drop
    // the member token. Queue the share for the reconnect flush and open/await
    // the replacement WITHOUT tearing down the session — keep the member token so
    // the rejoin re-attaches as the same member. Dropping it (as the fully-offline
    // branch below does) makes the server assign a new memberId and can surface a
    // duplicate member until the old socket leaves. The superseded old socket's
    // close is ignored by the socket controller, and the queued `pendingSharedVideo`
    // keeps the marker alive until the re-flushed share is confirmed.
    if (
      args.connectionState.socket !== null &&
      args.roomSessionState.roomCode &&
      args.roomSessionState.memberToken
    ) {
      setPendingLocalShare(payload.video.url, isAutoShare);
      args.roomSessionState.pendingSharedVideo = payload.video;
      args.roomSessionState.pendingSharedPlayback = payload.playback
        ? {
            ...payload.playback,
            serverTime: 0,
            actorId: args.roomSessionState.memberId ?? payload.playback.actorId,
          }
        : null;
      await args.connect();
      return { ok: true };
    }

    setPendingLocalShare(payload.video.url, isAutoShare);
    args.roomSessionState.pendingSharedVideo = payload.video;
    args.roomSessionState.pendingSharedPlayback = payload.playback
      ? {
          ...payload.playback,
          serverTime: 0,
          actorId: args.roomSessionState.memberId ?? payload.playback.actorId,
        }
      : null;
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
    // it no longer has an owning connection and is no longer an auto-share.
    args.shareState.pendingLocalShareGeneration = null;
    args.shareState.pendingLocalShareIsAutoShare = false;
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

  function readActivePendingLocalShareUrl(): string | null {
    return getActivePendingLocalShareUrl({
      pendingLocalShareUrl: args.shareState.pendingLocalShareUrl,
      pendingLocalShareExpiresAt: args.shareState.pendingLocalShareExpiresAt,
      now: Date.now(),
    });
  }

  function hasActivePendingLocalShare(): boolean {
    return readActivePendingLocalShareUrl() !== null;
  }

  function hasActivePendingManualShare(): boolean {
    return (
      readActivePendingLocalShareUrl() !== null &&
      !args.shareState.pendingLocalShareIsAutoShare
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

  function setPendingLocalShare(url: string, isAutoShare = false): void {
    clearPendingLocalShareTimer();
    // Record which connection owns this marker so a superseded socket's late
    // close only clears the marker it created, not one set by a newer connection.
    args.shareState.pendingLocalShareGeneration =
      args.connectionState.socketGeneration;
    // Remember whether this marker is a chained auto-share so the auto-share
    // handler can advance past its own in-flight share without skipping (only a
    // manual share's marker should block the next auto-share).
    args.shareState.pendingLocalShareIsAutoShare = isAutoShare;
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
    hasActivePendingManualShare,
    getActivePendingLocalShareUrl: readActivePendingLocalShareUrl,
  };
}
