import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  isClientMessage,
  type ErrorCode,
  type ServerMessage,
} from "@bili-syncplay/protocol";
import { createEventStore } from "./admin/event-store.js";
import { createRedisEventStore } from "./admin/redis-event-store.js";
import { createAdminServices } from "./bootstrap/admin-services.js";
import { createHttpRequestHandler } from "./bootstrap/http-handler.js";
import { createStructuredLogger } from "./logger.js";
import {
  createInMemoryAdminCommandBus,
  createNoopAdminCommandBus,
  type AdminCommandBus,
} from "./admin-command-bus.js";
import { createAdminCommandConsumer } from "./admin-command-consumer.js";
import { createMessageHandler } from "./message-handler.js";
import { createMirroredRuntimeStore } from "./mirrored-runtime-store.js";
import { createNodeHeartbeat } from "./node-heartbeat.js";
import { createSessionRateLimitState } from "./rate-limit.js";
import { createRedisAdminCommandBus } from "./redis-admin-command-bus.js";
import { createRedisRoomEventBus } from "./redis-room-event-bus.js";
import { createRoomEventConsumer } from "./room-event-consumer.js";
import { createInMemoryRoomStore, type RoomStore } from "./room-store.js";
import { createRoomReaper } from "./room-reaper.js";
import { createRoomService } from "./room-service.js";
import { createRuntimeIndexReaper } from "./runtime-index-reaper.js";
import { createRedisRoomStore } from "./redis-room-store.js";
import { createRedisRuntimeStore } from "./redis-runtime-store.js";
import {
  getRedisAdminCommandChannelPrefix,
  getRedisAdminCommandResultChannelPrefix,
  getRedisEventStreamKey,
  getRedisRoomEventChannel,
  getRedisRuntimeKeyPrefix,
} from "./redis-namespace.js";
import type { RoomEventBusMessage } from "./room-event-bus.js";
import {
  createInMemoryRoomEventBus,
  createNoopRoomEventBus,
  type RoomEventBus,
} from "./room-event-bus.js";
import {
  createInMemoryRuntimeStore,
  type RuntimeStore,
} from "./runtime-store.js";
import { createSecurityPolicy } from "./security.js";
import type { GlobalEventStore } from "./admin/global-event-store.js";
import { hasAttachedSocket } from "./types.js";
import type {
  AdminConfig,
  AdminUiConfig,
  LogEvent,
  PersistenceConfig,
  SecurityConfig,
  Session,
} from "./types.js";
import {
  INTERNAL_SERVER_ERROR_MESSAGE,
  INVALID_CLIENT_MESSAGE_MESSAGE,
  INVALID_JSON_MESSAGE,
} from "./messages.js";

export type {
  AdminConfig,
  AdminUiConfig,
  PersistenceConfig,
  SecurityConfig,
} from "./types.js";
export {
  INTERNAL_SERVER_ERROR_MESSAGE,
  INVALID_CLIENT_MESSAGE_MESSAGE,
  INVALID_JSON_MESSAGE,
} from "./messages.js";

const CLOSE_CODE_POLICY_VIOLATION = 1008;
const PACKAGE_JSON_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../package.json",
);

let cachedServiceVersion: string | null = null;

export type SyncServer = {
  httpServer: HttpServer;
  close: () => Promise<void>;
};

export type SyncServerDependencies = {
  roomStore?: RoomStore;
  logEvent?: LogEvent;
  generateToken?: () => string;
  now?: () => number;
  adminConfig?: AdminConfig;
  adminUiConfig?: AdminUiConfig;
  serviceVersion?: string;
};

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

async function resolveServiceVersion(): Promise<string> {
  if (process.env.npm_package_version) {
    return process.env.npm_package_version;
  }

  if (cachedServiceVersion) {
    return cachedServiceVersion;
  }

  try {
    const packageJson = JSON.parse(
      await readFile(PACKAGE_JSON_PATH, "utf8"),
    ) as { version?: unknown };
    if (
      typeof packageJson.version === "string" &&
      packageJson.version.length > 0
    ) {
      cachedServiceVersion = packageJson.version;
      return packageJson.version;
    }
  } catch {
    // Keep the legacy fallback when package metadata is unavailable.
  }

  return "0.0.0";
}

