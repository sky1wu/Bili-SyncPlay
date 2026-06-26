import type { ClientMessage, ServerMessage } from "@bili-syncplay/protocol";
import { isServerMessage, PROTOCOL_VERSION } from "@bili-syncplay/protocol";
import type { DebugLogEntry } from "../shared/messages";
import type { ConnectionState, RoomSessionState } from "./runtime-state";
import { getConnectionErrorMessage } from "./connection-error";
import { getExtensionOrigin } from "../shared/extension-origin";
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

    const extensionOrigin = getExtensionOrigin();
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

    const socket = new WebSocket(serverUrlResult.normalizedUrl);
    args.connectionState.socket = socket;

    // True once a newer connection has replaced this socket (e.g. a reconnect
    // opened while this one was still CLOSING — an explicit share queued in the
    // CLOSING micro-window opens the replacement). A superseded socket's events
    // must not mutate the live connection state, which the replacement now owns.
    const isSuperseded = () => args.connectionState.socket !== socket;

    socket.addEventListener("open", () => {
      if (isSuperseded()) {
        return;
      }
      args.connectionState.connected = true;
      args.connectionState.lastError = null;
      args.connectionState.reconnectAttempt = 0;
      args.connectionState.reconnectDeadlineMs = null;
      args.log("background", "Socket connected");
      args.onOpen();
      if (args.roomSessionState.pendingCreateRoom) {
        // Establishing/re-establishing a session: the cached room state is not
        // authoritative until the server replies with a fresh `room:state`.
        // Mark it so auto-share-next defers across the handshake window
        // (this `open` precedes the `room:joined`/`room:created` that arm the
        // bootstrap wait). Cleared once `room:state` lands.
        args.roomSessionState.awaitingFreshRoomState = true;
        args.roomSessionState.pendingCreateRoom = false;
        args.sendToServer({
          type: "room:create",
          payload: {
            displayName: args.roomSessionState.displayName ?? undefined,
            protocolVersion: PROTOCOL_VERSION,
          },
        });
      } else if (
        args.roomSessionState.pendingJoinRoomCode &&
        args.roomSessionState.pendingJoinToken &&
        !args.roomSessionState.pendingJoinRequestSent
      ) {
        args.roomSessionState.awaitingFreshRoomState = true;
        args.sendJoinRequest(
          args.roomSessionState.pendingJoinRoomCode,
          args.roomSessionState.pendingJoinToken,
        );
      } else if (
        args.roomSessionState.roomCode &&
        args.roomSessionState.joinToken
      ) {
        args.roomSessionState.awaitingFreshRoomState = true;
        args.sendJoinRequest(
          args.roomSessionState.roomCode,
          args.roomSessionState.joinToken,
        );
      }
      args.syncClock();
      args.startClockSyncTimer();
      args.notifyAll();
    });

    socket.addEventListener("message", (event) => {
      if (isSuperseded()) {
        return;
      }
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

    socket.addEventListener("close", (event) => {
      const closeReason = event.reason
        ? ` reason=${JSON.stringify(event.reason)}`
        : "";
      args.log(
        "background",
        `Socket closed code=${event.code} clean=${event.wasClean}${closeReason}`,
      );

      // Admin session resets are authoritative server actions: honour them even
      // for a superseded socket so a kicked / disconnected / closed-room session
      // is torn down rather than silently rejoined by the replacement.
      if (event.reason && ADMIN_SESSION_RESET_REASONS.has(event.reason)) {
        if (!isSuperseded()) {
          args.connectionState.connected = false;
          args.stopClockSyncTimer();
        }
        args.onAdminSessionReset(
          args.formatAdminSessionResetReason(event.reason),
        );
        return;
      }

      // A superseded socket's close belongs to a connection the replacement has
      // already taken over. Acting here would clear a share-confirmation marker
      // the new connection is still confirming (`flushPendingShare` nulls
      // `pendingSharedVideo` right after rejoin, so the queued-share check below
      // can no longer tell a re-flushed share from a lost one), flip `connected`
      // false on the live socket, and schedule a redundant reconnect.
      if (isSuperseded()) {
        return;
      }

      args.connectionState.connected = false;
      args.stopClockSyncTimer();
      // Keep the pending local-share confirmation marker while a share is queued
      // for re-flush on reconnect (the CLOSING/offline branch of
      // `queueOrSendSharedVideo` set `pendingSharedVideo`): the reconnect
      // `room:joined` re-sends it and the surviving marker suppresses the
      // interim stale `room:state` until the re-shared video is confirmed. With
      // nothing queued the in-flight share is lost, so clear the marker and let
      // fresh room state apply instead of stranding the client on it.
      if (args.roomSessionState.pendingSharedVideo === null) {
        args.clearPendingLocalShare("socket closed before share confirmation");
      }
      scheduleReconnect();
      args.notifyAll();
    });

    socket.addEventListener("error", () => {
      if (isSuperseded()) {
        return;
      }
      args.connectionState.lastError = getConnectionErrorMessage({
        healthcheckReachable,
        extensionOrigin,
      });
      args.connectionState.connected = false;
      args.stopClockSyncTimer();
      // See the close handler: preserve the marker only while a queued share is
      // still pending re-flush, otherwise clear it.
      if (args.roomSessionState.pendingSharedVideo === null) {
        args.clearPendingLocalShare("socket error before share confirmation");
      }
      args.logConnectionProbeFailure({
        stage: "websocket",
        serverUrl: serverUrlResult.normalizedUrl,
        extensionOrigin,
        readyState: socket.readyState,
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
