import type { ClientMessage, PlaybackState, RoomState, ServerMessage, SharedVideo } from "@bili-syncplay/protocol";
import { loadState, saveState } from "../shared/storage";
import type {
  BackgroundToContentMessage,
  BackgroundToPopupMessage,
  ContentToBackgroundMessage,
  DebugLogEntry,
  PopupToBackgroundMessage
} from "../shared/messages";

const DEFAULT_SERVER_URL = "ws://localhost:8787";
const MAX_LOGS = 30;
const CLOCK_SYNC_INTERVAL_MS = 15000;
const BILIBILI_VIDEO_URL_PATTERNS = [
  "https://www.bilibili.com/video/*",
  "https://www.bilibili.com/bangumi/play/*",
  "https://www.bilibili.com/festival/*"
];

let socket: WebSocket | null = null;
let serverUrl = DEFAULT_SERVER_URL;
let connected = false;
let lastError: string | null = null;
let roomCode: string | null = null;
let memberId: string | null = null;
let displayName: string | null = null;
let roomState: RoomState | null = null;
let sharedTabId: number | null = null;
let pendingCreateRoom = false;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;
let retryInMs: number | null = null;
let logs: DebugLogEntry[] = [];
let lastOpenedSharedUrl: string | null = null;
let clockOffsetMs: number | null = null;
let rttMs: number | null = null;
let clockSyncTimer: number | null = null;
let pendingSharedVideo: SharedVideo | null = null;
let pendingSharedPlayback: ClientMessage | null = null;
let openingSharedUrl: string | null = null;
let pendingLocalShareUrl: string | null = null;

bootstrap().catch(console.error);

async function bootstrap(): Promise<void> {
  const persisted = await loadState();
  roomCode = persisted.roomCode;
  memberId = persisted.memberId;
  displayName = persisted.displayName;
  roomState = persisted.roomState;
  serverUrl = persisted.serverUrl?.trim() || DEFAULT_SERVER_URL;
  if (roomCode) {
    connect();
  }

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (sharedTabId === tabId) {
      sharedTabId = null;
      log("background", `Cleared shared tab binding for closed tab ${tabId}`);
    }
  });
}

function connect(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  clearReconnectTimer();
  log("background", `Connecting to ${serverUrl}`);
  socket = new WebSocket(serverUrl);

  socket.addEventListener("open", () => {
    connected = true;
    lastError = null;
    reconnectAttempt = 0;
    retryInMs = null;
    log("background", "Socket connected");
    if (pendingCreateRoom) {
      pendingCreateRoom = false;
      sendToServer({
        type: "room:create",
        payload: { displayName: displayName ?? undefined }
      });
    } else if (roomCode) {
      sendToServer({
        type: "room:join",
        payload: { roomCode, displayName: displayName ?? undefined }
      });
      sendToServer({ type: "sync:request" });
    }
    syncClock();
    startClockSyncTimer();
    notifyAll();
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data) as ServerMessage;
    void handleServerMessage(message);
  });

  socket.addEventListener("close", () => {
    connected = false;
    stopClockSyncTimer();
    log("background", "Socket closed");
    scheduleReconnect();
    notifyAll();
  });

  socket.addEventListener("error", () => {
    lastError = "Cannot connect to sync server.";
    connected = false;
    stopClockSyncTimer();
    log("background", lastError);
    notifyAll();
  });
}

function sendToServer(message: ClientMessage): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log("background", `Socket not ready for ${message.type}`);
    connect();
    return;
  }
  log("background", `-> ${message.type}`);
  socket.send(JSON.stringify(message));
}

