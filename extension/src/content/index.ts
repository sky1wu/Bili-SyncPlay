import {
  normalizeBilibiliUrl,
  type PlaybackState,
  type RoomState,
  type SharedVideo
} from "@bili-syncplay/protocol";
import type { BackgroundToContentMessage, SharedVideoToastPayload } from "../shared/messages";
import { createFestivalBridgeController } from "./festival-bridge";
import {
  applyPendingPlaybackApplication as applyPendingPlaybackApplicationWithBinding,
  bindVideoElement,
  canApplyPlaybackImmediately,
  getPlayState,
  getVideoElement,
  pauseVideo
} from "./player-binding";
import { createSharePayload as createPageSharePayload, resolvePageSharedVideo } from "./page-video";
import { decidePlaybackApplication } from "./playback-apply";
import {
  createPlaybackBroadcastPayload,
  shouldPauseForNonSharedBroadcast,
  shouldSkipBroadcastWhileHydrating
} from "./playback-broadcast";
import {
  evaluateNonSharedPageGuard,
  hasRecentRemoteStopIntent as hasRecentRemoteStopIntentGuard,
  rememberRemotePlaybackForSuppression as rememberRemotePlaybackForSuppressionGuard,
  shouldApplySelfPlayback as shouldApplySelfPlaybackGuard,
  shouldForcePauseWhileWaitingForInitialRoomState,
  shouldSuppressLocalEcho as shouldSuppressLocalEchoGuard,
  shouldSuppressRemotePlayTransition as shouldSuppressRemotePlayTransitionGuard
} from "./sync-guards";
import { createContentRuntimeState } from "./runtime-state";
import {
  createToastCoordinatorState,
  createToastPresenter,
  getRoomStateToastMessages,
  getSharedVideoToastMessage
} from "./toast";

let seq = 0;
let lastBroadcastAt = 0;
let hydrateRetryTimer: number | null = null;
let videoBindingTimer: number | null = null;
let navigationWatchTimer: number | null = null;
let lastAppliedVersionByActor = new Map<string, { serverTime: number; seq: number }>();
const runtimeState = createContentRuntimeState();
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
let lastObservedPageUrl = window.location.href.split("#")[0];
const festivalBridge = createFestivalBridgeController();

void init();

function debugLog(message: string): void {
  void runtimeSendMessage({
    type: "content:debug-log",
    payload: { message }
  }).catch(() => undefined);
}

async function runtimeSendMessage<T>(message: unknown): Promise<T | null> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Extension context invalidated")) {
      return null;
    }
    throw error;
  }
}

function resetPlaybackSyncState(reason: string): void {
  lastAppliedVersionByActor.clear();
  runtimeState.suppressedRemotePlayback = null;
  runtimeState.recentRemotePlayingIntent = null;
  runtimeState.pendingPlaybackApplication = null;
  debugLog(`Reset playback sync state: ${reason}`);
}

function isCurrentPageShowingSharedVideo(state: RoomState): boolean {
  const currentVideo = getSharedVideo();
  if (!currentVideo || !state.sharedVideo) {
    return false;
  }

  return normalizeUrl(currentVideo.url) === normalizeUrl(state.sharedVideo.url);
}

function notifyRoomStateToasts(state: RoomState): void {
  const plan = getRoomStateToastMessages({
    previousState: toastState.lastRoomState,
    nextState: state,
    localMemberId: runtimeState.localMemberId,
    pendingRoomStateHydration: runtimeState.pendingRoomStateHydration,
    isCurrentPageShowingSharedVideo: isCurrentPageShowingSharedVideo(state),
    now: Date.now(),
    lastSeekToastByActor: toastState.lastSeekToastByActor
  });
  toastState.lastRoomState = state;
  toastState.lastSeekToastByActor = plan.nextSeekToastByActor;
  for (const message of plan.messages) {
    toastPresenter.show(message);
  }
}

