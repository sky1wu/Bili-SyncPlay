import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import {
  closeHttpServer,
  createSharedAdminHttpBootstrap,
  resolveServerRuntimeDependencies,
} from "./bootstrap/admin-http-bootstrap.js";
import {
  createServerBootstrapContext,
  createSharedServerShutdownSteps,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
  runShutdownSteps,
  type ShutdownStepFailure,
} from "./bootstrap/server-bootstrap.js";
import { createAdminCommandConsumer } from "./admin-command-consumer.js";
import { createMessageHandler } from "./message-handler.js";
import { createNodeHeartbeat } from "./node-heartbeat.js";
import { createRoomEventConsumer } from "./room-event-consumer.js";
import { type RoomStore } from "./room-store.js";
import { createRoomReaper } from "./room-reaper.js";
import { createRoomService } from "./room-service.js";
import { createWsHeartbeat } from "./ws-heartbeat.js";
import type { RoomEventBusMessage } from "./room-event-bus.js";
import { type RuntimeStore } from "./runtime-store.js";
import { hasAttachedSocket } from "./types.js";
import {
  createWsConnectionHandler,
  createWsUpgradeHandler,
  send,
  sendError,
} from "./ws-session-handler.js";
import type { AdminSessionStore } from "./admin-session-store.js";
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
export type { ShutdownStepFailure } from "./bootstrap/server-bootstrap.js";
// Re-exported for backward compatibility with existing tests
export { cleanupSessionAfterClose } from "./ws-session-handler.js";

/** RFC 6455 "going away": the endpoint is shutting down, not failing. */
const CLOSE_CODE_GOING_AWAY = 1001;
const SHUTDOWN_CLOSE_REASON = "server_shutting_down";
const WS_CLOSE_HANDSHAKE_GRACE_MS = 2_000;