async function handleServerMessage(message: ServerMessage): Promise<void> {
  log("server", `<- ${message.type}`);
  switch (message.type) {
    case "room:created":
    case "room:joined":
      roomCode = message.payload.roomCode;
      memberId = message.payload.memberId;
      lastError = null;
      await persistState();
      flushPendingShare();
      notifyAll();
      return;
    case "room:state":
      if (
        pendingLocalShareUrl &&
        normalizeUrl(message.payload.sharedVideo?.url) !== normalizeUrl(pendingLocalShareUrl)
      ) {
        log("background", `Ignored stale room state while sharing ${pendingLocalShareUrl}`);
        roomState = message.payload;
        roomCode = message.payload.roomCode;
        lastError = null;
        await persistState();
        const compensatedIgnoredState = compensateRoomState(roomState);
        await notifyContentScripts({
          type: "background:apply-room-state",
          payload: compensatedIgnoredState
        });
        notifyAll();
        return;
      }

      if (roomState?.sharedVideo?.url !== message.payload.sharedVideo?.url) {
        lastOpenedSharedUrl = null;
        log("background", `Shared video switched to ${message.payload.sharedVideo?.url ?? "none"}`);
      }
      roomState = message.payload;
      roomCode = message.payload.roomCode;
      lastError = null;
      if (
        pendingLocalShareUrl &&
        normalizeUrl(message.payload.sharedVideo?.url) === normalizeUrl(pendingLocalShareUrl)
      ) {
        log("background", `Confirmed shared video switch to ${pendingLocalShareUrl}`);
        pendingLocalShareUrl = null;
      }
      await persistState();
      await ensureSharedVideoOpen(roomState);
      const compensatedRoomState = compensateRoomState(roomState);
      await notifyContentScripts({
        type: "background:apply-room-state",
        payload: compensatedRoomState
      });
      notifyAll();
      return;
    case "error":
      lastError = message.payload.message;
      log("server", `error: ${message.payload.message}`);
      notifyAll();
      return;
    case "sync:pong":
      updateClockOffset(message.payload.clientSendTime, message.payload.serverReceiveTime, message.payload.serverSendTime);
      notifyAll();
      return;
  }
}

function flushPendingShare(): void {
  if (!pendingSharedVideo || !connected || !roomCode) {
    return;
  }
  sendToServer({ type: "video:share", payload: pendingSharedVideo });
  if (pendingSharedPlayback) {
    sendToServer(pendingSharedPlayback);
    pendingSharedPlayback = null;
  }
  pendingSharedVideo = null;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function getActiveVideoPayload(): Promise<{
  ok: boolean;
  payload: { video: SharedVideo; playback: PlaybackState | null } | null;
  tabId: number | null;
  error?: string;
}> {
  const activeTab = await getActiveTab();
  if (!activeTab?.id) {
    return { ok: false, payload: null, tabId: null, error: "No active tab." };
  }

  if (!activeTab.url || !parseBilibiliVideoRef(activeTab.url)) {
    return { ok: false, payload: null, tabId: activeTab.id, error: "Please open a Bilibili video page first." };
  }

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "background:get-current-video"
    });
    if (!response?.ok || !response.payload?.video) {
      return { ok: false, payload: null, tabId: activeTab.id, error: "Current page does not have a playable video." };
    }
    return {
      ok: true,
      payload: response.payload,
      tabId: activeTab.id
    };
  } catch {
    return { ok: false, payload: null, tabId: activeTab.id, error: "Cannot access the current page." };
  }
}

async function queueOrSendSharedVideo(
  payload: { video: SharedVideo; playback: PlaybackState | null },
  tabId: number | null
): Promise<void> {
  rememberSharedSourceTab(tabId ?? undefined, payload.video.url);
  pendingLocalShareUrl = payload.video.url;

  if (connected && roomCode) {
    sendToServer({ type: "video:share", payload: payload.video });
    if (payload.playback) {
      sendToServer({
        type: "playback:update",
        payload: {
          ...payload.playback,
          serverTime: 0,
          actorId: memberId ?? payload.playback.actorId
        }
      });
    }
    return;
  }

  pendingSharedVideo = payload.video;
  pendingSharedPlayback = payload.playback
    ? {
        type: "playback:update",
        payload: {
          ...payload.playback,
          serverTime: 0,
          actorId: memberId ?? payload.playback.actorId
        }
      }
    : null;

  if (roomCode) {
    connect();
    return;
  }

  roomCode = null;
  memberId = null;
  roomState = null;
  await persistState();
  connect();
  if (connected) {
    pendingCreateRoom = false;
    sendToServer({
      type: "room:create",
      payload: { displayName: displayName ?? undefined }
    });
  } else {
    pendingCreateRoom = true;
  }
}

