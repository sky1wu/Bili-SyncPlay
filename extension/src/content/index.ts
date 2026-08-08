import {
  type BackgroundToContentMessage,
  type PlaybackUpdateAck,
  type RoomStateHydrationResponse,
} from "../shared/messages";
import { normalizeSharedVideoUrl } from "../shared/url";
import { createAutoShareNextController } from "./auto-share-next-controller";
import { runtimeSendMessage } from "./content-messaging";
import { createFestivalBridgeController } from "./festival-bridge";
import { startUserGestureTracking } from "./gesture-tracker";
import { getVideoElement, pauseVideo, playVideo } from "./player-binding";
import { createContentStateStore } from "./content-store";
import { createNavigationController } from "./navigation-controller";
import { startNavigationSignalListener } from "./navigation-signal";
import { createPageShareButtonController } from "./page-share-button";
import { resolvePageShareButtonSettingsHydration } from "./page-share-button-settings";
import { createPlaybackBindingController } from "./playback-binding-controller";
import { createRoomStateController } from "./room-state-controller";
import { createShareController } from "./share-controller";
import { createSyncController } from "./sync-controller";
import {
  INITIAL_ROOM_STATE_PAUSE_HOLD_MS,
  SHARED_VIDEO_NATURAL_END_WINDOW_MS,
} from "./timing-constants";
import { createToastCoordinatorState, createToastPresenter } from "./toast";
import { reportCurrentUser } from "./user-reporter";

const normalizeUrl = normalizeSharedVideoUrl;
let seq = 0;
let lastBroadcastAt = 0;
const lastAppliedVersionByActor = new Map<
  string,
  { serverTime: number; seq: number }
>();
const contentStateStore = createContentStateStore();
const runtimeState = contentStateStore.getState();
const toastState = createToastCoordinatorState();
const toastPresenter = createToastPresenter();

