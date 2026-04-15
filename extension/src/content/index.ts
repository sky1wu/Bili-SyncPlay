import type { BackgroundToContentMessage } from "../shared/messages";
import { normalizeSharedVideoUrl } from "../shared/url";
import { runtimeSendMessage } from "./content-messaging";
import { createFestivalBridgeController } from "./festival-bridge";
import { startUserGestureTracking } from "./gesture-tracker";
import { getVideoElement, pauseVideo } from "./player-binding";
import { createContentStateStore } from "./content-store";
import { createNavigationController } from "./navigation-controller";
import { createPlaybackBindingController } from "./playback-binding-controller";
import { createRoomStateController } from "./room-state-controller";
import { createShareController } from "./share-controller";
import { createSyncController } from "./sync-controller";
import { createToastCoordinatorState, createToastPresenter } from "./toast";
import { reportCurrentUser } from "./user-reporter";

const normalizeUrl = normalizeSharedVideoUrl;
let seq = 0;
let lastBroadcastAt = 0;
let hydrateRetryTimer: number | null = null;
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
const INITIAL_ROOM_STATE_PAUSE_HOLD_MS = 3000;
const REMOTE_ECHO_SUPPRESSION_MS = 700;
const REMOTE_PLAY_TRANSITION_GUARD_MS = 1800;
const REMOTE_FOLLOW_PLAYING_WINDOW_MS = 3000;
const PROGRAMMATIC_APPLY_WINDOW_MS = 700;
const USER_GESTURE_GRACE_MS = 1200;
const FESTIVAL_SNAPSHOT_TTL_MS = 1200;
const NAVIGATION_WATCH_INTERVAL_MS = 400;
const VIDEO_BIND_INTERVAL_MS = 250;
const HEARTBEAT_LOG_INTERVAL_MS = 10000;
const festivalBridge = createFestivalBridgeController();
const broadcastLogState = { key: null as string | null, at: 0 };
const ignoredSelfPlaybackLogState = { key: null as string | null, at: 0 };
const shareController = createShareController({
  runtimeState,
  festivalSnapshotTtlMs: FESTIVAL_SNAPSHOT_TTL_MS,
  nextSeq: () => seq++,
  getFestivalSnapshot: () => festivalBridge.getSnapshot(),
  refreshFestivalBridge: (input) => festivalBridge.refreshSnapshot(input),
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
  nextSeq: () => seq++,
  markBroadcastAt: (at) => {
    lastBroadcastAt = at;
  },
  debugLog,
  shouldLogHeartbeat,
  runtimeSendMessage,
  getHydrateRetryTimer: () => hydrateRetryTimer,
  setHydrateRetryTimer: (timer) => {
    hydrateRetryTimer = timer;
  },
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
  userGestureGraceMs: USER_GESTURE_GRACE_MS,
  initialRoomStatePauseHoldMs: INITIAL_ROOM_STATE_PAUSE_HOLD_MS,
  getSharedVideo: () => shareController.getSharedVideo(),
  hasRecentRemoteStopIntent: (currentVideoUrl) =>
    syncController.hasRecentRemoteStopIntent(currentVideoUrl),
  normalizeUrl,
  getLastBroadcastAt: () => lastBroadcastAt,
  broadcastPlayback: (video, eventSource) =>
    syncController.broadcastPlayback(video, eventSource),
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
  getCurrentPageUrl: () => window.location.href.split("#")[0],
  normalizeVideoPageUrl: (url) => normalizeSharedVideoUrl(url),
  isSupportedVideoPage: (url) => Boolean(normalizeSharedVideoUrl(url)),
  clearFestivalSnapshot: () => {
    festivalBridge.clearSnapshot();
  },
  attachPlaybackListeners: () =>
    playbackBindingController.attachPlaybackListeners(),
  getVideoElement,
  pauseVideo,
  hydrateRoomState: () => syncController.hydrateRoomState(),
  activatePauseHold,
  debugLog,
});

void init();

function debugLog(message: string): void {
  void runtimeSendMessage({
    type: "content:debug-log",
    payload: { message },
  }).catch(() => undefined);
}

function shouldLogHeartbeat(
  state: { key: string | null; at: number },
  key: string,
  now = Date.now(),
): boolean {
  if (state.key === key && now - state.at < HEARTBEAT_LOG_INTERVAL_MS) {
    return false;
  }
  state.key = key;
  state.at = now;
  return true;
}

function activatePauseHold(durationMs = PAUSE_HOLD_MS): void {
  runtimeState.pauseHoldUntil = Date.now() + durationMs;
}

async function init(): Promise<void> {
  startUserGestureTracking(() => {
    runtimeState.lastUserGestureAt = Date.now();
  });
  playbackBindingController.start();
  navigationController.start();
  document.addEventListener("fullscreenchange", () => {
    toastPresenter.resetMountTarget();
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