function syncClock(): void {
  if (!connected) {
    return;
  }
  sendToServer({
    type: "sync:ping",
    payload: {
      clientSendTime: Date.now()
    }
  });
}

function startClockSyncTimer(): void {
  stopClockSyncTimer();
  clockSyncTimer = self.setInterval(() => {
    syncClock();
  }, CLOCK_SYNC_INTERVAL_MS);
}

function stopClockSyncTimer(): void {
  if (clockSyncTimer !== null) {
    clearInterval(clockSyncTimer);
    clockSyncTimer = null;
  }
}

function updateClockOffset(clientSendTime: number, serverReceiveTime: number, serverSendTime: number): void {
  const clientReceiveTime = Date.now();
  const sampleRtt = clientReceiveTime - clientSendTime - (serverSendTime - serverReceiveTime);
  const sampleOffset = ((serverReceiveTime - clientSendTime) + (serverSendTime - clientReceiveTime)) / 2;
  rttMs = rttMs === null ? sampleRtt : Math.round(rttMs * 0.7 + sampleRtt * 0.3);
  clockOffsetMs = clockOffsetMs === null ? sampleOffset : Math.round(clockOffsetMs * 0.7 + sampleOffset * 0.3);
  log("background", `Clock sync offset=${clockOffsetMs}ms rtt=${rttMs}ms`);
}

function compensateRoomState(state: RoomState): RoomState {
  if (!state.playback || clockOffsetMs === null) {
    return state;
  }
  if (state.playback.playState !== "playing") {
    return state;
  }
  const estimatedServerNow = Date.now() + clockOffsetMs;
  const elapsedMs = Math.max(0, estimatedServerNow - state.playback.serverTime);
  return {
    ...state,
    playback: {
      ...state.playback,
      currentTime: state.playback.currentTime + elapsedMs / 1000 * state.playback.playbackRate
    }
  };
}

function scheduleReconnect(): void {
  if (connected || reconnectTimer !== null) {
    return;
  }
  if (!roomCode && !pendingCreateRoom) {
    return;
  }
  reconnectAttempt += 1;
  retryInMs = Math.min(1000 * 2 ** (reconnectAttempt - 1), 10000);
  log("background", `Reconnect scheduled in ${retryInMs}ms`);
  reconnectTimer = self.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, retryInMs);
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  retryInMs = null;
}

function disconnectSocket(): void {
  clearReconnectTimer();
  stopClockSyncTimer();
  if (!socket) {
    connected = false;
    return;
  }

  const currentSocket = socket;
  socket = null;
  connected = false;
  currentSocket.close();
}

function log(scope: DebugLogEntry["scope"], message: string): void {
  logs = [{ at: Date.now(), scope, message }, ...logs].slice(0, MAX_LOGS);
}

function rememberSharedSourceTab(tabId: number | undefined, url: string): void {
  if (tabId !== undefined) {
    sharedTabId = tabId;
  }
  lastOpenedSharedUrl = url;
  log("background", `Shared source tab=${tabId ?? "unknown"} url=${url}`);
}

function isActiveSharedTab(tabId: number | undefined, url: string): boolean {
  if (tabId === undefined) {
    return false;
  }
  if (sharedTabId === null) {
    sharedTabId = tabId;
    log("background", `Accepted first shared playback tab=${tabId}`);
    return true;
  }
  if (sharedTabId === tabId) {
    log("background", `Accepted playback from shared tab=${tabId}`);
    return true;
  }
  if (normalizeUrl(roomState?.sharedVideo?.url) === normalizeUrl(url)) {
    log("background", `Ignored playback from non-shared tab ${tabId}`);
  }
  return false;
}