function maybeShowSharedVideoToast(toast: SharedVideoToastPayload | null | undefined, state: RoomState): void {
  const plan = getSharedVideoToastMessage({
    toast,
    state,
    localMemberId: runtimeState.localMemberId,
    lastSharedVideoToastKey: toastState.lastSharedVideoToastKey,
    normalizedToastUrl: normalizeUrl(toast?.videoUrl),
    normalizedSharedUrl: normalizeUrl(state.sharedVideo?.url)
  });
  toastState.lastSharedVideoToastKey = plan.nextSharedVideoToastKey;
  if (plan.message) {
    toastPresenter.show(plan.message);
  }
}
async function init(): Promise<void> {
  startUserGestureTracking();
  startPlaybackBinding();
  startNavigationWatch();
  document.addEventListener("fullscreenchange", () => {
    toastPresenter.resetMountTarget();
  });
  void reportCurrentUser();

  chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage, _sender, sendResponse) => {
    if (message.type === "background:apply-room-state") {
      void applyRoomState(message.payload, message.shareToast ?? null);
      return false;
    }

    if (message.type === "background:sync-status") {
      const previousRoomCode = runtimeState.activeRoomCode;
      runtimeState.activeRoomCode = message.payload.roomCode;
      runtimeState.localMemberId = message.payload.memberId;
      const roomChanged = Boolean(
        previousRoomCode && message.payload.roomCode && previousRoomCode !== message.payload.roomCode
      );

      if (roomChanged) {
        resetPlaybackSyncState(`room changed ${previousRoomCode} -> ${message.payload.roomCode}`);
        toastState.lastRoomState = null;
        runtimeState.hasReceivedInitialRoomState = false;
        runtimeState.pendingRoomStateHydration = true;
      }

      if (message.payload.roomCode && !runtimeState.hasReceivedInitialRoomState) {
        runtimeState.pendingRoomStateHydration = true;
        debugLog(`Waiting for initial room state of ${message.payload.roomCode}`);
        scheduleHydrationRetry(150);
      }

      if (!message.payload.roomCode) {
        if (previousRoomCode) {
          resetPlaybackSyncState(`room cleared from ${previousRoomCode}`);
        }
        runtimeState.activeSharedUrl = null;
        toastState.lastRoomState = null;
        runtimeState.pendingRoomStateHydration = false;
        runtimeState.hasReceivedInitialRoomState = false;
      }
      return false;
    }

    if (message.type === "background:get-current-video") {
      void (async () => {
        sendResponse({
          ok: true,
          payload: await resolveCurrentSharePayload()
        });
      })();
      return true;
    }

    return false;
  });

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
    videoBindingTimer = window.setInterval(attachPlaybackListeners, VIDEO_BIND_INTERVAL_MS);
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
        at: Date.now()
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
      debugLog(`Forced pause hold reapplied after unexpected resume intended=${runtimeState.intendedPlayState}`);
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
      if (currentVideo && normalizeUrl(currentVideo.url) === runtimeState.explicitNonSharedPlaybackUrl) {
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
    }
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
    debugLog(`Detected in-room navigation to ${nextPageUrl}, waiting for room state`);
    attachPlaybackListeners();
    const video = getVideoElement();
    if (video && !video.paused && Date.now() - runtimeState.lastUserGestureAt >= USER_GESTURE_GRACE_MS) {
      debugLog(`Suppressed autoplay immediately after in-room navigation to ${nextPageUrl}`);
      pauseVideo(video);
    }
    void hydrateRoomState();
  };

  handlePotentialNavigation();
  if (navigationWatchTimer === null) {
    navigationWatchTimer = window.setInterval(handlePotentialNavigation, NAVIGATION_WATCH_INTERVAL_MS);
  }
}