const LOCAL_INTENT_GUARD_MS = 1200;
const PAUSE_HOLD_MS = 1200;
const REMOTE_ECHO_SUPPRESSION_MS = 700;
const REMOTE_PLAY_TRANSITION_GUARD_MS = 1800;
const REMOTE_FOLLOW_PLAYING_WINDOW_MS = 3000;
const PROGRAMMATIC_APPLY_WINDOW_MS = 700;
const USER_GESTURE_GRACE_MS = 1200;
const BUFFER_SIGNAL_WINDOW_MS = 300;
const BUFFER_PAUSE_UPGRADE_MS = 1500;
const VIDEO_REBIND_BUFFER_SIGNAL_MS = 1000;
const REMOTE_PAUSE_DEBOUNCE_MS = 250;
const DUPLICATE_BROADCAST_WINDOW_MS = 1000;
const FESTIVAL_SNAPSHOT_TTL_MS = 1200;
const NAVIGATION_WATCH_INTERVAL_MS = 400;
const VIDEO_BIND_INTERVAL_MS = 250;
const HEARTBEAT_LOG_INTERVAL_MS = 10000;
const AUTO_SHARE_NEXT_SETTLE_DELAY_MS = 900;
const PAGE_SHARE_BUTTON_SETTINGS_RETRY_DELAY_MS = 400;
const PAGE_SHARE_BUTTON_SETTINGS_MAX_ATTEMPTS = 6;
const festivalBridge = createFestivalBridgeController();
const broadcastLogState = { key: null as string | null, at: 0 };
const ignoredSelfPlaybackLogState = { key: null as string | null, at: 0 };
let pageShareButtonSettingsHydrationTimer: number | null = null;
let navigationSignalUnsubscribe: (() => void) | null = null;
const shareController = createShareController({
  runtimeState,
  festivalSnapshotTtlMs: FESTIVAL_SNAPSHOT_TTL_MS,
  nextSeq: () => seq++,
  getFestivalSnapshot: () => festivalBridge.getSnapshot(),
  refreshFestivalBridge: (input) => festivalBridge.refreshSnapshot(input),
  getActiveCorrectionBaseRate: (url) =>
    syncController.getActiveCorrectionBaseRate(normalizeUrl(url)),
  bufferPauseUpgradeMs: BUFFER_PAUSE_UPGRADE_MS,
  getMonotonicNow: () => performance.now(),
  debugLog,
});
const autoShareNextController = createAutoShareNextController({
  settleDelayMs: AUTO_SHARE_NEXT_SETTLE_DELAY_MS,
  // Prefer the resolved festival video so the pre-send "page still on target"
  // check matches the scheduled `/video/...` target rather than the bare
  // `/festival/<id>` route (which would wrongly skip the auto-share).
  getCurrentPageUrl: () =>
    festivalBridge.resolveVideoUrlForPage(
      window.location.pathname,
      window.location.href.split("#")[0],
      FESTIVAL_SNAPSHOT_TTL_MS,
    ) ?? window.location.href.split("#")[0],
  // Lets the self-check distinguish a trustworthy resolved current video from the
  // untrustworthy address-bar fallback on opaque festival pages. A snapshot older
  // than the TTL is treated as untrustworthy so a stale target cannot be confirmed.
  getResolvedVideoUrl: () =>
    festivalBridge.resolveVideoUrlForPage(
      window.location.pathname,
      window.location.href.split("#")[0],
      FESTIVAL_SNAPSHOT_TTL_MS,
    ),
  normalizeVideoPageUrl: (url) => normalizeSharedVideoUrl(url),
  getActiveSharedUrl: () => runtimeState.activeSharedUrl,
  runtimeSendMessage,
  debugLog,
});
const roomStateController = createRoomStateController({
  runtimeState,
  toastState,
  toastPresenter,
  getSharedVideo: () => shareController.getSharedVideo(),
  normalizeUrl,
  debugLog,
  resetPlaybackSyncState: (reason) =>
    syncController.resetPlaybackSyncState(reason),
  scheduleHydrationRetry: (delayMs) =>
    syncController.scheduleHydrationRetry(delayMs),
  resetHydrationRetry: () => syncController.resetHydrationRetry(),
});
const syncController = createSyncController({
  runtimeState,
  lastAppliedVersionByActor,
  broadcastLogState,
  ignoredSelfPlaybackLogState,
  localIntentGuardMs: LOCAL_INTENT_GUARD_MS,
  pauseHoldMs: PAUSE_HOLD_MS,
  initialRoomStatePauseHoldMs: INITIAL_ROOM_STATE_PAUSE_HOLD_MS,
  remoteEchoSuppressionMs: REMOTE_ECHO_SUPPRESSION_MS,
  remotePlayTransitionGuardMs: REMOTE_PLAY_TRANSITION_GUARD_MS,
  remoteFollowPlayingWindowMs: REMOTE_FOLLOW_PLAYING_WINDOW_MS,
  programmaticApplyWindowMs: PROGRAMMATIC_APPLY_WINDOW_MS,
  userGestureGraceMs: USER_GESTURE_GRACE_MS,
  bufferPauseUpgradeMs: BUFFER_PAUSE_UPGRADE_MS,
  remotePauseDebounceMs: REMOTE_PAUSE_DEBOUNCE_MS,
  duplicateBroadcastWindowMs: DUPLICATE_BROADCAST_WINDOW_MS,
  nextSeq: () => seq++,
  markBroadcastAt: (at) => {
    lastBroadcastAt = at;
  },
  debugLog,
  shouldLogHeartbeat,
  sendPlaybackUpdate: (payload) =>
    runtimeSendMessage<PlaybackUpdateAck>({
      type: "content:playback-update",
      payload,
    }),
  requestRoomStateHydration: () =>
    runtimeSendMessage<RoomStateHydrationResponse>({
      type: "content:get-room-state",
    }),
  getVideoElement,
  getCurrentPlaybackVideo: () => shareController.getCurrentPlaybackVideo(),
  getSharedVideo: () => shareController.getSharedVideo(),
  normalizeUrl,
  notifyRoomStateToasts: (state) =>
    roomStateController.notifyRoomStateToasts(state),
  maybeShowSharedVideoToast: (toast, state) =>
    roomStateController.maybeShowSharedVideoToast(toast, state),
});
const playbackBindingController = createPlaybackBindingController({
  runtimeState,
  videoBindIntervalMs: VIDEO_BIND_INTERVAL_MS,
  // Hydration defers room state it cannot apply until a `<video>` exists; this
  // is the event that says one now does, so it no longer has to poll for it.
  onVideoElementBound: () => syncController.notifyVideoElementBound(),
  userGestureGraceMs: USER_GESTURE_GRACE_MS,
  initialRoomStatePauseHoldMs: INITIAL_ROOM_STATE_PAUSE_HOLD_MS,
  bufferSignalWindowMs: BUFFER_SIGNAL_WINDOW_MS,
  bufferPauseUpgradeMs: BUFFER_PAUSE_UPGRADE_MS,
  videoRebindBufferSignalMs: VIDEO_REBIND_BUFFER_SIGNAL_MS,
  getSharedVideo: () => shareController.getSharedVideo(),
  hasRecentRemoteStopIntent: (currentVideoUrl) =>
    syncController.hasRecentRemoteStopIntent(currentVideoUrl),
  normalizeUrl,
  getLastBroadcastAt: () => lastBroadcastAt,
  broadcastPlayback: (video, eventSource, naturalEnd) =>
    syncController.broadcastPlayback(video, eventSource, naturalEnd),
  cancelActiveSoftApply: (video, reason) =>
    syncController.cancelActiveSoftApply(video, reason),
  maintainActiveSoftApply: (video) =>
    syncController.maintainActiveSoftApply(video),
  applyPendingPlaybackApplication: (video) =>
    syncController.applyPendingPlaybackApplication(video),
  activatePauseHold,
  debugLog,
});
const navigationController = createNavigationController({
  runtimeState,
  intervalMs: NAVIGATION_WATCH_INTERVAL_MS,
  userGestureGraceMs: USER_GESTURE_GRACE_MS,
  initialRoomStatePauseHoldMs: INITIAL_ROOM_STATE_PAUSE_HOLD_MS,
  sharedVideoNaturalEndWindowMs: SHARED_VIDEO_NATURAL_END_WINDOW_MS,
  getCurrentPageUrl: () => window.location.href.split("#")[0],
  normalizeVideoPageUrl: (url) => normalizeSharedVideoUrl(url),
  // Festival pages keep a fixed `/festival/<id>` route in the address bar while
  // the player swaps videos, so the navigation watcher can only observe an
  // autoplay-next through the page-bridge snapshot's resolved share URL.
  getResolvedVideoUrl: () =>
    festivalBridge.resolveVideoUrlForPage(
      window.location.pathname,
      window.location.href.split("#")[0],
      FESTIVAL_SNAPSHOT_TTL_MS,
    ),
  isSupportedVideoPage: (url) => Boolean(normalizeSharedVideoUrl(url)),
  clearFestivalSnapshot: () => {
    festivalBridge.clearSnapshot();
    // The navigation controller sees every real route transition, including a
    // quick leave-and-return with no playback event on the page in between.
    // Give that visit boundary to the share controller so a festival address
    // bar refuted on the previous visit cannot stay refuted on the next one.
    shareController.observePageVisit(window.location.href.split("#")[0]);
  },
  attachPlaybackListeners: () =>
    playbackBindingController.attachPlaybackListeners(),
  getVideoElement,
  pauseVideo,
  playVideo,
  hydrateRoomState: () => syncController.hydrateRoomState(),
  activatePauseHold,
  scheduleAutoShareNextVideo: (input) =>
    autoShareNextController.scheduleForNavigation(input),
  cancelAutoShareNextVideo: () => autoShareNextController.cancelPending(),
  debugLog,
});
const pageShareButtonController = createPageShareButtonController({
  resolveCurrentSharePayload: () =>
    shareController.resolveCurrentSharePayload(),
  runtimeSendMessage,
  toastPresenter,
});