async function ensureSharedVideoOpen(state: RoomState): Promise<void> {
  if (!state.sharedVideo?.url) {
    return;
  }

  const targetUrl = state.sharedVideo.url;
  if (lastOpenedSharedUrl === targetUrl || openingSharedUrl === targetUrl) {
    return;
  }
  openingSharedUrl = targetUrl;

  try {
    if (sharedTabId !== null) {
      try {
        const existingTab = await chrome.tabs.get(sharedTabId);
        if (normalizeUrl(existingTab.url) === normalizeUrl(targetUrl)) {
          lastOpenedSharedUrl = targetUrl;
          return;
        }
        await chrome.tabs.update(sharedTabId, { url: targetUrl, active: true });
        lastOpenedSharedUrl = targetUrl;
        log("background", `Reusing tab ${sharedTabId} for shared video`);
        return;
      } catch {
        sharedTabId = null;
      }
    }

    const existingTabs = await chrome.tabs.query({ url: BILIBILI_VIDEO_URL_PATTERNS });
    const matched = existingTabs.find((tab) => normalizeUrl(tab.url) === normalizeUrl(targetUrl));
    if (matched?.id !== undefined) {
      sharedTabId = matched.id;
      await chrome.tabs.update(matched.id, { active: true });
      lastOpenedSharedUrl = targetUrl;
      log("background", `Activated existing shared tab ${matched.id}`);
      return;
    }

    const created = await chrome.tabs.create({ url: targetUrl, active: true });
    sharedTabId = created.id ?? null;
    lastOpenedSharedUrl = targetUrl;
    log("background", `Opened shared video in new tab ${sharedTabId ?? "unknown"}`);
  } finally {
    if (openingSharedUrl === targetUrl) {
      openingSharedUrl = null;
    }
  }
}

async function openSharedVideoFromPopup(): Promise<void> {
  const targetUrl = roomState?.sharedVideo?.url;
  if (!targetUrl) {
    return;
  }

  const existingTabs = await chrome.tabs.query({ url: BILIBILI_VIDEO_URL_PATTERNS });
  const matched = existingTabs.find((tab) => normalizeUrl(tab.url) === normalizeUrl(targetUrl));
  if (matched?.id !== undefined) {
    sharedTabId = matched.id;
    lastOpenedSharedUrl = targetUrl;
    await chrome.tabs.update(matched.id, { active: true });
    log("background", `Popup activated shared tab ${matched.id}`);
    return;
  }

  const created = await chrome.tabs.create({ url: targetUrl, active: true });
  sharedTabId = created.id ?? null;
  lastOpenedSharedUrl = targetUrl;
  log("background", `Popup opened shared video in new tab ${sharedTabId ?? "unknown"}`);
}

function normalizeUrl(url: string | undefined | null): string | null {
  return parseBilibiliVideoRef(url)?.normalizedUrl ?? null;
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

async function notifyContentScripts(message: BackgroundToContentMessage): Promise<void> {
  const tabs = await chrome.tabs.query({ url: BILIBILI_VIDEO_URL_PATTERNS });
  await Promise.all(
    tabs
      .filter((tab) => tab.id !== undefined)
      .map(async (tab) => {
        try {
          await chrome.tabs.sendMessage(tab.id!, message);
        } catch {
          // Ignore tabs without a ready content script.
        }
      })
  );
}

function popupState(): BackgroundToPopupMessage {
  return {
    type: "background:state",
    payload: {
      connected,
      roomCode,
      memberId,
      roomState,
      serverUrl,
      error: lastError,
      retryInMs,
      clockOffsetMs,
      rttMs,
      logs
    }
  };
}

function notifyAll(): void {
  void notifyContentScripts({
    type: "background:sync-status",
    payload: {
      roomCode,
      connected,
      memberId
    }
  });
}

async function persistState(): Promise<void> {
  await saveState({ roomCode, memberId, displayName, roomState, serverUrl });
}

function normalizeServerUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_SERVER_URL;
  }
  return trimmed;
}

