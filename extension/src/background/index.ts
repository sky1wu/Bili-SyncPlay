import type { ClientMessage, PlaybackState, RoomState, ServerMessage, SharedVideo } from "@bili-syncplay/protocol";
import { loadState, saveState } from "../shared/storage";
import type {
  BackgroundToContentMessage,
  BackgroundToPopupMessage,
  ContentToBackgroundMessage,
  DebugLogEntry,
  PopupToBackgroundMessage,
  SharedVideoToastPayload
} from "../shared/messages";
import { decideIncomingRoomState, isSharedVideoChange } from "./room-state";

const DEFAULT_SERVER_URL = "ws://localhost:8787";
const MAX_LOGS = 30;
const CLOCK_SYNC_INTERVAL_MS = 15000;
const MAX_RECONNECT_ATTEMPTS = 5;
const BILIBILI_VIDEO_URL_PATTERNS = [
  "https://www.bilibili.com/video/*",
  "https://www.bilibili.com/bangumi/play/*",
  "https://www.bilibili.com/festival/*",
  "https://www.bilibili.com/list/watchlater*",
  "https://www.bilibili.com/medialist/play/watchlater*"
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
let pendingJoinRoomCode: string | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;
let reconnectDeadlineMs: number | null = null;
let logs: DebugLogEntry[] = [];
let lastOpenedSharedUrl: string | null = null;
let clockOffsetMs: number | null = null;
let rttMs: number | null = null;
let clockSyncTimer: number | null = null;
let pendingSharedVideo: SharedVideo | null = null;
let pendingSharedPlayback: ClientMessage | null = null;
let openingSharedUrl: string | null = null;
let pendingLocalShareUrl: string | null = null;
let pendingShareToast: (SharedVideoToastPayload & { expiresAt: number; roomCode: string }) | null = null;
let connectProbe: Promise<void> | null = null;
let lastPopupStateLogKey: string | null = null;

const SHARE_TOAST_TTL_MS = 8000;

bootstrap().catch(console.error);

async function bootstrap(): Promise<void> {
  const persisted = await loadState();
  roomCode = persisted.roomCode;
  memberId = persisted.memberId;
  displayName = persisted.displayName;
  roomState = persisted.roomState;
  serverUrl = persisted.serverUrl?.trim() || DEFAULT_SERVER_URL;
  if (roomCode) {
    void connect();
  }

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (sharedTabId === tabId) {
      sharedTabId = null;
      log("background", `Cleared shared tab binding for closed tab ${tabId}`);
    }
  });
}

async function connect(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (connectProbe) {
    return connectProbe;
  }

  clearReconnectTimer();
  log("background", `Connecting to ${serverUrl}`);
  connectProbe = openSocketWithProbe();
  try {
    await connectProbe;
  } finally {
    connectProbe = null;
  }
}

