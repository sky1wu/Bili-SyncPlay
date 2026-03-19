import {
  normalizeBilibiliUrl,
  parseBilibiliVideoRef,
  type ClientMessage,
  type PlaybackState,
  type RoomState,
  type ServerMessage,
  type SharedVideo,
} from "@bili-syncplay/protocol";
import type {
  BackgroundToContentMessage,
  BackgroundToPopupMessage,
  ContentToBackgroundMessage,
  DebugLogEntry,
  PopupToBackgroundMessage,
  SharedVideoToastPayload,
} from "../shared/messages";
import {
  createPendingLocalShareExpiry,
  decideIncomingRoomState,
  getActivePendingLocalShareUrl,
  isSharedVideoChange,
  PENDING_LOCAL_SHARE_TIMEOUT_MS,
  preparePendingLocalShareCleanup,
  preparePendingLocalShareCleanupForRoomLifecycle,
  type RoomLifecycleAction,
  shouldClearPendingLocalShareOnServerUrlChange,
} from "./room-state";
import {
  compensateRoomStateForClock,
  CLOCK_SYNC_INTERVAL_MS,
  toConnectionCheckUrl as buildConnectionCheckUrl,
  toHealthcheckUrl as buildHealthcheckUrl,
  updateClockSample,
} from "./clock-sync";
import { notifyContentTabs } from "./content-bus";
import { appendLog, formatContentLogSource } from "./logger";
import { bootstrapBackground } from "./bootstrap";
import { getConnectionErrorMessage } from "./connection-error";
import { createPopupStateSnapshot } from "./popup-bus";
import {
  createPendingShareToast as createRoomPendingShareToast,
  flushPendingShare as getPendingShareFlushPlan,
  getPendingShareToastFor as getRoomPendingShareToastFor,
} from "./room-manager";
import {
  BILIBILI_VIDEO_URL_PATTERNS,
  DEFAULT_SERVER_URL,
  MAX_RECONNECT_ATTEMPTS,
  SHARE_TOAST_TTL_MS,
} from "./runtime-state";
import { createBackgroundStateStore } from "./state-store";
import { validateServerUrl } from "./server-url";
import { shouldReconnect, getReconnectDelayMs } from "./socket-manager";
import {
  loadPersistedBackgroundSnapshot,
  persistBackgroundState,
} from "./storage-manager";
import {
  decideSharedPlaybackTab,
  rememberSharedSource,
} from "./tab-coordinator";
import { localizeServerError, t } from "../shared/i18n";

const stateStore = createBackgroundStateStore();

let socket: WebSocket | null = null;
let serverUrl = DEFAULT_SERVER_URL;
let connected = false;
let lastError: string | null = null;
let roomCode: string | null = null;
let joinToken: string | null = null;
let memberToken: string | null = null;
let memberId: string | null = null;
let displayName: string | null = null;
let roomState: RoomState | null = null;
let sharedTabId: number | null = null;
let pendingCreateRoom = false;
let pendingJoinRoomCode: string | null = null;
let pendingJoinToken: string | null = null;
let pendingJoinRequestSent = false;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;
let reconnectDeadlineMs: number | null = null;
let logs: DebugLogEntry[] = [];
let lastOpenedSharedUrl: string | null = null;
let clockOffsetMs: number | null = null;
let rttMs: number | null = null;
let clockSyncTimer: number | null = null;
let pendingSharedVideo: SharedVideo | null = null;
let pendingSharedPlayback: PlaybackState | null = null;
let openingSharedUrl: string | null = null;
let pendingLocalShareUrl: string | null = null;
let pendingLocalShareExpiresAt: number | null = null;
let pendingLocalShareTimer: number | null = null;
let pendingShareToast:
  | (SharedVideoToastPayload & { expiresAt: number; roomCode: string })
  | null = null;
let connectProbe: Promise<void> | null = null;
let lastPopupStateLogKey: string | null = null;
let pendingJoinAttemptResolvers: Array<
  (result: "joined" | "failed" | "timeout") => void
> = [];
const HEARTBEAT_LOG_INTERVAL_MS = 10000;
const ADMIN_SESSION_RESET_REASONS = new Set([
  "Admin kicked member",
  "Admin disconnected session",
  "Admin closed room",
]);
const outgoingMessageLogState = new Map<string, number>();
const incomingMessageLogState = new Map<string, number>();
const popupPorts = new Set<chrome.runtime.Port>();

bootstrap().catch(console.error);

