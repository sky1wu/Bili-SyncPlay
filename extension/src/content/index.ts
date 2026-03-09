import type { PlaybackState, RoomState, SharedVideo } from "@bili-syncplay/protocol";
import type { BackgroundToContentMessage, SharedVideoToastPayload } from "../shared/messages";

let seq = 0;
let lastBroadcastAt = 0;
let localMemberId: string | null = null;
let activeSharedUrl: string | null = null;
let activeRoomCode: string | null = null;
let festivalBridgeReady = false;
let festivalSnapshot:
  | {
      videoId: string;
      url: string;
      title: string;
      updatedAt: number;
    }
  | null = null;
let hydrationReady = false;
let hasReceivedInitialRoomState = false;
let pendingRoomStateHydration = true;
let hydrateRetryTimer: number | null = null;
let videoBindingTimer: number | null = null;
let navigationWatchTimer: number | null = null;
let intendedPlayState: PlaybackState["playState"] = "paused";
let lastLocalIntentAt = 0;
let lastLocalIntentPlayState: PlaybackState["playState"] | null = null;
let lastUserGestureAt = 0;
let lastExplicitPlaybackAction:
  | {
      playState: "playing" | "paused";
      at: number;
    }
  | null = null;
let explicitNonSharedPlaybackUrl: string | null = null;
let pauseHoldUntil = 0;
let pendingPlaybackApplication: PlaybackState | null = null;
let lastAppliedVersionByActor = new Map<string, { serverTime: number; seq: number }>();
let suppressedRemotePlayback:
  | {
      until: number;
      url: string;
      playState: PlaybackState["playState"];
      currentTime: number;
      playbackRate: number;
    }
  | null = null;
let recentRemotePlayingIntent:
  | {
      until: number;
      url: string;
      currentTime: number;
    }
  | null = null;
let lastToastRoomState: RoomState | null = null;
let toastHost: HTMLDivElement | null = null;
let toastContainer: HTMLDivElement | null = null;
let lastSeekToastByActor = new Map<string, number>();
let lastSharedVideoToastKey: string | null = null;

const LOCAL_INTENT_GUARD_MS = 1200;
const PAUSE_HOLD_MS = 1200;
const INITIAL_ROOM_STATE_PAUSE_HOLD_MS = 3000;
const REMOTE_ECHO_SUPPRESSION_MS = 700;
const REMOTE_PLAY_TRANSITION_GUARD_MS = 1800;
const USER_GESTURE_GRACE_MS = 1200;
const FESTIVAL_SNAPSHOT_TTL_MS = 1200;
const NAVIGATION_WATCH_INTERVAL_MS = 400;
const VIDEO_BIND_INTERVAL_MS = 250;
const SEEK_TOAST_THRESHOLD_SECONDS = 1.5;
const SEEK_START_TOAST_SUPPRESSION_MS = 1600;

let lastObservedPageUrl = window.location.href.split("#")[0];

void init();

function debugLog(message: string): void {
  void chrome.runtime.sendMessage({
    type: "content:debug-log",
    payload: { message }
  }).catch(() => undefined);
}

function getToastMountTarget(): HTMLElement | null {
  return (document.fullscreenElement as HTMLElement | null) ?? document.body;
}

function ensureToastContainer(): HTMLDivElement | null {
  const mountTarget = getToastMountTarget();
  if (!mountTarget) {
    return null;
  }

  if (toastContainer?.isConnected && toastHost?.parentElement === mountTarget) {
    return toastContainer;
  }

  if (toastHost?.isConnected) {
    toastHost.remove();
  }

  toastHost = document.createElement("div");
  toastHost.style.position = "fixed";
  toastHost.style.inset = "0";
  toastHost.style.pointerEvents = "none";
  toastHost.style.zIndex = "2147483000";

  const shadowRoot = toastHost.attachShadow({ mode: "open" });
  shadowRoot.innerHTML = `
    <style>
      .toast-stack {
        position: absolute;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        gap: 10px;
        align-items: center;
      }
      .toast {
        max-width: min(520px, calc(100vw - 32px));
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.88);
        color: #f8fafc;
        font: 600 14px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.28);
        border: 1px solid rgba(148, 163, 184, 0.24);
        backdrop-filter: blur(14px);
      }
    </style>
    <div class="toast-stack" id="toast-stack"></div>
  `;

  mountTarget.appendChild(toastHost);
  toastContainer = shadowRoot.getElementById("toast-stack") as HTMLDivElement | null;
  return toastContainer;
}

function showToast(message: string): void {
  const container = ensureToastContainer();
  if (!container) {
    return;
  }

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  container.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 2600);
}

function getMemberName(state: RoomState, memberId: string | null | undefined): string | null {
  if (!memberId) {
    return null;
  }
  return state.members.find((member) => member.id === memberId)?.name ?? null;
}

function formatToastTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatPlaybackRate(rate: number): string {
  const rounded = Math.round(rate * 100) / 100;
  if (Number.isInteger(rounded)) {
    return `${rounded.toFixed(0)}x`;
  }
  return `${rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}x`;
}

function shouldShowSeekToast(previousPlayback: PlaybackState, nextPlayback: PlaybackState): boolean {
  const actualDelta = nextPlayback.currentTime - previousPlayback.currentTime;
  const elapsedSeconds = Math.max(0, nextPlayback.serverTime - previousPlayback.serverTime) / 1000;
  const expectedDelta = elapsedSeconds * previousPlayback.playbackRate;

  if (previousPlayback.playState === "playing" && nextPlayback.playState !== "playing") {
    return Math.abs(actualDelta - expectedDelta) >= SEEK_TOAST_THRESHOLD_SECONDS;
  }

  if (previousPlayback.playState !== "playing" || nextPlayback.playState !== "playing") {
    return Math.abs(actualDelta) >= SEEK_TOAST_THRESHOLD_SECONDS;
  }

  return Math.abs(actualDelta - expectedDelta) >= SEEK_TOAST_THRESHOLD_SECONDS;
}

function notifyRoomStateToasts(state: RoomState): void {
  const previousState = lastToastRoomState;
  lastToastRoomState = state;

  if (!localMemberId || !previousState || previousState.roomCode !== state.roomCode) {
    return;
  }

  const sharedVideoChanged = previousState.sharedVideo?.url !== state.sharedVideo?.url;

  const previousMembers = new Map(previousState.members.map((member) => [member.id, member.name]));
  const currentMembers = new Map(state.members.map((member) => [member.id, member.name]));

  for (const [memberId, memberName] of currentMembers) {
    if (!previousMembers.has(memberId) && memberId !== localMemberId) {
      showToast(`${memberName} 加入了房间`);
    }
  }

  for (const [memberId, memberName] of previousMembers) {
    if (!currentMembers.has(memberId) && memberId !== localMemberId) {
      showToast(`${memberName} 离开了房间`);
    }
  }

  if (sharedVideoChanged) {
    return;
  }

  const shouldShowSeek = Boolean(
    previousState.playback &&
      state.playback &&
      previousState.sharedVideo?.url === state.sharedVideo?.url &&
      state.playback.actorId !== localMemberId &&
      shouldShowSeekToast(previousState.playback, state.playback)
  );

  if (
    previousState.playback?.playState !== state.playback?.playState &&
    state.playback &&
    state.playback.playState !== "buffering" &&
    state.playback.actorId !== localMemberId &&
    !(shouldShowSeek && state.playback.playState === "playing") &&
    !(
      state.playback.playState === "playing" &&
      lastSeekToastByActor.has(state.playback.actorId) &&
      Date.now() - (lastSeekToastByActor.get(state.playback.actorId) ?? 0) < SEEK_START_TOAST_SUPPRESSION_MS
    )
  ) {
    const actorName = getMemberName(state, state.playback.actorId);
    if (actorName) {
      showToast(state.playback.playState === "playing" ? `${actorName} 开始播放` : `${actorName} 暂停了视频`);
    }
  }

  if (
    previousState.playback &&
    state.playback &&
    previousState.sharedVideo?.url === state.sharedVideo?.url &&
    state.playback.actorId !== localMemberId &&
    Math.abs(previousState.playback.playbackRate - state.playback.playbackRate) > 0.01
  ) {
    const actorName = getMemberName(state, state.playback.actorId);
    if (actorName) {
      showToast(`${actorName} 切换到 ${formatPlaybackRate(state.playback.playbackRate)}`);
    }
  }

  if (shouldShowSeek && state.playback) {
    const actorName = getMemberName(state, state.playback.actorId);
    if (actorName) {
      lastSeekToastByActor.set(state.playback.actorId, Date.now());
      showToast(`${actorName} 跳转到 ${formatToastTime(state.playback.currentTime)}`);
    }
  }
}

