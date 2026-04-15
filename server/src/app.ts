import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createEventStore } from "./admin/event-store.js";
import { createRedisEventStore } from "./admin/redis-event-store.js";
import { createAdminServices } from "./bootstrap/admin-services.js";
import { createHttpRequestHandler } from "./bootstrap/http-handler.js";
import { createStructuredLogger } from "./logger.js";
import {
  createInMemoryAdminCommandBus,
  createNoopAdminCommandBus,
} from "./admin-command-bus.js";
import { createAdminCommandConsumer } from "./admin-command-consumer.js";
import { createMessageHandler } from "./message-handler.js";
import { createMirroredRuntimeStore } from "./mirrored-runtime-store.js";
import { createNodeHeartbeat } from "./node-heartbeat.js";
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
} from "./room-event-bus.js";
import {
  createInMemoryRuntimeStore,
  type RuntimeStore,
} from "./runtime-store.js";
import { createSecurityPolicy } from "./security.js";
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
// Re-exported for backward compatibility with existing tests
export { cleanupSessionAfterClose } from "./ws-session-handler.js";

const DEFAULT_CLOSE_STEP_TIMEOUT_MS = 5_000;
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

type Closeable = {
  close: () => Promise<void>;
};

type ShutdownStep = {
  name: string;
  run: () => Promise<void> | void;
  timeoutMs?: number;
};

export async function runShutdownSteps(
  steps: ShutdownStep[],
  logEvent: LogEvent,
  defaultTimeoutMs = DEFAULT_CLOSE_STEP_TIMEOUT_MS,
): Promise<void> {
  for (const step of steps) {
    const timeoutMs = step.timeoutMs ?? defaultTimeoutMs;
    const pendingStep = Promise.resolve().then(step.run);
    void pendingStep.catch(() => undefined);

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        pendingStep,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Shutdown step timed out: ${step.name}.`));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        error.message === `Shutdown step timed out: ${step.name}.`;
      logEvent("server_shutdown_step_failed", {
        step: step.name,
        timeoutMs,
        result: timedOut ? "timeout" : "error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

export function hasClose(value: object | null | undefined): value is Closeable {
  return typeof value === "object" && value !== null && "close" in value;
}

export async function resolveServiceVersion(): Promise<string> {
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
    trustedProxyAddresses: [],
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
  const purgedStartupSessions =
    (await runtimeStore.purgeSessionsByInstance?.(
      persistenceConfig.instanceId,
    )) ?? 0;
  if (purgedStartupSessions > 0) {
    logEvent("runtime_instance_sessions_purged", {
      instanceId: persistenceConfig.instanceId,
      purgedSessions: purgedStartupSessions,
      result: "ok",
    });
  }
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
                  httpServer.close((httpError) => {
                    if (httpError) {
                      reject(httpError);
                      return;
                    }
                    resolve();
                  });
                });
              }),
          },
          {
            name: "await_pending_session_cleanup",
            run: () => Promise.allSettled(Array.from(pendingSessionCleanup)),
          },
          {
            name: "close_room_store",
            run: () => (hasClose(roomStore) ? roomStore.close() : undefined),
          },
          {
            name: "close_event_store",
            run: () => (hasClose(eventStore) ? eventStore.close() : undefined),
          },
          {
            name: "close_shared_runtime_store",
            run: () =>
              hasClose(maybeClosableRuntimeStore)
                ? maybeClosableRuntimeStore.close()
                : undefined,
          },
          {
            name: "close_admin_command_consumer",
            run: () => adminCommandConsumer.close(),
          },
          {
            name: "close_admin_command_bus",
            run: () =>
              hasClose(adminCommandBus) ? adminCommandBus.close() : undefined,
          },
          {
            name: "close_room_event_consumer",
            run: () => roomEventConsumer.close(),
          },
          {
            name: "close_room_event_bus",
            run: () =>
              hasClose(roomEventBus) ? roomEventBus.close() : undefined,
          },
          {
            name: "close_admin_services",
            run: () => closeAdminServices(),
          },
        ],
        logEvent,
      );
    },
  };
}
