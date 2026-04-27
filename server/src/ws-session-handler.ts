import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import {
  isClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from "@bili-syncplay/protocol";
import { createSessionRateLimitState } from "./rate-limit.js";
import { hasAttachedSocket } from "./types.js";
import type { LogEvent, SecurityConfig, Session } from "./types.js";
import {
  INTERNAL_SERVER_ERROR_MESSAGE,
  INVALID_CLIENT_MESSAGE_MESSAGE,
  INVALID_JSON_MESSAGE,
} from "./messages.js";
import type { RuntimeStore } from "./runtime-store.js";

const CLOSE_CODE_POLICY_VIOLATION = 1008;

export function send(
  socket: WebSocket,
  message: ServerMessage,
  logEvent?: LogEvent,
): void {
  if (socket.readyState === socket.OPEN) {
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      logEvent?.("ws_send_failed", {
        messageType: message.type,
        error: error instanceof Error ? error.message : "unknown_error",
      });
    }
  }
}

export function sendError(
  socket: WebSocket,
  code: ErrorCode,
  message: string,
): void {
  send(socket, { type: "error", payload: { code, message } });
}

export function rejectUpgrade(
  socket: Duplex,
  statusCode: number,
  statusText: string,
  details: Record<string, unknown>,
  logEvent: LogEvent,
): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
  logEvent("ws_connection_rejected", details);
}

export async function cleanupSessionAfterClose(options: {
  session: Session;
  code: number;
  reason: Buffer;
  messageHandler: { leaveRoom: (session: Session) => Promise<void> };
  runtimeStore: Pick<RuntimeStore, "unregisterSession">;
  securityPolicy: {
    decrementConnectionCount: (remoteAddress: string | null) => void;
  };
  logEvent: LogEvent;
  decodeCloseReason: (reason: Buffer) => string;
}): Promise<void> {
  const decodedReason = options.decodeCloseReason(options.reason);
  const roomCodeAtClose = options.session.roomCode;

  try {
    await options.messageHandler.leaveRoom(options.session);
  } catch (error) {
    options.logEvent("ws_connection_cleanup_failed", {
      sessionId: options.session.id,
      roomCode: roomCodeAtClose,
      remoteAddress: options.session.remoteAddress,
      origin: options.session.origin,
      result: "error",
      step: "leave_room",
      error: error instanceof Error ? error.message : "unknown_error",
    });
  } finally {
    try {
      options.runtimeStore.unregisterSession(options.session.id);
    } catch (error) {
      options.logEvent("ws_connection_cleanup_failed", {
        sessionId: options.session.id,
        roomCode: roomCodeAtClose,
        remoteAddress: options.session.remoteAddress,
        origin: options.session.origin,
        result: "error",
        step: "unregister_session",
        error: error instanceof Error ? error.message : "unknown_error",
      });
    }

    try {
      options.securityPolicy.decrementConnectionCount(
        options.session.remoteAddress,
      );
    } catch (error) {
      options.logEvent("ws_connection_cleanup_failed", {
        sessionId: options.session.id,
        roomCode: roomCodeAtClose,
        remoteAddress: options.session.remoteAddress,
        origin: options.session.origin,
        result: "error",
        step: "decrement_connection_count",
        error: error instanceof Error ? error.message : "unknown_error",
      });
    }
  }

  options.logEvent("ws_connection_closed", {
    sessionId: options.session.id,
    remoteAddress: options.session.remoteAddress,
    origin: options.session.origin,
    roomCode: options.session.roomCode ?? roomCodeAtClose,
    result: "closed",
    code: options.code,
    reason: decodedReason,
  });
}

export function createWsUpgradeHandler(args: {
  securityPolicy: {
    evaluateUpgrade: (request: IncomingMessage) => {
      ok: boolean;
      statusCode?: number;
      statusText?: string;
      context: { remoteAddress: string | null; origin: string | null };
      reason?: string;
    };
  };
  wss: WebSocketServer;
  logEvent: LogEvent;
}): (request: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (request, socket, head) => {
    const decision = args.securityPolicy.evaluateUpgrade(request);
    if (!decision.ok) {
      rejectUpgrade(
        socket,
        decision.statusCode!,
        decision.statusText!,
        {
          remoteAddress: decision.context.remoteAddress,
          origin: decision.context.origin,
          result: "rejected",
          reason: decision.reason,
        },
        args.logEvent,
      );
      return;
    }

    request.biliSyncPlayContext = decision.context as {
      remoteAddress: string | null;
      origin: string | null;
    };
    args.wss.handleUpgrade(request, socket, head, (ws) => {
      args.wss.emit("connection", ws, request);
    });
  };
}

