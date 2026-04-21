import { randomBytes } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { ServerMessage } from "@bili-syncplay/protocol";
import type { WebSocket } from "ws";
import type { GlobalEventStore } from "../admin/global-event-store.js";
import { createAdminOverviewService } from "../admin/overview-service.js";
import { createAdminRoomQueryService } from "../admin/room-query-service.js";
import type { MetricsCollector } from "../admin/metrics.js";
import type { AdminCommandBus } from "../admin-command-bus.js";
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
}): Promise<{
  securityPolicy: ReturnType<typeof createSecurityPolicy>;
  httpServer: HttpServer;
  metricsHttpServer: HttpServer | undefined;
  runtimeIndexReaper: ReturnType<typeof createRuntimeIndexReaper>;
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
  });

  const { adminRouter, close: closeAdminServices } = await createAdminServices({
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
        }),
      );
  runtimeIndexReaper.start();

  return {
    securityPolicy,
    httpServer,
    metricsHttpServer,
    runtimeIndexReaper,
    closeAdminServices,
  };
}

export function createCloseHttpServerStep(
  httpServer: HttpServer,
): ShutdownStep {
  return {
    name: "close_http_server",
    run: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
