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
  getPendingLocalShareGeneration: () => number | null;
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
    const probe = openSocketWithProbe(serverUrlResult.normalizedUrl);
    args.connectionState.connectProbe = probe;
    try {
      await probe;
    } finally {
      // Only clear if this is still the active probe. An authoritative teardown
      // (admin reset / leave) can abort this probe AND null `connectProbe` so a
      // subsequent `connect()` starts fresh instead of awaiting this doomed
      // promise; an unconditional clear here would then wipe that newer probe's
      // reference when this aborted one finally settles.
      if (args.connectionState.connectProbe === probe) {
        args.connectionState.connectProbe = null;
      }
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

    // Capture the abort generation before the first await. An authoritative
    // teardown (admin session reset / explicit leave) that lands while this
    // probe is awaiting connection-check/healthcheck bumps `connectEpoch`, so a
    // resuming probe must abort rather than open a room-less ghost connection
    // (which would also clear the teardown's `lastError`).
    const probeEpoch = args.connectionState.connectEpoch;
    const isProbeAborted = () =>
      args.connectionState.connectEpoch !== probeEpoch;

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
          if (isProbeAborted()) {
            return;
          }
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
        if (isProbeAborted()) {
          return;
        }
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

    if (isProbeAborted()) {
      return;
    }

    const socket = new WebSocket(serverUrlResult.normalizedUrl);
    // Tag this socket with a fresh generation so its handlers can tell a marker
    // it owns from one a newer connection set (see the superseded close below).
    args.connectionState.socketGeneration += 1;
    const socketGeneration = args.connectionState.socketGeneration;
    // A reconnect opened in the CLOSING micro-window replaces a socket whose
    // `connected` is still the stale `true` of the dying connection, but this
    // new socket is only CONNECTING until its `open` fires. Reflect that now:
    // callers that gate on `connected` right after `await connect()`
    // (requestCreateRoom / requestJoinRoom) would otherwise hand
    // `room:create` / `room:join` to a non-OPEN socket (silently dropped by
    // `sendToServer`) and mark the request as already sent, so the `open`
    // handler never re-issues it.
    args.connectionState.connected = false;
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
        args.stopClockSyncTimer();
        // Tear down the *live* connection. When this admin close arrived on a
        // socket that a CLOSING-window reconnect had already replaced, the
        // replacement is the live socket and may have rejoined; closing it stops
        // the kicked session from lingering as a ghost connection. Null the ref
        // before closing so the replacement's own close event is treated as
        // superseded and cannot schedule a reconnect (`onAdminSessionReset` then
        // clears the room context, which also resets the reconnect state).
        const liveSocket = args.connectionState.socket;
        args.connectionState.socket = null;
        args.connectionState.connected = false;
        // Abort any in-flight connect probe: when this admin close arrived while
        // a CLOSING-window reconnect was still awaiting connection-check /
        // healthcheck (the replacement socket is not created yet, so closing
        // `liveSocket` cannot reach it), the resuming probe would otherwise open
        // a room-less ghost connection and clear this reset's `lastError`. Also
        // null `connectProbe`: the aborted probe will short-circuit, but leaving
        // its promise in place would make a later create/join reuse it (and
        // never open a connection).
        args.connectionState.connectEpoch += 1;
        args.connectionState.connectProbe = null;
        if (liveSocket && liveSocket !== socket) {
          liveSocket.close();
        }
        args.onAdminSessionReset(
          args.formatAdminSessionResetReason(event.reason),
        );
        return;
      }

      // A superseded socket's close belongs to a connection the replacement has
      // already taken over, so it must not flip `connected` false on the live
      // socket or schedule a redundant reconnect. It must still tidy the marker
      // though, gated on two checks:
      //   1. `pendingSharedVideo` is null — nothing is still queued for the
      //      replacement's rejoin to re-flush. While a share is queued the marker
      //      is preserved (the rejoin re-sends it and reconfirms).
      //   2. The marker's generation matches THIS socket — it owns the last send
      //      the marker is tracking. A direct send stamps the marker with the
      //      live socket's generation; a re-flush (`flushPendingShare`) transfers
      //      ownership to the socket it re-sends on. So once a queued share has
      //      been re-flushed on the replacement, the marker belongs to the
      //      replacement and THIS old socket's late close no longer matches it
      //      (leaving it for the replacement to confirm). Conversely a fresh
      //      direct share the user sent on the new connection after this socket
      //      was superseded carries the newer generation and is also left intact.
      // When both hold the marker can only be reconfirmed by a `video:share` this
      // dead socket may have dropped on close, so it would suppress the
      // post-reconnect `room:state` until the 10s timeout; clear it.
      if (isSuperseded()) {
        if (
          args.roomSessionState.pendingSharedVideo === null &&
          args.getPendingLocalShareGeneration() === socketGeneration
        ) {
          args.clearPendingLocalShare(
            "superseded socket closed before share confirmation",
          );
        }
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
