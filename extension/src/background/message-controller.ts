import type {
  ContentToBackgroundMessage,
  PageShareButtonSettingsResponse,
  PopupToBackgroundMessage,
  ShareContextResponse,
  ShareCurrentVideoResponse,
} from "../shared/messages";
import { t } from "../shared/i18n";
import { areSharedVideoUrlsEqual } from "../shared/url";
import { isSocketWritable } from "./socket-manager";
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
    socket: WebSocket | null;
  };
  roomSessionState: {
    roomCode: string | null;
    memberToken: string | null;
    memberId: string | null;
    displayName: string | null;
    roomState: RoomState | null;
    awaitingFreshRoomState: boolean;
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
    hasActivePendingLocalShare(): boolean;
  };
  tabController: {
    openSharedVideoFromPopup(): Promise<void>;
    isActiveSharedTab(tabId?: number, videoUrl?: string | null): boolean;
    isRememberedSharedSourceTab(tabId?: number): boolean;
    canReclaimSharedSourceTab(tabId?: number): boolean;
    reclaimSharedSourceTabIfUnclaimed(tabId?: number): boolean;
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

  function canAutoShareNextVideoFromSender(): boolean {
    const sharedByMemberId =
      args.roomSessionState.roomState?.sharedVideo?.sharedByMemberId;
    // Identity check only: the sender must be the room's current sharer. The
    // source-tab binding is verified separately in the handler (after the room
    // check) so it can be re-claimed when an MV3 worker restart lost it. This is
    // also deliberately not gated on connectivity — the handler defers offline.
    return (
      args.roomSessionState.roomCode !== null &&
      args.roomSessionState.memberToken !== null &&
      args.roomSessionState.memberId !== null &&
      sharedByMemberId === args.roomSessionState.memberId
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
        if (!canAutoShareNextVideoFromSender()) {
          sendResponse({ ok: true } satisfies ShareCurrentVideoResponse);
          return;
        }

        // While disconnected the local room state may be stale, and queuing the
        // share to flush on reconnect would let it overwrite whatever another
        // member shared in the meantime (the `room:joined` path flushes pending
        // shares before the fresh `room:state` arrives). Defer with a retryable
        // failure so the content controller retries once reconnected, when the
        // room check below can run against authoritative state.
        //
        // `awaitingFreshRoomState` extends the same guard across the reconnect
        // handshake: the socket reports `connected` as soon as it opens, but the
        // re-sent `room:join` is not acknowledged (`room:joined` → fresh
        // `room:state`) until later. Sending in that window would run against a
        // stale `roomState`/member token, and `queueOrSendSharedVideo` returns
        // success immediately — silencing the content retry — even if the server
        // rejects the `video:share` for not-yet-rejoined, or the room has since
        // been advanced by another member. Keep deferring until authoritative
        // room state lands.
        //
        // `!isSocketWritable` closes the CLOSING micro-window: the socket has
        // already moved to CLOSING/CLOSED but its close event has not fired, so
        // `connected` still reads true. Without this the auto-share would reach
        // `queueOrSendSharedVideo`, take its offline branch, and queue a
        // `pendingSharedVideo` that the reconnect `room:joined` flushes before
        // fresh `room:state` — clobbering whatever the room advanced to.
        if (
          !args.connectionState.connected ||
          !isSocketWritable(args.connectionState.socket) ||
          args.roomSessionState.awaitingFreshRoomState
        ) {
          args.diagnosticsController.log(
            "content",
            args.connectionState.connected
              ? "Auto-share next video deferred: awaiting fresh room state after reconnect"
              : "Auto-share next video deferred: offline, will retry after reconnect",
          );
          sendResponse({
            ok: false,
            deferred: true,
          } satisfies ShareCurrentVideoResponse);
          return;
        }

        // Whether the room is still parked on the video that was shared when
        // this auto-share was scheduled. Re-read room state each call because
        // awaits below yield the event loop, during which the same member could
        // share a different video or fresh room state could arrive; without
        // re-checking, the stale timer would overwrite the room back to the
        // previous video's next episode.
        const isRoomStillOnScheduledVideo = (): boolean => {
          const sharedVideo = args.roomSessionState.roomState?.sharedVideo;
          const sharedVideoUrl = sharedVideo?.url ?? null;
          return (
            sharedVideoUrl !== null &&
            areSharedVideoUrlsEqual(
              sharedVideoUrl,
              message.payload.previousSharedUrl,
            ) &&
            // The local member must still own the share. If another member
            // re-shared the same URL during an await, the URL is unchanged but
            // `sharedByMemberId` is now someone else's — this stale autoplay must
            // not override the new sharer's freshly acquired control.
            args.roomSessionState.memberId !== null &&
            sharedVideo?.sharedByMemberId === args.roomSessionState.memberId
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

        // The auto-share must come from the remembered shared source tab. After
        // an MV3 service worker restart `sharedTabId` is lost (it is not in the
        // persisted snapshot) while room state is restored, so a genuine source
        // tab would be silently skipped. Admit an as-yet-unbound binding here,
        // but defer actually re-claiming it until the payload below validates the
        // scheduled next video: claiming up front would let a tab whose payload
        // fails or resolves a stale URL permanently steal the binding from the
        // real source tab, blocking all later auto-shares and playback updates.
        const isRememberedSourceTab =
          args.tabController.isRememberedSharedSourceTab(sender.tab?.id);
        if (
          !isRememberedSourceTab &&
          !args.tabController.canReclaimSharedSourceTab(sender.tab?.id)
        ) {
          args.diagnosticsController.log(
            "content",
            "Auto-share next video skipped: not from the remembered shared source tab",
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

        // The SPA can resolve the next video's identity before its new `<video>`
        // element is bound/loaded, in which case the content side returns
        // `playback: null`. Sharing now would advance the room to the next
        // episode but the server backfills the missing playback as paused@0 — the
        // room would jump to a 0s paused state while the sharer's own later
        // `play` could still be broadcast-suppressed as a non-shared page until
        // room state applies. Treat a missing playback as a retryable
        // "page not ready" so the content controller retries once the element is
        // bound and the current playback can be read.
        if (!response.payload.playback) {
          args.diagnosticsController.log(
            "content",
            "Auto-share next video not ready: next video has no readable playback yet",
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

        // Payload, target, and room are all validated; only now claim the
        // source-tab binding if it was lost (MV3 restart). Re-claiming here —
        // not before reading the tab — guarantees a tab that failed validation
        // never strands the binding away from the real source tab.
        if (!isRememberedSourceTab) {
          // The earlier `canReclaimSharedSourceTab` probe only proved the slot
          // was free *before* the tab read. During that await the genuine
          // source tab can send a playback update and bind `sharedTabId` to
          // itself, so re-claiming now returns false. Bail out instead of
          // continuing: `queueOrSendSharedVideo` would otherwise re-`remember`
          // the binding with this stale/non-source tab and advance the room in
          // the sharer's name from a tab that has lost its eligibility.
          if (
            !args.tabController.reclaimSharedSourceTabIfUnclaimed(
              sender.tab?.id,
            )
          ) {
            args.diagnosticsController.log(
              "content",
              "Auto-share next video skipped: source tab binding was claimed during the tab read",
            );
            sendResponse({ ok: true } satisfies ShareCurrentVideoResponse);
            return;
          }
        }

        // Re-check connectivity right before sending. The validations above
        // (`getVideoPayloadFromTab`, the re-claim) yielded the event loop, so the
        // socket may have dropped (or a reconnect handshake started) in between.
        // `queueOrSendSharedVideo` would then take its offline branch and store
        // this non-explicit auto-share as a pending share that flushes on the
        // next `room:joined` — before the fresh `room:state` — clobbering whatever
        // the room advanced to while we were disconnected. Defer instead so the
        // content controller retries against authoritative state. `!isSocketWritable`
        // also covers the CLOSING micro-window where `connected` still reads true.
        if (
          !args.connectionState.connected ||
          !isSocketWritable(args.connectionState.socket) ||
          args.roomSessionState.awaitingFreshRoomState
        ) {
          args.diagnosticsController.log(
            "content",
            "Auto-share next video deferred: connection dropped while validating, will retry after reconnect",
          );
          sendResponse({
            ok: false,
            deferred: true,
          } satisfies ShareCurrentVideoResponse);
          return;
        }

        // An explicit share the user just made only sets a pending local share;
        // `roomState.sharedVideo` still holds the previous video until the server
        // confirms, so the room re-check above can still pass. Sending now would
        // overwrite that unconfirmed manual share — skip and let it stand.
        if (args.shareController.hasActivePendingLocalShare()) {
          args.diagnosticsController.log(
            "content",
            "Auto-share next video skipped: a manual share is awaiting confirmation",
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