async function bootstrap(): Promise<void> {
  await bootstrapBackground({
    state: {
      get roomCode() {
        return roomCode;
      },
      set roomCode(value) {
        roomCode = value;
      },
      get joinToken() {
        return joinToken;
      },
      set joinToken(value) {
        joinToken = value;
      },
      get memberToken() {
        return memberToken;
      },
      set memberToken(value) {
        memberToken = value;
      },
      get memberId() {
        return memberId;
      },
      set memberId(value) {
        memberId = value;
      },
      get displayName() {
        return displayName;
      },
      set displayName(value) {
        displayName = value;
      },
      get roomState() {
        return roomState;
      },
      set roomState(value) {
        roomState = value;
      },
      get serverUrl() {
        return serverUrl;
      },
      set serverUrl(value) {
        serverUrl = value;
      },
      get lastError() {
        return lastError;
      },
      set lastError(value) {
        lastError = value;
      },
      get sharedTabId() {
        return sharedTabId;
      },
      set sharedTabId(value) {
        sharedTabId = value;
      },
    },
    loadPersistedBackgroundSnapshot,
    connect: () => {
      void connect();
    },
    log,
    broadcastPopupState,
    addTabRemovedListener: (listener) => {
      chrome.tabs.onRemoved.addListener(listener);
    },
  });
}

function formatAdminSessionResetReason(reason: string): string {
  if (reason === "Admin kicked member") {
    return t("adminRemovedFromRoom");
  }
  if (reason === "Admin disconnected session") {
    return t("adminDisconnectedSession");
  }
  if (reason === "Admin closed room") {
    return t("adminClosedRoom");
  }
  return t("leftRoomWithReason", { reason });
}

function logInvalidServerUrl(context: string, invalidUrl: string): void {
  log("background", `Invalid server URL (${context}): ${invalidUrl}`);
}

function logConnectionProbeFailure(details: {
  stage: "connection-check" | "healthcheck" | "websocket";
  serverUrl: string;
  reason?: string | null;
  extensionOrigin?: string | null;
  readyState?: number | null;
}): void {
  const parts = [
    `Connection failure stage=${details.stage}`,
    `serverUrl=${details.serverUrl}`,
  ];
  if (details.reason) {
    parts.push(`reason=${details.reason}`);
  }
  if (details.extensionOrigin) {
    parts.push(`extensionOrigin=${details.extensionOrigin}`);
  }
  if (details.readyState !== undefined && details.readyState !== null) {
    parts.push(`readyState=${details.readyState}`);
  }
  log("background", parts.join(" "));
}

function logServerError(code: string, message: string): void {
  log(
    "server",
    `Received server error code=${code} message=${JSON.stringify(message)}`,
  );
}

async function connect(): Promise<void> {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  if (connectProbe) {
    return connectProbe;
  }

  const serverUrlResult = validateServerUrl(serverUrl);
  if (!serverUrlResult.ok) {
    lastError = serverUrlResult.message;
    connected = false;
    stopClockSyncTimer();
    logInvalidServerUrl("connect", serverUrl);
    notifyAll();
    return;
  }

  clearReconnectTimer();
  log("background", `Connecting to ${serverUrlResult.normalizedUrl}`);
  connectProbe = openSocketWithProbe(serverUrlResult.normalizedUrl);
  try {
    await connectProbe;
  } finally {
    connectProbe = null;
  }
}