function maybeShowSharedVideoToast(toast: SharedVideoToastPayload | null | undefined, state: RoomState): void {
  if (!toast || !localMemberId || lastSharedVideoToastKey === toast.key) {
    return;
  }
  if (normalizeUrl(toast.videoUrl) !== normalizeUrl(state.sharedVideo?.url)) {
    return;
  }

  const actorName = getMemberName(state, toast.actorId);
  if (!actorName || toast.actorId === localMemberId) {
    lastSharedVideoToastKey = toast.key;
    return;
  }

  lastSharedVideoToastKey = toast.key;
  showToast(`${actorName} 共享了新视频：${toast.title}`);
}
async function init(): Promise<void> {
  startUserGestureTracking();
  startPlaybackBinding();
  startNavigationWatch();
  document.addEventListener("fullscreenchange", () => {
    toastContainer = null;
    void ensureToastContainer();
  });
  void reportCurrentUser();

  chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage, _sender, sendResponse) => {
    if (message.type === "background:apply-room-state") {
      void applyRoomState(message.payload, message.shareToast ?? null);
      return false;
    }

    if (message.type === "background:sync-status") {
      const previousRoomCode = activeRoomCode;
      activeRoomCode = message.payload.roomCode;
      localMemberId = message.payload.memberId;
      const roomChanged = Boolean(previousRoomCode && message.payload.roomCode && previousRoomCode !== message.payload.roomCode);

      if (roomChanged) {
        hasReceivedInitialRoomState = false;
        pendingRoomStateHydration = true;
      }

      if (message.payload.roomCode && !hasReceivedInitialRoomState) {
        pendingRoomStateHydration = true;
        debugLog(`Waiting for initial room state of ${message.payload.roomCode}`);
        scheduleHydrationRetry(150);
      }

      if (!message.payload.roomCode) {
        pendingRoomStateHydration = false;
        hasReceivedInitialRoomState = false;
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
    lastUserGestureAt = Date.now();
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
  if (!video || (video as HTMLVideoElement & { __biliSyncBound?: boolean }).__biliSyncBound) {
    return;
  }

  (video as HTMLVideoElement & { __biliSyncBound?: boolean }).__biliSyncBound = true;

  const scheduleBroadcast = (followUpMs?: number) => {
    void broadcastPlayback(video);
    if (followUpMs) {
      window.setTimeout(() => {
        void broadcastPlayback(video);
      }, followUpMs);
    }
  };

  const rememberExplicitPlaybackAction = (playState: "playing" | "paused") => {
    if (Date.now() - lastUserGestureAt < USER_GESTURE_GRACE_MS) {
      lastExplicitPlaybackAction = {
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
      intendedPlayState !== "playing" &&
      Date.now() - lastUserGestureAt >= USER_GESTURE_GRACE_MS
    ) {
      debugLog(`Forced pause hold reapplied after unexpected resume intended=${intendedPlayState}`);
      window.setTimeout(() => {
        pauseVideo(video, "unexpected-resume-during-shared-stop-hold");
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

  video.addEventListener("play", () => {
    rememberExplicitPlaybackAction("playing");
    if (!guardUnexpectedResume()) {
      scheduleBroadcast(180);
    }
  });
  video.addEventListener("pause", () => {
    const currentVideo = getSharedVideo();
    rememberExplicitPlaybackAction("paused");
    if (currentVideo && normalizeUrl(currentVideo.url) === explicitNonSharedPlaybackUrl) {
      explicitNonSharedPlaybackUrl = null;
    }
    scheduleBroadcast(120);
  });
  video.addEventListener("waiting", () => scheduleBroadcast());
  video.addEventListener("stalled", () => scheduleBroadcast());
  video.addEventListener("loadedmetadata", () => {
    if (!forcePauseWhileWaitingForInitialRoomState(video)) {
      applyPendingPlaybackApplication(video);
    }
  });
  video.addEventListener("canplay", () => {
    if (!forcePauseWhileWaitingForInitialRoomState(video)) {
      applyPendingPlaybackApplication(video);
    }
    scheduleBroadcast(120);
  });
  video.addEventListener("playing", () => {
    rememberExplicitPlaybackAction("playing");
    if (!guardUnexpectedResume()) {
      scheduleBroadcast(180);
    }
  });
  video.addEventListener("seeking", () => scheduleBroadcast());
  video.addEventListener("seeked", () => scheduleBroadcast(120));
  video.addEventListener("ratechange", () => scheduleBroadcast(120));
  video.addEventListener("timeupdate", () => {
    if (Date.now() - lastBroadcastAt > 2000 && !video.paused) {
      void broadcastPlayback(video);
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
    festivalSnapshot = null;
    pendingPlaybackApplication = null;
    explicitNonSharedPlaybackUrl = null;

    if (!activeRoomCode || !parseBilibiliVideoRef(nextPageUrl)) {
      return;
    }

    hasReceivedInitialRoomState = false;
    pendingRoomStateHydration = true;
    intendedPlayState = "paused";
    activatePauseHold(INITIAL_ROOM_STATE_PAUSE_HOLD_MS);
    debugLog(`Detected in-room navigation to ${nextPageUrl}, waiting for room state`);
    attachPlaybackListeners();
    const video = getVideoElement();
    if (video && !video.paused && Date.now() - lastUserGestureAt >= USER_GESTURE_GRACE_MS) {
      debugLog(`Suppressed autoplay immediately after in-room navigation to ${nextPageUrl}`);
      pauseVideo(video, "in-room-navigation-autoplay");
    }
    void hydrateRoomState();
  };

  handlePotentialNavigation();
  if (navigationWatchTimer === null) {
    navigationWatchTimer = window.setInterval(handlePotentialNavigation, NAVIGATION_WATCH_INTERVAL_MS);
  }
}

function getVideoElement(): HTMLVideoElement | null {
  return document.querySelector("video");
}

function pauseVideo(video: HTMLVideoElement, _reason: string): void {
  video.pause();
}

function forcePauseWhileWaitingForInitialRoomState(video: HTMLVideoElement): boolean {
  if (!activeRoomCode || !pendingRoomStateHydration) {
    return false;
  }
  if (video.paused) {
    return false;
  }
  if (Date.now() - lastUserGestureAt < USER_GESTURE_GRACE_MS) {
    debugLog(`Allowed user-initiated playback while waiting for initial room state of ${activeRoomCode}`);
    return false;
  }

  debugLog(`Suppressed page autoplay while waiting for initial room state of ${activeRoomCode}`);
  intendedPlayState = "paused";
  window.setTimeout(() => {
    if (!video.paused) {
      pauseVideo(video, "waiting-for-initial-room-state");
    }
  }, 0);
  return true;
}

function forcePauseOnNonSharedPage(video: HTMLVideoElement): boolean {
  if (!activeRoomCode || !activeSharedUrl) {
    return false;
  }

  const currentVideo = getSharedVideo();
  const normalizedCurrentUrl = normalizeUrl(currentVideo?.url);
  if (!currentVideo || !normalizedCurrentUrl || normalizedCurrentUrl === activeSharedUrl) {
    explicitNonSharedPlaybackUrl = null;
    return false;
  }

  if (video.paused) {
    return true;
  }

  if (explicitNonSharedPlaybackUrl === normalizedCurrentUrl) {
    return false;
  }

  if (
    lastExplicitPlaybackAction &&
    Date.now() - lastExplicitPlaybackAction.at < USER_GESTURE_GRACE_MS &&
    lastExplicitPlaybackAction.playState === "playing"
  ) {
    explicitNonSharedPlaybackUrl = normalizedCurrentUrl;
    return false;
  }

  intendedPlayState = "paused";
  activatePauseHold(INITIAL_ROOM_STATE_PAUSE_HOLD_MS);
  window.setTimeout(() => {
    if (!video.paused) {
      pauseVideo(video, "non-shared-page-autoplay");
    }
  }, 0);
  return true;
}

function isCurrentVideoShared(currentVideo: SharedVideo | null): boolean {
  if (!currentVideo || !activeSharedUrl) {
    return false;
  }
  return normalizeUrl(currentVideo.url) === activeSharedUrl;
}

function activatePauseHold(durationMs = PAUSE_HOLD_MS): void {
  pauseHoldUntil = Date.now() + durationMs;
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

function canApplyPlaybackImmediately(video: HTMLVideoElement): boolean {
  return Number.isFinite(video.duration) && video.readyState >= 1;
}

function applyPendingPlaybackApplication(video: HTMLVideoElement): void {
  if (!pendingPlaybackApplication || !canApplyPlaybackImmediately(video)) {
    return;
  }

  const playback = pendingPlaybackApplication;
  pendingPlaybackApplication = null;

  syncPlaybackPosition(video, playback.currentTime, playback.playState, playback.playbackRate);
  if (playback.playState === "playing") {
    void video.play().catch(() => {
      debugLog(`Skipped delayed play() after seek ${playback.url} t=${playback.currentTime.toFixed(2)} seq=${playback.seq}`);
    });
    return;
  }

  if (!video.paused) {
    video.pause();
  }
}

function hasRecentRemoteStopIntent(currentVideoUrl: string): boolean {
  if (Date.now() >= pauseHoldUntil) {
    return false;
  }
  const normalizedCurrentUrl = normalizeUrl(currentVideoUrl);
  if (!normalizedCurrentUrl) {
    return false;
  }
  if (activeSharedUrl && normalizedCurrentUrl !== activeSharedUrl) {
    return false;
  }
  if (intendedPlayState === "paused" || intendedPlayState === "buffering") {
    return true;
  }
  if (!suppressedRemotePlayback || normalizedCurrentUrl !== suppressedRemotePlayback.url) {
    return false;
  }
  return suppressedRemotePlayback.playState === "paused" || suppressedRemotePlayback.playState === "buffering";
}

function rememberRemotePlaybackForSuppression(playback: PlaybackState): void {
  const url = normalizeUrl(playback.url);
  if (!url) {
    suppressedRemotePlayback = null;
    recentRemotePlayingIntent = null;
    return;
  }

  suppressedRemotePlayback = {
    until: Date.now() + REMOTE_ECHO_SUPPRESSION_MS,
    url,
    playState: playback.playState,
    currentTime: playback.currentTime,
    playbackRate: playback.playbackRate
  };
  debugLog(
    `Remember remote echo ${playback.playState} ${url} t=${playback.currentTime.toFixed(2)} rate=${playback.playbackRate.toFixed(2)}`
  );

  if (playback.playState === "playing") {
    recentRemotePlayingIntent = {
      until: Date.now() + REMOTE_PLAY_TRANSITION_GUARD_MS,
      url,
      currentTime: playback.currentTime
    };
    return;
  }

  recentRemotePlayingIntent = null;
}

function shouldSuppressLocalEcho(
  video: HTMLVideoElement,
  currentVideo: SharedVideo,
  playState: PlaybackState["playState"]
): boolean {
  if (!suppressedRemotePlayback || Date.now() >= suppressedRemotePlayback.until) {
    if (suppressedRemotePlayback) {
      debugLog(`Remote echo window expired for ${suppressedRemotePlayback.playState} ${suppressedRemotePlayback.url}`);
    }
    suppressedRemotePlayback = null;
    return false;
  }

  if (normalizeUrl(currentVideo.url) !== suppressedRemotePlayback.url) {
    debugLog(`Remote echo skipped by url ${currentVideo.url} != ${suppressedRemotePlayback.url}`);
    return false;
  }

  if (playState !== suppressedRemotePlayback.playState) {
    debugLog(`Remote echo skipped by playState ${playState} != ${suppressedRemotePlayback.playState}`);
    return false;
  }

  if (Math.abs(video.playbackRate - suppressedRemotePlayback.playbackRate) > 0.01) {
    debugLog(
      `Remote echo skipped by rate ${video.playbackRate.toFixed(2)} != ${suppressedRemotePlayback.playbackRate.toFixed(2)}`
    );
    return false;
  }

  const delta = Math.abs(video.currentTime - suppressedRemotePlayback.currentTime);
  const threshold = playState === "playing" ? 0.9 : 0.2;
  const shouldSuppress = delta <= threshold;
  debugLog(
    `${shouldSuppress ? "Suppressed" : "Allowed"} local echo ${playState} ${currentVideo.url} delta=${delta.toFixed(2)} threshold=${threshold.toFixed(2)}`
  );
  return shouldSuppress;
}

function shouldSuppressRemotePlayTransition(
  currentVideo: SharedVideo,
  playState: PlaybackState["playState"],
  currentTime: number
): boolean {
  if (!recentRemotePlayingIntent || Date.now() >= recentRemotePlayingIntent.until) {
    recentRemotePlayingIntent = null;
    return false;
  }

  if (normalizeUrl(currentVideo.url) !== recentRemotePlayingIntent.url || playState === "playing") {
    return false;
  }
  if (
    lastExplicitPlaybackAction &&
    Date.now() - lastExplicitPlaybackAction.at < USER_GESTURE_GRACE_MS &&
    lastExplicitPlaybackAction.playState === "paused" &&
    playState === "paused"
  ) {
    debugLog(`Allowed remote play transition echo by explicit action ${playState} ${currentVideo.url}`);
    return false;
  }

  const delta = Math.abs(currentTime - recentRemotePlayingIntent.currentTime);
  const shouldSuppress = delta <= 1.5;
  if (shouldSuppress) {
    debugLog(`Suppressed remote play transition echo ${playState} ${currentVideo.url} delta=${delta.toFixed(2)}`);
  }
  return shouldSuppress;
}

function getSharedVideo(): SharedVideo | null {
  if (window.location.pathname.startsWith("/festival/") && festivalSnapshot) {
    return {
      videoId: festivalSnapshot.videoId,
      url: festivalSnapshot.url,
      title: festivalSnapshot.title
    };
  }

  const pageUrl = window.location.href.split("#")[0];
  const fallbackVideoRef = parseBilibiliVideoRef(pageUrl);

  if (!fallbackVideoRef) {
    return null;
  }

  const heading = document.querySelector("h1")?.textContent?.trim();
  const currentPartTitle = getCurrentPartTitle();
  const title = currentPartTitle || heading || document.title.split("_")[0]?.trim() || document.title.trim();

  return {
    videoId: fallbackVideoRef.videoId,
    url: pageUrl,
    title
  };
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
  if (!video) {
    return { video: sharedVideo, playback: null };
  }

  return {
    video: sharedVideo,
    playback: {
      url: sharedVideo.url,
      currentTime: video.currentTime,
      playState: getPlayState(video),
      playbackRate: video.playbackRate,
      updatedAt: Date.now(),
      serverTime: 0,
      actorId: localMemberId ?? "local",
      seq: seq++
    }
  };
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
  if (!window.location.pathname.startsWith("/festival/")) {
    festivalSnapshot = null;
    return null;
  }

  if (festivalSnapshot && Date.now() - festivalSnapshot.updatedAt < maxAgeMs) {
    return {
      videoId: festivalSnapshot.videoId,
      url: festivalSnapshot.url,
      title: festivalSnapshot.title
    };
  }

  const nextSnapshot = await readFestivalSnapshotFromPageContext();
  if (!nextSnapshot) {
    return festivalSnapshot
      ? {
          videoId: festivalSnapshot.videoId,
          url: festivalSnapshot.url,
          title: festivalSnapshot.title
        }
      : null;
  }

  festivalSnapshot = {
    ...nextSnapshot,
    updatedAt: Date.now()
  };
  debugLog(`Festival video detected id=${nextSnapshot.videoId} title=${nextSnapshot.title} url=${nextSnapshot.url}`);
  return nextSnapshot;
}

function parseBilibiliVideoRef(url: string | undefined | null): { videoId: string; normalizedUrl: string } | null {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    const bvid = parsed.searchParams.get("bvid");
    if (bvid) {
      const cid = parsed.searchParams.get("cid");
      const p = parsed.searchParams.get("p");
      return {
        videoId: cid ? `${bvid}:${cid}` : p ? `${bvid}:p${p}` : bvid,
        normalizedUrl: cid
          ? `https://www.bilibili.com/video/${bvid}?cid=${cid}`
          : p
            ? `https://www.bilibili.com/video/${bvid}?p=${p}`
            : `https://www.bilibili.com/video/${bvid}`
      };
    }

    const pathname = parsed.pathname.replace(/\/+$/, "");
    const match = pathname.match(/^\/(?:video|bangumi\/play)\/([^/?]+)$/);
    if (!match) {
      if (pathname === "/list/watchlater" || pathname === "/medialist/play/watchlater") {
        return null;
      }
      return null;
    }

    return {
      videoId: parsed.searchParams.get("p") ? `${match[1]}:p${parsed.searchParams.get("p")}` : match[1],
      normalizedUrl: parsed.searchParams.get("p")
        ? `${parsed.origin}${pathname}?p=${parsed.searchParams.get("p")}`
        : `${parsed.origin}${pathname}`
    };
  } catch {
    return null;
  }
}

function buildFestivalShareUrl(pageUrl: string, bvid: string, cid: string): string {
  const parsed = new URL(pageUrl);
  parsed.searchParams.set("bvid", bvid);
  parsed.searchParams.set("cid", cid);
  parsed.hash = "";
  return parsed.toString();
}

async function readFestivalSnapshotFromPageContext(): Promise<SharedVideo | null> {
  ensureFestivalBridge();
  const requestId = `bili-syncplay-festival-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return await new Promise<SharedVideo | null>((resolve) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, 800);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", onSnapshot as EventListener);
    };

    const onSnapshot = (event: Event) => {
      const messageEvent = event as MessageEvent<{
        type?: string;
        requestId?: string;
        detail?: {
          bvid?: string;
          cid?: string | number;
          title?: string;
        };
      }>;
      if (messageEvent.source !== window) {
        return;
      }
      if (messageEvent.data?.type !== "bili-syncplay:festival-video" || messageEvent.data.requestId !== requestId) {
        return;
      }
      const detail = messageEvent.data.detail;
      cleanup();

      if (!detail?.bvid || detail.cid === undefined || !detail.title) {
        resolve(null);
        return;
      }

      const pageUrl = window.location.href.split("#")[0];
      resolve({
        videoId: `${detail.bvid}:${detail.cid}`,
        url: buildFestivalShareUrl(pageUrl, detail.bvid, String(detail.cid)),
        title: detail.title.trim()
      });
    };

    window.addEventListener("message", onSnapshot as EventListener);
    window.postMessage({ type: "bili-syncplay:get-festival-video", requestId }, "*");
  });
}

function ensureFestivalBridge(): void {
  if (festivalBridgeReady) {
    return;
  }

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-bridge.js");
  script.async = false;
  script.dataset.biliSyncplayBridge = "true";
  (document.head || document.documentElement).appendChild(script);
  festivalBridgeReady = true;
}

function normalizeUrl(url: string | undefined | null): string | null {
  return parseBilibiliVideoRef(url)?.normalizedUrl ?? null;
}

function shouldApplySelfPlayback(video: HTMLVideoElement, playback: PlaybackState): boolean {
  const timeDelta = Math.abs(video.currentTime - playback.currentTime);
  const rateDelta = Math.abs(video.playbackRate - playback.playbackRate);

  if ((playback.playState === "paused" || playback.playState === "buffering") && !video.paused) {
    return true;
  }
  if (playback.playState === "playing" && video.paused) {
    return true;
  }
  if (timeDelta > 0.6 || rateDelta > 0.01) {
    return true;
  }
  return false;
}

async function broadcastPlayback(video: HTMLVideoElement): Promise<void> {
  if (!hydrationReady) {
    debugLog("Skip broadcast before hydration ready");
    return;
  }
  if (pendingRoomStateHydration) {
    if (Date.now() - lastUserGestureAt < USER_GESTURE_GRACE_MS) {
      debugLog(`Allowed user-initiated broadcast while waiting for initial room state of ${activeRoomCode ?? "unknown-room"}`);
    } else {
      debugLog(`Skip broadcast while waiting for initial room state of ${activeRoomCode ?? "unknown-room"}`);
      return;
    }
  }

  const currentVideo = getSharedVideo();
  if (!currentVideo) {
    return;
  }
  const normalizedCurrentVideoUrl = normalizeUrl(currentVideo.url);
  if (activeRoomCode && activeSharedUrl && normalizedCurrentVideoUrl !== activeSharedUrl) {
    if (
      getPlayState(video) === "playing" &&
      explicitNonSharedPlaybackUrl !== normalizedCurrentVideoUrl &&
      !(
        lastExplicitPlaybackAction &&
        Date.now() - lastExplicitPlaybackAction.at < USER_GESTURE_GRACE_MS &&
        lastExplicitPlaybackAction.playState === "playing"
      )
    ) {
      intendedPlayState = "paused";
      activatePauseHold(INITIAL_ROOM_STATE_PAUSE_HOLD_MS);
      window.setTimeout(() => {
        if (!video.paused) {
          pauseVideo(video, "non-shared-page-broadcast-guard");
        }
      }, 0);
    }
    return;
  }

  lastBroadcastAt = Date.now();
  const playState = getPlayState(video);
  if (
    playState === "playing" &&
    hasRecentRemoteStopIntent(currentVideo.url) &&
    Date.now() - lastUserGestureAt >= USER_GESTURE_GRACE_MS
  ) {
    debugLog(`Skip playing broadcast during remote stop hold ${currentVideo.url}`);
    intendedPlayState = "paused";
    window.setTimeout(() => {
      if (!video.paused) {
        pauseVideo(video, "shared-stop-hold-broadcast-guard");
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

  intendedPlayState = playState;
  lastLocalIntentAt = Date.now();
  lastLocalIntentPlayState = playState;

  const payload: PlaybackState = {
    url: currentVideo.url,
    currentTime: video.currentTime,
    playState,
    playbackRate: video.playbackRate,
    updatedAt: Date.now(),
    serverTime: 0,
    actorId: localMemberId ?? "local",
    seq: seq++
  };

  await chrome.runtime.sendMessage({
    type: "content:playback-update",
    payload
  });
  debugLog(`Broadcast playback ${playState} ${currentVideo.url} t=${payload.currentTime.toFixed(2)} seq=${payload.seq}`);
}

async function applyRoomState(state: RoomState, shareToast: SharedVideoToastPayload | null = null): Promise<void> {
  notifyRoomStateToasts(state);
  maybeShowSharedVideoToast(shareToast, state);

  const currentVideo = getSharedVideo();
  if (!state.sharedVideo || !state.playback || !currentVideo) {
    return;
  }

  const normalizedSharedUrl = normalizeUrl(state.sharedVideo.url);
  const normalizedCurrentUrl = normalizeUrl(currentVideo.url);
  const normalizedPlaybackUrl = normalizeUrl(state.playback.url);

  if (activeSharedUrl !== normalizedSharedUrl) {
    activeSharedUrl = normalizedSharedUrl;
    lastAppliedVersionByActor.clear();
    suppressedRemotePlayback = null;
    recentRemotePlayingIntent = null;
    intendedPlayState = "paused";
    debugLog(`Reset local sync state for shared url ${state.sharedVideo.url}`);
  }

  if (!normalizedSharedUrl || normalizedCurrentUrl !== normalizedSharedUrl || normalizedPlaybackUrl !== normalizedSharedUrl) {
    debugLog(`Ignored room state for ${state.sharedVideo.url} on current page ${currentVideo.url}`);
    if (pendingRoomStateHydration) {
      hasReceivedInitialRoomState = true;
      pendingRoomStateHydration = false;
      intendedPlayState = "paused";
      activatePauseHold(INITIAL_ROOM_STATE_PAUSE_HOLD_MS);
      const video = getVideoElement();
      if (video && !video.paused && explicitNonSharedPlaybackUrl !== normalizedCurrentUrl) {
        pauseVideo(video, "non-shared-page-room-state");
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

  if (
    lastLocalIntentPlayState &&
    Date.now() - lastLocalIntentAt < LOCAL_INTENT_GUARD_MS &&
    (lastLocalIntentPlayState === "paused" || lastLocalIntentPlayState === "buffering") &&
    state.playback.playState === "playing"
  ) {
    debugLog(
      `Ignored conflicting remote playback ${state.playback.playState} during local ${lastLocalIntentPlayState} guard actor=${state.playback.actorId} seq=${state.playback.seq}`
    );
    return;
  }

  const lastApplied = lastAppliedVersionByActor.get(state.playback.actorId);
  if (
    lastApplied &&
    (state.playback.serverTime < lastApplied.serverTime ||
      (state.playback.serverTime === lastApplied.serverTime && state.playback.seq <= lastApplied.seq))
  ) {
    debugLog(`Ignored stale playback actor=${state.playback.actorId} seq=${state.playback.seq}`);
    return;
  }

  const isSelfPlayback = localMemberId && state.playback.actorId === localMemberId;
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
    activatePauseHold(pendingRoomStateHydration || !hasReceivedInitialRoomState ? INITIAL_ROOM_STATE_PAUSE_HOLD_MS : PAUSE_HOLD_MS);
  }

  intendedPlayState = state.playback.playState;
  debugLog(
    `Apply playback ${state.playback.playState} ${state.sharedVideo.url} t=${state.playback.currentTime.toFixed(2)} seq=${state.playback.seq} actor=${state.playback.actorId}`
  );

  pendingPlaybackApplication = { ...state.playback };
  if (canApplyPlaybackImmediately(video)) {
    applyPendingPlaybackApplication(video);
  } else {
    debugLog(`Deferred playback apply until metadata is ready ${state.sharedVideo.url}`);
  }

  pendingRoomStateHydration = false;
  hasReceivedInitialRoomState = true;
}

async function hydrateRoomState(): Promise<void> {
  if (hydrateRetryTimer !== null) {
    window.clearTimeout(hydrateRetryTimer);
    hydrateRetryTimer = null;
  }

  const response = await chrome.runtime.sendMessage({ type: "content:get-room-state" });
  localMemberId = response?.memberId ?? null;
  activeRoomCode = response?.roomCode ?? activeRoomCode;

  if (response?.ok && response.roomState) {
    debugLog(`Hydrate room state success for ${response.roomState.roomCode}`);
    if (response.roomState.playback?.playState === "paused" || response.roomState.playback?.playState === "buffering") {
      intendedPlayState = response.roomState.playback.playState;
      activatePauseHold(INITIAL_ROOM_STATE_PAUSE_HOLD_MS);
    }
    const video = getVideoElement();
    if (
      video &&
      !video.paused &&
      (response.roomState.playback?.playState === "paused" || response.roomState.playback?.playState === "buffering") &&
      Date.now() - lastUserGestureAt >= USER_GESTURE_GRACE_MS
    ) {
      intendedPlayState = response.roomState.playback.playState;
      debugLog(`Suppressed autoplay during hydrate for ${response.roomState.roomCode}`);
      pauseVideo(video, "hydrate-room-state");
    }
    await applyRoomState(response.roomState as RoomState);
    hydrationReady = true;
    return;
  }

  if (!response?.roomCode) {
    pendingRoomStateHydration = false;
  }

  if (!response?.memberId) {
    debugLog("Hydrate skipped without member id");
    hydrationReady = true;
    return;
  }

  debugLog(`Hydrate pending for ${response.roomCode ?? activeRoomCode ?? "unknown-room"}, retry scheduled`);
  scheduleHydrationRetry(1500);
}

function syncPlaybackPosition(
  video: HTMLVideoElement,
  targetTime: number,
  playState: PlaybackState["playState"],
  playbackRate: number
): void {
  const delta = Math.abs(targetTime - video.currentTime);

  if (playState !== "playing") {
    if (delta > 0.15) {
      video.currentTime = targetTime;
    }
    if (Math.abs(video.playbackRate - playbackRate) > 0.01) {
      video.playbackRate = playbackRate;
    }
    return;
  }

  if (delta > 0.15) {
    video.currentTime = targetTime;
  }
  if (Math.abs(video.playbackRate - playbackRate) > 0.01) {
    video.playbackRate = playbackRate;
  }
}

function getPlayState(video: HTMLVideoElement): PlaybackState["playState"] {
  if (!video.paused && video.readyState < 3) {
    return "buffering";
  }
  if (video.paused) {
    return intendedPlayState === "buffering" ? "buffering" : "paused";
  }
  return "playing";
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

    await chrome.runtime.sendMessage({
      type: "content:report-user",
      payload: { displayName: nextDisplayName }
    });
  } catch {
    // Ignore lookup failures and keep guest naming.
  }
}
