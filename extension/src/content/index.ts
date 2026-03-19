import {
  normalizeBilibiliUrl,
  type PlaybackState,
  type RoomState,
  type SharedVideo,
} from "@bili-syncplay/protocol";
import type {
  BackgroundToContentMessage,
  SharedVideoToastPayload,
} from "../shared/messages";
import { createFestivalBridgeController } from "./festival-bridge";
import {
  bindVideoElement,
  getPlayState,
  getVideoElement,
  pauseVideo,
} from "./player-binding";
import {
  createSharePayload as createPageSharePayload,
  resolvePageSharedVideo,
} from "./page-video";
import {
  evaluateNonSharedPageGuard,
  shouldForcePauseWhileWaitingForInitialRoomState,
} from "./sync-guards";
import { createContentStateStore } from "./content-store";
import { createRoomStateController } from "./room-state-controller";
import { createSyncController } from "./sync-controller";
import { createToastCoordinatorState, createToastPresenter } from "./toast";

let seq = 0;
let lastBroadcastAt = 0;
let hydrateRetryTimer: number | null = null;
let videoBindingTimer: number | null = null;
let navigationWatchTimer: number | null = null;
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
const USER_GESTURE_GRACE_MS = 1200;
const FESTIVAL_SNAPSHOT_TTL_MS = 1200;
const NAVIGATION_WATCH_INTERVAL_MS = 400;
const VIDEO_BIND_INTERVAL_MS = 250;
const HEARTBEAT_LOG_INTERVAL_MS = 10000;
let lastObservedPageUrl = window.location.href.split("#")[0];
const festivalBridge = createFestivalBridgeController();
const broadcastLogState = { key: null as string | null, at: 0 };
const ignoredSelfPlaybackLogState = { key: null as string | null, at: 0 };
const roomStateController = createRoomStateController({
  runtimeState,
  toastState,
  toastPresenter,
  getSharedVideo,
  normalizeUrl,
  debugLog,
  resetPlaybackSyncState,
  scheduleHydrationRetry,
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
  getCurrentPlaybackVideo,
  getSharedVideo,
  normalizeUrl,
  notifyRoomStateToasts: (state) =>
    roomStateController.notifyRoomStateToasts(state),
  maybeShowSharedVideoToast: (toast, state) =>
    roomStateController.maybeShowSharedVideoToast(toast, state),
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

async function runtimeSendMessage<T>(message: unknown): Promise<T | null> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Extension context invalidated")
    ) {
      return null;
    }
    throw error;
  }
}

function resetPlaybackSyncState(reason: string): void {
  syncController.resetPlaybackSyncState(reason);
}

async function init(): Promise<void> {
  startUserGestureTracking();
  startPlaybackBinding();
  startNavigationWatch();
  document.addEventListener("fullscreenchange", () => {
    toastPresenter.resetMountTarget();
  });
  void reportCurrentUser();

  chrome.runtime.onMessage.addListener(
    (message: BackgroundToContentMessage, _sender, sendResponse) => {
      if (message.type === "background:apply-room-state") {
        void applyRoomState(message.payload, message.shareToast ?? null);
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
            payload: await resolveCurrentSharePayload(),
          });
        })();
        return true;
      }

      return false;
    },
  );

  await hydrateRoomState();
}

function startUserGestureTracking(): void {
  const markUserGesture = () => {
    runtimeState.lastUserGestureAt = Date.now();
  };

  document.addEventListener("pointerdown", markUserGesture, true);
  document.addEventListener("keydown", markUserGesture, true);
}

function startPlaybackBinding(): void {
  attachPlaybackListeners();
  if (videoBindingTimer === null) {
    videoBindingTimer = window.setInterval(
      attachPlaybackListeners,
      VIDEO_BIND_INTERVAL_MS,
    );
  }
}

