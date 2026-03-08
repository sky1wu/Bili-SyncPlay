import type { PlaybackState, RoomState, SharedVideo } from "@bili-syncplay/protocol";
import type { BackgroundToContentMessage } from "../shared/messages";

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

const LOCAL_INTENT_GUARD_MS = 1200;
const PAUSE_HOLD_MS = 1200;
const REMOTE_ECHO_SUPPRESSION_MS = 700;
const REMOTE_PLAY_TRANSITION_GUARD_MS = 1800;
const USER_GESTURE_GRACE_MS = 1200;
const FESTIVAL_SNAPSHOT_TTL_MS = 1200;

void init();

function debugLog(message: string): void {
  void chrome.runtime.sendMessage({
    type: "content:debug-log",
    payload: { message }
  }).catch(() => undefined);
}

async function init(): Promise<void> {
  startUserGestureTracking();
  startPlaybackBinding();
  void reportCurrentUser();

  chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage, _sender, sendResponse) => {
    if (message.type === "background:apply-room-state") {
      void applyRoomState(message.payload);
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
  const attachListeners = () => {
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
        hasRecentRemoteStopIntent(currentVideo.url) &&
        intendedPlayState !== "playing" &&
        Date.now() - lastUserGestureAt >= USER_GESTURE_GRACE_MS
      ) {
        debugLog(`Forced pause hold reapplied after unexpected resume intended=${intendedPlayState}`);
        window.setTimeout(() => {
          video.pause();
        }, 0);
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
      rememberExplicitPlaybackAction("paused");
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
  };

  attachListeners();
  if (videoBindingTimer === null) {
    videoBindingTimer = window.setInterval(attachListeners, 1500);
  }
}

function getVideoElement(): HTMLVideoElement | null {
  return document.querySelector("video");
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
      video.pause();
    }
  }, 0);
  return true;
}

function activatePauseHold(): void {
  pauseHoldUntil = Date.now() + PAUSE_HOLD_MS;
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
  if (Date.now() >= pauseHoldUntil || !suppressedRemotePlayback) {
    return false;
  }
  if (normalizeUrl(currentVideoUrl) !== suppressedRemotePlayback.url) {
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
    lastExplicitPlaybackAction.playState === playState
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
  const title = heading || document.title.split("_")[0]?.trim() || document.title.trim();

  return {
    videoId: fallbackVideoRef.videoId,
    url: pageUrl,
    title
  };
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
      return {
        videoId: cid ? `${bvid}:${cid}` : bvid,
        normalizedUrl: cid ? `https://www.bilibili.com/video/${bvid}?cid=${cid}` : `https://www.bilibili.com/video/${bvid}`
      };
    }

    const pathname = parsed.pathname.replace(/\/+$/, "");
    const match = pathname.match(/^\/(?:video|bangumi\/play)\/([^/?]+)$/);
    if (!match) {
      return null;
    }

    return {
      videoId: match[1],
      normalizedUrl: `${parsed.origin}${pathname}`
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

  lastBroadcastAt = Date.now();
  const playState = getPlayState(video);
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

async function applyRoomState(state: RoomState): Promise<void> {
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
    activatePauseHold();
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

  if (response?.ok && response.roomState) {
    debugLog(`Hydrate room state success for ${response.roomState.roomCode}`);
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
