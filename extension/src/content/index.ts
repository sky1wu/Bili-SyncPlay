import type { PlaybackState, RoomState, SharedVideo } from "@bili-syncplay/protocol";
import type { BackgroundToContentMessage } from "../shared/messages";

let seq = 0;
let lastBroadcastAt = 0;
let localMemberId: string | null = null;
let lastAppliedVersionByActor = new Map<string, { serverTime: number; seq: number }>();
let correctionTimer: number | null = null;
let lastRemoteRate = 1;
let intendedPlayState: "playing" | "paused" | "buffering" = "paused";
let shareStylesInjected = false;
let activeSharedUrl: string | null = null;
let hydrationReady = false;
let pendingRoomCodeCopy = false;
let lastLocalIntentAt = 0;
let lastLocalIntentPlayState: PlaybackState["playState"] | null = null;
const LOCAL_INTENT_GUARD_MS = 1200;
let pendingRoomStateHydration = false;
let activeRoomCode: string | null = null;
let pauseHoldUntil = 0;
const PAUSE_HOLD_MS = 450;
const REMOTE_ECHO_SUPPRESSION_MS = 700;
const REMOTE_PLAY_TRANSITION_GUARD_MS = 900;
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

init().catch(console.error);

function debugLog(message: string): void {
  void chrome.runtime.sendMessage({
    type: "content:debug-log",
    payload: { message }
  }).catch(() => undefined);
}

async function handleAutoCopiedRoomCode(roomCode: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(roomCode);
    showPageToast(`已创建房间，房间码已复制：${roomCode}`);
    debugLog(`Auto copied room code ${roomCode}`);
  } catch {
    showPageToast(`已创建房间，房间码：${roomCode}`);
    debugLog(`Room created but clipboard copy failed for ${roomCode}`);
  }
}

function showPageToast(message: string): void {
  const existing = document.getElementById("bili-syncplay-toast");
  existing?.remove();

  const toast = document.createElement("div");
  toast.id = "bili-syncplay-toast";
  toast.textContent = message;
  const toolbar = document.querySelector(".video-toolbar-left-main");
  const toolbarRect = toolbar?.getBoundingClientRect();
  const bottomOffset = toolbarRect ? Math.max(40, window.innerHeight - toolbarRect.top + 18) : 96;
  Object.assign(toast.style, {
    position: "fixed",
    bottom: `${bottomOffset}px`,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: "1000000",
    maxWidth: "360px",
    padding: "12px 16px",
    borderRadius: "999px",
    background: "rgba(23, 32, 51, 0.92)",
    color: "#fff",
    fontSize: "13px",
    fontWeight: "700",
    lineHeight: "1.5",
    boxShadow: "0 16px 36px rgba(0, 0, 0, 0.24)",
    backdropFilter: "blur(8px)",
    textAlign: "center",
    pointerEvents: "none"
  });

  document.body.appendChild(toast);
  window.setTimeout(() => {
    toast.remove();
  }, 2600);
}

async function init(): Promise<void> {
  injectShareButton();
  void reportCurrentUser();
  chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage) => {
    if (message.type === "background:apply-room-state") {
      void applyRoomState(message.payload);
    } else if (message.type === "background:sync-status") {
      const previousRoomCode = activeRoomCode;
      activeRoomCode = message.payload.roomCode;
      localMemberId = message.payload.memberId;
      if (message.payload.roomCode && message.payload.roomCode !== previousRoomCode) {
        pendingRoomStateHydration = true;
        debugLog(`Waiting for initial room state of ${message.payload.roomCode}`);
      }
      if (!message.payload.roomCode) {
        pendingRoomStateHydration = false;
      }
      if (pendingRoomCodeCopy && message.payload.roomCode) {
        pendingRoomCodeCopy = false;
        void handleAutoCopiedRoomCode(message.payload.roomCode);
      }
    }
  });

  await hydrateRoomState();
}

function getVideoElement(): HTMLVideoElement | null {
  return document.querySelector("video");
}

