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

        // Whether the room is still parked on the video that was shared when
        // this auto-share was scheduled. Re-read room state each call because
        // awaits below yield the event loop, during which the same member could
        // share a different video or fresh room state could arrive; without
        // re-checking, the stale timer would overwrite the room back to the
        // previous video's next episode.
        const isRoomStillOnScheduledVideo = (): boolean => {
          const sharedVideoUrl =
            args.roomSessionState.roomState?.sharedVideo?.url ?? null;
          return (
            sharedVideoUrl !== null &&
            areSharedVideoUrlsEqual(
              sharedVideoUrl,
              message.payload.previousSharedUrl,
            )
          );
        };

        if (!isRoomStillOnScheduledVideo()) {
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

        // The tab must currently resolve the exact next episode this auto-share
        // was scheduled for. Mid-SPA the page bridge can still return the
        // previous episode's `__INITIAL_STATE__` (a no-op share), or the tab may
        // have already jumped past it to a different video (which we must not
        // share in the room's name). In both cases the resolved URL differs from
        // the scheduled `targetNormalizedUrl`, so report a retryable failure and
        // let the content controller retry until the bridge settles on it.
        if (
          !areSharedVideoUrlsEqual(
            response.payload.video.url,
            message.payload.targetNormalizedUrl,
          )
        ) {
          args.diagnosticsController.log(
            "content",
            "Auto-share next video not ready: tab has not resolved the scheduled next video",
          );
          sendResponse({ ok: false } satisfies ShareCurrentVideoResponse);
          return;
        }

        // `getVideoPayloadFromTab` yielded the event loop, so re-confirm the room
        // is still on `previousSharedUrl` before overwriting it. A manual share
        // or fresh room state received in that window means the room has moved
        // on and this stale auto-share must not clobber it.
        if (!isRoomStillOnScheduledVideo()) {
          args.diagnosticsController.log(
            "content",
            "Auto-share next video skipped: room moved past the scheduled shared video while reading the tab",
          );
          sendResponse({ ok: true } satisfies ShareCurrentVideoResponse);
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
