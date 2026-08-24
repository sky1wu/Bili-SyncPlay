import type { IncomingMessage } from "node:http";
import type { ServerMessage } from "@bili-syncplay/protocol";
import type { WebSocket } from "ws";
import { createAdminActionService } from "../admin/action-service.js";
import type { AdminCommandBus } from "../admin-command-bus.js";
import { createAuditLogService } from "../admin/audit-log.js";
import { createInMemoryAdminSessionStore } from "../admin/auth-store.js";
import { createAdminAuthService } from "../admin/auth-service.js";
import { createAdminConfigService } from "../admin/config-service.js";
import { createDiagnosisThrottle } from "../diagnosis-throttle.js";
import { createAdminLoginRateLimiter } from "../admin/login-rate-limit.js";
import type { GlobalAuditStore } from "../admin/global-audit-store.js";
import type { GlobalEventStore } from "../admin/global-event-store.js";
import type { MetricsCollector } from "../admin/metrics.js";
import { createAdminOverviewService } from "../admin/overview-service.js";
import { createAdminRoomQueryService } from "../admin/room-query-service.js";
import { createRedisAuditStore } from "../admin/redis-audit-store.js";
import { createAdminRouter } from "../admin/router.js";
import type { AdminSession } from "../admin/types.js";
import type { AdminSessionStore } from "../admin-session-store.js";
import { createRedisAdminSessionStore } from "../redis-admin-session-store.js";
import {
  getRedisAdminSessionKeyPrefix,
  getRedisAuditStreamKey,
} from "../redis-namespace.js";
import { createRoomService } from "../room-service.js";
import type { RoomEventBusMessage } from "../room-event-bus.js";
import type { RoomStore } from "../room-store.js";
import type { RuntimeStore } from "../runtime-store.js";
import type {
  AdminConfig,
  LogEvent,
  PersistenceConfig,
  SecurityConfig,
} from "../types.js";

/**
 * How often a repeated session-store failure diagnosis may be logged.
 *
 * Its own constant, not the event store's: that one paces a report driven by
 * log volume, this one paces a report an unauthenticated caller can drive per
 * request. Two behaviours, two constants, even where the value agrees today.
 */
const SESSION_STORE_FAILURE_REPORT_INTERVAL_MS = 60_000;

/** Three operations; the bound only exists because the throttle is shared. */
const MAX_TRACKED_SESSION_STORE_FAILURE_OPERATIONS = 8;