void init();

function debugLog(message: string): void {
  void runtimeSendMessage({
    type: "content:debug-log",
    payload: { message },
  }).catch(() => undefined);
}

/**
 * Every timestamp below is monotonic (`performance.now()`), and so is every
 * timestamp the controllers this file wires up store. They are all intervals
 * measured on this machine — a throttle window, a pause hold, the age of a user
 * gesture — and none of them may move when the wall clock is stepped. Some of
 * these fields (`lastUserGestureAt`) are written here and compared in three
 * other controllers, so the domain is only consistent if every writer and every
 * reader uses the same clock.
 *
 * The single exception in the content script is `PlaybackState.updatedAt`, a
 * wire field that stays on the wall clock; it is produced in
 * `playback-broadcast` / `page-video`, never here.
 */
function shouldLogHeartbeat(
  state: { key: string | null; at: number },
  key: string,
  now = performance.now(),
): boolean {
  if (state.key === key && now - state.at < HEARTBEAT_LOG_INTERVAL_MS) {
    return false;
  }
  state.key = key;
  state.at = now;
  return true;
}

function activatePauseHold(durationMs = PAUSE_HOLD_MS): void {
  runtimeState.pauseHoldUntil = performance.now() + durationMs;
}

async function init(): Promise<void> {
  startUserGestureTracking((insidePlayer, rateControl) => {
    const now = performance.now();
    runtimeState.lastUserGestureAt = now;
    if (insidePlayer) {
      runtimeState.lastUserGestureInPlayerAt = now;
    }
    if (rateControl) {
      runtimeState.lastRateControlGestureAt = now;
    }
  });
  pageShareButtonController.start();
  void hydratePageShareButtonSettings();
  playbackBindingController.start();
  navigationController.start();
  // Inject the page-world bridge eagerly so its SPA navigation hooks are armed on
  // every page (not just festival pages that read a snapshot), and route the
  // resulting navigation signal into an immediate navigation check so a
  // non-shared page's load autoplay is suppressed without waiting for the poll.
  festivalBridge.ensureBridgeInjected();
  navigationSignalUnsubscribe = startNavigationSignalListener(() => {
    navigationController.notifyNavigation();
  });
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) {
      clearPageShareButtonSettingsHydrationTimer();
      navigationSignalUnsubscribe?.();
      navigationSignalUnsubscribe = null;
      pageShareButtonController.destroy();
      autoShareNextController.destroy();
      syncController.destroy();
      playbackBindingController.destroy();
      navigationController.destroy();
    }
  });
  document.addEventListener("fullscreenchange", () => {
    toastPresenter.resetMountTarget();
    pageShareButtonController.resetMountTarget();
  });
  void reportCurrentUser((msg) => runtimeSendMessage(msg));

  chrome.runtime.onMessage.addListener(
    (message: BackgroundToContentMessage, _sender, sendResponse) => {
      if (message.type === "background:apply-room-state") {
        void syncController.applyRoomState(
          message.payload,
          message.shareToast ?? null,
        );
        return false;
      }

      if (message.type === "background:sync-status") {
        roomStateController.handleSyncStatus(message.payload);
        return false;
      }

      if (message.type === "background:page-share-button-settings") {
        clearPageShareButtonSettingsHydrationTimer();
        pageShareButtonController.setEnabled(message.payload.enabled);
        return false;
      }

      if (message.type === "background:get-current-video") {
        void (async () => {
          sendResponse({
            ok: true,
            payload: await shareController.resolveCurrentSharePayload(),
          });
        })();
        return true;
      }

      return false;
    },
  );

  await syncController.hydrateRoomState();
}

