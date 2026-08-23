import { randomBytes } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { ServerMessage } from "@bili-syncplay/protocol";
import type { WebSocket } from "ws";
import type { GlobalEventStore } from "../admin/global-event-store.js";
import { createAdminOverviewService } from "../admin/overview-service.js";
import { createAdminRoomQueryService } from "../admin/room-query-service.js";
import type { MetricsCollector } from "../admin/metrics.js";
import type { AdminCommandBus } from "../admin-command-bus.js";
import type { AdminSessionStore } from "../admin-session-store.js";
import type { GlobalAuditStore } from "../admin/global-audit-store.js";
import type { RoomEventBusMessage } from "../room-event-bus.js";
import type { RoomStore } from "../room-store.js";
import { createRoomService } from "../room-service.js";
import { createRuntimeIndexReaper } from "../runtime-index-reaper.js";
import { createSecurityPolicy } from "../security.js";
import type {
  AdminConfig,
  AdminUiConfig,
  LogEvent,
  PersistenceConfig,
  SecurityConfig,
} from "../types.js";
import type { RuntimeStore } from "../runtime-store.js";
import { createAdminServices } from "./admin-services.js";
import { createHttpRequestHandler } from "./http-handler.js";
import { createMetricsRequestHandler } from "./metrics-handler.js";
import type { ShutdownStep } from "./server-bootstrap.js";

export function resolveServerRuntimeDependencies(dependencies: {
  now?: () => number;
  generateToken?: () => string;
}): {
  now: () => number;
  generateToken: () => string;
} {
  return {
    now: dependencies.now ?? Date.now,
    generateToken:
      dependencies.generateToken ??
      (() => randomBytes(24).toString("base64url")),
  };
}

export async function createSharedAdminHttpBootstrap(args: {
  securityConfig: SecurityConfig;
  persistenceConfig: PersistenceConfig;
  roomStore: RoomStore;
  runtimeStore: RuntimeStore;
  eventStore: GlobalEventStore;
  roomService: ReturnType<typeof createRoomService>;
  send: (socket: WebSocket, message: ServerMessage) => void;
  publishRoomEvent: (message: RoomEventBusMessage) => Promise<void>;
  requestAdminCommand: AdminCommandBus["request"];
  logEvent: LogEvent;
  metricsCollector: MetricsCollector;
  now: () => number;
  adminConfig?: AdminConfig;
  adminUiConfig?: AdminUiConfig;
  serviceVersion: string;
  serviceName?: string;
  createOverviewService?: typeof createAdminOverviewService;
  createRoomQueryService?: typeof createAdminRoomQueryService;
  metricsPort?: number;
  adminSessionStoreOverride?: AdminSessionStore;
  auditStoreOverride?: GlobalAuditStore;
}): Promise<{
  securityPolicy: ReturnType<typeof createSecurityPolicy>;
  httpServer: HttpServer;
  metricsHttpServer: HttpServer | undefined;
  runtimeIndexReaper: ReturnType<typeof createRuntimeIndexReaper>;
  closeAdminActionService: () => Promise<void>;
  closeAdminServices: () => Promise<void>;
}> {
  const securityPolicy = createSecurityPolicy(args.securityConfig);
  const runtimeIndexReaper = createRuntimeIndexReaper({
    enabled:
      args.persistenceConfig.nodeHeartbeatEnabled &&
      args.persistenceConfig.runtimeStoreProvider === "redis",
    runtimeStore: args.runtimeStore,
    intervalMs: args.persistenceConfig.nodeHeartbeatIntervalMs,
    now: args.now,
    logEvent: args.logEvent,
    // A dead node's members vanish without anyone publishing their departure,
    // so the rooms they were in have to be told to rebuild — otherwise a share
    // owned by one of those seats is still cached by every survivor (#235).
    publishRoomStateUpdate: (roomCode) =>
      args.publishRoomEvent({
        type: "room_state_updated",
        roomCode,
        sourceInstanceId: args.persistenceConfig.instanceId,
        emittedAt: args.now(),
      }),
  });

  const {
    adminRouter,
    closeAdminActionService,
    close: closeAdminServices,
  } = await createAdminServices({
    securityConfig: args.securityConfig,
    persistenceConfig: args.persistenceConfig,
    roomStore: args.roomStore,
    runtimeStore: args.runtimeStore,
    eventStore: args.eventStore,
    roomService: args.roomService,
    send: args.send,
    publishRoomEvent: args.publishRoomEvent,
    requestAdminCommand: args.requestAdminCommand,
    logEvent: args.logEvent,
    metricsCollector: args.metricsCollector,
    now: args.now,
    adminConfig: args.adminConfig,
    serviceVersion: args.serviceVersion,
    serviceName: args.serviceName,
    createOverviewService: args.createOverviewService,
    createRoomQueryService: args.createRoomQueryService,
    getRequestIpKey: (request) =>
      securityPolicy.getRemoteAddress(request) ?? "unknown",
    adminSessionStoreOverride: args.adminSessionStoreOverride,
    auditStoreOverride: args.auditStoreOverride,
  });

  const metricsOnMain = args.metricsPort === undefined;
  const httpServer = createServer(
    createHttpRequestHandler({
      adminRouter,
      securityPolicy,
      adminUiConfig: args.adminUiConfig,
      metricsEnabled: metricsOnMain,
    }),
  );
  const metricsHttpServer = metricsOnMain
    ? undefined
    : createServer(
        createMetricsRequestHandler({
          getMetrics: () => args.metricsCollector.render(),
          metricsToken: args.securityConfig.metricsToken,
        }),
      );
  runtimeIndexReaper.start();

  return {
    securityPolicy,
    httpServer,
    metricsHttpServer,
    runtimeIndexReaper,
    closeAdminActionService,
    closeAdminServices,
  };
}

/**
 * Resolves once the server is no longer accepting connections.
 *
 * A server that never called `listen()` reports `ERR_SERVER_NOT_RUNNING`, which
 * is not a failure here: a stop signal that arrives during startup tears the
 * server down before the entry point ever starts listening, and treating that
 * as a failed step would make an otherwise clean shutdown exit non-zero.
 */
export function closeHttpServer(httpServer: HttpServer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (
        error &&
        (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
      ) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function createCloseHttpServerStep(
  httpServer: HttpServer,
): ShutdownStep {
  return {
    name: "close_http_server",
    run: () => closeHttpServer(httpServer),
  };
}