async function openSocketWithProbe(targetServerUrl: string): Promise<void> {
  const serverUrlResult = validateServerUrl(targetServerUrl);
  if (!serverUrlResult.ok) {
    lastError = serverUrlResult.message;
    connected = false;
    stopClockSyncTimer();
    logInvalidServerUrl("open-socket", targetServerUrl);
    notifyAll();
    return;
  }

  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
  const connectionCheckUrl = buildConnectionCheckUrl(
    serverUrlResult.normalizedUrl,
  );
  const healthUrl = buildHealthcheckUrl(serverUrlResult.normalizedUrl);
  let healthcheckReachable = false;
  if (connectionCheckUrl) {
    try {
      const response = await fetch(connectionCheckUrl, {
        method: "GET",
        cache: "no-store",
      });
      if (response.ok) {
        type ConnectionCheckResponse = {
          ok?: boolean;
          data?: {
            websocketAllowed?: boolean;
            reason?: string | null;
          };
        };

        const payload = (await response.json()) as ConnectionCheckResponse;
        healthcheckReachable = true;
        if (payload.data?.websocketAllowed === false) {
          lastError = getConnectionErrorMessage({
            healthcheckReachable: true,
            extensionOrigin,
            reason: payload.data.reason,
          });
          connected = false;
          stopClockSyncTimer();
          logConnectionProbeFailure({
            stage: "connection-check",
            serverUrl: serverUrlResult.normalizedUrl,
            reason: payload.data.reason,
            extensionOrigin,
          });
          scheduleReconnect();
          notifyAll();
          return;
        }
      }
    } catch {
      // Fall back to the healthcheck probe for older servers that do not expose the preflight endpoint.
    }
  }

  if (healthUrl) {
    try {
      await fetch(healthUrl, {
        method: "GET",
        cache: "no-store",
        mode: "no-cors",
      });
      healthcheckReachable = true;
    } catch {
      lastError = getConnectionErrorMessage({
        healthcheckReachable: false,
        extensionOrigin,
      });
      connected = false;
      stopClockSyncTimer();
      logConnectionProbeFailure({
        stage: "healthcheck",
        serverUrl: serverUrlResult.normalizedUrl,
        extensionOrigin,
      });
      scheduleReconnect();
      notifyAll();
      return;
    }
  }

  socket = new WebSocket(serverUrlResult.normalizedUrl);

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
        payload: { displayName: displayName ?? undefined },
      });
    } else if (
      pendingJoinRoomCode &&
      pendingJoinToken &&
      !pendingJoinRequestSent
    ) {
      const targetRoomCode = pendingJoinRoomCode;
      const targetJoinToken = pendingJoinToken;
      sendJoinRequest(targetRoomCode, targetJoinToken);
    } else if (roomCode) {
      if (joinToken) {
        sendJoinRequest(roomCode, joinToken);
      }
    }
    syncClock();
    startClockSyncTimer();
    notifyAll();
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data) as ServerMessage;
    void handleServerMessage(message);
  });

  socket.addEventListener("close", (event) => {
    connected = false;
    stopClockSyncTimer();
    clearPendingLocalShare("socket closed before share confirmation");
    const closeReason = event.reason
      ? ` reason=${JSON.stringify(event.reason)}`
      : "";
    log(
      "background",
      `Socket closed code=${event.code} clean=${event.wasClean}${closeReason}`,
    );
    if (event.reason && ADMIN_SESSION_RESET_REASONS.has(event.reason)) {
      void clearCurrentRoomContext(
        `socket closed by server: ${event.reason}`,
        formatAdminSessionResetReason(event.reason),
      );
      return;
    }
    scheduleReconnect();
    notifyAll();
  });

  socket.addEventListener("error", () => {
    lastError = getConnectionErrorMessage({
      healthcheckReachable,
      extensionOrigin,
    });
    connected = false;
    stopClockSyncTimer();
    clearPendingLocalShare("socket error before share confirmation");
    logConnectionProbeFailure({
      stage: "websocket",
      serverUrl: serverUrlResult.normalizedUrl,
      extensionOrigin,
      readyState: socket?.readyState ?? -1,
    });
    notifyAll();
  });
}

function sendToServer(message: ClientMessage): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log("background", `Socket not ready for ${message.type}`);
    void connect();
    return;
  }
  if (shouldLogHeartbeatMessage(outgoingMessageLogState, message.type)) {
    log("background", `-> ${message.type}`);
  }
  socket.send(JSON.stringify(message));
}

function sendJoinRequest(
  targetRoomCode: string,
  targetJoinToken: string,
): void {
  pendingJoinRequestSent = true;
  sendToServer({
    type: "room:join",
    payload: {
      roomCode: targetRoomCode,
      joinToken: targetJoinToken,
      ...(memberToken ? { memberToken } : {}),
      displayName: displayName ?? undefined,
    },
  });
}

function settlePendingJoinAttempt(
  result: "joined" | "failed" | "timeout",
): void {
  if (pendingJoinAttemptResolvers.length === 0) {
    return;
  }

  const resolvers = pendingJoinAttemptResolvers;
  pendingJoinAttemptResolvers = [];
  for (const resolve of resolvers) {
    resolve(result);
  }
}

function waitForJoinAttemptResult(
  timeoutMs = 3000,
): Promise<"joined" | "failed" | "timeout"> {
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => {
      pendingJoinAttemptResolvers = pendingJoinAttemptResolvers.filter(
        (candidate) => candidate !== finalize,
      );
      resolve("timeout");
    }, timeoutMs);

    const finalize = (result: "joined" | "failed" | "timeout") => {
      globalThis.clearTimeout(timer);
      resolve(result);
    };

    pendingJoinAttemptResolvers.push(finalize);
  });
}