function forcePauseWhileWaitingForInitialRoomState(video: HTMLVideoElement): boolean {
  if (
    !shouldForcePauseWhileWaitingForInitialRoomState({
      activeRoomCode: runtimeState.activeRoomCode,
      pendingRoomStateHydration: runtimeState.pendingRoomStateHydration,
      videoPaused: video.paused,
      now: Date.now(),
      lastUserGestureAt: runtimeState.lastUserGestureAt,
      userGestureGraceMs: USER_GESTURE_GRACE_MS
    })
  ) {
    if (
      runtimeState.activeRoomCode &&
      runtimeState.pendingRoomStateHydration &&
      !video.paused &&
      Date.now() - runtimeState.lastUserGestureAt < USER_GESTURE_GRACE_MS
    ) {
      debugLog(`Allowed user-initiated playback while waiting for initial room state of ${runtimeState.activeRoomCode}`);
    }
    return false;
  }

  if (Date.now() - runtimeState.lastUserGestureAt < USER_GESTURE_GRACE_MS) {
    debugLog(`Allowed user-initiated playback while waiting for initial room state of ${runtimeState.activeRoomCode}`);
    return false;
  }

  debugLog(`Suppressed page autoplay while waiting for initial room state of ${runtimeState.activeRoomCode}`);
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
    userGestureGraceMs: USER_GESTURE_GRACE_MS
  });

  if (!normalizedCurrentUrl || normalizedCurrentUrl === runtimeState.activeSharedUrl) {
    runtimeState.explicitNonSharedPlaybackUrl = null;
    return false;
  }

  runtimeState.explicitNonSharedPlaybackUrl = decision.nextExplicitNonSharedPlaybackUrl;
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
  if (hydrateRetryTimer !== null) {
    return;
  }
  hydrateRetryTimer = window.setTimeout(() => {
    hydrateRetryTimer = null;
    void hydrateRoomState(1);
  }, delayMs);
}

function applyPendingPlaybackApplication(video: HTMLVideoElement): void {
  applyPendingPlaybackApplicationWithBinding({
    video,
    pendingPlaybackApplication: runtimeState.pendingPlaybackApplication,
    clearPendingPlaybackApplication: () => {
      runtimeState.pendingPlaybackApplication = null;
    },
    debugLog
  });
}

function hasRecentRemoteStopIntent(currentVideoUrl: string): boolean {
  return hasRecentRemoteStopIntentGuard({
    now: Date.now(),
    pauseHoldUntil: runtimeState.pauseHoldUntil,
    normalizedCurrentUrl: normalizeUrl(currentVideoUrl),
    activeSharedUrl: runtimeState.activeSharedUrl,
    intendedPlayState: runtimeState.intendedPlayState,
    suppressedRemotePlayback: runtimeState.suppressedRemotePlayback
  });
}

function rememberRemotePlaybackForSuppression(playback: PlaybackState): void {
  const url = normalizeUrl(playback.url);
  const remembered = rememberRemotePlaybackForSuppressionGuard({
    playback,
    normalizedUrl: url,
    now: Date.now(),
    remoteEchoSuppressionMs: REMOTE_ECHO_SUPPRESSION_MS,
    remotePlayTransitionGuardMs: REMOTE_PLAY_TRANSITION_GUARD_MS
  });
  runtimeState.suppressedRemotePlayback = remembered.suppressedRemotePlayback;
  runtimeState.recentRemotePlayingIntent = remembered.recentRemotePlayingIntent;
  if (!url) {
    return;
  }
  debugLog(
    `Remember remote echo ${playback.playState} ${url} t=${playback.currentTime.toFixed(2)} rate=${playback.playbackRate.toFixed(2)}`
  );
}

function shouldSuppressLocalEcho(
  video: HTMLVideoElement,
  currentVideo: SharedVideo,
  playState: PlaybackState["playState"]
): boolean {
  const decision = shouldSuppressLocalEchoGuard({
    suppressedRemotePlayback: runtimeState.suppressedRemotePlayback,
    normalizedCurrentUrl: normalizeUrl(currentVideo.url),
    playState,
    currentTime: video.currentTime,
    playbackRate: video.playbackRate,
    now: Date.now()
  });

  if (runtimeState.suppressedRemotePlayback && !decision.nextSuppressedRemotePlayback) {
    if (runtimeState.suppressedRemotePlayback) {
      debugLog(
        `Remote echo window expired for ${runtimeState.suppressedRemotePlayback.playState} ${runtimeState.suppressedRemotePlayback.url}`
      );
    }
    runtimeState.suppressedRemotePlayback = decision.nextSuppressedRemotePlayback;
  }

  if (
    runtimeState.suppressedRemotePlayback &&
    decision.nextSuppressedRemotePlayback &&
    normalizeUrl(currentVideo.url) !== runtimeState.suppressedRemotePlayback.url
  ) {
    debugLog(`Remote echo skipped by url ${currentVideo.url} != ${runtimeState.suppressedRemotePlayback.url}`);
  } else if (
    runtimeState.suppressedRemotePlayback &&
    decision.nextSuppressedRemotePlayback &&
    playState !== runtimeState.suppressedRemotePlayback.playState
  ) {
    debugLog(`Remote echo skipped by playState ${playState} != ${runtimeState.suppressedRemotePlayback.playState}`);
  } else if (
    runtimeState.suppressedRemotePlayback &&
    decision.nextSuppressedRemotePlayback &&
    Math.abs(video.playbackRate - runtimeState.suppressedRemotePlayback.playbackRate) > 0.01
  ) {
    debugLog(
      `Remote echo skipped by rate ${video.playbackRate.toFixed(2)} != ${runtimeState.suppressedRemotePlayback.playbackRate.toFixed(2)}`
    );
  }

  const threshold = playState === "playing" ? 0.9 : 0.2;
  const delta = runtimeState.suppressedRemotePlayback
    ? Math.abs(video.currentTime - runtimeState.suppressedRemotePlayback.currentTime)
    : Infinity;
  debugLog(
    `${decision.shouldSuppress ? "Suppressed" : "Allowed"} local echo ${playState} ${currentVideo.url} delta=${delta.toFixed(2)} threshold=${threshold.toFixed(2)}`
  );
  return decision.shouldSuppress;
}

