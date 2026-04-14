import type {
  ContentToBackgroundMessage,
  PopupToBackgroundMessage,
} from "../shared/messages";
import { t } from "../shared/i18n";
import type {
  PlaybackState,
  RoomState,
  SharedVideo,
} from "@bili-syncplay/protocol";

type RuntimeMessage = PopupToBackgroundMessage | ContentToBackgroundMessage;

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
    queueOrSendSharedVideo(
      payload: { video: SharedVideo; playback: PlaybackState | null },
      tabId: number | null,
    ): Promise<void>;
  };
  tabController: {
    openSharedVideoFromPopup(): Promise<void>;
    isActiveSharedTab(tabId?: number, videoUrl?: string | null): boolean;
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
  notifyAll: () => void;
}): MessageController {
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
        await args.shareController.queueOrSendSharedVideo(
          response.payload,
          response.tabId,
        );
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