export type SyncServer = {
  httpServer: HttpServer;
  metricsHttpServer: HttpServer | undefined;
  /** Resolves with the steps that failed; an empty array means a clean teardown. */
  close: () => Promise<ShutdownStepFailure[]>;
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
  adminSessionStoreOverride?: AdminSessionStore;
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
    roomIndexReconciler,
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
    resolveRoomResidue: (roomCode) =>
      Promise.resolve(sharedRuntimeStore.hasRoomResidue(roomCode)),
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
    // The same clock the room service stamps `playback.serverTime` with, so the
    // snapshot age this consumer reports is a difference of two readings from
    // one time base rather than of two unrelated ones.
    now,
  });
  const adminCommandConsumer = await createAdminCommandConsumer({
    instanceId: persistenceConfig.instanceId,
    adminCommandBus,
    getLocalSession: (sessionId) => localRuntimeStore.getSession(sessionId),
    listLocalSessionsByRoom: (roomCode) =>
      localRuntimeStore.listSessionsByRoom(roomCode),
    evictMemberToken: (roomCode, memberId, memberToken, blockedUntil) =>
      runtimeStore.evictMemberToken(
        roomCode,
        memberId,
        memberToken,
        blockedUntil,
      ),
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
    onRoomJoined: async (session, roomCode) => {
      runtimeStore.registerSession(session);
      runtimeStore.markSessionJoinedRoom(session.id, roomCode);
      await runtimeStore.flush?.();
    },
    onRoomLeft: async (session, roomCode) => {
      runtimeStore.registerSession(session);
      runtimeStore.markSessionLeftRoom(session.id, roomCode);
      // Flushed like the join hook, and for a sharper reason: everything the
      // handler publishes next is read back off the room index this write
      // clears. Leaving it queued lets a `room:state` be rebuilt with the
      // leaver still in it (#235 review).
      await runtimeStore.flush?.();
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
    adminSessionStoreOverride: dependencies.adminSessionStoreOverride,
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: securityConfig.maxMessageBytes,
  });
  const pendingSessionCleanup = new Set<Promise<void>>();
  const wsHeartbeat = createWsHeartbeat({
    enabled: securityConfig.wsHeartbeatEnabled,
    intervalMs: securityConfig.wsHeartbeatIntervalMs,
    logEvent,
  });
  wsHeartbeat.start();

  let shuttingDown = false;
  httpServer.on(
    "upgrade",
    createWsUpgradeHandler({
      securityPolicy,
      wss,
      logEvent,
      isShuttingDown: () => shuttingDown,
    }),
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
      wsHeartbeat,
    }),
  );

  return {
    httpServer,
    metricsHttpServer,
    close: async () => {
      // Refuse upgrades from here on: a TCP connection accepted just before
      // httpServer.close() can still deliver its upgrade request during the
      // close-frame grace below, and a client that appears after the snapshot
      // would only ever be terminated (1006) or, later still, keep wss.close()
      // waiting until that step times out.
      shuttingDown = true;
      const maybeClosableRuntimeStore =
        sharedRuntimeStore === localRuntimeStore ? null : sharedRuntimeStore;

      // Stop accepting new connections immediately, before any shutdown step runs.
      // httpServer.close() returns synchronously after detaching the listener;
      // its callback only fires once existing sockets disconnect. Capture the
      // promises now so close_ws_clients can run with a stable client snapshot.
      const httpServerClosed = closeHttpServer(httpServer);
      httpServerClosed.catch(() => undefined);
      const metricsHttpServerClosed = metricsHttpServer
        ? closeHttpServer(metricsHttpServer)
        : null;
      metricsHttpServerClosed?.catch(() => undefined);

      return await runShutdownSteps(
        [
          {
            name: "stop_room_reaper",
            run: () => roomReaper.stop(),
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
            name: "stop_ws_heartbeat",
            run: () => {
              wsHeartbeat.stop();
            },
          },
          {
            name: "close_ws_clients",
            run: async () => {
              // Send a real close frame first: terminate() drops the TCP
              // connection with no close handshake, which every client reports
              // as 1006 (abnormal closure) — indistinguishable from a crash or a
              // network drop, and the extension surfaces it as an error state.
              // 1001 "going away" says the disconnect was intentional. Clients
              // still reconnect either way; only the reported reason changes.
              const closures = Array.from(wss.clients).map(
                (client) =>
                  new Promise<void>((resolve) => {
                    if (client.readyState === client.CLOSED) {
                      resolve();
                      return;
                    }
                    client.once("close", () => {
                      resolve();
                    });
                    if (client.readyState === client.OPEN) {
                      client.close(
                        CLOSE_CODE_GOING_AWAY,
                        SHUTDOWN_CLOSE_REASON,
                      );
                    }
                  }),
              );
              // A peer that never answers the close frame would otherwise keep
              // the socket in CLOSING until its own TCP timeout, so give the
              // handshake a bounded window and terminate whoever is left. The
              // window stays well inside this step's 5s cap: overrunning it
              // would be recorded as a failed step and exit the process non-zero.
              let graceTimer: ReturnType<typeof setTimeout> | undefined;
              const grace = new Promise<void>((resolve) => {
                graceTimer = setTimeout(resolve, WS_CLOSE_HANDSHAKE_GRACE_MS);
              });
              await Promise.race([
                Promise.allSettled(closures).then(() => undefined),
                grace,
              ]);
              if (graceTimer) {
                clearTimeout(graceTimer);
              }
              for (const client of wss.clients) {
                if (client.readyState !== client.CLOSED) {
                  client.terminate();
                }
              }
              await Promise.allSettled(closures);
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
                  httpServerClosed.then(() => resolve(), reject);
                });
              }),
          },
          ...(metricsHttpServerClosed
            ? [
                {
                  name: "close_metrics_http_server",
                  run: () => metricsHttpServerClosed,
                },
              ]
            : []),
          {
            name: "await_pending_session_cleanup",
            // Session cleanup now drains in-flight handlers before leaveRoom,
            // so it can take longer than the 5s shutdown-step default. Give it
            // 30s to fully drain so the subsequent flush_pending_room_event_publishes
            // step doesn't run while leaveRoom broadcasts are still being queued.
            timeoutMs: 30_000,
            run: async () => {
              while (pendingSessionCleanup.size > 0) {
                await Promise.allSettled(Array.from(pendingSessionCleanup));
              }
            },
          },
          {
            name: "flush_pending_room_event_publishes",
            // Allow generous time to drain in-flight publishes before
            // close_room_event_consumer / close_room_event_bus tears the bus down,
            // so we don't lose final broadcasts under Redis backpressure.
            timeoutMs: 30_000,
            run: () => messageHandler.flushPendingPublishes(),
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
            roomIndexReconciler,
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
