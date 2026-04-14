import {
  type ClientMessage,
  type ServerMessage,
} from "@bili-syncplay/protocol";
import type {
  BackgroundToContentMessage,
  ContentToBackgroundMessage,
  PopupToBackgroundMessage,
} from "../shared/messages";
import { normalizeSharedVideoUrl } from "../shared/url";
import {
  preparePendingLocalShareCleanupForRoomLifecycle,
  type RoomLifecycleAction,
} from "./room-state";
import {
  toConnectionCheckUrl as buildConnectionCheckUrl,
  toHealthcheckUrl as buildHealthcheckUrl,
} from "./clock-sync";
import { notifyContentTabs } from "./content-bus";
import { bootstrapBackground } from "./bootstrap";
import { createClockController } from "./clock-controller";
import { createDiagnosticsController } from "./diagnostics-controller";
import { createMessageController } from "./message-controller";
import { createOutgoingMessageController } from "./outgoing-message-controller";
import { flushPendingShare as getPendingShareFlushPlan } from "./room-manager";
import { createPopupStateController } from "./popup-state-controller";
import { createRoomSessionController } from "./room-session-controller";
import {
  BILIBILI_VIDEO_URL_PATTERNS,
  MAX_RECONNECT_ATTEMPTS,
  SHARE_TOAST_TTL_MS,
} from "./runtime-state";
import { createServerMessageController } from "./server-message-controller";
import { createServerUrlController } from "./server-url-controller";
import { createShareController } from "./share-controller";
import { createSocketController } from "./socket-controller";
import { createBackgroundStateStore } from "./state-store";
import { createRuntimeSyncController } from "./runtime-sync-controller";
import {
  loadPersistedBackgroundSnapshot,
  persistBackgroundProfile,
  persistBackgroundState,
} from "./storage-manager";
import { createTabController } from "./tab-controller";
import { t } from "../shared/i18n";

const normalizeUrl = normalizeSharedVideoUrl;
const stateStore = createBackgroundStateStore();
const connectionState = stateStore.getState().connection;
const roomSessionState = stateStore.getState().room;
const shareState = stateStore.getState().share;
const clockState = stateStore.getState().clock;
const diagnosticsState = stateStore.getState().diagnostics;
const diagnosticsController = createDiagnosticsController({
  diagnosticsState,
  roomSessionState,
  connectionState,
  onLog: () => {
    if (popupStateController?.hasPopupConnections()) {
      popupStateController.broadcastPopupState();
    }
  },
});
const backgroundLog = (message: string) =>
  diagnosticsController.log("background", message);
const serverLog = (message: string) =>
  diagnosticsController.log("server", message);
let outgoingMessageController: ReturnType<
  typeof createOutgoingMessageController
> | null = null;
let serverMessageController: ReturnType<
  typeof createServerMessageController
