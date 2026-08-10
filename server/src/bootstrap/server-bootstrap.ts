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
import { createAdminCommandBusFailureHandlers } from "../admin-command-bus-diagnostics.js";
import { createStructuredLogger, DEFAULT_EVENT_SAMPLING } from "../logger.js";
import { createMirroredRuntimeStore } from "../mirrored-runtime-store.js";
import { createRedisAdminCommandBus } from "../redis-admin-command-bus.js";
import type { RedisQuitOutcome } from "../redis-graceful-close.js";
import { createRedisRoomEventBus } from "../redis-room-event-bus.js";
import { createRedisRoomStore } from "../redis-room-store.js";
import {
  createRedisRuntimeStore,
  type PendingOperationLogContext,
} from "../redis-runtime-store.js";
import {
  getRedisAdminCommandChannelPrefix,
  getRedisAdminCommandResultChannelPrefix,
  getRedisEventCountsKey,
  getRedisEventStreamKey,
  getRedisEventWindowIndexKeyPrefix,
  getRedisRoomEventChannel,
  getRedisRuntimeKeyPrefix,
} from "../redis-namespace.js";
import {
  createInMemoryRoomEventBus,
  createNoopRoomEventBus,
  type RoomEventBus,
  type RoomEventBusMessage,
} from "../room-event-bus.js";
import { ROOM_INDEX_RECONCILE_INTERVAL_MS } from "../redis-room-store.js";
import {
  createRoomIndexReconciler,
  type RoomIndexReconciler,
} from "../room-index-reconciler.js";
import { createInMemoryRoomStore, type RoomStore } from "../room-store.js";
import {
  instrumentRoomStore,
  type MaintainableRoomStore,
} from "../room-store-instrumentation.js";
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

export type ShutdownStepFailure = {
  step: string;
  result: "timeout" | "error";
  error: string;
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
  // Maintainable rather than plain RoomStore so the reconcile hook is visible
  // without probing for it structurally.
  roomStore: MaintainableRoomStore;
  // Built here rather than in each entry point so every server that shares
  // this Redis keeps the index converging. The standalone global admin reads
  // rooms but writes none, so an entry point that forgot to start this would
  // serve a listing and a count that silently drift from what the room nodes
  // wrote — with nothing failing to say so. Null when the store keeps no index.
  roomIndexReconciler: RoomIndexReconciler | null;
  localRuntimeStore: RuntimeStore;
  sharedRuntimeStore: RuntimeStore;
  runtimeStore: RuntimeStore;
  adminCommandBus: AdminCommandBus;
  roomEventBus: RoomEventBus;
  eventStore: GlobalEventStore;
  logEvent: LogEvent;
  metricsCollector: MetricsCollector;
};

/**
 * Runs every step even when earlier ones fail, and reports which ones did:
 * a caller that exits the process needs to know whether the teardown actually
 * released everything, otherwise a shutdown that skipped Redis cleanup still
 * looks successful to the orchestrator.
 */