async function openSocketWithProbe(): Promise<void> {
  const healthUrl = toHealthcheckUrl(serverUrl);
  if (healthUrl) {
    try {
      await fetch(healthUrl, {
        method: "GET",
        cache: "no-store",
        mode: "no-cors"
      });
    } catch {
      lastError = "Cannot connect to sync server.";
      connected = false;
      stopClockSyncTimer();
      log("background", lastError);
      scheduleReconnect();
      notifyAll();
      return;
    }
  }

  socket = new WebSocket(serverUrl);

  socket.addEventListener("open", () => {
    connected = true;
    lastError = null;
    reconnectAttempt = 0;
    reconnectDeadlineMs = null;
    log("background", "Socket connected");
    if (pendingCreateRoom) {
      pendingCreateRoom = false;
      sendToServer({
        type: "room:create",
        payload: { displayName: displayName ?? undefined }
      });
    } else if (pendingJoinRoomCode) {
      const targetRoomCode = pendingJoinRoomCode;
      pendingJoinRoomCode = null;
      sendJoinRequest(targetRoomCode);
    } else if (roomCode) {
      sendJoinRequest(roomCode);
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
    void connect();
    return;
  }
  log("background", `-> ${message.type}`);
  socket.send(JSON.stringify(message));
}

function sendJoinRequest(targetRoomCode: string): void {
  sendToServer({
    type: "room:join",
    payload: { roomCode: targetRoomCode, displayName: displayName ?? undefined }
  });
}

function toHealthcheckUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "ws:") {
      parsed.protocol = "http:";
    } else if (parsed.protocol === "wss:") {
      parsed.protocol = "https:";
    } else {
      return null;
    }
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

async function handleServerMessage(message: ServerMessage): Promise<void> {
  log("server", `<- ${message.type}`);
  switch (message.type) {
    case "room:created":
    case "room:joined":
      pendingJoinRoomCode = null;
      roomCode = message.payload.roomCode;
      memberId = message.payload.memberId;
      lastError = null;
      await persistState();
      flushPendingShare();
      notifyAll();
      return;
    case "room:state":
      await handleRoomStateMessage(message.payload);
      return;
    case "error":
      lastError = message.payload.message;
      if (pendingJoinRoomCode && message.payload.message === "Room not found.") {
        log("background", `Join failed for room ${pendingJoinRoomCode}`);
        pendingJoinRoomCode = null;
        roomCode = null;
        memberId = null;
        roomState = null;
        await persistState();
      }
      log("server", `error: ${message.payload.message}`);
      notifyAll();
      return;
    case "sync:pong":
      updateClockOffset(message.payload.clientSendTime, message.payload.serverReceiveTime, message.payload.serverSendTime);
      notifyAll();
      return;
  }
}

async function handleRoomStateMessage(nextState: RoomState): Promise<void> {
  const decision = decideIncomingRoomState({
    currentRoomState: roomState,
    nextState,
    normalizedPendingLocalShareUrl: normalizeUrl(pendingLocalShareUrl),
    normalizedIncomingSharedUrl: normalizeUrl(nextState.sharedVideo?.url)
  });

  if (decision.kind === "ignore-stale") {
    log(
      "background",
      `Ignored stale room state while waiting for ${pendingLocalShareUrl}; received ${nextState.sharedVideo?.url ?? "none"}`
    );
    return;
  }

  if (isSharedVideoChange(decision.previousSharedUrl, nextState)) {
    lastOpenedSharedUrl = null;
    log("background", `Shared video switched to ${nextState.sharedVideo?.url ?? "none"}`);
    pendingShareToast = createPendingShareToast(nextState);
  }

  roomState = nextState;
  roomCode = nextState.roomCode;
  lastError = null;

  if (decision.confirmedPendingLocalShare) {
    log("background", `Confirmed shared video switch to ${pendingLocalShareUrl}`);
    pendingLocalShareUrl = null;
  }

  await persistState();
  await ensureSharedVideoOpen(roomState);
  const compensatedRoomState = compensateRoomState(roomState);
  await notifyContentScripts({
    type: "background:apply-room-state",
    payload: compensatedRoomState,
    shareToast: getPendingShareToastFor(nextState)
  });
  notifyAll();
}

function createPendingShareToast(state: RoomState): (SharedVideoToastPayload & { expiresAt: number; roomCode: string }) | null {
  if (!state.sharedVideo) {
    return null;
  }
  return {
    key: `${state.roomCode}:${normalizeUrl(state.sharedVideo.url) ?? state.sharedVideo.url}:${Date.now()}`,
    actorId: state.playback?.actorId ?? null,
    title: state.sharedVideo.title,
    videoUrl: state.sharedVideo.url,
    roomCode: state.roomCode,
    expiresAt: Date.now() + SHARE_TOAST_TTL_MS
  };
}

function getPendingShareToastFor(state: RoomState): SharedVideoToastPayload | null {
  if (!pendingShareToast) {
    return null;
  }
  if (pendingShareToast.expiresAt <= Date.now()) {
    pendingShareToast = null;
    return null;
  }
  if (pendingShareToast.roomCode !== state.roomCode) {
    return null;
  }
  if (normalizeUrl(pendingShareToast.videoUrl) !== normalizeUrl(state.sharedVideo?.url)) {
    return null;
  }
  return {
    key: pendingShareToast.key,
    actorId: pendingShareToast.actorId,
    title: pendingShareToast.title,
    videoUrl: pendingShareToast.videoUrl
  };
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
  pendingShareToast = null;
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
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    reconnectDeadlineMs = null;
    lastError = `Cannot connect to sync server after ${MAX_RECONNECT_ATTEMPTS} attempts.`;
    log("background", lastError);
    return;
  }
  reconnectAttempt += 1;
  const retryDelayMs = Math.min(1000 * 2 ** (reconnectAttempt - 1), 10000);
  reconnectDeadlineMs = Date.now() + retryDelayMs;
  log("background", `Reconnect scheduled in ${retryDelayMs}ms`);
  reconnectTimer = self.setTimeout(() => {
    reconnectTimer = null;
    reconnectDeadlineMs = null;
    connect();
  }, retryDelayMs);
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectDeadlineMs = null;
}

function getRetryInMs(): number | null {
  if (reconnectDeadlineMs === null) {
    return null;
  }
  return Math.max(0, reconnectDeadlineMs - Date.now());
}

function resetReconnectState(): void {
  clearReconnectTimer();
  reconnectAttempt = 0;
}