async function handleServerMessage(message: ServerMessage): Promise<void> {
  if (shouldLogHeartbeatMessage(incomingMessageLogState, message.type)) {
    log("server", `<- ${message.type}`);
  }
  switch (message.type) {
    case "room:created":
      pendingJoinRoomCode = null;
      pendingJoinToken = null;
      roomCode = message.payload.roomCode;
      joinToken = message.payload.joinToken;
      memberToken = message.payload.memberToken;
      memberId = message.payload.memberId;
      lastError = null;
      await persistState();
      flushPendingShare();
      notifyAll();
      return;
    case "room:joined":
      roomCode = message.payload.roomCode;
      joinToken = pendingJoinToken ?? joinToken;
      memberToken = message.payload.memberToken;
      memberId = message.payload.memberId;
      pendingJoinRequestSent = false;
      pendingJoinRoomCode = null;
      pendingJoinToken = null;
      lastError = null;
      settlePendingJoinAttempt("joined");
      await persistState();
      flushPendingShare();
      notifyAll();
      return;
    case "room:state":
      await handleRoomStateMessage(message.payload);
      return;
    case "error":
      lastError = localizeServerError(
        message.payload.code,
        message.payload.message,
      );
      if (
        pendingJoinRoomCode &&
        (message.payload.code === "room_not_found" ||
          message.payload.code === "join_token_invalid" ||
          message.payload.code === "invalid_message")
      ) {
        log("background", `Join failed for room ${pendingJoinRoomCode}`);
        settlePendingJoinAttempt("failed");
        pendingJoinRequestSent = false;
        pendingJoinRoomCode = null;
        pendingJoinToken = null;
        roomCode = null;
        joinToken = null;
        memberToken = null;
        memberId = null;
        roomState = null;
        await persistState();
      }
      if (
        roomCode &&
        !pendingJoinRoomCode &&
        (message.payload.code === "room_not_found" ||
          message.payload.code === "join_token_invalid")
      ) {
        await clearCurrentRoomContext(
          `server rejected stored room context: ${message.payload.code}`,
          message.payload.message,
        );
        logServerError(message.payload.code, message.payload.message);
        return;
      }
      if (message.payload.code === "member_token_invalid") {
        memberToken = null;
        await persistState();
      }
      logServerError(message.payload.code, message.payload.message);
      notifyAll();
      return;
    case "sync:pong":
      updateClockOffset(
        message.payload.clientSendTime,
        message.payload.serverReceiveTime,
        message.payload.serverSendTime,
      );
      notifyAll();
      return;
  }
}

async function handleRoomStateMessage(nextState: RoomState): Promise<void> {
  expirePendingLocalShareIfNeeded();
  const decision = decideIncomingRoomState({
    currentRoomState: roomState,
    normalizedPendingLocalShareUrl: normalizeUrl(
      getActivePendingLocalShareUrl({
        pendingLocalShareUrl,
        pendingLocalShareExpiresAt,
        now: Date.now(),
      }),
    ),
    normalizedIncomingSharedUrl: normalizeUrl(nextState.sharedVideo?.url),
  });

  if (decision.kind === "ignore-stale") {
    log(
      "background",
      `Ignored stale room state while waiting for ${pendingLocalShareUrl}; received ${nextState.sharedVideo?.url ?? "none"}`,
    );
    return;
  }

  if (isSharedVideoChange(decision.previousSharedUrl, nextState)) {
    lastOpenedSharedUrl = null;
    log(
      "background",
      `Shared video switched to ${nextState.sharedVideo?.url ?? "none"}`,
    );
    pendingShareToast = createPendingShareToast(nextState);
  }

  roomState = nextState;
  roomCode = nextState.roomCode;
  lastError = null;

  if (decision.confirmedPendingLocalShare) {
    log(
      "background",
      `Confirmed shared video switch to ${pendingLocalShareUrl}`,
    );
    clearPendingLocalShare("share confirmation received");
  }

  await persistState();
  await ensureSharedVideoOpen(roomState);
  const compensatedRoomState = compensateRoomState(roomState);
  await notifyContentScripts({
    type: "background:apply-room-state",
    payload: compensatedRoomState,
    shareToast: getPendingShareToastFor(nextState),
  });
  notifyAll();
}

function createPendingShareToast(
  state: RoomState,
): (SharedVideoToastPayload & { expiresAt: number; roomCode: string }) | null {
  return createRoomPendingShareToast({
    state,
    normalizedSharedUrl: normalizeUrl(state.sharedVideo?.url),
    now: Date.now(),
    ttlMs: SHARE_TOAST_TTL_MS,
  });
}