function shouldSuppressRemotePlayTransition(
  currentVideo: SharedVideo,
  playState: PlaybackState["playState"],
  currentTime: number
): boolean {
  const decision = shouldSuppressRemotePlayTransitionGuard({
    recentRemotePlayingIntent: runtimeState.recentRemotePlayingIntent,
    normalizedCurrentUrl: normalizeUrl(currentVideo.url),
    playState,
    currentTime,
    lastExplicitPlaybackAction: runtimeState.lastExplicitPlaybackAction,
    now: Date.now(),
    userGestureGraceMs: USER_GESTURE_GRACE_MS
  });

  if (
    runtimeState.recentRemotePlayingIntent &&
    decision.nextRecentRemotePlayingIntent &&
    runtimeState.lastExplicitPlaybackAction &&
    Date.now() - runtimeState.lastExplicitPlaybackAction.at < USER_GESTURE_GRACE_MS &&
    runtimeState.lastExplicitPlaybackAction.playState === "paused" &&
    playState === "paused"
  ) {
    debugLog(`Allowed remote play transition echo by explicit action ${playState} ${currentVideo.url}`);
  }
  runtimeState.recentRemotePlayingIntent = decision.nextRecentRemotePlayingIntent;

  const delta = runtimeState.recentRemotePlayingIntent
    ? Math.abs(currentTime - runtimeState.recentRemotePlayingIntent.currentTime)
    : Infinity;
  if (decision.shouldSuppress) {
    debugLog(`Suppressed remote play transition echo ${playState} ${currentVideo.url} delta=${delta.toFixed(2)}`);
  }
  return decision.shouldSuppress;
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
          title: festivalSnapshot.title
        }
      : null
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
    document.querySelector("li.bpx-state-multi-active-item")?.textContent?.trim() ||
    document.querySelector(".video-section-list li.on, .video-section-list li.active, [data-cid].bpx-state-multi-active-item")?.textContent?.trim() ||
    null
  );
}

function createSharePayload(sharedVideo: SharedVideo): { video: SharedVideo; playback: PlaybackState | null } {
  const video = getVideoElement();
  return createPageSharePayload({
    sharedVideo,
    playback: video
      ? {
          currentTime: video.currentTime,
          playbackRate: video.playbackRate,
          playState: getPlayState(video, runtimeState.intendedPlayState)
        }
      : null,
    actorId: runtimeState.localMemberId ?? "local",
    seq: seq++,
    now: Date.now()
  });
}

function getCurrentSharePayload(): { video: SharedVideo; playback: PlaybackState | null } | null {
  const currentVideo = getSharedVideo();
  if (currentVideo && window.location.pathname.startsWith("/festival/")) {
    debugLog(`Festival video detected id=${currentVideo.videoId} title=${currentVideo.title} url=${currentVideo.url}`);
  }
  return currentVideo ? createSharePayload(currentVideo) : null;
}

async function resolveCurrentSharePayload(): Promise<{ video: SharedVideo; playback: PlaybackState | null } | null> {
  if (window.location.pathname.startsWith("/festival/")) {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const refreshed = await refreshFestivalSnapshot(attempt === 1 ? 0 : FESTIVAL_SNAPSHOT_TTL_MS);
      if (refreshed) {
        debugLog(`Festival payload stabilized after retry ${attempt}: ${refreshed.videoId}`);
        return createSharePayload(refreshed);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }

    debugLog("Festival payload fell back to URL-based detection");
  }

  const initialPayload = getCurrentSharePayload();
  return initialPayload;
}