export function createAdminServices(args: {
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
  serviceVersion: string;
  serviceName?: string;
  createOverviewService?: typeof createAdminOverviewService;
  createRoomQueryService?: typeof createAdminRoomQueryService;
  getRequestIpKey?: (request: IncomingMessage) => string;
  adminSessionStoreOverride?: AdminSessionStore;
  auditStoreOverride?: GlobalAuditStore;
}): Promise<{
  adminRouter: ReturnType<typeof createAdminRouter>;
  closeAdminActionService: () => Promise<void>;
  close: () => Promise<void>;
}> {
  return (async () => {
    const sessionStoreFailureThrottle = createDiagnosisThrottle({
      intervalMs: SESSION_STORE_FAILURE_REPORT_INTERVAL_MS,
      maxTrackedDiagnoses: MAX_TRACKED_SESSION_STORE_FAILURE_OPERATIONS,
      now: args.now,
    });
    let auditLogService: GlobalAuditStore = createAuditLogService();
    let adminSessionStore: AdminSessionStore | undefined;
    let closeAdminSessionStore: (() => Promise<void>) | undefined;
    let closeAuditLogService: (() => Promise<void>) | undefined;

    if (args.adminConfig) {
      if (args.adminSessionStoreOverride) {
        adminSessionStore = args.adminSessionStoreOverride;
      } else if (args.adminConfig.sessionStoreProvider === "redis") {
        const redisAdminSessionStore = await createRedisAdminSessionStore(
          args.persistenceConfig.redisUrl,
          {
            logEvent: args.logEvent,
            keyPrefix: getRedisAdminSessionKeyPrefix(
              args.persistenceConfig.redisNamespace,
            ),
            onCommandFailed: ({ operation, error }) => {
              // Counted BEFORE the throttle and every time, because the two
              // questions are different: the line says what is broken, only a
              // counter says how much (#266).
              args.metricsCollector.observeRedisAdminSessionStoreFailure(
                operation,
              );
              // And throttled, because the earlier version of this comment
              // claimed the admin API is rate limited and it is not: the only
              // admin HTTP limiter counts login credential failures, so any
              // caller can drive one `authenticate` — and one line, and one
              // event-store append — per request with an arbitrary bearer
              // token, before any credential is checked. A precondition that
              // does not hold is not a bound (#266's rule, #271's review).
              //
              // The vocabulary is three operations, so it never reaches the
              // throttle's overflow bucket; the bound is there because the
              // throttle is shared, not because this caller needs it.
              if (!sessionStoreFailureThrottle.allow(operation)) {
                return;
              }
              // The detail the 503 withholds: `authenticate` runs before any
              // credential is accepted, so its response is reachable by an
              // unauthenticated caller and the Redis error belongs here rather
              // than in the body. It does not route through the thing it
              // reports on — `logEvent` writes to the event store's separate
              // connection (#266).
              args.logEvent("admin_session_store_command_failed", {
                instanceId: args.persistenceConfig.instanceId,
                operation,
                result: "error",
                error: error instanceof Error ? error.message : String(error),
              });
            },
            onCloseUnfinished: ({ quitOutcome, budgetMs }) => {
              args.logEvent("admin_session_store_close_unfinished", {
                instanceId: args.persistenceConfig.instanceId,
                quitOutcome,
                budgetMs,
                // Derived, not hardcoded: a `QUIT` that came back an ERROR is
                // not a timeout, and a query aggregating on `result` would file
                // the two under one diagnosis (#266 review).
                result: quitOutcome === "failed" ? "error" : "timeout",
              });
            },
          },
        );
        adminSessionStore = redisAdminSessionStore;
        closeAdminSessionStore = redisAdminSessionStore.close;
      } else {
        adminSessionStore = createInMemoryAdminSessionStore();
      }

      if (args.auditStoreOverride) {
        auditLogService = args.auditStoreOverride;
      } else if (args.adminConfig.auditStoreProvider === "redis") {
        const redisAuditStore = await createRedisAuditStore(
          args.persistenceConfig.redisUrl,
          {
            logEvent: args.logEvent,
            streamKey: getRedisAuditStreamKey(
              args.persistenceConfig.redisNamespace,
            ),
            onCloseUnfinished: ({
              pendingWrites,
              queuedAppends,
              quitOutcome,
              budgetMs,
            }) => {
              args.logEvent("admin_audit_appends_abandoned_at_shutdown", {
                instanceId: args.persistenceConfig.instanceId,
                pendingWrites,
                queuedAppends,
                quitOutcome,
                budgetMs,
                result: quitOutcome === "failed" ? "error" : "timeout",
              });
            },
          },
        );
        auditLogService = redisAuditStore;
        closeAuditLogService = redisAuditStore.close;
      }
    }

    const createOverviewService =
      args.createOverviewService ?? createAdminOverviewService;
    const createRoomQueryService =
      args.createRoomQueryService ?? createAdminRoomQueryService;
    const authService =
      args.adminConfig && adminSessionStore
        ? createAdminAuthService(args.adminConfig, adminSessionStore, args.now)
        : undefined;
    const loginRateLimiter = authService
      ? createAdminLoginRateLimiter(
          {
            failuresPerIpPerMinute:
              args.securityConfig.rateLimits.adminLoginFailuresPerIpPerMinute,
            failuresPerUsernamePerMinute:
              args.securityConfig.rateLimits
                .adminLoginFailuresPerUsernamePerMinute,
          },
          args.now,
        )
      : undefined;
    const overviewService = createOverviewService({
      instanceId: args.persistenceConfig.instanceId,
      serviceName: args.serviceName ?? "bili-syncplay-server",
      serviceVersion: args.serviceVersion,
      persistenceConfig: args.persistenceConfig,
      roomStore: args.roomStore,
      runtimeStore: args.runtimeStore,
      eventStore: args.eventStore,
      now: args.now,
    });
    const roomQueryService = createRoomQueryService({
      instanceId: args.persistenceConfig.instanceId,
      roomStore: args.roomStore,
      runtimeStore: args.runtimeStore,
      eventStore: args.eventStore,
    });
    const metricsService = args.metricsCollector;
    const configService = createAdminConfigService({
      adminConfig: args.adminConfig ?? null,
      persistenceConfig: args.persistenceConfig,
      securityConfig: args.securityConfig,
    });

    async function publishRoomStateUpdate(roomCode: string): Promise<void> {
      await args.publishRoomEvent({
        type: "room_state_updated",
        roomCode,
        sourceInstanceId: args.persistenceConfig.instanceId,
        emittedAt: args.now(),
      });
    }

    const actionService = createAdminActionService({
      instanceId: args.persistenceConfig.instanceId,
      roomStore: args.roomStore,
      runtimeStore: args.runtimeStore,
      teardownRoomRuntime: (roomCode) =>
        args.roomService.teardownRoomRuntime(roomCode),
      listClusterSessions: () =>
        args.runtimeStore.listClusterSessions("request"),
      listClusterSessionsByRoom: (roomCode) =>
        args.runtimeStore.listClusterSessionsByRoom(roomCode),
      requestAdminCommand: args.requestAdminCommand,
      auditLogService,
      getRoomStateByCode: (roomCode) =>
        args.roomService.getRoomStateByCode(roomCode),
      publishRoomStateUpdate,
      publishRoomDeleted: async (roomCode) => {
        await args.publishRoomEvent({
          type: "room_deleted",
          roomCode,
          sourceInstanceId: args.persistenceConfig.instanceId,
          emittedAt: args.now(),
        });
      },
      logEvent: args.logEvent,
      now: args.now,
    });

    const adminRouter = createAdminRouter({
      getConfigSummary: () => configService.getSummary(),
      getMetrics: () => metricsService.render(),
      metricsToken: args.securityConfig.metricsToken,
      authService,
      roomStoreReady: () => args.roomStore.isReady(),
      getOverview: () => overviewService.getOverview(),
      listRooms: (query: import("../admin/types.js").RoomListQuery) =>
        roomQueryService.listRooms(query),
      getRoomDetail: (roomCode: string) =>
        roomQueryService.getRoomDetail(roomCode),
      listAuditLogs: (query: import("../admin/types.js").AuditLogQuery) =>
        Promise.resolve(auditLogService.query(query)),
      closeRoom: (actor: AdminSession, roomCode: string, reason?: string) =>
        actionService.closeRoom(actor, roomCode, reason),
      expireRoom: (actor: AdminSession, roomCode: string, reason?: string) =>
        actionService.expireRoom(actor, roomCode, reason),
      clearRoomVideo: (
        actor: AdminSession,
        roomCode: string,
        reason?: string,
      ) => actionService.clearRoomVideo(actor, roomCode, reason),
      kickMember: (
        actor: AdminSession,
        roomCode: string,
        memberId: string,
        reason?: string,
      ) => actionService.kickMember(actor, roomCode, memberId, reason),
      disconnectSession: (
        actor: AdminSession,
        sessionId: string,
        reason?: string,
      ) => actionService.disconnectSession(actor, sessionId, reason),
      eventStore: args.eventStore,
      serviceName: args.serviceName ?? "bili-syncplay-server",
      now: args.now,
      writeOriginPolicy: {
        allowedOrigins: args.securityConfig.allowedOrigins,
      },
      loginRateLimiter,
      getRequestIpKey: args.getRequestIpKey,
    });

    return {
      adminRouter,
      closeAdminActionService: actionService.close,
      async close() {
        // Settled together, not awaited in sequence: the two hold independent
        // Redis connections with no ordering between them, so a rejection from
        // the first would otherwise skip the second's close entirely and leak a
        // connection past a shutdown that reported it was done. Both are
        // internally bounded (#267), so this step no longer depends on Redis
        // answering at all.
        const closed = await Promise.allSettled([
          closeAdminSessionStore?.(),
          closeAuditLogService?.(),
        ]);
        const failed = closed.find((outcome) => outcome.status === "rejected");
        if (failed?.status === "rejected") {
          throw failed.reason;
        }
      },
    };
  })();
}