export function createWsConnectionHandler(args: {
  securityPolicy: {
    getRemoteAddress: (request: IncomingMessage) => string | null;
    incrementConnectionCount: (remoteAddress: string | null) => void;
    decrementConnectionCount: (remoteAddress: string | null) => void;
  };
  securityConfig: SecurityConfig;
  instanceId: string;
  runtimeStore: RuntimeStore;
  messageHandler: {
    handleClientMessage: (
      session: Session,
      message: ClientMessage,
    ) => Promise<void>;
    leaveRoom: (session: Session) => Promise<void>;
  };
  logEvent: LogEvent;
  pendingSessionCleanup: Set<Promise<void>>;
  messageQueueDrainTimeoutMs?: number;
}): (socket: WebSocket, request: IncomingMessage) => void {
  const drainTimeoutMs = args.messageQueueDrainTimeoutMs ?? 10_000;
  return (socket, request) => {
    const context = request.biliSyncPlayContext ?? {
      remoteAddress: args.securityPolicy.getRemoteAddress(request),
      origin:
        typeof request.headers.origin === "string"
          ? request.headers.origin
          : null,
    };
    const session: Session = {
      id: randomUUID(),
      connectionState: "attached",
      socket,
      instanceId: args.instanceId,
      remoteAddress: context.remoteAddress,
      origin: context.origin,
      roomCode: null,
      memberId: null,
      displayName: `Guest-${Math.floor(Math.random() * 900 + 100)}`,
      memberToken: null,
      joinedAt: null,
      invalidMessageCount: 0,
      rateLimitState: createSessionRateLimitState(args.securityConfig),
    };

    args.securityPolicy.incrementConnectionCount(session.remoteAddress);
    args.runtimeStore.registerSession(session);
    args.logEvent("ws_connection_accepted", {
      sessionId: session.id,
      remoteAddress: session.remoteAddress,
      origin: session.origin,
      result: "ok",
    });

    let messageQueue = Promise.resolve();

    socket.on("message", (raw: RawData) => {
      messageQueue = messageQueue
        .catch((error: unknown) => {
          args.logEvent("ws_message_queue_failed", {
            sessionId: session.id,
            roomCode: session.roomCode,
            remoteAddress: session.remoteAddress,
            origin: session.origin,
            result: "error",
            error: error instanceof Error ? error.message : "unknown_error",
          });
        })
        .then(async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString());
          } catch {
            sendError(socket, "invalid_message", INVALID_JSON_MESSAGE);
            countInvalidMessage(
              session,
              "invalid_json",
              args.securityConfig,
              args.logEvent,
            );
            return;
          }

          if (!isClientMessage(parsed)) {
            sendError(
              socket,
              "invalid_message",
              INVALID_CLIENT_MESSAGE_MESSAGE,
            );
            countInvalidMessage(
              session,
              "invalid_client_message",
              args.securityConfig,
              args.logEvent,
            );
            return;
          }

          try {
            await args.messageHandler.handleClientMessage(session, parsed);
          } catch (error) {
            args.logEvent("ws_client_message_failed", {
              sessionId: session.id,
              roomCode: session.roomCode,
              remoteAddress: session.remoteAddress,
              origin: session.origin,
              result: "error",
              error: error instanceof Error ? error.message : "unknown_error",
            });
            sendError(socket, "internal_error", INTERNAL_SERVER_ERROR_MESSAGE);
          }
        });
    });

    socket.on("error", (error) => {
      args.logEvent("ws_connection_error", {
        sessionId: session.id,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        roomCode: session.roomCode,
        result: "error",
        error: error.message,
      });
    });

    socket.on("close", (code, reason) => {
      const decodeCloseReason = (r: Buffer): string => {
        const decoded = r.toString("utf8");
        return decoded.length > 0 ? decoded : "";
      };
      const inFlightMessageHandling = messageQueue;
      const cleanup = (async () => {
        // Bound the wait on in-flight handlers so a hung handleClientMessage
        // (e.g. a deadlocked downstream call) cannot stall cleanup forever.
        // Without a bound, the session would never unregister, the per-IP
        // connection count would never decrement, and reconnects from that
        // address would soon hit maxConnectionsPerIp.
        let drainTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const drainOutcome = await Promise.race<"drained" | "timeout">([
          inFlightMessageHandling.then(
            () => "drained" as const,
            () => "drained" as const,
          ),
          new Promise<"timeout">((resolve) => {
            drainTimeoutHandle = setTimeout(
              () => resolve("timeout"),
              drainTimeoutMs,
            );
          }),
        ]);
        if (drainTimeoutHandle !== null) {
          clearTimeout(drainTimeoutHandle);
          drainTimeoutHandle = null;
        }
        if (drainOutcome === "timeout") {
          // The in-flight handler may still be running when cleanup proceeds;
          // we accept that race in exchange for guaranteeing the session is
          // unregistered and the connection slot is freed.
          args.logEvent("ws_close_drain_timeout", {
            sessionId: session.id,
            roomCode: session.roomCode,
            remoteAddress: session.remoteAddress,
            origin: session.origin,
            result: "timeout",
            timeoutMs: drainTimeoutMs,
          });
        }
        await cleanupSessionAfterClose({
          session,
          code,
          reason,
          messageHandler: args.messageHandler,
          runtimeStore: args.runtimeStore,
          securityPolicy: args.securityPolicy,
          logEvent: args.logEvent,
          decodeCloseReason,
        });
      })();
      args.pendingSessionCleanup.add(cleanup);
      void cleanup.finally(() => {
        args.pendingSessionCleanup.delete(cleanup);
      });
    });
  };
}

function countInvalidMessage(
  session: Session,
  reason: string,
  securityConfig: SecurityConfig,
  logEvent: LogEvent,
): void {
  session.invalidMessageCount += 1;
  logEvent("invalid_message", {
    sessionId: session.id,
    roomCode: session.roomCode,
    remoteAddress: session.remoteAddress,
    origin: session.origin,
    result: "rejected",
    reason,
    invalidMessageCount: session.invalidMessageCount,
  });

  if (
    session.invalidMessageCount >=
      securityConfig.invalidMessageCloseThreshold &&
    hasAttachedSocket(session)
  ) {
    session.socket.close(
      CLOSE_CODE_POLICY_VIOLATION,
      "Too many invalid messages",
    );
  }
}
