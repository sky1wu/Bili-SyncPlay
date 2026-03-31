import type { ClientMessage, ServerMessage } from "@bili-syncplay/protocol";
import { isServerMessage } from "@bili-syncplay/protocol";
import type { DebugLogEntry } from "../shared/messages";
import type { ConnectionState, RoomSessionState } from "./runtime-state";
import { getConnectionErrorMessage } from "./connection-error";
import {
  shouldReconnect as shouldScheduleReconnect,
  getReconnectDelayMs,
} from "./socket-manager";
import { validateServerUrl } from "./server-url";

export interface SocketController {
  connect(): Promise<void>;
  scheduleReconnect(): void;
  clearReconnectTimer(): void;
  getRetryInMs(): number | null;
  resetReconnectState(): void;
}

export function createSocketController(args: {
  connectionState: ConnectionState;
  roomSessionState: RoomSessionState;
  maxReconnectAttempts: number;
  log: (scope: DebugLogEntry["scope"], message: string) => void;
  logInvalidServerUrl: (context: string, invalidUrl: string) => void;
  logConnectionProbeFailure: (details: {
    stage: "connection-check" | "healthcheck" | "websocket";
    serverUrl: string;
    reason?: string | null;
    extensionOrigin?: string | null;
    readyState?: number | null;
  }) => void;
  notifyAll: () => void;
  stopClockSyncTimer: () => void;
  syncClock: () => void;
  startClockSyncTimer: () => void;
  clearPendingLocalShare: (reason: string) => void;
  sendJoinRequest: (targetRoomCode: string, targetJoinToken: string) => void;
  sendToServer: (message: ClientMessage) => void;
  handleServerMessage: (message: ServerMessage) => Promise<void>;
  buildConnectionCheckUrl: (serverUrl: string) => string | null;
  buildHealthcheckUrl: (serverUrl: string) => string | null;
  onOpen: () => void;
  onAdminSessionReset: (reason: string) => void;
  formatAdminSessionResetReason: (reason: string) => string;
  reconnectFailedMessage: () => string;
}): SocketController {
  async function connect(): Promise<void> {
    if (
      args.connectionState.socket &&
      (args.connectionState.socket.readyState === WebSocket.OPEN ||
        args.connectionState.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    if (args.connectionState.connectProbe) {
      return args.connectionState.connectProbe;
    }

    const serverUrlResult = validateServerUrl(args.connectionState.serverUrl);
    if ("message" in serverUrlResult) {
      args.connectionState.lastError = serverUrlResult.message;
      args.connectionState.connected = false;
      args.stopClockSyncTimer();
      args.logInvalidServerUrl("connect", args.connectionState.serverUrl);
      args.notifyAll();
      return;
    }

    clearReconnectTimer();
    args.log("background", `Connecting to ${serverUrlResult.normalizedUrl}`);
    args.connectionState.connectProbe = openSocketWithProbe(
      serverUrlResult.normalizedUrl,
    );
    try {
      await args.connectionState.connectProbe;
    } finally {
      args.connectionState.connectProbe = null;
    }
  }

  async function openSocketWithProbe(targetServerUrl: string): Promise<void> {
    const serverUrlResult = validateServerUrl(targetServerUrl);
    if ("message" in serverUrlResult) {
      args.connectionState.lastError = serverUrlResult.message;
      args.connectionState.connected = false;
      args.stopClockSyncTimer();
      args.logInvalidServerUrl("open-socket", targetServerUrl);
      args.notifyAll();
      return;
    }

    const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
    const connectionCheckUrl = args.buildConnectionCheckUrl(
      serverUrlResult.normalizedUrl,
    );
    const healthUrl = args.buildHealthcheckUrl(serverUrlResult.normalizedUrl);
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
            args.connectionState.lastError = getConnectionErrorMessage({
              healthcheckReachable: true,
              extensionOrigin,
              reason: payload.data.reason,
            });
            args.connectionState.connected = false;
            args.stopClockSyncTimer();
            args.logConnectionProbeFailure({
              stage: "connection-check",
              serverUrl: serverUrlResult.normalizedUrl,
              reason: payload.data.reason,
              extensionOrigin,
            });
            scheduleReconnect();
            args.notifyAll();
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
        args.connectionState.lastError = getConnectionErrorMessage({
          healthcheckReachable: false,
          extensionOrigin,
        });
        args.connectionState.connected = false;
        args.stopClockSyncTimer();
        args.logConnectionProbeFailure({
          stage: "healthcheck",
          serverUrl: serverUrlResult.normalizedUrl,
          extensionOrigin,
        });
        scheduleReconnect();
        args.notifyAll();
        return;
      }
    }

    args.connectionState.socket = new WebSocket(serverUrlResult.normalizedUrl);

    args.connectionState.socket.addEventListener("open", () => {
      args.connectionState.connected = true;
      args.connectionState.lastError = null;
      args.connectionState.reconnectAttempt = 0;
      args.connectionState.reconnectDeadlineMs = null;
      args.log("background", "Socket connected");
      args.onOpen();
      if (args.roomSessionState.pendingCreateRoom) {
        args.roomSessionState.pendingCreateRoom = false;
        args.sendToServer({
          type: "room:create",
          payload: {
            displayName: args.roomSessionState.displayName ?? undefined,
          },
        });
      } else if (
        args.roomSessionState.pendingJoinRoomCode &&
        args.roomSessionState.pendingJoinToken &&
        !args.roomSessionState.pendingJoinRequestSent
      ) {
        args.sendJoinRequest(
          args.roomSessionState.pendingJoinRoomCode,
          args.roomSessionState.pendingJoinToken,
        );
      } else if (
        args.roomSessionState.roomCode &&
        args.roomSessionState.joinToken
      ) {
        args.sendJoinRequest(
          args.roomSessionState.roomCode,
          args.roomSessionState.joinToken,
        );
      }
      args.syncClock();
      args.startClockSyncTimer();
      args.notifyAll();
    });

    args.connectionState.socket.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        args.log("background", "Received invalid JSON from server");
        return;
      }
      if (!isServerMessage(parsed)) {
        args.log("background", "Received unrecognized server message");
        return;
      }
      void args.handleServerMessage(parsed);
    });

    args.connectionState.socket.addEventListener("close", (event) => {
      args.connectionState.connected = false;
      args.stopClockSyncTimer();
      args.clearPendingLocalShare("socket closed before share confirmation");
      const closeReason = event.reason
        ? ` reason=${JSON.stringify(event.reason)}`
        : "";
      args.log(
        "background",
        `Socket closed code=${event.code} clean=${event.wasClean}${closeReason}`,
      );
      if (event.reason && ADMIN_SESSION_RESET_REASONS.has(event.reason)) {
        args.onAdminSessionReset(
          args.formatAdminSessionResetReason(event.reason),
        );
        return;
      }
      scheduleReconnect();
      args.notifyAll();
    });

    args.connectionState.socket.addEventListener("error", () => {
      args.connectionState.lastError = getConnectionErrorMessage({
        healthcheckReachable,
        extensionOrigin,
      });
      args.connectionState.connected = false;
      args.stopClockSyncTimer();
      args.clearPendingLocalShare("socket error before share confirmation");
      args.logConnectionProbeFailure({
        stage: "websocket",
        serverUrl: serverUrlResult.normalizedUrl,
        extensionOrigin,
        readyState: args.connectionState.socket?.readyState ?? -1,
      });
      args.notifyAll();
    });
  }

  function scheduleReconnect(): void {
    if (
      !shouldScheduleReconnect({
        connected: args.connectionState.connected,
        reconnectTimer: args.connectionState.reconnectTimer,
        roomCode: args.roomSessionState.roomCode,
        pendingCreateRoom: args.roomSessionState.pendingCreateRoom,
        reconnectAttempt: args.connectionState.reconnectAttempt,
        maxReconnectAttempts: args.maxReconnectAttempts,
      })
    ) {
      if (args.connectionState.reconnectAttempt >= args.maxReconnectAttempts) {
        args.connectionState.reconnectDeadlineMs = null;
        args.connectionState.lastError = args.reconnectFailedMessage();
        args.log(
          "background",
          `Reconnect exhausted after ${args.maxReconnectAttempts} attempts`,
        );
      }
      return;
    }

    args.connectionState.reconnectAttempt += 1;
    const retryDelayMs = getReconnectDelayMs(
      args.connectionState.reconnectAttempt,
    );
    args.connectionState.reconnectDeadlineMs = Date.now() + retryDelayMs;
    args.log("background", `Reconnect scheduled in ${retryDelayMs}ms`);
    args.connectionState.reconnectTimer = self.setTimeout(() => {
      args.connectionState.reconnectDeadlineMs = null;
      args.connectionState.reconnectTimer = null;
      void connect();
    }, retryDelayMs);
  }

  function clearReconnectTimer(): void {
    if (args.connectionState.reconnectTimer !== null) {
      clearTimeout(args.connectionState.reconnectTimer);
      args.connectionState.reconnectTimer = null;
    }
    args.connectionState.reconnectDeadlineMs = null;
  }

  function getRetryInMs(): number | null {
    if (args.connectionState.reconnectDeadlineMs === null) {
      return null;
    }
    return Math.max(0, args.connectionState.reconnectDeadlineMs - Date.now());
  }

  function resetReconnectState(): void {
    clearReconnectTimer();
    args.connectionState.reconnectAttempt = 0;
  }

  return {
    connect,
    scheduleReconnect,
    clearReconnectTimer,
    getRetryInMs,
    resetReconnectState,
  };
}

const ADMIN_SESSION_RESET_REASONS = new Set([
  "Admin kicked member",
  "Admin disconnected session",
  "Admin closed room",
]);