> | null = null;
const runtimeSyncController = createRuntimeSyncController({
  stateStore,
  connectionState,
  roomSessionState,
  shareState,
  clockState,
  diagnosticsState,
  persistBackgroundState,
});
outgoingMessageController = createOutgoingMessageController({
  connectionState,
  connect: () => socketController.connect(),
  log: backgroundLog,
  shouldLogOutgoingMessage: (messageType) =>
    diagnosticsController.shouldLogOutgoingMessage(messageType),
  normalizeUrl,
});
const tabController = createTabController({
  roomSessionState,
  shareState,
  log: (scope, message) => diagnosticsController.log(scope, message),
  normalizeUrl,
  bilibiliVideoUrlPatterns: BILIBILI_VIDEO_URL_PATTERNS,
});
const clockController = createClockController({
  connectionState,
  clockState,
  sendToServer,
  log: (scope, message) => diagnosticsController.log(scope, message),
});
const shareController = createShareController({
  connectionState,
  roomSessionState,
  shareState,
  log: (scope, message) => diagnosticsController.log(scope, message),
  sendToServer: (message) => sendToServer(message as ClientMessage),
  connect: () => socketController.connect(),
  persistState,
  notifyAll,
  rememberSharedSourceTab: (tabId, videoUrl) =>
    tabController.rememberSharedSourceTab(tabId, videoUrl),
});
const roomSessionController = createRoomSessionController({
  connectionState,
  roomSessionState,
  shareState,
  log: (scope, message) => diagnosticsController.log(scope, message),
  notifyAll,
  persistState,
  sendToServer,
  connect: () => socketController.connect(),
  disconnectSocket,
  resetReconnectState: () => socketController.resetReconnectState(),
  resetRoomLifecycleTransientState,
  flushPendingShare,
  ensureSharedVideoOpen: () => tabController.ensureSharedVideoOpen(),
  notifyContentScripts,
  compensateRoomState: (state) => clockController.compensateRoomState(state),
  clearPendingLocalShare: (reason) =>
    shareController.clearPendingLocalShare(reason),
  expirePendingLocalShareIfNeeded: () =>
    shareController.expirePendingLocalShareIfNeeded(),
  normalizeUrl,
  logServerError,
  shareToastTtlMs: SHARE_TOAST_TTL_MS,
});
serverMessageController = createServerMessageController({
  log: serverLog,
  shouldLogIncomingMessage: (messageType) =>
    diagnosticsController.shouldLogIncomingMessage(messageType),
  consumeRoomState: (roomState) => {
    outgoingMessageController?.consumeRoomState(roomState);
  },
  handleRoomSessionServerMessage: (message) =>
    roomSessionController.handleServerMessage(message),
  updateClockOffset,
  notifyAll,
});
const socketController = createSocketController({
  connectionState,
  roomSessionState,
  maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
  log: (scope, message) => diagnosticsController.log(scope, message),
  logInvalidServerUrl,
  logConnectionProbeFailure,
  notifyAll,
  stopClockSyncTimer: () => clockController.stopClockSyncTimer(),
  syncClock: () => clockController.syncClock(),
  startClockSyncTimer: () => clockController.startClockSyncTimer(),
  clearPendingLocalShare: (reason) =>
    shareController.clearPendingLocalShare(reason),
  sendJoinRequest: (...args) => roomSessionController.sendJoinRequest(...args),
  sendToServer,
  handleServerMessage,
  buildConnectionCheckUrl,
  buildHealthcheckUrl,
  onOpen: () => undefined,
  onAdminSessionReset: (errorMessage) => {
    void roomSessionController.clearCurrentRoomContext(
      "socket closed by server",
      errorMessage,
    );
  },
  formatAdminSessionResetReason,
  reconnectFailedMessage: () =>
    t("popupErrorReconnectFailed", {
      attempts: MAX_RECONNECT_ATTEMPTS,
    }),
});
const serverUrlController = createServerUrlController({
  connectionState,
  roomSessionState,
  shareState,
  persistProfileState,
  notifyAll,
  connect: () => socketController.connect(),
  resetReconnectState: () => socketController.resetReconnectState(),
  stopClockSyncTimer: () => clockController.stopClockSyncTimer(),
  clearPendingLocalShare: (reason) =>
    shareController.clearPendingLocalShare(reason),
  log: (scope, message) => diagnosticsController.log(scope, message),
  logInvalidServerUrl,
});
const popupStateController = createPopupStateController({
  createState: () => runtimeSyncController.syncRuntimeStateStore(),
  getRetryInMs: () => socketController.getRetryInMs(),
  retryAttemptMax: MAX_RECONNECT_ATTEMPTS,
  notifyContentScripts,
  getSyncStatus: () => ({
    roomCode: roomSessionState.roomCode,
    connected: connectionState.connected,
    memberId: roomSessionState.memberId,
    rttMs: clockState.rttMs,
  }),
});
const messageController = createMessageController({
  connectionState,
  roomSessionState,
  diagnosticsController,
  popupStateController,
  roomSessionController,
  shareController,
  tabController,
  clockController,
  socketController,
  sendToServer,
  updateServerUrl,
  persistState,
  persistProfileState,
  notifyAll,
});

const BOOTSTRAP_PENDING_MESSAGE = "Extension is still initializing.";
const BOOTSTRAP_FAILED_MESSAGE =
  "Extension initialization failed. Reload the extension and try again.";
let bootstrapStatus: "pending" | "ready" | "failed" = "pending";

void bootstrap().catch((error) => {
  bootstrapStatus = "failed";
  connectionState.connected = false;
  connectionState.lastError = BOOTSTRAP_FAILED_MESSAGE;
  clockController.stopClockSyncTimer();
  shareController.clearPendingLocalShare("bootstrap failed");
  diagnosticsController.log(
    "background",
    `Bootstrap failed: ${formatBootstrapError(error)}`,
  );
  notifyAll();
});

async function bootstrap(): Promise<void> {
  await bootstrapBackground({
    state: {
      get roomCode() {
        return roomSessionState.roomCode;
      },
      set roomCode(value) {
        roomSessionState.roomCode = value;
      },
      get joinToken() {
        return roomSessionState.joinToken;
      },
      set joinToken(value) {
        roomSessionState.joinToken = value;
      },
      get memberToken() {
        return roomSessionState.memberToken;
      },
      set memberToken(value) {
        roomSessionState.memberToken = value;
      },
      get memberId() {
        return roomSessionState.memberId;
      },
      set memberId(value) {
        roomSessionState.memberId = value;
      },
      get displayName() {
        return roomSessionState.displayName;
      },
      set displayName(value) {
        roomSessionState.displayName = value;
      },
      get roomState() {
        return roomSessionState.roomState;
      },
      set roomState(value) {
        roomSessionState.roomState = value;
      },
      get serverUrl() {
        return connectionState.serverUrl;
      },
      set serverUrl(value) {
        connectionState.serverUrl = value;
      },
      get lastError() {
        return connectionState.lastError;
      },
      set lastError(value) {
        connectionState.lastError = value;
      },
      get sharedTabId() {
        return shareState.sharedTabId;
      },
      set sharedTabId(value) {
        shareState.sharedTabId = value;
      },
    },
    loadPersistedBackgroundSnapshot,
    connect: () => {
      void socketController.connect();
    },
    log: (scope, message) => diagnosticsController.log(scope, message),
    broadcastPopupState: () => popupStateController.broadcastPopupState(),
    addTabRemovedListener: (listener) => {
      chrome.tabs.onRemoved.addListener(listener);
    },
  });
  bootstrapStatus = "ready";
}