function getPendingShareToastFor(
  state: RoomState,
): SharedVideoToastPayload | null {
  const result = getRoomPendingShareToastFor({
    pendingShareToast,
    state,
    normalizedPendingToastUrl: normalizeUrl(pendingShareToast?.videoUrl),
    normalizedSharedUrl: normalizeUrl(state.sharedVideo?.url),
    now: Date.now(),
  });
  pendingShareToast = result.pendingShareToast;
  return result.shareToast;
}

function flushPendingShare(): void {
  const plan = getPendingShareFlushPlan({
    pendingSharedVideo,
    pendingSharedPlayback,
    connected,
    roomCode,
    memberToken,
  });
  if (!plan.shouldFlush || !plan.video) {
    return;
  }
  sendToServer({
    type: "video:share",
    payload: {
      memberToken,
      video: plan.video,
      ...(plan.playback ? { playback: plan.playback } : {}),
    },
  });
  pendingSharedVideo = null;
  pendingSharedPlayback = null;
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
    return {
      ok: false,
      payload: null,
      tabId: null,
      error: t("popupErrorNoActiveTab"),
    };
  }

  if (!activeTab.url || !parseBilibiliVideoRef(activeTab.url)) {
    return {
      ok: false,
      payload: null,
      tabId: activeTab.id,
      error: t("popupErrorOpenBilibiliVideo"),
    };
  }

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "background:get-current-video",
    });
    if (!response?.ok || !response.payload?.video) {
      return {
        ok: false,
        payload: null,
        tabId: activeTab.id,
        error: t("popupErrorNoPlayableVideo"),
      };
    }
    return {
      ok: true,
      payload: response.payload,
      tabId: activeTab.id,
    };
  } catch {
    return {
      ok: false,
      payload: null,
      tabId: activeTab.id,
      error: t("popupErrorCannotAccessPage"),
    };
  }
}