async function updateServerUrl(nextServerUrl: string): Promise<void> {
  const normalized = normalizeServerUrl(nextServerUrl);
  if (normalized === serverUrl) {
    return;
  }

  serverUrl = normalized;
  lastError = null;
  await persistState();
  log("background", `Server URL updated to ${serverUrl}`);

  if (socket) {
    clearReconnectTimer();
    stopClockSyncTimer();
    const currentSocket = socket;
    socket = null;
    connected = false;
    currentSocket.close();
  }

  if (roomCode || pendingCreateRoom) {
    connect();
  }
  notifyAll();
}

chrome.runtime.onMessage.addListener((message: PopupToBackgroundMessage | ContentToBackgroundMessage, sender, sendResponse) => {
  void (async () => {
    switch (message.type) {
      case "popup:create-room":
        roomCode = null;
        memberId = null;
        roomState = null;
        pendingSharedVideo = null;
        pendingSharedPlayback = null;
        await persistState();
        connect();
        if (connected) {
          pendingCreateRoom = false;
          sendToServer({
            type: "room:create",
            payload: { displayName: displayName ?? undefined }
          });
        } else {
          pendingCreateRoom = true;
        }
        sendResponse(popupState());
        return;
      case "popup:join-room":
        roomCode = message.roomCode.trim().toUpperCase();
        await persistState();
        connect();
        sendToServer({
          type: "room:join",
          payload: { roomCode, displayName: displayName ?? undefined }
        });
        sendResponse(popupState());
        return;
      case "popup:leave-room":
        if (connected) {
          sendToServer({ type: "room:leave" });
        }
        roomCode = null;
        memberId = null;
        roomState = null;
        lastOpenedSharedUrl = null;
        pendingSharedVideo = null;
        pendingSharedPlayback = null;
        pendingLocalShareUrl = null;
        pendingCreateRoom = false;
        disconnectSocket();
        await persistState();
        notifyAll();
        sendResponse(popupState());
        return;
      case "popup:get-state":
        if (roomCode && !connected) {
          connect();
        }
        sendResponse(popupState());
        return;
      case "popup:get-active-video": {
        const response = await getActiveVideoPayload();
        if (!response.ok && response.error) {
          lastError = response.error;
        } else {
          lastError = null;
        }
        notifyAll();
        sendResponse(response);
        return;
      }
      case "popup:share-current-video": {
        const response = await getActiveVideoPayload();
        if (!response.ok || !response.payload) {
          lastError = response.error ?? "Cannot read the current video.";
          notifyAll();
          sendResponse({ ok: false, error: lastError });
          return;
        }
        lastError = null;
        await queueOrSendSharedVideo(response.payload, response.tabId);
        await persistState();
        notifyAll();
        sendResponse({ ok: true });
        return;
      }
      case "popup:open-shared-video":
        await openSharedVideoFromPopup();
        sendResponse({ ok: true });
        return;
      case "popup:set-server-url":
        await updateServerUrl(message.serverUrl);
        sendResponse(popupState());
        return;
      case "content:report-user":
        if (displayName !== message.payload.displayName) {
          displayName = message.payload.displayName;
          await persistState();
          if (connected && roomCode) {
            sendToServer({
              type: "room:join",
              payload: { roomCode, displayName }
            });
          }
        }
        sendResponse({ ok: true });
        return;
      case "content:playback-update":
        if (connected && isActiveSharedTab(sender.tab?.id, message.payload.url)) {
          sendToServer({
            type: "playback:update",
            payload: {
              ...message.payload,
              serverTime: 0,
              actorId: memberId ?? message.payload.actorId
            }
          });
        }
        sendResponse({ ok: true });
        return;
      case "content:get-room-state":
        if (roomCode && !connected) {
          connect();
        }
        if (connected && roomCode) {
          sendToServer({ type: "sync:request" });
        }
        sendResponse(
          roomState
            ? { ok: true, roomState: compensateRoomState(roomState), memberId, roomCode }
            : { ok: false, memberId, roomCode }
        );
        return;
      case "content:debug-log":
        log("content", message.payload.message);
        sendResponse({ ok: true });
        return;
      default:
        sendResponse({ ok: false });
    }
  })();

  return true;
});
