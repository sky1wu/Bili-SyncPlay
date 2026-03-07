import type { ClientMessage, RoomState, ServerMessage, SharedVideo } from "@bili-syncplay/protocol";
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
      await persistState();
      flushPendingShare();
      notifyAll();
      return;
    case "room:state":
      if (roomState?.sharedVideo?.url !== message.payload.sharedVideo?.url) {
        lastOpenedSharedUrl = null;
        log("background", `Shared video switched to ${message.payload.sharedVideo?.url ?? "none"}`);
      }
      roomState = message.payload;
      roomCode = message.payload.roomCode;
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

    const existingTabs = await chrome.tabs.query({ url: ["https://www.bilibili.com/video/*"] });
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

function normalizeUrl(url: string | undefined | null): string | null {
  if (!url) {
    return null;
  }
  return url.split("?")[0].replace(/\/+$/, "");
}

async function notifyContentScripts(message: BackgroundToContentMessage): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ["https://www.bilibili.com/video/*"] });
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
        pendingCreateRoom = false;
        clearReconnectTimer();
        await persistState();
        sendResponse(popupState());
        return;
      case "popup:get-state":
        if (roomCode && !connected) {
          connect();
        }
        sendResponse(popupState());
        return;
      case "popup:set-server-url":
        await updateServerUrl(message.serverUrl);
        sendResponse(popupState());
        return;
      case "content:share-video":
        if (connected && roomCode) {
          rememberSharedSourceTab(sender.tab?.id, message.payload.video.url);
          sendToServer({ type: "video:share", payload: message.payload.video });
          if (message.payload.playback) {
            sendToServer({
              type: "playback:update",
              payload: {
                ...message.payload.playback,
                serverTime: 0,
                actorId: memberId ?? message.payload.playback.actorId
              }
            });
          }
          sendResponse({ ok: true });
          return;
        }
        sendResponse({ ok: false, reason: "not-in-room" });
        return;
      case "content:create-room-and-share":
        roomCode = null;
        memberId = null;
        roomState = null;
        pendingSharedVideo = message.payload.video;
        pendingSharedPlayback = message.payload.playback
          ? {
              type: "playback:update",
              payload: {
                ...message.payload.playback,
                serverTime: 0,
                actorId: message.payload.playback.actorId
              }
            }
          : null;
        rememberSharedSourceTab(sender.tab?.id, message.payload.video.url);
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
        sendResponse({ ok: true });
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
        sendResponse(roomState ? { ok: true, roomState: compensateRoomState(roomState), memberId } : { ok: false, memberId });
        return;
      case "content:get-share-context":
        sendResponse({
          ok: true,
          roomCode,
          roomState: roomState ? compensateRoomState(roomState) : null,
          connected
        });
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
