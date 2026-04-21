import type { Server as HttpServer } from "node:http";
import { createGlobalAdminOverviewService } from "./admin/global-overview-service.js";
import { createGlobalAdminRoomQueryService } from "./admin/global-room-query-service.js";
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
import { type RoomStore } from "./room-store.js";
import { createRoomService } from "./room-service.js";
import type { RoomEventBusMessage } from "./room-event-bus.js";
import type {
  AdminConfig,
  AdminUiConfig,
  LogEvent,
  LogLevel,
  PersistenceConfig,
  SecurityConfig,
} from "./types.js";

export type GlobalAdminServer = {
  httpServer: HttpServer;
  close: () => Promise<void>;
};

export type GlobalAdminServerDependencies = {
  roomStore?: RoomStore;
  logEvent?: LogEvent;
  generateToken?: () => string;
  now?: () => number;
  adminConfig?: AdminConfig;
  adminUiConfig?: AdminUiConfig;
  serviceVersion?: string;
  logLevel?: LogLevel;
  logSampling?: Record<string, number>;
};

export async function createGlobalAdminServer(
  securityConfig: SecurityConfig = getDefaultSecurityConfig(),
  persistenceConfig: PersistenceConfig = getDefaultPersistenceConfig(),
  dependencies: GlobalAdminServerDependencies = {},
): Promise<GlobalAdminServer> {
  const { now, generateToken } = resolveServerRuntimeDependencies(dependencies);
  const {
    serviceVersion,
    roomStore,
    runtimeStore,
    adminCommandBus,
    roomEventBus,
    eventStore,
    logEvent,
    metricsCollector,
  } = await createServerBootstrapContext(persistenceConfig, dependencies, {
    useMirroredRuntimeStore: false,
  });
  const roomService = createRoomService({
    config: securityConfig,
    persistence: persistenceConfig,
    roomStore,
    runtimeStore,
    generateToken,
    logEvent,
    now,
  });
  const { httpServer, runtimeIndexReaper, closeAdminServices } =
    await createSharedAdminHttpBootstrap({
      securityConfig,
      persistenceConfig,
      roomStore,
      runtimeStore,
      eventStore,
      roomService,
      send() {},
      publishRoomEvent: (message: RoomEventBusMessage) =>
        roomEventBus.publish(message),
      requestAdminCommand: (command, timeoutMs) =>
        adminCommandBus.request(command, timeoutMs),
      logEvent,
      metricsCollector,
      now,
      adminConfig: dependencies.adminConfig,
      adminUiConfig: dependencies.adminUiConfig,
      serviceName: "bili-syncplay-global-admin",
      createOverviewService: createGlobalAdminOverviewService,
      createRoomQueryService: createGlobalAdminRoomQueryService,
      serviceVersion,
    });

  return {
    httpServer,
    close: () =>
      runShutdownSteps(
        [
          createCloseHttpServerStep(httpServer),
          {
            name: "stop_runtime_index_reaper",
            run: () => runtimeIndexReaper.stop(),
          },
          ...createSharedServerShutdownSteps({
            roomStore,
            eventStore,
            runtimeStore,
            adminCommandBus,
            roomEventBus,
            closeAdminServices,
          }),
        ],
        logEvent,
      ),
  };
}