function activatePauseHold(): void {
  pauseHoldUntil = Date.now() + PAUSE_HOLD_MS;
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
  } else {
    recentRemotePlayingIntent = null;
  }
}

function shouldSuppressLocalEcho(video: HTMLVideoElement, currentVideo: SharedVideo, playState: PlaybackState["playState"]): boolean {
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
  const timeThreshold = playState === "playing" ? 0.9 : 0.2;
  const shouldSuppress = delta <= timeThreshold;
  debugLog(
    `${shouldSuppress ? "Suppressed" : "Allowed"} local echo ${playState} ${currentVideo.url} delta=${delta.toFixed(2)} threshold=${timeThreshold.toFixed(2)}`
  );
  return shouldSuppress;
}

function shouldSuppressRemotePlayTransition(currentVideo: SharedVideo, playState: PlaybackState["playState"], currentTime: number): boolean {
  if (!recentRemotePlayingIntent || Date.now() >= recentRemotePlayingIntent.until) {
    recentRemotePlayingIntent = null;
    return false;
  }

  if (normalizeUrl(currentVideo.url) !== recentRemotePlayingIntent.url) {
    return false;
  }

  if (playState === "playing") {
    return false;
  }

  const delta = Math.abs(currentTime - recentRemotePlayingIntent.currentTime);
  const shouldSuppress = delta <= 1.5;
  if (shouldSuppress) {
    debugLog(
      `Suppressed remote play transition echo ${playState} ${currentVideo.url} delta=${delta.toFixed(2)}`
    );
  }
  return shouldSuppress;
}