function clearPageShareButtonSettingsHydrationTimer(): void {
  if (pageShareButtonSettingsHydrationTimer === null) {
    return;
  }
  window.clearTimeout(pageShareButtonSettingsHydrationTimer);
  pageShareButtonSettingsHydrationTimer = null;
}

function schedulePageShareButtonSettingsHydrationRetry(
  nextAttempt: number,
): void {
  clearPageShareButtonSettingsHydrationTimer();
  pageShareButtonSettingsHydrationTimer = window.setTimeout(() => {
    pageShareButtonSettingsHydrationTimer = null;
    void hydratePageShareButtonSettings(nextAttempt);
  }, PAGE_SHARE_BUTTON_SETTINGS_RETRY_DELAY_MS);
}

async function hydratePageShareButtonSettings(attempt = 1): Promise<void> {
  let response: unknown;
  try {
    response = await runtimeSendMessage<unknown>({
      type: "content:get-page-share-button-settings",
    });
  } catch {
    response = null;
  }

  const result = resolvePageShareButtonSettingsHydration(
    response,
    attempt,
    PAGE_SHARE_BUTTON_SETTINGS_MAX_ATTEMPTS,
  );
  if (result.action === "apply") {
    clearPageShareButtonSettingsHydrationTimer();
    pageShareButtonController.setEnabled(result.enabled);
    return;
  }
  if (result.action === "retry") {
    schedulePageShareButtonSettingsHydrationRetry(attempt + 1);
  }
}