function formatBootstrapError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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
  diagnosticsController.log(
    "background",
    `Invalid server URL (${context}): ${invalidUrl}`,
  );
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
  diagnosticsController.log("background", parts.join(" "));
}

function logServerError(code: string, message: string): void {
  diagnosticsController.log(
    "server",
    `Received server error code=${code} message=${JSON.stringify(message)}`,
  );
}

function sendToServer(message: ClientMessage): void {
  outgoingMessageController?.sendToServer(message);
}

async function handleServerMessage(message: ServerMessage): Promise<void> {
  await serverMessageController?.handleServerMessage(message);
}

function updateClockOffset(
  clientSendTime: number,
  serverReceiveTime: number,
  serverSendTime: number,
): void {
  clockController.updateClockOffset(
    clientSendTime,
    serverReceiveTime,
    serverSendTime,
  );
}

function flushPendingShare(): void {
  const plan = getPendingShareFlushPlan({
    pendingSharedVideo: roomSessionState.pendingSharedVideo,
    pendingSharedPlayback: roomSessionState.pendingSharedPlayback,
    connected: connectionState.connected,
    roomCode: roomSessionState.roomCode,
    memberToken: roomSessionState.memberToken,
  });
  if (!plan.shouldFlush || !plan.video) {
    return;
  }
  sendToServer({
    type: "video:share",
    payload: {
      memberToken: roomSessionState.memberToken,
      video: plan.video,
      ...(plan.playback ? { playback: plan.playback } : {}),
    },
  });
  roomSessionState.pendingSharedVideo = null;
  roomSessionState.pendingSharedPlayback = null;
}

function disconnectSocket(): void {
  socketController.resetReconnectState();
  clockController.stopClockSyncTimer();
  shareController.clearPendingLocalShare("socket disconnected");
  roomSessionState.memberToken = null;
  if (!connectionState.socket) {
    connectionState.connected = false;
    return;
  }

  const currentSocket = connectionState.socket;
  connectionState.socket = null;
  connectionState.connected = false;
  currentSocket.close();
}

function resetRoomLifecycleTransientState(
  action: RoomLifecycleAction,
  reason: string,
): void {
  const cleanup = preparePendingLocalShareCleanupForRoomLifecycle(action, {
    pendingLocalShareUrl: shareState.pendingLocalShareUrl,
    pendingLocalShareExpiresAt: shareState.pendingLocalShareExpiresAt,
    pendingLocalShareTimer: shareState.pendingLocalShareTimer,
  });
  if (cleanup.hadPendingLocalShare) {
    if (cleanup.shouldCancelTimer) {
      if (shareState.pendingLocalShareTimer !== null) {
        clearTimeout(shareState.pendingLocalShareTimer);
        shareState.pendingLocalShareTimer = null;
      }
    }
    diagnosticsController.log(
      "background",
      `Cleared pending local share (${reason})`,
    );
    ({
      pendingLocalShareUrl: shareState.pendingLocalShareUrl,
      pendingLocalShareExpiresAt: shareState.pendingLocalShareExpiresAt,
      pendingLocalShareTimer: shareState.pendingLocalShareTimer,
    } = cleanup.nextState);
  }
  shareState.pendingShareToast = null;
  roomSessionState.pendingSharedVideo = null;
  roomSessionState.pendingSharedPlayback = null;
}

async function notifyContentScripts(
  message: BackgroundToContentMessage,
): Promise<void> {
  await notifyContentTabs(message, BILIBILI_VIDEO_URL_PATTERNS);
}

function notifyAll(): void {
  popupStateController.notifyAll();
}

async function persistState(): Promise<void> {
  await runtimeSyncController.persistState();
}

async function persistProfileState(): Promise<void> {
  await persistBackgroundProfile(runtimeSyncController.syncRuntimeStateStore());
}

async function updateServerUrl(nextServerUrl: string): Promise<void> {
  await serverUrlController.updateServerUrl(nextServerUrl);
}

chrome.runtime.onMessage.addListener(
  (
    message: PopupToBackgroundMessage | ContentToBackgroundMessage,
    sender,
    sendResponse,
  ) => {
    if (bootstrapStatus !== "ready") {
      const error =
        bootstrapStatus === "failed"
          ? BOOTSTRAP_FAILED_MESSAGE
          : BOOTSTRAP_PENDING_MESSAGE;
      if (message.type === "popup:get-state") {
        sendResponse(popupStateController.popupState());
      } else {
        sendResponse({ ok: false, error });
      }
      return true;
    }
    void messageController.handleRuntimeMessage(message, sender, sendResponse);

    return true;
  },
);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup-state") {
    return;
  }
  popupStateController.attachPort(port);
});