function attachPlaybackListeners(): void {
  const video = getVideoElement();
  if (!video) {
    return;
  }

  const scheduleBroadcast = (followUpMs?: number) => {
    void broadcastPlayback(video);
    if (followUpMs) {
      window.setTimeout(() => {
        void broadcastPlayback(video);
      }, followUpMs);
    }
  };

  const rememberExplicitPlaybackAction = (playState: "playing" | "paused") => {
    if (Date.now() - runtimeState.lastUserGestureAt < USER_GESTURE_GRACE_MS) {
      runtimeState.lastExplicitPlaybackAction = {
        playState,
        at: Date.now(),
      };
    }
  };

  const guardUnexpectedResume = () => {
    const currentVideo = getSharedVideo();
    if (
      currentVideo &&
      isCurrentVideoShared(currentVideo) &&
      hasRecentRemoteStopIntent(currentVideo.url) &&
      runtimeState.intendedPlayState !== "playing" &&
      Date.now() - runtimeState.lastUserGestureAt >= USER_GESTURE_GRACE_MS
    ) {
      debugLog(
        `Forced pause hold reapplied after unexpected resume intended=${runtimeState.intendedPlayState}`,
      );
      window.setTimeout(() => {
        pauseVideo(video);
      }, 0);
      return true;
    }
    if (forcePauseOnNonSharedPage(video)) {
      return true;
    }
    if (forcePauseWhileWaitingForInitialRoomState(video)) {
      return true;
    }
    return false;
  };

  bindVideoElement({
    video,
    onPlay: () => {
      rememberExplicitPlaybackAction("playing");
      if (!guardUnexpectedResume()) {
        scheduleBroadcast(180);
      }
    },
    onPause: () => {
      const currentVideo = getSharedVideo();
      rememberExplicitPlaybackAction("paused");
      if (
        currentVideo &&
        normalizeUrl(currentVideo.url) ===
          runtimeState.explicitNonSharedPlaybackUrl
      ) {
        runtimeState.explicitNonSharedPlaybackUrl = null;
      }
      scheduleBroadcast(120);
    },
    onWaiting: () => scheduleBroadcast(),
    onStalled: () => scheduleBroadcast(),
    onLoadedMetadata: () => {
      if (!forcePauseWhileWaitingForInitialRoomState(video)) {
        applyPendingPlaybackApplication(video);
      }
    },
    onCanPlay: () => {
      if (!forcePauseWhileWaitingForInitialRoomState(video)) {
        applyPendingPlaybackApplication(video);
      }
      scheduleBroadcast(120);
    },
    onPlaying: () => {
      rememberExplicitPlaybackAction("playing");
      if (!guardUnexpectedResume()) {
        scheduleBroadcast(180);
      }
    },
    onSeeking: () => scheduleBroadcast(),
    onSeeked: () => scheduleBroadcast(120),
    onRateChange: () => scheduleBroadcast(120),
    onTimeUpdate: () => {
      if (Date.now() - lastBroadcastAt > 2000 && !video.paused) {
        void broadcastPlayback(video);
      }
    },
  });
}

function startNavigationWatch(): void {
  const handlePotentialNavigation = () => {
    const nextPageUrl = window.location.href.split("#")[0];
    if (nextPageUrl === lastObservedPageUrl) {
      return;
    }

    lastObservedPageUrl = nextPageUrl;
    festivalBridge.clearSnapshot();
    runtimeState.pendingPlaybackApplication = null;
    runtimeState.explicitNonSharedPlaybackUrl = null;

    if (!runtimeState.activeRoomCode || !normalizeBilibiliUrl(nextPageUrl)) {
      return;
    }

    runtimeState.hasReceivedInitialRoomState = false;
    runtimeState.pendingRoomStateHydration = true;
    runtimeState.intendedPlayState = "paused";
    activatePauseHold(INITIAL_ROOM_STATE_PAUSE_HOLD_MS);
    debugLog(
      `Detected in-room navigation to ${nextPageUrl}, waiting for room state`,
    );
    attachPlaybackListeners();
    const video = getVideoElement();
    if (
      video &&
      !video.paused &&
      Date.now() - runtimeState.lastUserGestureAt >= USER_GESTURE_GRACE_MS
    ) {
      debugLog(
        `Suppressed autoplay immediately after in-room navigation to ${nextPageUrl}`,
      );
      pauseVideo(video);
    }
    void hydrateRoomState();
  };

  handlePotentialNavigation();
  if (navigationWatchTimer === null) {
    navigationWatchTimer = window.setInterval(
      handlePotentialNavigation,
      NAVIGATION_WATCH_INTERVAL_MS,
    );
  }
}