async function refreshFestivalSnapshot(maxAgeMs = FESTIVAL_SNAPSHOT_TTL_MS): Promise<SharedVideo | null> {
  const nextSnapshot = await festivalBridge.refreshSnapshot({
    pathname: window.location.pathname,
    pageUrl: window.location.href.split("#")[0],
    maxAgeMs
  });
  if (!nextSnapshot) {
    return null;
  }
  debugLog(`Festival video detected id=${nextSnapshot.videoId} title=${nextSnapshot.title} url=${nextSnapshot.url}`);
  return nextSnapshot;
}

function normalizeUrl(url: string | undefined | null): string | null {
  return normalizeBilibiliUrl(url);
}

function shouldApplySelfPlayback(video: HTMLVideoElement, playback: PlaybackState): boolean {
  return shouldApplySelfPlaybackGuard({
    videoPaused: video.paused,
    videoCurrentTime: video.currentTime,
    videoPlaybackRate: video.playbackRate,
    playback
  });
}

async function broadcastPlayback(video: HTMLVideoElement): Promise<void> {
  if (!runtimeState.hydrationReady) {
    debugLog("Skip broadcast before hydration ready");
    return;
  }
  const now = Date.now();
  if (runtimeState.pendingRoomStateHydration) {
    if (!shouldSkipBroadcastWhileHydrating({
      pendingRoomStateHydration: runtimeState.pendingRoomStateHydration,
      now,
      lastUserGestureAt: runtimeState.lastUserGestureAt,
      userGestureGraceMs: USER_GESTURE_GRACE_MS
    })) {
      debugLog(
        `Allowed user-initiated broadcast while waiting for initial room state of ${runtimeState.activeRoomCode ?? "unknown-room"}`
      );
    } else {
      debugLog(`Skip broadcast while waiting for initial room state of ${runtimeState.activeRoomCode ?? "unknown-room"}`);
      return;
    }
  }

  const currentVideo = await getCurrentPlaybackVideo();
  if (!currentVideo) {
    return;
  }
  const normalizedCurrentVideoUrl = normalizeUrl(currentVideo.url);
  if (
    runtimeState.activeRoomCode &&
    runtimeState.activeSharedUrl &&
    normalizedCurrentVideoUrl !== runtimeState.activeSharedUrl
  ) {
    if (
      shouldPauseForNonSharedBroadcast({
        activeRoomCode: runtimeState.activeRoomCode,
        activeSharedUrl: runtimeState.activeSharedUrl,
        normalizedCurrentVideoUrl,
        explicitNonSharedPlaybackUrl: runtimeState.explicitNonSharedPlaybackUrl,
        playState: getPlayState(video, runtimeState.intendedPlayState),
        lastExplicitPlaybackAction: runtimeState.lastExplicitPlaybackAction,
        now,
        userGestureGraceMs: USER_GESTURE_GRACE_MS
      })
    ) {
      runtimeState.intendedPlayState = "paused";
      activatePauseHold(INITIAL_ROOM_STATE_PAUSE_HOLD_MS);
      window.setTimeout(() => {
        if (!video.paused) {
          pauseVideo(video);
        }
      }, 0);
    }
    return;
  }

  lastBroadcastAt = now;
  const playState = getPlayState(video, runtimeState.intendedPlayState);
  if (
    playState === "playing" &&
    hasRecentRemoteStopIntent(currentVideo.url) &&
    Date.now() - runtimeState.lastUserGestureAt >= USER_GESTURE_GRACE_MS
  ) {
    debugLog(`Skip playing broadcast during remote stop hold ${currentVideo.url}`);
    runtimeState.intendedPlayState = "paused";
    window.setTimeout(() => {
      if (!video.paused) {
        pauseVideo(video);
      }
    }, 0);
    return;
  }
  if (shouldSuppressLocalEcho(video, currentVideo, playState)) {
    return;
  }
  if (shouldSuppressRemotePlayTransition(currentVideo, playState, video.currentTime)) {
    return;
  }

  runtimeState.intendedPlayState = playState;
  runtimeState.lastLocalIntentAt = now;
  runtimeState.lastLocalIntentPlayState = playState;

  const payload = createPlaybackBroadcastPayload({
    currentVideo,
    currentTime: video.currentTime,
    playState,
    playbackRate: video.playbackRate,
    actorId: runtimeState.localMemberId ?? "local",
    seq: seq++,
    now
  });

  const response = await runtimeSendMessage({
    type: "content:playback-update",
    payload
  });
  if (response === null) {
    return;
  }
  debugLog(`Broadcast playback ${playState} ${currentVideo.url} t=${payload.currentTime.toFixed(2)} seq=${payload.seq}`);
}

