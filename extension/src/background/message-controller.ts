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

/**
 * How long a cached `roomState` is trusted before one `sync:request` is let
 * through to re-establish authority. Bounds how long a client can hold a
 * snapshot the server silently failed to push (see the call site for why that
 * is unobservable locally), while capping a stuck hydration loop at 6
 * requests/min per browser session — the limiter allows 36/min.
 */
const AUTHORITATIVE_REFRESH_INTERVAL_MS = 10_000;

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
      isAutoShare?: boolean,
    ): Promise<QueueSharedVideoResult>;
    hasActivePendingLocalShare(): boolean;
    hasActivePendingManualShare(): boolean;
    getActivePendingLocalShareUrl(): string | null;
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
  /**
   * Monotonic time source for the authoritative-refresh window. Must not be the
   * wall clock — see `lastRoomStateRefreshAt`.
   */
  getMonotonicNow?: () => number;
}): MessageController {
  const monotonicNow = () => args.getMonotonicNow?.() ?? performance.now();
  /**
   * When this session last asked the server for authoritative room state, or
   * `null` if it never has. Read from a monotonic clock, never the wall clock:
   * `Date.now()` moves when the clock is stepped, and a *backward* step makes
   * `now - lastRoomStateRefreshAt` negative — which compares as "well inside
   * the window" and would freeze the refresh for the entire duration of the
   * step, exactly when a missed push most needs recovering from. Only ever
   * compared against another reading of the same clock, so it stays an elapsed
   * duration and never crosses machines.
   *
   * Resetting to `null` on an MV3 worker restart is correct and matches
   * `performance.now()`'s own epoch resetting with the worker: the next call
   * re-establishes authority instead of trusting a reading from a dead epoch.
   */
  let lastRoomStateRefreshAt: number | null = null;

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
        // Classify the room against the video this auto-share was scheduled from
        // (`previousSharedUrl`):
        //   - "on-scheduled": the room is parked on it and we still own the
        //     share → safe to advance to the next video.
        //   - "share-in-flight": the room has not reached it yet because our OWN
        //     share of it is still awaiting confirmation — chained autoplay
        //     (A→B→C) outran the room round-trip, so when C arrives the room is
        //     still on A while `previousSharedUrl` is B, the video we just shared
        //     but whose `room:state` has not returned. Retry without consuming
        //     the page-bridge attempt budget; once B confirms, the retry sees
        //     "on-scheduled" and advances to C.
        //   - "moved-on": the room is on a different video for any other reason
        //     (another member shared, the room genuinely advanced past it, …) →
        //     skip so this stale autoplay does not override it.
        const classifyRoomSchedule = ():
          "on-scheduled" | "share-in-flight" | "moved-on" => {
          const sharedVideo = args.roomSessionState.roomState?.sharedVideo;
          const sharedVideoUrl = sharedVideo?.url ?? null;
          if (
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
          ) {
            return "on-scheduled";
          }
          const inFlightOwnShareUrl =
            args.shareController.getActivePendingLocalShareUrl();
          if (
            inFlightOwnShareUrl !== null &&
            areSharedVideoUrlsEqual(
              inFlightOwnShareUrl,
              message.payload.previousSharedUrl,
            )
          ) {
            return "share-in-flight";
          }
          return "moved-on";
        };

        const scheduleState = classifyRoomSchedule();
        if (scheduleState === "share-in-flight") {
          args.diagnosticsController.log(
            "content",
            "Auto-share next video deferred: room has not confirmed the previous share yet",
          );
          sendResponse({
            ok: false,
            deferred: true,
          } satisfies ShareCurrentVideoResponse);
          return;
        }
        if (scheduleState === "moved-on") {
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
        // on and this stale auto-share must not clobber it. (Only "on-scheduled"
        // may proceed here: having already passed the check above the room was on
        // `previousSharedUrl`, so a non-on-scheduled recheck means it advanced —
        // treat any such state as moved-on and skip rather than send.)
        if (classifyRoomSchedule() !== "on-scheduled") {
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
        // overwrite that unconfirmed manual share — skip and let it stand. Only a
        // *manual* pending share blocks here: our own previous in-flight
        // auto-share is the chain we are advancing, so skipping on it would strand
        // the room one step behind when chained autoplay outruns confirmation.
        if (args.shareController.hasActivePendingManualShare()) {
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
          true,
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
      case "content:get-room-state": {
        if (args.roomSessionState.roomCode && !args.connectionState.connected) {
          void args.socketController.connect();
        }
        // Only ask the server when this message cannot be answered locally.
        // `content:get-room-state` conflates "hand me the state you have" with
        // "go refresh it", and content-side hydration retries call it in a loop
        // for the former reason — a tab sitting on the shared video whose
        // player has not produced a `<video>` element yet re-hydrates every
        // 350ms (`room-state-apply-controller`), and each pass used to forward a
        // `sync:request` even though the cached state was returned in the very
        // same response. That loop alone saturated the per-session limiter
        // (6 per 10s), which is how 72% of all `sync:request` got rejected
        // upstream (#229).
        //
        // Cache authority DECAYS — it is not a property the cache either has or
        // lacks. Two of its three terms are locally observable: an absent
        // `roomState` means there is nothing to answer with, and
        // `awaitingFreshRoomState` means the reconnect handshake has not yet
        // delivered an authoritative snapshot. The third is not observable at
        // all: the server can silently fail to push. Both
        // `sendRoomStateToSession` (bootstrap) and the `room_event_consume_failed`
        // catch in `room-event-consumer.ts` swallow the error without retrying,
        // closing the socket, or telling the client — and the member-delta
        // branch also drops the push when `getRoomStateByCode` returns null.
        // A client left holding a pre-pause or pre-switch snapshot has no local
        // signal that anything went wrong.
        //
        // So the cache is trusted only inside a bounded staleness window; past
        // it exactly one request goes through and re-arms the window. That
        // ceiling is what keeps #229 fixed: this timestamp lives in the
        // background, which is per browser session — the same object every tab
        // funnels through — so a stuck hydration loop costs 6 requests/min
        // total no matter how many tabs are spinning, against a limiter that
        // allows 36/min. The pre-fix loop sent ~171/min from a single tab.
        const now = monotonicNow();
        const cachedRoomStateIsAuthoritative =
          args.roomSessionState.roomState !== null &&
          !args.roomSessionState.awaitingFreshRoomState &&
          lastRoomStateRefreshAt !== null &&
          now - lastRoomStateRefreshAt < AUTHORITATIVE_REFRESH_INTERVAL_MS;
        if (
          args.connectionState.connected &&
          args.roomSessionState.roomCode &&
          args.roomSessionState.memberToken &&
          !cachedRoomStateIsAuthoritative
        ) {
          lastRoomStateRefreshAt = now;
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
      }
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
