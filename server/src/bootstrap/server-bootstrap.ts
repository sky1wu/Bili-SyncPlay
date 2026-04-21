import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventStore } from "../admin/event-store.js";
import { createRedisEventStore } from "../admin/redis-event-store.js";
import {
  createMetricsCollector,
  type MetricsCollector,
} from "../admin/metrics.js";
import {
  createInMemoryAdminCommandBus,
  createNoopAdminCommandBus,
  type AdminCommandBus,
} from "../admin-command-bus.js";
import { createStructuredLogger, DEFAULT_EVENT_SAMPLING } from "../logger.js";
import { createMirroredRuntimeStore } from "../mirrored-runtime-store.js";
import { createRedisAdminCommandBus } from "../redis-admin-command-bus.js";
import { createRedisRoomEventBus } from "../redis-room-event-bus.js";
import { createRedisRoomStore } from "../redis-room-store.js";
import { createRedisRuntimeStore } from "../redis-runtime-store.js";
import {
  getRedisAdminCommandChannelPrefix,
  getRedisAdminCommandResultChannelPrefix,
  getRedisEventStreamKey,
  getRedisRoomEventChannel,
  getRedisRuntimeKeyPrefix,
} from "../redis-namespace.js";
import {
  createInMemoryRoomEventBus,
  createNoopRoomEventBus,
  type RoomEventBus,
  type RoomEventBusMessage,
} from "../room-event-bus.js";
import { createInMemoryRoomStore, type RoomStore } from "../room-store.js";
import {
  createInMemoryRuntimeStore,
  type RuntimeStore,
} from "../runtime-store.js";
import type { GlobalEventStore } from "../admin/global-event-store.js";
import type {
  AdminConfig,
  LogEvent,
  LogLevel,
  PersistenceConfig,
  SecurityConfig,
} from "../types.js";

const DEFAULT_CLOSE_STEP_TIMEOUT_MS = 5_000;
const PACKAGE_JSON_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../package.json",
);

let cachedServiceVersion: string | null = null;

export type Closeable = {
  close: () => Promise<void>;
};

export type ShutdownStep = {
  name: string;
  run: () => Promise<void> | void;
  timeoutMs?: number;
};

export type ServerBootstrapDependencies = {
  roomStore?: RoomStore;
  logEvent?: LogEvent;
  now?: () => number;
  adminConfig?: AdminConfig;
  serviceVersion?: string;
  logLevel?: LogLevel;
  logSampling?: Record<string, number>;
};

type PendingOperationLogContext = {
  operationName: string;
  pendingCount: number;
  reason: "backpressure" | "timeout" | "failed";
};

type BootstrapLoggingHooks = {
  onRuntimeStorePendingOperationError?: (
    logEvent: LogEvent,
    context: PendingOperationLogContext,
    error: unknown,
  ) => void;
  onRoomEventBusConnectionError?: (
    logEvent: LogEvent,
    role: string,
    error: unknown,
  ) => void;
  onRoomEventBusInvalidMessage?: (logEvent: LogEvent, payload: string) => void;
  onRoomEventBusHandlerError?: (
    logEvent: LogEvent,
    message: RoomEventBusMessage,
    error: unknown,
  ) => void;
};

