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

    if (args.connectionState.connected && args.roomSessionState.roomCode) {
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

    setPendingLocalShare(payload.video.url);
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