export function getDefaultSecurityConfig(): SecurityConfig {
  return {
    allowedOrigins: [],
    allowMissingOriginInDev: false,
    trustProxyHeaders: false,
    maxConnectionsPerIp: 10,
    connectionAttemptsPerMinute: 20,
    maxMembersPerRoom: 8,
    maxMessageBytes: 8 * 1024,
    invalidMessageCloseThreshold: 3,
    rateLimits: {
      roomCreatePerMinute: 3,
      roomJoinPerMinute: 10,
      videoSharePer10Seconds: 3,
      playbackUpdatePerSecond: 8,
      playbackUpdateBurst: 12,
      syncRequestPer10Seconds: 6,
      syncPingPerSecond: 1,
      syncPingBurst: 2,
    },
  };
}

export function getDefaultPersistenceConfig(): PersistenceConfig {
  return {
    provider: "memory",
    runtimeStoreProvider: "memory",
    roomEventBusProvider: "memory",
    adminCommandBusProvider: "memory",
    nodeHeartbeatEnabled: false,
    nodeHeartbeatIntervalMs: 15_000,
    nodeHeartbeatTtlMs: 45_000,
    emptyRoomTtlMs: 15 * 60 * 1000,
    roomCleanupIntervalMs: 60 * 1000,
    redisUrl: "redis://localhost:6379",
    redisNamespace: undefined,
    instanceId: "instance-1",
  };
}