async function queueOrSendSharedVideo(
  payload: { video: SharedVideo; playback: PlaybackState | null },
  tabId: number | null,
): Promise<void> {
  rememberSharedSourceTab(tabId ?? undefined, payload.video.url);
  setPendingLocalShare(payload.video.url);

  if (connected && roomCode) {
    if (!memberToken) {
      lastError = t("popupErrorMemberTokenMissing");
      notifyAll();
      return;
    }
    sendToServer({
      type: "video:share",
      payload: {
        memberToken,
        video: payload.video,
        ...(payload.playback
          ? {
              playback: {
                ...payload.playback,
                serverTime: 0,
                actorId: memberId ?? payload.playback.actorId,
              },
            }
          : {}),
      },
    });
    return;
  }

  pendingSharedVideo = payload.video;
  pendingSharedPlayback = payload.playback
    ? {
        ...payload.playback,
        serverTime: 0,
        actorId: memberId ?? payload.playback.actorId,
      }
    : null;

  if (roomCode) {
    memberToken = null;
    connect();
    return;
  }

  roomCode = null;
  joinToken = null;
  memberToken = null;
  memberId = null;
  roomState = null;
  pendingShareToast = null;
  await persistState();
  connect();
  if (connected) {
    pendingCreateRoom = false;
    sendToServer({
      type: "room:create",
      payload: { displayName: displayName ?? undefined },
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
      clientSendTime: Date.now(),
    },
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

function updateClockOffset(
  clientSendTime: number,
  serverReceiveTime: number,
  serverSendTime: number,
): void {
  const sample = updateClockSample({
    clientSendTime,
    serverReceiveTime,
    serverSendTime,
    now: Date.now(),
    previousRttMs: rttMs,
    previousClockOffsetMs: clockOffsetMs,
  });
  rttMs = sample.rttMs;
  clockOffsetMs = sample.clockOffsetMs;
  log("background", `Clock sync offset=${clockOffsetMs}ms rtt=${rttMs}ms`);
}

function compensateRoomState(state: RoomState): RoomState {
  return compensateRoomStateForClock(state, clockOffsetMs);
}

function scheduleReconnect(): void {
  if (
    !shouldReconnect({
      connected,
      reconnectTimer,
      roomCode,
      pendingCreateRoom,
      reconnectAttempt,
      maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    })
  ) {
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      reconnectDeadlineMs = null;
      lastError = t("popupErrorReconnectFailed", {
        attempts: MAX_RECONNECT_ATTEMPTS,
      });
      log(
        "background",
        `Reconnect exhausted after ${MAX_RECONNECT_ATTEMPTS} attempts`,
      );
    }
    return;
  }

  reconnectAttempt += 1;
  const retryDelayMs = getReconnectDelayMs(reconnectAttempt);
  reconnectDeadlineMs = Date.now() + retryDelayMs;
  log("background", `Reconnect scheduled in ${retryDelayMs}ms`);
  reconnectTimer = self.setTimeout(() => {
    reconnectDeadlineMs = null;
    reconnectTimer = null;
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

async function clearCurrentRoomContext(
  reason: string,
  errorMessage: string | null = null,
): Promise<void> {
  log("background", `Clearing current room context (${reason})`);
  roomCode = null;
  joinToken = null;
  memberToken = null;
  memberId = null;
  roomState = null;
  pendingCreateRoom = false;
  pendingJoinRoomCode = null;
  pendingJoinToken = null;
  pendingJoinRequestSent = false;
  lastOpenedSharedUrl = null;
  lastError = errorMessage;
  resetReconnectState();
  resetRoomLifecycleTransientState("leave-room", reason);
  await persistState();
  notifyAll();
}

function clearPendingLocalShareTimer(): void {
  if (pendingLocalShareTimer !== null) {
    clearTimeout(pendingLocalShareTimer);
    pendingLocalShareTimer = null;
  }
}

function clearPendingLocalShare(reason: string): void {
  const cleanup = preparePendingLocalShareCleanup({
    pendingLocalShareUrl,
    pendingLocalShareExpiresAt,
    pendingLocalShareTimer,
  });
  if (!cleanup.hadPendingLocalShare) {
    return;
  }
  if (cleanup.shouldCancelTimer) {
    clearPendingLocalShareTimer();
  }
  log("background", `Cleared pending local share (${reason})`);
  ({
    pendingLocalShareUrl,
    pendingLocalShareExpiresAt,
    pendingLocalShareTimer,
  } = cleanup.nextState);
}

function expirePendingLocalShareIfNeeded(): void {
  const activePendingShare = getActivePendingLocalShareUrl({
    pendingLocalShareUrl,
    pendingLocalShareExpiresAt,
    now: Date.now(),
  });
  if (pendingLocalShareUrl && activePendingShare === null) {
    clearPendingLocalShare(
      `share confirmation timed out after ${PENDING_LOCAL_SHARE_TIMEOUT_MS}ms`,
    );
  }
}

function setPendingLocalShare(url: string): void {
  clearPendingLocalShareTimer();
  pendingLocalShareUrl = url;
  pendingLocalShareExpiresAt = createPendingLocalShareExpiry(Date.now());
  log(
    "background",
    `Waiting up to ${PENDING_LOCAL_SHARE_TIMEOUT_MS}ms for share confirmation ${url}`,
  );
  pendingLocalShareTimer = self.setTimeout(() => {
    expirePendingLocalShareIfNeeded();
    notifyAll();
  }, PENDING_LOCAL_SHARE_TIMEOUT_MS);
}

function disconnectSocket(): void {
  resetReconnectState();
  stopClockSyncTimer();
  clearPendingLocalShare("socket disconnected");
  memberToken = null;
  if (!socket) {
    connected = false;
    return;
  }

  const currentSocket = socket;
  socket = null;
  connected = false;
  currentSocket.close();
}

function resetRoomLifecycleTransientState(
  action: RoomLifecycleAction,
  reason: string,
): void {
  const cleanup = preparePendingLocalShareCleanupForRoomLifecycle(action, {
    pendingLocalShareUrl,
    pendingLocalShareExpiresAt,
    pendingLocalShareTimer,
  });
  if (cleanup.hadPendingLocalShare) {
    if (cleanup.shouldCancelTimer) {
      clearPendingLocalShareTimer();
    }
    log("background", `Cleared pending local share (${reason})`);
    ({
      pendingLocalShareUrl,
      pendingLocalShareExpiresAt,
      pendingLocalShareTimer,
    } = cleanup.nextState);
  }
  pendingShareToast = null;
  pendingSharedVideo = null;
  pendingSharedPlayback = null;
}

function log(scope: DebugLogEntry["scope"], message: string): void {
  logs = appendLog(logs, scope, message);
  if (popupPorts.size > 0) {
    broadcastPopupState();
  }
}

function shouldLogHeartbeatMessage(
  logState: Map<string, number>,
  type: string,
  now = Date.now(),
): boolean {
  if (type !== "playback:update" && type !== "room:state") {
    return true;
  }

  const lastAt = logState.get(type) ?? 0;
  if (now - lastAt < HEARTBEAT_LOG_INTERVAL_MS) {
    return false;
  }
  logState.set(type, now);
  return true;
}

function maybeLogPopupStateRequest(): void {
  const key = `${roomCode ?? "none"}|${connected}|${pendingJoinRoomCode ?? "none"}`;
  if (key === lastPopupStateLogKey) {
    return;
  }
  lastPopupStateLogKey = key;
  log(
    "background",
    `Popup requested state room=${roomCode ?? "none"} connected=${connected} pendingJoin=${pendingJoinRoomCode ?? "none"}`,
  );
}

function rememberSharedSourceTab(tabId: number | undefined, url: string): void {
  const next = rememberSharedSource({
    currentSharedTabId: sharedTabId,
    tabId,
    url,
  });
  sharedTabId = next.sharedTabId;
  lastOpenedSharedUrl = next.lastOpenedSharedUrl;
  log("background", `Shared source tab=${tabId ?? "unknown"} url=${url}`);
}

function isActiveSharedTab(tabId: number | undefined, url: string): boolean {
  const decision = decideSharedPlaybackTab({
    tabId,
    sharedTabId,
    normalizedRoomUrl: normalizeUrl(roomState?.sharedVideo?.url),
    normalizedPayloadUrl: normalizeUrl(url),
  });
  sharedTabId = decision.nextSharedTabId;

  if (decision.reason === "accepted-first") {
    log("background", `Accepted first shared playback tab=${tabId}`);
  } else if (decision.reason === "room-mismatch") {
    log(
      "background",
      `Ignored playback from shared tab ${tabId} because url no longer matches room`,
    );
  } else if (
    decision.reason === "ignored-non-shared" &&
    decision.nextSharedTabId !== null
  ) {
    log("background", `Ignored playback from non-shared tab ${tabId}`);
  }

  return decision.accepted;
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

    const existingTabs = await chrome.tabs.query({
      url: BILIBILI_VIDEO_URL_PATTERNS,
    });
    const matched = existingTabs.find(
      (tab) => normalizeUrl(tab.url) === normalizeUrl(targetUrl),
    );
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
    log(
      "background",
      `Opened shared video in new tab ${sharedTabId ?? "unknown"}`,
    );
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

  const existingTabs = await chrome.tabs.query({
    url: BILIBILI_VIDEO_URL_PATTERNS,
  });
  const matched = existingTabs.find(
    (tab) => normalizeUrl(tab.url) === normalizeUrl(targetUrl),
  );
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
  log(
    "background",
    `Popup opened shared video in new tab ${sharedTabId ?? "unknown"}`,
  );
}

function normalizeUrl(url: string | undefined | null): string | null {
  return normalizeBilibiliUrl(url);
}

async function notifyContentScripts(
  message: BackgroundToContentMessage,
): Promise<void> {
  await notifyContentTabs(message, BILIBILI_VIDEO_URL_PATTERNS);
}

function popupState(): BackgroundToPopupMessage {
  return createPopupStateSnapshot({
    state: syncRuntimeStateStore(),
    retryInMs: getRetryInMs(),
    retryAttemptMax: MAX_RECONNECT_ATTEMPTS,
  });
}

function broadcastPopupState(): void {
  const snapshot = popupState();
  for (const port of popupPorts) {
    try {
      port.postMessage(snapshot);
    } catch {
      popupPorts.delete(port);
    }
  }
}

function notifyAll(): void {
  broadcastPopupState();
  void notifyContentScripts({
    type: "background:sync-status",
    payload: {
      roomCode,
      connected,
      memberId,
    },
  });
}

async function persistState(): Promise<void> {
  await persistBackgroundState(syncRuntimeStateStore());
}

function syncRuntimeStateStore() {
  return stateStore.patch({
    connection: {
      socket,
      serverUrl,
      connected,
      lastError,
      connectProbe,
      reconnectTimer,
      reconnectAttempt,
      reconnectDeadlineMs,
    },
    room: {
      roomCode,
      joinToken,
      memberToken,
      memberId,
      displayName,
      roomState,
      pendingCreateRoom,
      pendingJoinRoomCode,
      pendingJoinToken,
      pendingJoinRequestSent,
      pendingSharedVideo,
      pendingSharedPlayback,
    },
    share: {
      sharedTabId,
      lastOpenedSharedUrl,
      openingSharedUrl,
      pendingLocalShareUrl,
      pendingLocalShareExpiresAt,
      pendingLocalShareTimer,
      pendingShareToast,
    },
    clock: {
      clockOffsetMs,
      rttMs,
      clockSyncTimer,
    },
    diagnostics: {
      logs,
      lastPopupStateLogKey,
    },
  });
}

async function updateServerUrl(nextServerUrl: string): Promise<void> {
  const serverUrlResult = validateServerUrl(nextServerUrl);
  if (!serverUrlResult.ok) {
    lastError = serverUrlResult.message;
    logInvalidServerUrl(
      "update-server-url",
      nextServerUrl.trim() || DEFAULT_SERVER_URL,
    );
    notifyAll();
    return;
  }

  const normalized = serverUrlResult.normalizedUrl;
  if (normalized === serverUrl) {
    return;
  }

  if (
    shouldClearPendingLocalShareOnServerUrlChange({
      currentServerUrl: serverUrl,
      nextServerUrl: normalized,
      pendingLocalShareUrl,
    })
  ) {
    clearPendingLocalShare("server URL changed");
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

chrome.runtime.onMessage.addListener(
  (
    message: PopupToBackgroundMessage | ContentToBackgroundMessage,
    sender,
    sendResponse,
  ) => {
    void (async () => {
      switch (message.type) {
        case "popup:create-room":
          resetReconnectState();
          roomCode = null;
          joinToken = null;
          memberToken = null;
          memberId = null;
          roomState = null;
          pendingJoinRoomCode = null;
          pendingJoinToken = null;
          resetRoomLifecycleTransientState(
            "create-room",
            "create room requested",
          );
          lastOpenedSharedUrl = null;
          await persistState();
          connect();
          if (connected) {
            pendingCreateRoom = false;
            sendToServer({
              type: "room:create",
              payload: { displayName: displayName ?? undefined },
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
          pendingJoinToken = message.joinToken.trim();
          pendingJoinRequestSent = false;
          log("background", `Popup requested join for ${pendingJoinRoomCode}`);
          roomCode = null;
          joinToken = null;
          memberToken = null;
          memberId = null;
          roomState = null;
          resetRoomLifecycleTransientState("join-room", "join room requested");
          lastOpenedSharedUrl = null;
          lastError = null;
          await persistState();
          await connect();
          if (!connected) {
            sendResponse(popupState());
            return;
          }
          if (connected && pendingJoinRoomCode && pendingJoinToken) {
            const targetRoomCode = pendingJoinRoomCode;
            const targetJoinToken = pendingJoinToken;
            if (!pendingJoinRequestSent) {
              sendJoinRequest(targetRoomCode, targetJoinToken);
            }
          }
          await waitForJoinAttemptResult();
          sendResponse(popupState());
          return;
        case "popup:leave-room":
          log("background", `Popup requested leave for ${roomCode ?? "none"}`);
          if (connected) {
            sendToServer({
              type: "room:leave",
              payload: memberToken ? { memberToken } : undefined,
            });
          }
          roomCode = null;
          joinToken = null;
          memberToken = null;
          memberId = null;
          roomState = null;
          pendingJoinRoomCode = null;
          pendingJoinToken = null;
          pendingJoinRequestSent = false;
          resetRoomLifecycleTransientState(
            "leave-room",
            "leave room requested",
          );
          lastOpenedSharedUrl = null;
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
            lastError = response.error ?? t("popupErrorCannotReadCurrentVideo");
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
            if (connected && roomCode && memberToken) {
              sendToServer({
                type: "profile:update",
                payload: {
                  memberToken,
                  displayName,
                },
              });
            }
          }
          sendResponse({ ok: true });
          return;
        case "content:playback-update":
          if (
            connected &&
            memberToken &&
            isActiveSharedTab(sender.tab?.id, message.payload.url)
          ) {
            sendToServer({
              type: "playback:update",
              payload: {
                memberToken,
                playback: {
                  ...message.payload,
                  serverTime: 0,
                  actorId: memberId ?? message.payload.actorId,
                },
              },
            });
          }
          sendResponse({ ok: true });
          return;
        case "content:get-room-state":
          if (roomCode && !connected) {
            connect();
          }
          if (connected && roomCode && memberToken) {
            sendToServer({ type: "sync:request", payload: { memberToken } });
          }
          sendResponse(
            roomState
              ? {
                  ok: true,
                  roomState: compensateRoomState(roomState),
                  memberId,
                  roomCode,
                }
              : { ok: false, memberId, roomCode },
          );
          return;
        case "content:debug-log":
          log(
            "content",
            `[${formatContentLogSource(sender)}] ${message.payload.message}`,
          );
          sendResponse({ ok: true });
          return;
        default:
          sendResponse({ ok: false });
      }
    })();

    return true;
  },
);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup-state") {
    return;
  }

  popupPorts.add(port);
  port.postMessage({
    type: "background:popup-connected",
    payload: {
      connectedAt: Date.now(),
    },
  } satisfies BackgroundToPopupMessage);
  port.postMessage(popupState());

  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
  });
});
