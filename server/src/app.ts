import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import {
  createCloseHttpServerStep,
  createSharedAdminHttpBootstrap,
  resolveServerRuntimeDependencies,
} from "./bootstrap/admin-http-bootstrap.js";
import {
  createServerBootstrapContext,
  createSharedServerShutdownSteps,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
  runShutdownSteps,
} from "./bootstrap/server-bootstrap.js";
import { createAdminCommandConsumer } from "./admin-command-consumer.js";
import { createMessageHandler } from "./message-handler.js";
import { createNodeHeartbeat } from "./node-heartbeat.js";
import { createRoomEventConsumer } from "./room-event-consumer.js";
import { type RoomStore } from "./room-store.js";
import { createRoomReaper } from "./room-reaper.js";
import { createRoomService } from "./room-service.js";
import type { RoomEventBusMessage } from "./room-event-bus.js";
import { type RuntimeStore } from "./runtime-store.js";
import { hasAttachedSocket } from "./types.js";
import {
  createWsConnectionHandler,
  createWsUpgradeHandler,
  send,
  sendError,
} from "./ws-session-handler.js";
import type {
  AdminConfig,
  AdminUiConfig,
  LogEvent,
  LogLevel,
  PersistenceConfig,
  SecurityConfig,
} from "./types.js";
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
export {
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
  hasClose,
  resolveServiceVersion,
  runShutdownSteps,
} from "./bootstrap/server-bootstrap.js";
// Re-exported for backward compatibility with existing tests
export { cleanupSessionAfterClose } from "./ws-session-handler.js";

export type SyncServer = {
  httpServer: HttpServer;
  metricsHttpServer: HttpServer | undefined;
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
  logLevel?: LogLevel;
  logSampling?: Record<string, number>;
  metricsPort?: number;
};

export async function createSyncServer(
  securityConfig: SecurityConfig = getDefaultSecurityConfig(),
  persistenceConfig: PersistenceConfig = getDefaultPersistenceConfig(),
  dependencies: SyncServerDependencies = {},
): Promise<SyncServer> {
  const { now, generateToken } = resolveServerRuntimeDependencies(dependencies);
  const {
    serviceVersion,
    roomStore,
    localRuntimeStore,
    sharedRuntimeStore,
    runtimeStore,
    adminCommandBus,
    roomEventBus,
    eventStore,
    logEvent,
    metricsCollector,
  } = await createServerBootstrapContext(persistenceConfig, dependencies, {
    useMirroredRuntimeStore: true,
    loggingHooks: {
      onRuntimeStorePendingOperationError: (writeLog, context, error) => {
        writeLog("redis_runtime_store_operation_failed", {
          instanceId: persistenceConfig.instanceId,
          provider: persistenceConfig.runtimeStoreProvider,
          operationName: context.operationName,
          pendingCount: context.pendingCount,
          reason: context.reason,
          result: context.reason === "backpressure" ? "rejected" : "error",
          error: error instanceof Error ? error.message : String(error),
        });
      },
      onRoomEventBusConnectionError: (writeLog, role, error) => {
        writeLog("room_event_bus_error", {
          busRole: role,
          instanceId: persistenceConfig.instanceId,
          provider: persistenceConfig.roomEventBusProvider,
          result: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      },
      onRoomEventBusInvalidMessage: (writeLog, payload) => {
        writeLog("room_event_bus_invalid_message", {
          instanceId: persistenceConfig.instanceId,
          provider: persistenceConfig.roomEventBusProvider,
          result: "rejected",
          payloadSize: payload.length,
        });
      },
      onRoomEventBusHandlerError: (writeLog, message, error) => {
        writeLog("room_event_handler_failed", {
          roomCode: message.roomCode,
          eventType: message.type,
          sourceInstanceId: message.sourceInstanceId,
          instanceId: persistenceConfig.instanceId,
          provider: persistenceConfig.roomEventBusProvider,
          result: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      },
    },
  });

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
    metricsCollector,
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
  const {
    securityPolicy,
    httpServer,
    metricsHttpServer,
    runtimeIndexReaper,
    closeAdminServices,
  } = await createSharedAdminHttpBootstrap({
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
    metricsCollector,
    now,
    adminConfig: dependencies.adminConfig,
    adminUiConfig: dependencies.adminUiConfig,
    serviceVersion,
    metricsPort: dependencies.metricsPort,
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: securityConfig.maxMessageBytes,
  });
  const pendingSessionCleanup = new Set<Promise<void>>();

  httpServer.on(
    "upgrade",
    createWsUpgradeHandler({ securityPolicy, wss, logEvent }),
  );

  wss.on(
    "connection",
    createWsConnectionHandler({
      securityPolicy,
      securityConfig,
      instanceId: persistenceConfig.instanceId,
      runtimeStore,
      messageHandler,
      logEvent,
      pendingSessionCleanup,
    }),
  );

  return {
    httpServer,
    metricsHttpServer,
    close: async () => {
      const maybeClosableRuntimeStore =
        sharedRuntimeStore === localRuntimeStore ? null : sharedRuntimeStore;

      await runShutdownSteps(
        [
          {
            name: "stop_room_reaper",
            run: () => {
              roomReaper.stop();
            },
          },
          {
            name: "stop_node_heartbeat",
            run: () => nodeHeartbeat.stop(),
          },
          {
            name: "stop_runtime_index_reaper",
            run: () => runtimeIndexReaper.stop(),
          },
          {
            name: "terminate_ws_clients",
            run: () => {
              for (const client of wss.clients) {
                client.terminate();
              }
            },
          },
          {
            name: "close_network_servers",
            run: () =>
              new Promise<void>((resolve, reject) => {
                wss.close((wsError) => {
                  if (wsError) {
                    reject(wsError);
                    return;
                  }
                  Promise.resolve(
                    createCloseHttpServerStep(httpServer).run(),
                  ).then(() => resolve(), reject);
                });
              }),
          },
          ...(metricsHttpServer
            ? [createCloseHttpServerStep(metricsHttpServer)]
            : []),
          {
            name: "await_pending_session_cleanup",
            run: () => Promise.allSettled(Array.from(pendingSessionCleanup)),
          },
          {
            name: "close_admin_command_consumer",
            run: () => adminCommandConsumer.close(),
          },
          {
            name: "close_room_event_consumer",
            run: () => roomEventConsumer.close(),
          },
          ...createSharedServerShutdownSteps({
            roomStore,
            eventStore,
            runtimeStore: maybeClosableRuntimeStore,
            runtimeStoreStepName: "close_shared_runtime_store",
            adminCommandBus,
            roomEventBus,
            closeAdminServices,
          }),
        ],
        logEvent,
      );
    },
  };
}