function disconnectSocket(): void {
  resetReconnectState();
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

function maybeLogPopupStateRequest(): void {
  const key = `${roomCode ?? "none"}|${connected}|${pendingJoinRoomCode ?? "none"}`;
  if (key === lastPopupStateLogKey) {
    return;
  }
  lastPopupStateLogKey = key;
  log("background", `Popup requested state room=${roomCode ?? "none"} connected=${connected} pendingJoin=${pendingJoinRoomCode ?? "none"}`);
}

function formatContentLogSource(sender: chrome.runtime.MessageSender): string {
  const tabId = sender.tab?.id;
  const rawUrl = sender.tab?.url ?? sender.url ?? null;
  if (!rawUrl) {
    return tabId !== undefined ? `tab=${tabId}` : "tab=unknown";
  }

  try {
    const parsed = new URL(rawUrl);
    const conciseUrl = `${parsed.origin}${parsed.pathname}`;
    return tabId !== undefined ? `tab=${tabId} ${conciseUrl}` : conciseUrl;
  } catch {
    return tabId !== undefined ? `tab=${tabId} ${rawUrl}` : rawUrl;
  }
}

function rememberSharedSourceTab(tabId: number | undefined, url: string): void {
  if (tabId !== undefined) {
    sharedTabId = tabId;
  }
  lastOpenedSharedUrl = url;
  log("background", `Shared source tab=${tabId ?? "unknown"} url=${url}`);
}

function isActiveSharedTab(tabId: number | undefined, url: string): boolean {
  const normalizedRoomUrl = normalizeUrl(roomState?.sharedVideo?.url);
  const normalizedPayloadUrl = normalizeUrl(url);
  if (tabId === undefined) {
    return false;
  }
  if (sharedTabId === null) {
    if (normalizedRoomUrl && normalizedPayloadUrl && normalizedRoomUrl === normalizedPayloadUrl) {
      sharedTabId = tabId;
      log("background", `Accepted first shared playback tab=${tabId}`);
      return true;
    }
    return false;
  }
  if (sharedTabId === tabId) {
    if (!normalizedRoomUrl || !normalizedPayloadUrl || normalizedRoomUrl !== normalizedPayloadUrl) {
      log("background", `Ignored playback from shared tab ${tabId} because url no longer matches room`);
      return false;
    }
    log("background", `Accepted playback from shared tab=${tabId}`);
    return true;
  }
  if (normalizedRoomUrl && normalizedPayloadUrl && normalizedRoomUrl === normalizedPayloadUrl) {
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
      pendingCreateRoom,
      pendingJoinRoomCode,
      retryInMs: getRetryInMs(),
      retryAttempt: reconnectAttempt,
      retryAttemptMax: MAX_RECONNECT_ATTEMPTS,
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
    resetReconnectState();
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
        resetReconnectState();
        roomCode = null;
        memberId = null;
        roomState = null;
        pendingJoinRoomCode = null;
        pendingShareToast = null;
        pendingSharedVideo = null;
        pendingSharedPlayback = null;
        pendingLocalShareUrl = null;
        lastOpenedSharedUrl = null;
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
        resetReconnectState();
        pendingCreateRoom = false;
        pendingJoinRoomCode = message.roomCode.trim().toUpperCase();
        log("background", `Popup requested join for ${pendingJoinRoomCode}`);
        roomCode = pendingJoinRoomCode;
        memberId = null;
        roomState = null;
        pendingShareToast = null;
        pendingSharedVideo = null;
        pendingSharedPlayback = null;
        pendingLocalShareUrl = null;
        lastOpenedSharedUrl = null;
        lastError = null;
        await persistState();
        await connect();
        if (connected && pendingJoinRoomCode) {
          const targetRoomCode = pendingJoinRoomCode;
          pendingJoinRoomCode = null;
          sendJoinRequest(targetRoomCode);
        }
        sendResponse(popupState());
        return;
      case "popup:leave-room":
        log("background", `Popup requested leave for ${roomCode ?? "none"}`);
        if (connected) {
          sendToServer({ type: "room:leave" });
        }
        roomCode = null;
        memberId = null;
        roomState = null;
        pendingJoinRoomCode = null;
        pendingShareToast = null;
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
      case "popup:debug-log":
        log("popup", message.message);
        sendResponse({ ok: true });
        return;
      case "popup:get-state":
        maybeLogPopupStateRequest();
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
        log("content", `[${formatContentLogSource(sender)}] ${message.payload.message}`);
        sendResponse({ ok: true });
        return;
      default:
        sendResponse({ ok: false });
    }
  })();

  return true;
});