async function applyRoomState(state: RoomState, shareToast: SharedVideoToastPayload | null = null): Promise<void> {
  notifyRoomStateToasts(state);
  maybeShowSharedVideoToast(shareToast, state);

  const currentVideo = getSharedVideo();
  const normalizedSharedUrl = normalizeUrl(state.sharedVideo?.url);
  const normalizedCurrentUrl = normalizeUrl(currentVideo?.url);
  const normalizedPlaybackUrl = normalizeUrl(state.playback?.url);

  const decision = decidePlaybackApplication({
    roomState: state,
    currentVideo,
    normalizedSharedUrl,
    normalizedCurrentUrl,
    normalizedPlaybackUrl,
    pendingRoomStateHydration: runtimeState.pendingRoomStateHydration,
    explicitNonSharedPlaybackUrl: runtimeState.explicitNonSharedPlaybackUrl,
    now: Date.now(),
    lastLocalIntentAt: runtimeState.lastLocalIntentAt,
    lastLocalIntentPlayState: runtimeState.lastLocalIntentPlayState,
    localIntentGuardMs: LOCAL_INTENT_GUARD_MS,
    lastAppliedVersion: state.playback ? lastAppliedVersionByActor.get(state.playback.actorId) ?? null : null,
    localMemberId: runtimeState.localMemberId
  });

  if (decision.kind === "empty-room") {
    runtimeState.activeSharedUrl = null;
    if (decision.acceptedHydration) {
      debugLog(`Accepted empty room state for ${state.roomCode}`);
      runtimeState.pendingRoomStateHydration = false;
      runtimeState.hasReceivedInitialRoomState = true;
    }
    return;
  }

  if (decision.kind === "no-current-video") {
    return;
  }

  if (runtimeState.activeSharedUrl !== normalizedSharedUrl) {
    runtimeState.activeSharedUrl = normalizedSharedUrl ?? null;
    resetPlaybackSyncState(`shared url changed to ${state.sharedVideo?.url ?? "none"}`);
    runtimeState.intendedPlayState = "paused";
    debugLog(`Reset local sync state for shared url ${state.sharedVideo?.url ?? "none"}`);
  }

  if (decision.kind === "ignore-non-shared") {
    debugLog(`Ignored room state for ${state.sharedVideo?.url ?? "none"} on current page ${currentVideo?.url ?? "none"}`);
    if (decision.acceptedHydration) {
      runtimeState.hasReceivedInitialRoomState = true;
      runtimeState.pendingRoomStateHydration = false;
      runtimeState.intendedPlayState = "paused";
      activatePauseHold(INITIAL_ROOM_STATE_PAUSE_HOLD_MS);
      const video = getVideoElement();
      if (video && !video.paused && decision.shouldPauseNonSharedVideo) {
        pauseVideo(video);
      }
    }
    return;
  }

  const video = getVideoElement();
  if (!video) {
    debugLog(`Deferred room state because video element is not ready for ${state.sharedVideo.url}`);
    scheduleHydrationRetry();
    return;
  }

  if (decision.kind === "ignore-local-guard") {
    debugLog(
      `Ignored conflicting remote playback ${state.playback.playState} during local ${runtimeState.lastLocalIntentPlayState} guard actor=${state.playback.actorId} seq=${state.playback.seq}`
    );
    return;
  }

  if (decision.kind === "ignore-stale-playback") {
    debugLog(`Ignored stale playback actor=${state.playback.actorId} seq=${state.playback.seq}`);
    return;
  }

  const isSelfPlayback = decision.isSelfPlayback;
  lastAppliedVersionByActor.set(state.playback.actorId, {
    serverTime: state.playback.serverTime,
    seq: state.playback.seq
  });

  if (isSelfPlayback && !shouldApplySelfPlayback(video, state.playback)) {
    debugLog(
      `Ignored self playback actor=${state.playback.actorId} seq=${state.playback.seq} localPaused=${video.paused} localT=${video.currentTime.toFixed(2)} remoteT=${state.playback.currentTime.toFixed(2)}`
    );
    return;
  }

  rememberRemotePlaybackForSuppression(state.playback);
  if (state.playback.playState === "paused" || state.playback.playState === "buffering") {
    activatePauseHold(
      runtimeState.pendingRoomStateHydration || !runtimeState.hasReceivedInitialRoomState
        ? INITIAL_ROOM_STATE_PAUSE_HOLD_MS
        : PAUSE_HOLD_MS
    );
  }

  runtimeState.intendedPlayState = state.playback.playState;
  debugLog(
    `Apply playback ${state.playback.playState} ${state.sharedVideo.url} t=${state.playback.currentTime.toFixed(2)} seq=${state.playback.seq} actor=${state.playback.actorId}`
  );

  runtimeState.pendingPlaybackApplication = { ...state.playback };
  if (canApplyPlaybackImmediately(video)) {
    applyPendingPlaybackApplication(video);
  } else {
    debugLog(`Deferred playback apply until metadata is ready ${state.sharedVideo.url}`);
  }

  runtimeState.pendingRoomStateHydration = false;
  runtimeState.hasReceivedInitialRoomState = true;
}

