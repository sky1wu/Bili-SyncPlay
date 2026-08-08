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
  type ShutdownStepFailure,
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
  metricsHttpServer: HttpServer | undefined;
  /** Resolves with the steps that failed; an empty array means a clean teardown. */
  close: () => Promise<ShutdownStepFailure[]>;
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
  metricsPort?: number;
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
    roomIndexReconciler,
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
    // This process runs no reaper, but its admin reads still go through
    // `resolveRoom`, which deletes a room found already past its expiry. Those
    // reclamations are real and belong in the counter — unlike the sweep
    // series, which stays absent here because nothing can ever move it.
    metricsCollector,
    now,
  });
  const {
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
    metricsPort: dependencies.metricsPort,
  });

  return {
    httpServer,
    metricsHttpServer,
    close: () =>
      runShutdownSteps(
        [
          createCloseHttpServerStep(httpServer),
          ...(metricsHttpServer
            ? [createCloseHttpServerStep(metricsHttpServer)]
            : []),
          {
            name: "stop_runtime_index_reaper",
            // Bigger than the reaper's own shutdown budget for its pending
            // resync announcements, which is what stops that last pass from
            // being cut short and recorded as a failed step (#242 review).
            timeoutMs: 10_000,
            run: () => runtimeIndexReaper.stop(),
          },
          ...createSharedServerShutdownSteps({
            roomStore,
            roomIndexReconciler,
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