function injectShareButton(): void {
  injectShareButtonStyles();
  injectToolbarShareButton();
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

    const guardUnexpectedResume = () => {
      const currentVideo = getSharedVideo();
      if (
        currentVideo &&
        hasRecentRemoteStopIntent(currentVideo.url) &&
        intendedPlayState !== "playing"
      ) {
        debugLog(`Forced pause hold reapplied after unexpected resume intended=${intendedPlayState}`);
        window.setTimeout(() => {
          video.pause();
        }, 0);
        return true;
      }
      return false;
    };

    video.addEventListener("play", () => {
      if (guardUnexpectedResume()) {
        return;
      }
      scheduleBroadcast(180);
    });
    video.addEventListener("pause", () => {
      scheduleBroadcast(120);
    });
    video.addEventListener("waiting", () => scheduleBroadcast());
    video.addEventListener("stalled", () => scheduleBroadcast());
    video.addEventListener("canplay", () => scheduleBroadcast(120));
    video.addEventListener("playing", () => {
      if (guardUnexpectedResume()) {
        return;
      }
      scheduleBroadcast(180);
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
  const observer = new MutationObserver(() => {
    injectToolbarShareButton();
    attachListeners();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function injectShareButtonStyles(): void {
  if (shareStylesInjected || document.getElementById("bili-syncplay-share-style")) {
    shareStylesInjected = true;
    return;
  }

  const style = document.createElement("style");
  style.id = "bili-syncplay-share-style";
  style.textContent = `
    #bili-syncplay-share-entry .bili-syncplay-share-button {
      border: 0;
      padding: 0;
      margin: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
      display: flex;
      align-items: center;
      line-height: 28px;
      appearance: none;
      -webkit-appearance: none;
    }

    #bili-syncplay-share-entry .bili-syncplay-share-button,
    #bili-syncplay-share-entry .bili-syncplay-share-button .video-toolbar-item-icon,
    #bili-syncplay-share-entry .bili-syncplay-share-button .video-toolbar-item-text {
      transition: color 0.2s ease, transform 0.2s ease, opacity 0.2s ease, filter 0.2s ease;
    }

    #bili-syncplay-share-entry .bili-syncplay-share-button:hover,
    #bili-syncplay-share-entry .bili-syncplay-share-button:hover .video-toolbar-item-icon,
    #bili-syncplay-share-entry .bili-syncplay-share-button:hover .video-toolbar-item-text {
      color: var(--brand_pink, #fb7299);
    }

    #bili-syncplay-share-entry .bili-syncplay-share-button:hover .bili-syncplay-share-icon {
      transform: translateY(-1px) scale(1.04);
      filter: drop-shadow(0 4px 10px rgba(251, 114, 153, 0.22));
    }

    #bili-syncplay-share-entry .bili-syncplay-share-button:active .bili-syncplay-share-icon {
      transform: scale(0.96);
    }

    #bili-syncplay-share-entry .bili-syncplay-share-button:focus-visible {
      outline: none;
    }

    #bili-syncplay-share-entry .bili-syncplay-share-button:focus-visible .bili-syncplay-share-icon {
      filter: drop-shadow(0 0 0 rgba(251, 114, 153, 0.35));
    }

    #bili-syncplay-share-entry .bili-syncplay-share-icon {
      width: 28px;
      height: 28px;
      color: currentColor;
      transform-origin: center;
      flex: 0 0 auto;
    }

    #bili-syncplay-share-entry .bili-syncplay-share-icon path,
    #bili-syncplay-share-entry .bili-syncplay-share-icon circle {
      vector-effect: non-scaling-stroke;
    }

    #bili-syncplay-share-entry .bili-syncplay-share-text {
      margin-left: 2px;
    }

    #bili-syncplay-share-floating {
      transition: transform 0.2s ease, box-shadow 0.2s ease, filter 0.2s ease;
    }

    #bili-syncplay-share-floating:hover {
      transform: translateY(-1px);
      box-shadow: 0 18px 40px rgba(255, 107, 154, 0.32);
      filter: saturate(1.05);
    }

    #bili-syncplay-share-floating:active {
      transform: translateY(0) scale(0.98);
    }
  `;

  document.head.appendChild(style);
  shareStylesInjected = true;
}

function injectToolbarShareButton(): void {
  const toolbar = document.querySelector(".video-toolbar-left-main");
  const existing = document.getElementById("bili-syncplay-share-entry");

  if (!toolbar) {
    if (!document.getElementById("bili-syncplay-share-floating")) {
      injectFloatingFallbackButton();
    }
    return;
  }

  document.getElementById("bili-syncplay-share-floating")?.remove();
  if (existing) {
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.id = "bili-syncplay-share-entry";
  wrapper.className = "toolbar-left-item-wrap";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "video-toolbar-left-item bili-syncplay-share-button";
  button.setAttribute("aria-label", "同步播放");

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 28 28");
  icon.setAttribute("aria-hidden", "true");
  icon.classList.add("video-toolbar-item-icon", "bili-syncplay-share-icon");
  icon.innerHTML = `
    <path
      d="M13.2 6.4C9.56 6.4 6.6 9.33 6.6 12.96V13.54"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    ></path>
    <path
      d="M8.85 16.15L6.6 13.54L4.35 16.15"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    ></path>
    <path
      d="M14.8 21.6C18.44 21.6 21.4 18.67 21.4 15.04V14.46"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    ></path>
    <path
      d="M19.15 11.85L21.4 14.46L23.65 11.85"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    ></path>
    <path
      d="M11.5 10.35V17.65L17.6 14L11.5 10.35Z"
      fill="currentColor"
    ></path>
  `;

  const text = document.createElement("span");
  text.className = "video-toolbar-item-text bili-syncplay-share-text";
  text.textContent = "同步播放";

  button.append(icon, text);
  button.addEventListener("click", () => {
    void shareCurrentVideo();
  });
  wrapper.appendChild(button);

  const shareWrap = toolbar.querySelector(".video-share-wrap");
  if (shareWrap?.parentElement) {
    shareWrap.parentElement.insertAdjacentElement("afterend", wrapper);
    return;
  }

  toolbar.appendChild(wrapper);
}

function injectFloatingFallbackButton(): void {
  if (document.getElementById("bili-syncplay-share-floating")) {
    return;
  }

  const button = document.createElement("button");
  button.id = "bili-syncplay-share-floating";
  button.textContent = "同步播放";
  Object.assign(button.style, {
    position: "fixed",
    right: "24px",
    bottom: "24px",
    zIndex: "999999",
    border: "none",
    borderRadius: "999px",
    padding: "12px 18px",
    background: "linear-gradient(135deg, #ff6b9a, #ff8b5c)",
    color: "#fff",
    fontWeight: "700",
    boxShadow: "0 14px 36px rgba(255,107,154,0.28)",
    cursor: "pointer"
  });
  button.addEventListener("click", () => {
    void shareCurrentVideo();
  });
  document.body.appendChild(button);
}

async function shareCurrentVideo(): Promise<void> {
  const currentVideo = getSharedVideo();
  if (!currentVideo) {
    return;
  }
  const payload = createSharePayload(currentVideo);

  const context = await chrome.runtime.sendMessage({
    type: "content:get-share-context"
  }) as {
    ok: boolean;
    roomCode: string | null;
    connected: boolean;
    roomState: RoomState | null;
  };

  if (!context.roomCode) {
    debugLog(`Share requested without room for ${currentVideo.url}`);
    const shouldCreateRoom = window.confirm("当前还未加入房间。是否立即创建房间，并将这个视频设为当前同步视频？");
    if (!shouldCreateRoom) {
      return;
    }

    pendingRoomCodeCopy = true;
    await chrome.runtime.sendMessage({
      type: "content:create-room-and-share",
      payload
    });
    return;
  }

  const existingSharedVideo = context.roomState?.sharedVideo;
  if (existingSharedVideo && normalizeUrl(existingSharedVideo.url) !== normalizeUrl(currentVideo.url)) {
    debugLog(`Replacing shared video ${existingSharedVideo.url} -> ${currentVideo.url}`);
    const shouldReplaceVideo = window.confirm(
      `当前房间正在同步《${existingSharedVideo.title}》。\n是否替换为《${payload.title}》？`
    );
    if (!shouldReplaceVideo) {
      return;
    }
  }

  await chrome.runtime.sendMessage({
    type: "content:share-video",
    payload
  });
  debugLog(`Shared current video ${currentVideo.url}`);
}

function getSharedVideo(): SharedVideo | null {
  const rawUrl = window.location.href.split("?")[0];
  const url = normalizeUrl(rawUrl);
  if (!url) {
    return null;
  }
  const match = url.match(/\/video\/([^/?]+)/);
  if (!match) {
    return null;
  }

  const heading = document.querySelector("h1")?.textContent?.trim();
  const title = heading || document.title.split("_")[0]?.trim() || document.title.trim();

  return {
    videoId: match[1],
    url,
    title
  };
}

function createSharePayload(sharedVideo: SharedVideo): { video: SharedVideo; playback: PlaybackState | null } {
  const video = getVideoElement();
  if (!video) {
    return {
      video: sharedVideo,
      playback: null
    };
  }

  const playState = getPlayState(video);
  return {
    video: sharedVideo,
    playback: {
      url: sharedVideo.url,
      currentTime: video.currentTime,
      playState,
      playbackRate: video.playbackRate,
      updatedAt: Date.now(),
      serverTime: 0,
      actorId: localMemberId ?? "local",
      seq: seq++
    }
  };
}

function normalizeUrl(url: string | undefined | null): string | null {
  if (!url) {
    return null;
  }
  return url.split("?")[0].replace(/\/+$/, "");
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
  if (timeDelta > 0.6) {
    return true;
  }
  if (rateDelta > 0.01) {
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
    debugLog(`Skip broadcast while waiting for initial room state of ${activeRoomCode ?? "unknown-room"}`);
    return;
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
  pendingRoomStateHydration = false;

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
    const video = getVideoElement();
    if (video) {
      stopCorrection(video);
    }
  }

  if (!normalizedSharedUrl || normalizedCurrentUrl !== normalizedSharedUrl || normalizedPlaybackUrl !== normalizedSharedUrl) {
    debugLog(`Ignored room state for ${state.sharedVideo.url} on current page ${currentVideo.url}`);
    return;
  }

  const video = getVideoElement();
  if (!video) {
    return;
  }

  if (
    lastLocalIntentPlayState &&
    Date.now() - lastLocalIntentAt < LOCAL_INTENT_GUARD_MS &&
    state.playback.playState !== lastLocalIntentPlayState
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
  lastRemoteRate = state.playback.playbackRate;
  if (state.playback.playState === "paused" || state.playback.playState === "buffering") {
    activatePauseHold();
  }
  intendedPlayState = state.playback.playState;
  if (state.playback.playState === "playing") {
    if (video.paused) {
      try {
        await video.play();
      } catch {
        stopCorrection(video);
        debugLog(
          `Skipped playback correction because play() was blocked ${state.sharedVideo.url} t=${state.playback.currentTime.toFixed(2)} seq=${state.playback.seq}`
        );
        return;
      }
    }
  } else if (!video.paused) {
    video.pause();
  }
  debugLog(
    `Apply playback ${state.playback.playState} ${state.sharedVideo.url} t=${state.playback.currentTime.toFixed(2)} seq=${state.playback.seq} actor=${state.playback.actorId}`
  );
  syncPlaybackPosition(video, state.playback.currentTime, state.playback.playState, state.playback.playbackRate);
}

async function hydrateRoomState(retries = 5): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: "content:get-room-state" });
  localMemberId = response?.memberId ?? null;
  if (response?.ok && response.roomState) {
    debugLog(`Hydrate room state success for ${response.roomState.roomCode}`);
    await applyRoomState(response.roomState as RoomState);
    hydrationReady = true;
    return;
  }
  if (!response?.memberId) {
    debugLog("Hydrate skipped without member id");
    hydrationReady = true;
    return;
  }
  if (retries <= 0) {
    debugLog("Hydrate retries exhausted");
    hydrationReady = true;
    return;
  }
  debugLog(`Hydrate retry scheduled (${retries})`);
  window.setTimeout(() => {
    void hydrateRoomState(retries - 1);
  }, 1200);
}

function syncPlaybackPosition(
  video: HTMLVideoElement,
  targetTime: number,
  playState: PlaybackState["playState"],
  playbackRate: number
): void {
  const delta = targetTime - video.currentTime;
  const absoluteDelta = Math.abs(delta);

  if (playState !== "playing") {
    stopCorrection(video);
    if (absoluteDelta > 0.15) {
      video.currentTime = targetTime;
    }
    if (Math.abs(video.playbackRate - playbackRate) > 0.01) {
      video.playbackRate = playbackRate;
    }
    return;
  }

  if (absoluteDelta > 1.5) {
    stopCorrection(video);
    video.currentTime = targetTime;
    if (Math.abs(video.playbackRate - playbackRate) > 0.01) {
      video.playbackRate = playbackRate;
    }
    return;
  }

  if (absoluteDelta > 0.35) {
    const correctionRate = delta > 0 ? playbackRate + 0.08 : Math.max(0.5, playbackRate - 0.08);
    applyTemporaryRate(video, correctionRate, playbackRate);
    return;
  }

  stopCorrection(video);
  if (Math.abs(video.playbackRate - playbackRate) > 0.01) {
    video.playbackRate = playbackRate;
  }
}

function applyTemporaryRate(video: HTMLVideoElement, temporaryRate: number, fallbackRate: number): void {
  stopCorrection(video);
  video.playbackRate = temporaryRate;
  correctionTimer = window.setTimeout(() => {
    correctionTimer = null;
    video.playbackRate = lastRemoteRate || fallbackRate;
  }, 1800);
}

function stopCorrection(video: HTMLVideoElement): void {
  if (correctionTimer !== null) {
    window.clearTimeout(correctionTimer);
    correctionTimer = null;
  }
  if (Math.abs(video.playbackRate - lastRemoteRate) > 0.01) {
    video.playbackRate = lastRemoteRate;
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
    const data = await response.json() as {
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
    // Ignore user lookup failures and keep guest naming.
  }
}