async function hydrateRoomState(): Promise<void> {
  if (hydrateRetryTimer !== null) {
    window.clearTimeout(hydrateRetryTimer);
    hydrateRetryTimer = null;
  }

  const response = await runtimeSendMessage<{ ok?: boolean; roomState?: RoomState; memberId?: string | null; roomCode?: string | null }>({
    type: "content:get-room-state"
  });
  if (response === null) {
    runtimeState.hydrationReady = true;
    return;
  }
  runtimeState.localMemberId = response?.memberId ?? null;
  runtimeState.activeRoomCode = response?.roomCode ?? runtimeState.activeRoomCode;

  if (response?.ok && response.roomState) {
    debugLog(`Hydrate room state success for ${response.roomState.roomCode}`);
    if (response.roomState.playback?.playState === "paused" || response.roomState.playback?.playState === "buffering") {
      runtimeState.intendedPlayState = response.roomState.playback.playState;
      activatePauseHold(INITIAL_ROOM_STATE_PAUSE_HOLD_MS);
    }
    const video = getVideoElement();
    if (
      video &&
      !video.paused &&
      (response.roomState.playback?.playState === "paused" || response.roomState.playback?.playState === "buffering") &&
      Date.now() - runtimeState.lastUserGestureAt >= USER_GESTURE_GRACE_MS
    ) {
      runtimeState.intendedPlayState = response.roomState.playback.playState;
      debugLog(`Suppressed autoplay during hydrate for ${response.roomState.roomCode}`);
      pauseVideo(video);
    }
    await applyRoomState(response.roomState as RoomState);
    runtimeState.hydrationReady = true;
    return;
  }

  if (!response?.roomCode) {
    runtimeState.pendingRoomStateHydration = false;
  }

  if (!response?.memberId) {
    debugLog("Hydrate skipped without member id");
    runtimeState.hydrationReady = true;
    return;
  }

  debugLog(`Hydrate pending for ${response.roomCode ?? runtimeState.activeRoomCode ?? "unknown-room"}, retry scheduled`);
  scheduleHydrationRetry(1500);
}

async function reportCurrentUser(): Promise<void> {
  try {
    const response = await fetch("https://api.bilibili.com/x/web-interface/nav", {
      credentials: "include"
    });
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

    const nextDisplayName = data.data.uname?.trim() || (data.data.mid ? `UID-${data.data.mid}` : "");
    if (!nextDisplayName) {
      return;
    }

    const reportResponse = await runtimeSendMessage({
      type: "content:report-user",
      payload: { displayName: nextDisplayName }
    });
    if (reportResponse === null) {
      return;
    }
  } catch {
    // Ignore lookup failures and keep guest naming.
  }
}