export async function createSyncServer(
  securityConfig: SecurityConfig = getDefaultSecurityConfig(),
  persistenceConfig: PersistenceConfig = getDefaultPersistenceConfig(),
  dependencies: SyncServerDependencies = {},
): Promise<SyncServer> {
  const serviceVersion =
    dependencies.serviceVersion ?? (await resolveServiceVersion());
  const now = dependencies.now ?? Date.now;
  const generateToken =
    dependencies.generateToken ?? (() => randomBytes(24).toString("base64url"));
  const roomStore =
    dependencies.roomStore ??
    (persistenceConfig.provider === "redis"
      ? await createRedisRoomStore(persistenceConfig.redisUrl, {
          namespace: persistenceConfig.redisNamespace,
        })
      : createInMemoryRoomStore({ now }));
  const localRuntimeStore = createInMemoryRuntimeStore(now);
  const sharedRuntimeStore =
    persistenceConfig.runtimeStoreProvider === "redis"
      ? await createRedisRuntimeStore(persistenceConfig.redisUrl, {
          now,
          keyPrefix: getRedisRuntimeKeyPrefix(persistenceConfig.redisNamespace),
          onPendingOperationError: (context, error) => {
            logEvent("redis_runtime_store_operation_failed", {
              instanceId: persistenceConfig.instanceId,
              provider: persistenceConfig.runtimeStoreProvider,
              operationName: context.operationName,
              pendingCount: context.pendingCount,
              reason: context.reason,
              result: context.reason === "backpressure" ? "rejected" : "error",
              error: error instanceof Error ? error.message : String(error),
            });
          },
        })
      : localRuntimeStore;
  const runtimeStore =
    sharedRuntimeStore === localRuntimeStore
      ? localRuntimeStore
      : createMirroredRuntimeStore(localRuntimeStore, sharedRuntimeStore);
  const adminCommandBus =
    persistenceConfig.adminCommandBusProvider === "redis"
      ? await createRedisAdminCommandBus(persistenceConfig.redisUrl, {
          commandChannelPrefix: getRedisAdminCommandChannelPrefix(
            persistenceConfig.redisNamespace,
          ),
          resultChannelPrefix: getRedisAdminCommandResultChannelPrefix(
            persistenceConfig.redisNamespace,
          ),
        })
      : persistenceConfig.adminCommandBusProvider === "none"
        ? createNoopAdminCommandBus()
        : createInMemoryAdminCommandBus();
  const roomEventBus =
    persistenceConfig.roomEventBusProvider === "redis"
      ? await createRedisRoomEventBus(persistenceConfig.redisUrl, {
          channel: getRedisRoomEventChannel(persistenceConfig.redisNamespace),
          onConnectionError: (role, error) => {
            logEvent("room_event_bus_error", {
              busRole: role,
              instanceId: persistenceConfig.instanceId,
              provider: persistenceConfig.roomEventBusProvider,
              result: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          },
          onInvalidMessage: (payload) => {
            logEvent("room_event_bus_invalid_message", {
              instanceId: persistenceConfig.instanceId,
              provider: persistenceConfig.roomEventBusProvider,
              result: "rejected",
              payloadSize: payload.length,
            });
          },
          onHandlerError: (message, error) => {
            logEvent("room_event_handler_failed", {
              roomCode: message.roomCode,
              eventType: message.type,
              sourceInstanceId: message.sourceInstanceId,
              instanceId: persistenceConfig.instanceId,
              provider: persistenceConfig.roomEventBusProvider,
              result: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          },
        })
      : persistenceConfig.roomEventBusProvider === "none"
        ? createNoopRoomEventBus()
        : createInMemoryRoomEventBus();
  const eventStore =
    dependencies.adminConfig?.eventStoreProvider === "redis"
      ? await createRedisEventStore(persistenceConfig.redisUrl, {
          streamKey: getRedisEventStreamKey(persistenceConfig.redisNamespace),
        })
      : createEventStore();
  const logEvent =
    dependencies.logEvent ??
    createStructuredLogger(undefined, eventStore, runtimeStore);
  const securityPolicy = createSecurityPolicy(securityConfig);

  const roomService = createRoomService({
    config: securityConfig,
    persistence: persistenceConfig,
    roomStore,
    runtimeStore,
    resolveActiveRoom: (roomCode) =>
      Promise.resolve(sharedRuntimeStore.getRoom(roomCode)),
    resolveMemberIdByToken: (roomCode, memberToken) =>
      Promise.resolve(
        sharedRuntimeStore.findMemberIdByToken(roomCode, memberToken),
      ),
    resolveBlockedMemberToken: (roomCode, memberToken, currentTime) =>
      Promise.resolve(
        sharedRuntimeStore.isMemberTokenBlocked(
          roomCode,
          memberToken,
          currentTime,
        ),
      ),
    generateToken,
    logEvent,
    now,
  });

  async function publishRoomEvent(message: RoomEventBusMessage): Promise<void> {
    try {
      await roomEventBus.publish(message);
      logEvent("room_event_published", {
        roomCode: message.roomCode,
        eventType: message.type,
        sourceInstanceId: message.sourceInstanceId,
        provider: persistenceConfig.roomEventBusProvider,
        result: "ok",
      });
    } catch (error) {
      logEvent("room_event_publish_failed", {
        roomCode: message.roomCode,
        eventType: message.type,
        sourceInstanceId: message.sourceInstanceId,
        provider: persistenceConfig.roomEventBusProvider,
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  const roomEventConsumer = await createRoomEventConsumer({
    roomEventBus,
    getRoomStateByCode: (roomCode) => roomService.getRoomStateByCode(roomCode),
    listLocalSessionsByRoom: (roomCode) =>
      localRuntimeStore.listSessionsByRoom(roomCode),
    send,
    instanceId: persistenceConfig.instanceId,
    logEvent,
  });
  const adminCommandConsumer = await createAdminCommandConsumer({
    instanceId: persistenceConfig.instanceId,
    adminCommandBus,
    getLocalSession: (sessionId) => localRuntimeStore.getSession(sessionId),
    listLocalSessionsByRoom: (roomCode) =>
      localRuntimeStore.listSessionsByRoom(roomCode),
    blockMemberToken: (roomCode, memberToken, expiresAt) =>
      runtimeStore.blockMemberToken(roomCode, memberToken, expiresAt),
    disconnectSessionSocket: (session, reason) => {
      if (!hasAttachedSocket(session)) {
        return;
      }
      if (session.socket.readyState === session.socket.OPEN) {
        session.socket.close(1000, reason);
        return;
      }
      session.socket.terminate();
    },
    now,
    logEvent,
  });

  const messageHandler = createMessageHandler({
    config: securityConfig,
    roomService,
    logEvent,
    send,
    sendError,
    publishRoomEvent,
    instanceId: persistenceConfig.instanceId,
    onRoomJoined: (session, roomCode) => {
      runtimeStore.registerSession(session);
      runtimeStore.markSessionJoinedRoom(session.id, roomCode);
    },
    onRoomLeft: (session, roomCode) => {
      runtimeStore.registerSession(session);
      runtimeStore.markSessionLeftRoom(session.id, roomCode);
    },
    now,
  });

  const roomReaper = createRoomReaper({
    intervalMs: persistenceConfig.roomCleanupIntervalMs,
    deleteExpiredRooms: roomService.deleteExpiredRooms,
    logEvent,
    now,
  });
  const nodeHeartbeatRuntimeStore = {
    ...localRuntimeStore,
    heartbeatNode: (
      status: Awaited<ReturnType<RuntimeStore["listNodeStatuses"]>>[number],
    ) => sharedRuntimeStore.heartbeatNode(status),
  } satisfies RuntimeStore;
  const nodeHeartbeat = createNodeHeartbeat({
    enabled: persistenceConfig.nodeHeartbeatEnabled,
    instanceId: persistenceConfig.instanceId,
    serviceVersion,
    runtimeStore: nodeHeartbeatRuntimeStore,
    intervalMs: persistenceConfig.nodeHeartbeatIntervalMs,
    ttlMs: persistenceConfig.nodeHeartbeatTtlMs,
    now,
    logEvent,
  });
  nodeHeartbeat.start();
  const runtimeIndexReaper = createRuntimeIndexReaper({
    enabled:
      persistenceConfig.nodeHeartbeatEnabled &&
      persistenceConfig.runtimeStoreProvider === "redis",
    runtimeStore,
    intervalMs: persistenceConfig.nodeHeartbeatIntervalMs,
    now,
    logEvent,
  });
  runtimeIndexReaper.start();
  const { adminRouter, close: closeAdminServices } = await createAdminServices({
    securityConfig,
    persistenceConfig,
    roomStore,
    runtimeStore,
    eventStore,
    roomService,
    send,
    publishRoomEvent,
    requestAdminCommand: (command, timeoutMs) =>
      adminCommandBus.request(command, timeoutMs),
    logEvent,
    now,
    adminConfig: dependencies.adminConfig,
    serviceVersion,
  });

  const httpServer = createServer(
    createHttpRequestHandler({
      adminRouter,
      securityPolicy,
      adminUiConfig: dependencies.adminUiConfig,
    }),
  );

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: securityConfig.maxMessageBytes,
  });
  const pendingSessionCleanup = new Set<Promise<void>>();

  function send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function sendError(
    socket: WebSocket,
    code: ErrorCode,
    message: string,
  ): void {
    send(socket, {
      type: "error",
      payload: { code, message },
    });
  }

  function parseIncomingMessage(raw: RawData): unknown {
    return JSON.parse(raw.toString()) as unknown;
  }

  function decodeCloseReason(reason: Buffer): string {
    const decoded = reason.toString("utf8");
    return decoded.length > 0 ? decoded : "";
  }

  function countInvalidMessage(session: Session, reason: string): void {
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

  function rejectUpgrade(
    socket: import("node:stream").Duplex,
    statusCode: number,
    statusText: string,
    details: Record<string, unknown>,
  ): void {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
    logEvent("ws_connection_rejected", details);
  }

  httpServer.on("upgrade", (request, socket, head) => {
    const decision = securityPolicy.evaluateUpgrade(request);
    if (!decision.ok) {
      rejectUpgrade(socket, decision.statusCode, decision.statusText, {
        remoteAddress: decision.context.remoteAddress,
        origin: decision.context.origin,
        result: "rejected",
        reason: decision.reason,
      });
      return;
    }

    request.biliSyncPlayContext = decision.context;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket, request) => {
    const context = request.biliSyncPlayContext ?? {
      remoteAddress: securityPolicy.getRemoteAddress(request),
      origin:
        typeof request.headers.origin === "string"
          ? request.headers.origin
          : null,
    };
    const session: Session = {
      id: randomUUID(),
      connectionState: "attached",
      socket,
      instanceId: persistenceConfig.instanceId,
      remoteAddress: context.remoteAddress,
      origin: context.origin,
      roomCode: null,
      memberId: null,
      displayName: `Guest-${Math.floor(Math.random() * 900 + 100)}`,
      memberToken: null,
      joinedAt: null,
      invalidMessageCount: 0,
      rateLimitState: createSessionRateLimitState(securityConfig),
    };

    securityPolicy.incrementConnectionCount(session.remoteAddress);
    runtimeStore.registerSession(session);
    logEvent("ws_connection_accepted", {
      sessionId: session.id,
      remoteAddress: session.remoteAddress,
      origin: session.origin,
      result: "ok",
    });
    let messageQueue = Promise.resolve();

    socket.on("message", (raw) => {
      messageQueue = messageQueue
        .catch((error: unknown) => {
          logEvent("ws_message_queue_failed", {
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
            parsed = parseIncomingMessage(raw);
          } catch {
            sendError(socket, "invalid_message", INVALID_JSON_MESSAGE);
            countInvalidMessage(session, "invalid_json");
            return;
          }

          if (!isClientMessage(parsed)) {
            sendError(
              socket,
              "invalid_message",
              INVALID_CLIENT_MESSAGE_MESSAGE,
            );
            countInvalidMessage(session, "invalid_client_message");
            return;
          }

          try {
            await messageHandler.handleClientMessage(session, parsed);
          } catch (error) {
            logEvent("ws_client_message_failed", {
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
      logEvent("ws_connection_error", {
        sessionId: session.id,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        roomCode: session.roomCode,
        result: "error",
        error: error.message,
      });
    });

    socket.on("close", (code, reason) => {
      const cleanup = cleanupSessionAfterClose({
        session,
        code,
        reason,
        messageHandler,
        runtimeStore,
        securityPolicy,
        logEvent,
        decodeCloseReason,
      });
      pendingSessionCleanup.add(cleanup);
      void cleanup.finally(() => {
        pendingSessionCleanup.delete(cleanup);
      });
    });
  });

  return {
    httpServer,
    close: async () => {
      roomReaper.stop();
      await nodeHeartbeat.stop();
      await runtimeIndexReaper.stop();
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((wsError) => {
          if (wsError) {
            reject(wsError);
            return;
          }
          httpServer.close((httpError) => {
            if (httpError) {
              reject(httpError);
              return;
            }
            resolve();
          });
        });
      });
      await Promise.allSettled(Array.from(pendingSessionCleanup));
      const maybeClosableStore = roomStore as RoomStore & {
        close?: () => Promise<void>;
      };
      if (typeof maybeClosableStore.close === "function") {
        await maybeClosableStore.close();
      }
      const maybeClosableEventStore = eventStore as GlobalEventStore & {
        close?: () => Promise<void>;
      };
      if (typeof maybeClosableEventStore.close === "function") {
        await maybeClosableEventStore.close();
      }
      if (sharedRuntimeStore !== localRuntimeStore) {
        const maybeClosableRuntimeStore =
          sharedRuntimeStore as typeof sharedRuntimeStore & {
            close?: () => Promise<void>;
          };
        if (typeof maybeClosableRuntimeStore.close === "function") {
          await maybeClosableRuntimeStore.close();
        }
      }
      await adminCommandConsumer.close();
      const maybeClosableAdminCommandBus =
        adminCommandBus as AdminCommandBus & {
          close?: () => Promise<void>;
        };
      if (typeof maybeClosableAdminCommandBus.close === "function") {
        await maybeClosableAdminCommandBus.close();
      }
      await roomEventConsumer.close();
      const maybeClosableRoomEventBus = roomEventBus as RoomEventBus & {
        close?: () => Promise<void>;
      };
      if (typeof maybeClosableRoomEventBus.close === "function") {
        await maybeClosableRoomEventBus.close();
      }
      await closeAdminServices();
    },
  };
}
