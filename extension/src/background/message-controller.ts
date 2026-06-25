import type {
  ContentToBackgroundMessage,
  PageShareButtonSettingsResponse,
  PopupToBackgroundMessage,
  ShareContextResponse,
  ShareCurrentVideoResponse,
} from "../shared/messages";
import { t } from "../shared/i18n";
import { areSharedVideoUrlsEqual } from "../shared/url";
import type {
  PlaybackState,
  RoomState,
  SharedVideo,
} from "@bili-syncplay/protocol";

type RuntimeMessage = PopupToBackgroundMessage | ContentToBackgroundMessage;
type QueueSharedVideoResult = { ok: true } | { ok: false; error: string };

export interface MessageController {
  handleRuntimeMessage(
    message: RuntimeMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): Promise<void>;
}

export function createMessageController(args: {
  connectionState: {
    connected: boolean;
    lastError: string | null;
  };
  roomSessionState: {
    roomCode: string | null;
    memberToken: string | null;
    memberId: string | null;
    displayName: string | null;
    roomState: RoomState | null;
  };
  settingsState: {
    pageShareButtonEnabled: boolean;
  };
  diagnosticsController: {
    log: (scope: "popup" | "content", message: string) => void;
    maybeLogPopupStateRequest: () => void;
    formatContentSource: (sender: chrome.runtime.MessageSender) => string;
  };
  popupStateController: {
    popupState: () => unknown;
  };
  roomSessionController: {
    requestCreateRoom(): Promise<void>;
    requestJoinRoom(roomCode: string, joinToken: string): Promise<void>;
    waitForJoinAttemptResult(timeoutMs?: number): Promise<unknown>;
    requestLeaveRoom(): Promise<void>;
  };
  shareController: {
    getActiveVideoPayload(): Promise<{
      ok: boolean;
      payload: { video: SharedVideo; playback: PlaybackState | null } | null;
      tabId: number | null;
      error?: string;
    }>;
    getVideoPayloadFromTab(
      tab: Pick<chrome.tabs.Tab, "id" | "url"> | null | undefined,
    ): Promise<{
      ok: boolean;
      payload: { video: SharedVideo; playback: PlaybackState | null } | null;
      tabId: number | null;
      error?: string;
    }>;
    queueOrSendSharedVideo(
      payload: { video: SharedVideo; playback: PlaybackState | null },
      tabId: number | null,
    ): Promise<QueueSharedVideoResult>;
  };
  tabController: {
    openSharedVideoFromPopup(): Promise<void>;
    isActiveSharedTab(tabId?: number, videoUrl?: string | null): boolean;
    isRememberedSharedSourceTab(tabId?: number): boolean;
  };
  clockController: {
    compensateRoomState(state: RoomState): RoomState;
  };
  socketController: {
    connect(): Promise<void>;
  };
  sendToServer: (message: unknown) => void;
  updateServerUrl: (serverUrl: string) => Promise<void>;
  persistState: () => Promise<void>;
  persistProfileState: () => Promise<void>;
  notifyPageShareButtonSettings: () => Promise<void>;
  notifyAll: () => void;
}): MessageController {
  async function updatePageShareButtonEnabled(enabled: boolean): Promise<void> {
    args.settingsState.pageShareButtonEnabled = enabled;
    await args.persistProfileState();
    args.notifyAll();
    await args.notifyPageShareButtonSettings();
  }

  function canAutoShareNextVideoFromSender(
    sender: chrome.runtime.MessageSender,
  ): boolean {
    const sharedByMemberId =
      args.roomSessionState.roomState?.sharedVideo?.sharedByMemberId;
    // Deliberately not gated on `connectionState.connected`: when the sharer is
    // briefly offline (reconnecting) we still want to authorize the share and
    // let `queueOrSendSharedVideo` queue it for delivery on reconnect, rather
    // than silently skipping and leaving the room stuck on the old video.
    return (
      args.roomSessionState.roomCode !== null &&
      args.roomSessionState.memberToken !== null &&
      args.roomSessionState.memberId !== null &&
      sharedByMemberId === args.roomSessionState.memberId &&
      args.tabController.isRememberedSharedSourceTab(sender.tab?.id)
    );
  }

  async function handleRuntimeMessage(
    message: RuntimeMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): Promise<void> {
    switch (message.type) {
      case "popup:create-room":
        await args.roomSessionController.requestCreateRoom();
        sendResponse(args.popupStateController.popupState());
        return;
      case "popup:join-room":
        await args.roomSessionController.requestJoinRoom(
          message.roomCode,
          message.joinToken,
        );
        if (!args.connectionState.connected) {
          sendResponse(args.popupStateController.popupState());
          return;
        }
        await args.roomSessionController.waitForJoinAttemptResult();
        sendResponse(args.popupStateController.popupState());
        return;
      case "popup:leave-room":
        await args.roomSessionController.requestLeaveRoom();
        sendResponse(args.popupStateController.popupState());
        return;
      case "popup:debug-log":
        args.diagnosticsController.log("popup", message.message);
        sendResponse({ ok: true });
        return;
      case "popup:get-state":
        args.diagnosticsController.maybeLogPopupStateRequest();
        if (args.roomSessionState.roomCode && !args.connectionState.connected) {
          void args.socketController.connect();
        }
        sendResponse(args.popupStateController.popupState());
        return;
      case "popup:get-active-video": {
        const response = await args.shareController.getActiveVideoPayload();
        if (!response.ok && response.error) {
          args.connectionState.lastError = response.error;
        } else {
          args.connectionState.lastError = null;
        }
        args.notifyAll();
        sendResponse(response);
        return;
      }
      case "popup:share-current-video": {
        const response = await args.shareController.getActiveVideoPayload();
        if (!response.ok || !response.payload) {
          args.connectionState.lastError =
            response.error ?? t("popupErrorCannotReadCurrentVideo");
          args.notifyAll();
          sendResponse({ ok: false, error: args.connectionState.lastError });
          return;
        }
        args.connectionState.lastError = null;
        const shareResult = await args.shareController.queueOrSendSharedVideo(
          response.payload,
          response.tabId,
        );
        if (shareResult.ok === false) {
          args.connectionState.lastError = shareResult.error;
          args.notifyAll();
          sendResponse({ ok: false, error: shareResult.error });
          return;
        }
        await args.persistState();
        args.notifyAll();
        sendResponse({ ok: true });
        return;
      }
      case "popup:open-shared-video":
        await args.tabController.openSharedVideoFromPopup();
        sendResponse({ ok: true });
        return;
      case "popup:set-server-url":
        await args.updateServerUrl(message.serverUrl);
        sendResponse(args.popupStateController.popupState());
        return;
      case "popup:set-page-share-button-enabled":
        await updatePageShareButtonEnabled(message.enabled);
        sendResponse(args.popupStateController.popupState());
        return;
      case "content:get-share-context": {
        const sharedVideo =
          args.roomSessionState.roomState?.sharedVideo ?? null;
        sendResponse({
          ok: true,
          roomCode: args.roomSessionState.roomCode,
          memberCount: args.roomSessionState.roomState?.members.length ?? null,
          sharedVideo: sharedVideo
            ? {
                videoId: sharedVideo.videoId,
                url: sharedVideo.url,
                title: sharedVideo.title,
              }
            : null,
        } satisfies ShareContextResponse);
        return;
      }
      case "content:share-current-video": {
        const response = await args.shareController.getVideoPayloadFromTab(
          sender.tab,
        );
        if (!response.ok || !response.payload) {
          args.connectionState.lastError =
            response.error ?? t("popupErrorCannotReadCurrentVideo");
          args.notifyAll();
          sendResponse({
            ok: false,
            error: args.connectionState.lastError,
          } satisfies ShareCurrentVideoResponse);
          return;
        }

        args.connectionState.lastError = null;
        const shareResult = await args.shareController.queueOrSendSharedVideo(
          response.payload,
          response.tabId,
        );
        if (shareResult.ok === false) {
          args.connectionState.lastError = shareResult.error;
          args.notifyAll();
          sendResponse({
            ok: false,
            error: shareResult.error,
          } satisfies ShareCurrentVideoResponse);
          return;
        }
        await args.persistState();
        args.notifyAll();
        sendResponse({ ok: true } satisfies ShareCurrentVideoResponse);
        return;
      }
      case "content:auto-share-next-video": {
        if (!canAutoShareNextVideoFromSender(sender)) {
          sendResponse({ ok: true } satisfies ShareCurrentVideoResponse);
          return;
        }

        // Confirm the room is still parked on the video that was shared when
        // this auto-share was scheduled. The 900ms settle delay leaves a window
        // where the same member could have shared a different video from
        // elsewhere; without this guard the stale timer would overwrite the
        // room back to the previous video's next episode.
        const sharedVideoUrl =
          args.roomSessionState.roomState?.sharedVideo?.url ?? null;
        if (
          !sharedVideoUrl ||
          !areSharedVideoUrlsEqual(
            sharedVideoUrl,
            message.payload.previousSharedUrl,
          )
        ) {
          args.diagnosticsController.log(
            "content",
            "Auto-share next video skipped: room moved past the scheduled shared video",
          );
          sendResponse({ ok: true } satisfies ShareCurrentVideoResponse);
          return;
        }

        const response = await args.shareController.getVideoPayloadFromTab(
          sender.tab,
        );
        if (!response.ok || !response.payload) {
          args.diagnosticsController.log(
            "content",
            `Auto-share next video skipped: ${response.error ?? t("popupErrorCannotReadCurrentVideo")}`,
          );
          sendResponse({ ok: false } satisfies ShareCurrentVideoResponse);
          return;
        }

        // The page bridge can still return the previous episode's
        // `__INITIAL_STATE__` while the SPA transition settles, so the resolved
        // URL equals the video the room is already parked on
        // (`previousSharedUrl`). Sharing it would be a no-op while the sharer has
        // already advanced to the next episode. Report a retryable failure so
        // the content controller retries until the bridge resolves the new
        // video, instead of treating the stale resolution as a successful share
        // and leaving the room behind.
        if (
          areSharedVideoUrlsEqual(
            response.payload.video.url,
            message.payload.previousSharedUrl,
          )
        ) {
          args.diagnosticsController.log(
            "content",
            "Auto-share next video not ready: page bridge still resolves the previous shared video",
          );
          sendResponse({ ok: false } satisfies ShareCurrentVideoResponse);
          return;
        }

        const shareResult = await args.shareController.queueOrSendSharedVideo(
          response.payload,
          response.tabId,
        );
        if (shareResult.ok === false) {
          args.diagnosticsController.log(
            "content",
            `Auto-share next video failed: ${shareResult.error}`,
          );
          sendResponse({
            ok: false,
            error: shareResult.error,
          } satisfies ShareCurrentVideoResponse);
          return;
        }
        await args.persistState();
        args.notifyAll();
        sendResponse({ ok: true } satisfies ShareCurrentVideoResponse);
        return;
      }
      case "content:get-page-share-button-settings":
        sendResponse({
          ok: true,
          enabled: args.settingsState.pageShareButtonEnabled,
        } satisfies PageShareButtonSettingsResponse);
        return;
      case "content:set-page-share-button-enabled":
        await updatePageShareButtonEnabled(message.enabled);
        sendResponse({
          ok: true,
          enabled: args.settingsState.pageShareButtonEnabled,
        } satisfies PageShareButtonSettingsResponse);
        return;
      case "content:report-user":
        if (args.roomSessionState.displayName !== message.payload.displayName) {
          args.roomSessionState.displayName = message.payload.displayName;
          await args.persistProfileState();
          if (
            args.connectionState.connected &&
            args.roomSessionState.roomCode &&
            args.roomSessionState.memberToken
          ) {
            args.sendToServer({
              type: "profile:update",
              payload: {
                memberToken: args.roomSessionState.memberToken,
                displayName: args.roomSessionState.displayName,
              },
            });
          }
        }
        sendResponse({ ok: true });
        return;
      case "content:playback-update":
        if (
          args.connectionState.connected &&
          args.roomSessionState.memberToken &&
          args.tabController.isActiveSharedTab(
            sender.tab?.id,
            message.payload.url,
          )
        ) {
          args.sendToServer({
            type: "playback:update",
            payload: {
              memberToken: args.roomSessionState.memberToken,
              playback: {
                ...message.payload,
                serverTime: 0,
                actorId:
                  args.roomSessionState.memberId ?? message.payload.actorId,
              },
            },
          });
        }
        sendResponse({ ok: true });
        return;
      case "content:get-room-state":
        if (args.roomSessionState.roomCode && !args.connectionState.connected) {
          void args.socketController.connect();
        }
        if (
          args.connectionState.connected &&
          args.roomSessionState.roomCode &&
          args.roomSessionState.memberToken
        ) {
          args.sendToServer({
            type: "sync:request",
            payload: { memberToken: args.roomSessionState.memberToken },
          });
        }
        sendResponse(
          args.roomSessionState.roomState
            ? {
                ok: true,
                roomState: args.clockController.compensateRoomState(
                  args.roomSessionState.roomState,
                ),
                memberId: args.roomSessionState.memberId,
                roomCode: args.roomSessionState.roomCode,
              }
            : {
                ok: false,
                memberId: args.roomSessionState.memberId,
                roomCode: args.roomSessionState.roomCode,
              },
        );
        return;
      case "content:debug-log":
        args.diagnosticsController.log(
          "content",
          `[${args.diagnosticsController.formatContentSource(sender)}] ${message.payload.message}`,
        );
        sendResponse({ ok: true });
        return;
      default:
        sendResponse({ ok: false });
    }
  }

  return {
    handleRuntimeMessage,
  };
}