export type ServerBootstrapContext = {
  serviceVersion: string;
  roomStore: RoomStore;
  localRuntimeStore: RuntimeStore;
  sharedRuntimeStore: RuntimeStore;
  runtimeStore: RuntimeStore;
  adminCommandBus: AdminCommandBus;
  roomEventBus: RoomEventBus;
  eventStore: GlobalEventStore;
  logEvent: LogEvent;
  metricsCollector: MetricsCollector;
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

export async function createServerBootstrapContext(
  persistenceConfig: PersistenceConfig,
  dependencies: ServerBootstrapDependencies,
  options: {
    useMirroredRuntimeStore: boolean;
    loggingHooks?: BootstrapLoggingHooks;
  },
): Promise<ServerBootstrapContext> {
  const serviceVersion =
    dependencies.serviceVersion ?? (await resolveServiceVersion());
  const now = dependencies.now ?? Date.now;
  const roomStore =
    dependencies.roomStore ??
    (persistenceConfig.provider === "redis"
      ? await createRedisRoomStore(persistenceConfig.redisUrl, {
          namespace: persistenceConfig.redisNamespace,
        })
      : createInMemoryRoomStore({ now }));
  const localRuntimeStore = createInMemoryRuntimeStore(now);
  const metricsCollector = createMetricsCollector({
    runtimeStore: localRuntimeStore,
    roomStore,
  });
  const runtimeStorePendingOperationLogger =
    options.loggingHooks?.onRuntimeStorePendingOperationError;

  let logEvent: LogEvent = dependencies.logEvent ?? (() => undefined);

  const sharedRuntimeStore =
    persistenceConfig.runtimeStoreProvider === "redis"
      ? await createRedisRuntimeStore(persistenceConfig.redisUrl, {
          now,
          keyPrefix: getRedisRuntimeKeyPrefix(persistenceConfig.redisNamespace),
          metricsCollector,
          ...(runtimeStorePendingOperationLogger
            ? {
                onPendingOperationError: (context, error) => {
                  runtimeStorePendingOperationLogger(logEvent, context, error);
                },
              }
            : {}),
        })
      : localRuntimeStore;
  const runtimeStore =
    options.useMirroredRuntimeStore && sharedRuntimeStore !== localRuntimeStore
      ? createMirroredRuntimeStore(localRuntimeStore, sharedRuntimeStore)
      : sharedRuntimeStore;
  metricsCollector.bindRuntimeStore(runtimeStore);
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
          metricsCollector,
          onConnectionError: (role, error) => {
            options.loggingHooks?.onRoomEventBusConnectionError?.(
              logEvent,
              role,
              error,
            );
          },
          onInvalidMessage: (payload) => {
            options.loggingHooks?.onRoomEventBusInvalidMessage?.(
              logEvent,
              payload,
            );
          },
          onHandlerError: (message, error) => {
            options.loggingHooks?.onRoomEventBusHandlerError?.(
              logEvent,
              message,
              error,
            );
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

  logEvent = dependencies.logEvent
    ? (event, data, options) => {
        dependencies.logEvent?.(event, data, options);
        runtimeStore.recordEvent(event, now());
        metricsCollector.recordEvent(event);
      }
    : createStructuredLogger({
        eventStore,
        runtimeStore,
        metricsCollector,
        logLevel: dependencies.logLevel,
        sampling: dependencies.logSampling ?? { ...DEFAULT_EVENT_SAMPLING },
      });

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

  return {
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
  };
}

export function createSharedServerShutdownSteps(args: {
  roomStore: RoomStore;
  eventStore: GlobalEventStore;
  runtimeStore?: RuntimeStore | null;
  runtimeStoreStepName?: string;
  adminCommandBus: AdminCommandBus;
  roomEventBus: RoomEventBus;
  closeAdminServices: () => Promise<void>;
}): ShutdownStep[] {
  const steps: ShutdownStep[] = [
    {
      name: "close_room_store",
      run: () =>
        hasClose(args.roomStore) ? args.roomStore.close() : undefined,
    },
    {
      name: "close_event_store",
      run: () =>
        hasClose(args.eventStore) ? args.eventStore.close() : undefined,
    },
  ];

  if (args.runtimeStore) {
    steps.push({
      name: args.runtimeStoreStepName ?? "close_runtime_store",
      run: () =>
        hasClose(args.runtimeStore) ? args.runtimeStore.close() : undefined,
    });
  }

  steps.push(
    {
      name: "close_admin_command_bus",
      run: () =>
        hasClose(args.adminCommandBus)
          ? args.adminCommandBus.close()
          : undefined,
    },
    {
      name: "close_room_event_bus",
      run: () =>
        hasClose(args.roomEventBus) ? args.roomEventBus.close() : undefined,
    },
    {
      name: "close_admin_services",
      run: () => args.closeAdminServices(),
    },
  );

  return steps;
}