export async function runShutdownSteps(
  steps: ShutdownStep[],
  logEvent: LogEvent,
  defaultTimeoutMs = DEFAULT_CLOSE_STEP_TIMEOUT_MS,
): Promise<ShutdownStepFailure[]> {
  const failures: ShutdownStepFailure[] = [];
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
      const failure: ShutdownStepFailure = {
        step: step.name,
        result: timedOut ? "timeout" : "error",
        error: error instanceof Error ? error.message : String(error),
      };
      failures.push(failure);
      logEvent("server_shutdown_step_failed", {
        ...failure,
        timeoutMs,
      });
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  return failures;
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
    allowAnyFirefoxExtensionOrigin: false,
    trustedProxyAddresses: [],
    maxConnectionsPerIp: 10,
    connectionAttemptsPerMinute: 20,
    maxMembersPerRoom: 8,
    maxMessageBytes: 8 * 1024,
    invalidMessageCloseThreshold: 3,
    wsHeartbeatEnabled: true,
    wsHeartbeatIntervalMs: 30_000,
    rateLimits: {
      roomCreatePerMinute: 3,
      roomJoinPerMinute: 10,
      videoSharePer10Seconds: 3,
      playbackUpdatePerSecond: 8,
      playbackUpdateBurst: 12,
      syncRequestPer10Seconds: 6,
      syncPingPerSecond: 1,
      syncPingBurst: 2,
      adminLoginFailuresPerIpPerMinute: 10,
      adminLoginFailuresPerUsernamePerMinute: 5,
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
  // The Redis components are constructed before the structured logger because
  // that logger itself may depend on Redis. Their close callbacks capture this
  // binding and therefore use the final logger by the time shutdown runs.
  let logEvent: LogEvent = dependencies.logEvent ?? (() => undefined);

  function logRedisCloseUnfinished<
    Report extends {
      quitOutcome: RedisQuitOutcome;
      budgetMs: number;
    },
  >(event: string, report: Report): void {
    logEvent(event, {
      instanceId: persistenceConfig.instanceId,
      ...report,
      // A rejected `QUIT` is an error; a reply that never arrived spent the
      // wait budget. Keep that distinction queryable in every close report.
      //
      // `ok` reaches this helper only from the runtime store, whose report also
      // fires on abandoned callers/commands — and those exist precisely because
      // a drain budget ran out, so `timeout` is the right diagnosis there. The
      // event store's own mapping differs for a reason: `closingAppends` is not
      // a budget expiry, so a graceful `QUIT` with appends refused after close
      // is a fault (#268). Same field, two derivations, because the underlying
      // question is "what made this close incomplete" and the answers differ.
      result: report.quitOutcome === "failed" ? "error" : "timeout",
    });
  }

  const rawRoomStore =
    dependencies.roomStore ??
    (persistenceConfig.provider === "redis"
      ? await createRedisRoomStore(persistenceConfig.redisUrl, {
          namespace: persistenceConfig.redisNamespace,
          onCloseUnfinished: (report) =>
            logRedisCloseUnfinished("room_store_close_unfinished", report),
        })
      : createInMemoryRoomStore({ now }));
  const localRuntimeStore = createInMemoryRuntimeStore(now);
  // The collector polls countRooms on every scrape; give it the raw store so
  // scrape-driven reads stay out of the room store operation histogram.
  const metricsCollector = createMetricsCollector({
    runtimeStore: localRuntimeStore,
    roomStore: rawRoomStore,
    serviceVersion,
  });
  const roomStore: MaintainableRoomStore =
    persistenceConfig.provider === "redis" &&
    dependencies.roomStore === undefined
      ? instrumentRoomStore(rawRoomStore, metricsCollector)
      : rawRoomStore;
  const runtimeStorePendingOperationLogger =
    options.loggingHooks?.onRuntimeStorePendingOperationError;

  const sharedRuntimeStore =
    persistenceConfig.runtimeStoreProvider === "redis"
      ? await createRedisRuntimeStore(persistenceConfig.redisUrl, {
          now,
          keyPrefix: getRedisRuntimeKeyPrefix(persistenceConfig.redisNamespace),
          // How long a disconnected member can still reclaim their identity.
          // Twice the empty-room lifetime, so it comfortably covers a restart
          // or a node failover without outliving the room by much.
          memberTokenRetentionMs: persistenceConfig.emptyRoomTtlMs * 2,
          metricsCollector,
          ...(runtimeStorePendingOperationLogger
            ? {
                onPendingOperationError: (context, error) => {
                  runtimeStorePendingOperationLogger(logEvent, context, error);
                },
              }
            : {}),
          onCloseUnfinished: (report) =>
            logRedisCloseUnfinished("runtime_store_close_unfinished", report),
        })
      : localRuntimeStore;
  const runtimeStore =
    options.useMirroredRuntimeStore && sharedRuntimeStore !== localRuntimeStore
      ? createMirroredRuntimeStore(localRuntimeStore, sharedRuntimeStore)
      : sharedRuntimeStore;
  metricsCollector.bindRuntimeStore(runtimeStore);
  const commandBusFailureHandlers = createAdminCommandBusFailureHandlers({
    metricsCollector,
    // Components are built before the structured logger because that logger
    // may itself use Redis. Read the binding at callback time so failures use
    // the final logger rather than the bootstrap no-op.
    getLogEvent: () => logEvent,
    instanceId: persistenceConfig.instanceId,
    now,
  });
  const adminCommandBus =
    persistenceConfig.adminCommandBusProvider === "redis"
      ? await createRedisAdminCommandBus(persistenceConfig.redisUrl, {
          commandChannelPrefix: getRedisAdminCommandChannelPrefix(
            persistenceConfig.redisNamespace,
          ),
          resultChannelPrefix: getRedisAdminCommandResultChannelPrefix(
            persistenceConfig.redisNamespace,
          ),
          ...commandBusFailureHandlers,
          onCloseUnfinished: (report) =>
            logRedisCloseUnfinished(
              "admin_command_bus_close_unfinished",
              report,
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
          onCloseUnfinished: (report) =>
            logRedisCloseUnfinished("room_event_bus_close_unfinished", report),
        })
      : persistenceConfig.roomEventBusProvider === "none"
        ? createNoopRoomEventBus()
        : createInMemoryRoomEventBus();
  const eventStore =
    dependencies.adminConfig?.eventStoreProvider === "redis"
      ? await createRedisEventStore(persistenceConfig.redisUrl, {
          streamKey: getRedisEventStreamKey(persistenceConfig.redisNamespace),
          countsKey: getRedisEventCountsKey(persistenceConfig.redisNamespace),
          legacyCountsKey: persistenceConfig.redisNamespace
            ? getRedisEventCountsKey()
            : undefined,
          windowIndexKeyPrefix: getRedisEventWindowIndexKeyPrefix(
            persistenceConfig.redisNamespace,
          ),
          metricsCollector,
          // Wired here rather than through `loggingHooks`: the standalone
          // global admin passes no hooks, and it runs the same store against
          // the same Redis, so routing these through an opt-in would leave the
          // process most likely to be watching the event list as the one that
          // never says the list went incomplete.
          // No explicit level: `logger.ts` pins these to `error` next to the
          // rule that keeps them out of the event store, because both rules
          // exist for the same reason and a policy split across two files
          // drifts apart (#266 review).
          onAppendsDropped: ({ reason }) => {
            logEvent("runtime_event_appends_dropped", {
              instanceId: persistenceConfig.instanceId,
              reason,
              result: "error",
            });
          },
          onAppendsAbandonedAtShutdown: ({
            pendingWrites,
            queuedAppends,
            closingAppends,
            quitOutcome,
            budgetMs,
          }) => {
            logEvent("runtime_event_appends_abandoned_at_shutdown", {
              instanceId: persistenceConfig.instanceId,
              pendingWrites,
              queuedAppends,
              closingAppends,
              quitOutcome,
              budgetMs,
              // Derived, not hardcoded: a `QUIT` that came back an ERROR is not
              // a timeout, and a query aggregating on `result` would file the
              // two under one diagnosis while the runbook tells operators to
              // tell them apart (#266 review).
              //
              // `result` says how the CLOSE ended, not how much was lost — and
              // it has to, because every outcome here loses something and a
              // loss-based reading would make the field constant. `skipped` and
              // `timed_out` both mean a budget ran out; `ok` reaching this
              // callback at all means the close was graceful and `closingAppends`
              // is what made it incomplete, which is a fault, not a timeout. How
              // much was lost is `pendingWrites` and `closingAppends` (#268
              // review).
              result:
                quitOutcome === "timed_out" || quitOutcome === "skipped"
                  ? "timeout"
                  : "error",
            });
          },
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

  // Only the Redis store keeps an index that can drift from the room bodies;
  // the in-memory one has nothing to reconcile.
  const reconcileRoomIndex = roomStore.reconcileRoomIndex;
  const roomIndexReconciler = reconcileRoomIndex
    ? createRoomIndexReconciler({
        intervalMs: ROOM_INDEX_RECONCILE_INTERVAL_MS,
        reconcileRoomIndex: () => reconcileRoomIndex(),
        logEvent,
      })
    : null;

  return {
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
  };
}

export function createSharedServerShutdownSteps(args: {
  // Maintainable, not plain RoomStore: this function probes for close(), so
  // the parameter should say the hook is expected rather than leave callers
  // passing something the declared type claims cannot have one.
  roomStore: MaintainableRoomStore;
  // Required, not optional: an entry point that forgets it would silently stop
  // reconciling the index, and nothing at runtime would say so. Making it
  // mandatory turns that omission into a compile error — which is why the
  // standalone global admin regressed here in the first place. Pass the
  // context's value; null when the store keeps no index.
  roomIndexReconciler: RoomIndexReconciler | null;
  eventStore: GlobalEventStore;
  runtimeStore?: RuntimeStore | null;
  runtimeStoreStepName?: string;
  adminCommandBus: AdminCommandBus;
  roomEventBus: RoomEventBus;
  closeAdminServices: () => Promise<void>;
}): ShutdownStep[] {
  const steps: ShutdownStep[] = [
    // Must precede close_room_store: stop() waits out the pass in flight, and
    // a SCAN/GET/EVAL still in the air would otherwise race redis.quit().
    {
      name: "stop_room_index_reconciler",
      run: () => args.roomIndexReconciler?.stop(),
    },
    {
      name: "close_room_store",
      run: () =>
        hasClose(args.roomStore) ? args.roomStore.close() : undefined,
    },
  ];

  if (args.runtimeStore) {
    steps.push({
      name: args.runtimeStoreStepName ?? "close_runtime_store",
      // Default worst case is 14s: 5s for the wound-down queue's one in-flight
      // attempt to answer its caller, another 5s for that timed-out Redis
      // command to really settle, then 4s for bounded `QUIT`. The 15s step
      // leaves a one-second margin while preserving the rule that a timeout
      // answers the caller but does not cancel the command (#242, #270).
      timeoutMs: DEFAULT_CLOSE_STEP_TIMEOUT_MS * 3,
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
    // The event store is the structured logger's sink. Close it after every
    // shared producer so failures from winding those components down can still
    // land, and so its final abandonment report includes every append refused
    // after close started (#268).
    {
      name: "close_event_store",
      run: () =>
        hasClose(args.eventStore) ? args.eventStore.close() : undefined,
    },
  );

  return steps;
}