function forcePauseWhileWaitingForInitialRoomState(
  video: HTMLVideoElement,
): boolean {
  if (
    !shouldForcePauseWhileWaitingForInitialRoomState({
      activeRoomCode: runtimeState.activeRoomCode,
      pendingRoomStateHydration: runtimeState.pendingRoomStateHydration,
      videoPaused: video.paused,
      now: Date.now(),
      lastUserGestureAt: runtimeState.lastUserGestureAt,
      userGestureGraceMs: USER_GESTURE_GRACE_MS,
    })
  ) {
    if (
      runtimeState.activeRoomCode &&
      runtimeState.pendingRoomStateHydration &&
      !video.paused &&
      Date.now() - runtimeState.lastUserGestureAt < USER_GESTURE_GRACE_MS
    ) {
      debugLog(
        `Allowed user-initiated playback while waiting for initial room state of ${runtimeState.activeRoomCode}`,
      );
    }
    return false;
  }

  if (Date.now() - runtimeState.lastUserGestureAt < USER_GESTURE_GRACE_MS) {
    debugLog(
      `Allowed user-initiated playback while waiting for initial room state of ${runtimeState.activeRoomCode}`,
    );
    return false;
  }

  debugLog(
    `Suppressed page autoplay while waiting for initial room state of ${runtimeState.activeRoomCode}`,
  );
  runtimeState.intendedPlayState = "paused";
  window.setTimeout(() => {
    if (!video.paused) {
      pauseVideo(video);
    }
  }, 0);
  return true;
}

function forcePauseOnNonSharedPage(video: HTMLVideoElement): boolean {
  if (!runtimeState.activeRoomCode || !runtimeState.activeSharedUrl) {
    return false;
  }

  const currentVideo = getSharedVideo();
  const normalizedCurrentUrl = normalizeUrl(currentVideo?.url);
  if (!currentVideo) {
    runtimeState.explicitNonSharedPlaybackUrl = null;
    return false;
  }

  const decision = evaluateNonSharedPageGuard({
    activeRoomCode: runtimeState.activeRoomCode,
    activeSharedUrl: runtimeState.activeSharedUrl,
    normalizedCurrentUrl,
    videoPaused: video.paused,
    explicitNonSharedPlaybackUrl: runtimeState.explicitNonSharedPlaybackUrl,
    lastExplicitPlaybackAction: runtimeState.lastExplicitPlaybackAction,
    now: Date.now(),
    userGestureGraceMs: USER_GESTURE_GRACE_MS,
  });

  if (
    !normalizedCurrentUrl ||
    normalizedCurrentUrl === runtimeState.activeSharedUrl
  ) {
    runtimeState.explicitNonSharedPlaybackUrl = null;
    return false;
  }

  runtimeState.explicitNonSharedPlaybackUrl =
    decision.nextExplicitNonSharedPlaybackUrl;
  if (!decision.shouldPause) {
    return false;
  }

  runtimeState.intendedPlayState = "paused";
  activatePauseHold(INITIAL_ROOM_STATE_PAUSE_HOLD_MS);
  window.setTimeout(() => {
    if (!video.paused) {
      pauseVideo(video);
    }
  }, 0);
  return true;
}

function isCurrentVideoShared(currentVideo: SharedVideo | null): boolean {
  if (!currentVideo || !runtimeState.activeSharedUrl) {
    return false;
  }
  return normalizeUrl(currentVideo.url) === runtimeState.activeSharedUrl;
}

function activatePauseHold(durationMs = PAUSE_HOLD_MS): void {
  runtimeState.pauseHoldUntil = Date.now() + durationMs;
}

function scheduleHydrationRetry(delayMs = 350): void {
  syncController.scheduleHydrationRetry(delayMs);
}

function applyPendingPlaybackApplication(video: HTMLVideoElement): void {
  syncController.applyPendingPlaybackApplication(video);
}

function getSharedVideo(): SharedVideo | null {
  const festivalSnapshot = festivalBridge.getSnapshot();
  return resolvePageSharedVideo({
    pageUrl: window.location.href.split("#")[0],
    pathname: window.location.pathname,
    documentTitle: document.title,
    headingTitle: document.querySelector("h1")?.textContent?.trim() ?? null,
    currentPartTitle: getCurrentPartTitle(),
    festivalSnapshot: festivalSnapshot
      ? {
          videoId: festivalSnapshot.videoId,
          url: festivalSnapshot.url,
          title: festivalSnapshot.title,
        }
      : null,
  });
}

async function getCurrentPlaybackVideo(): Promise<SharedVideo | null> {
  if (window.location.pathname.startsWith("/festival/")) {
    const refreshed = await refreshFestivalSnapshot(0);
    if (refreshed) {
      return refreshed;
    }
  }

  return getSharedVideo();
}

function getCurrentPartTitle(): string | null {
  return (
    document
      .querySelector("li.bpx-state-multi-active-item")
      ?.textContent?.trim() ||
    document
      .querySelector(
        ".video-section-list li.on, .video-section-list li.active, [data-cid].bpx-state-multi-active-item",
      )
      ?.textContent?.trim() ||
    null
  );
}

function createSharePayload(sharedVideo: SharedVideo): {
  video: SharedVideo;
  playback: PlaybackState | null;
} {
  const video = getVideoElement();
  return createPageSharePayload({
    sharedVideo,
    playback: video
      ? {
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
          playState: getPlayState(video, runtimeState.intendedPlayState),
        }
      : null,
    actorId: runtimeState.localMemberId ?? "local",
    seq: seq++,
    now: Date.now(),
  });
}

function getCurrentSharePayload(): {
  video: SharedVideo;
  playback: PlaybackState | null;
} | null {
  const currentVideo = getSharedVideo();
  if (currentVideo && window.location.pathname.startsWith("/festival/")) {
    debugLog(
      `Festival video detected id=${currentVideo.videoId} title=${currentVideo.title} url=${currentVideo.url}`,
    );
  }
  return currentVideo ? createSharePayload(currentVideo) : null;
}

async function resolveCurrentSharePayload(): Promise<{
  video: SharedVideo;
  playback: PlaybackState | null;
} | null> {
  if (window.location.pathname.startsWith("/festival/")) {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const refreshed = await refreshFestivalSnapshot(
        attempt === 1 ? 0 : FESTIVAL_SNAPSHOT_TTL_MS,
      );
      if (refreshed) {
        debugLog(
          `Festival payload stabilized after retry ${attempt}: ${refreshed.videoId}`,
        );
        return createSharePayload(refreshed);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }

    debugLog("Festival payload fell back to URL-based detection");
  }

  const initialPayload = getCurrentSharePayload();
  return initialPayload;
}

async function refreshFestivalSnapshot(
  maxAgeMs = FESTIVAL_SNAPSHOT_TTL_MS,
): Promise<SharedVideo | null> {
  const nextSnapshot = await festivalBridge.refreshSnapshot({
    pathname: window.location.pathname,
    pageUrl: window.location.href.split("#")[0],
    maxAgeMs,
  });
  if (!nextSnapshot) {
    return null;
  }
  debugLog(
    `Festival video detected id=${nextSnapshot.videoId} title=${nextSnapshot.title} url=${nextSnapshot.url}`,
  );
  return nextSnapshot;
}

function normalizeUrl(url: string | undefined | null): string | null {
  return normalizeBilibiliUrl(url);
}

async function broadcastPlayback(video: HTMLVideoElement): Promise<void> {
  await syncController.broadcastPlayback(video);
}

async function applyRoomState(
  state: RoomState,
  shareToast: SharedVideoToastPayload | null = null,
): Promise<void> {
  await syncController.applyRoomState(state, shareToast);
}

async function hydrateRoomState(): Promise<void> {
  await syncController.hydrateRoomState();
}

async function reportCurrentUser(): Promise<void> {
  try {
    const response = await fetch(
      "https://api.bilibili.com/x/web-interface/nav",
      {
        credentials: "include",
      },
    );
    const data = (await response.json()) as {
      code: number;
      data?: {
        isLogin?: boolean;
        uname?: string;
        mid?: number;
      };
    };

    if (data.code !== 0 || !data.data?.isLogin) {
      return;
    }

    const nextDisplayName =
      data.data.uname?.trim() || (data.data.mid ? `UID-${data.data.mid}` : "");
    if (!nextDisplayName) {
      return;
    }

    const reportResponse = await runtimeSendMessage({
      type: "content:report-user",
      payload: { displayName: nextDisplayName },
    });
    if (reportResponse === null) {
      return;
    }
  } catch {
    // Ignore lookup failures and keep guest naming.
  }
}
