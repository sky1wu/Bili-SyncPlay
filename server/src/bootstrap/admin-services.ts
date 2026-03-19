import type { ServerMessage } from "@bili-syncplay/protocol";
import type { WebSocket } from "ws";
import { createAdminActionService } from "../admin/action-service.js";
import { createAuditLogService } from "../admin/audit-log.js";
import { createInMemoryAuthStore } from "../admin/auth-store.js";
import { createAdminAuthService } from "../admin/auth-service.js";
import { createAdminConfigService } from "../admin/config-service.js";
import { createEventStore } from "../admin/event-store.js";
import { createMetricsService } from "../admin/metrics.js";
import { createAdminOverviewService } from "../admin/overview-service.js";
import { createAdminRoomQueryService } from "../admin/room-query-service.js";
import { createAdminRouter } from "../admin/router.js";
import type { AdminSession } from "../admin/types.js";
import { createRoomService } from "../room-service.js";
import type { RoomStore } from "../room-store.js";
import type {
  AdminConfig,
  LogEvent,
  PersistenceConfig,
  SecurityConfig,
  Session,
} from "../types.js";

export function createAdminServices(args: {
  securityConfig: SecurityConfig;
  persistenceConfig: PersistenceConfig;
  roomStore: RoomStore;
  runtimeRegistry: ReturnType<typeof import("../admin/runtime-registry.js").createRuntimeRegistry>;
  eventStore: ReturnType<typeof createEventStore>;
  activeRooms: ReturnType<typeof import("../active-room-registry.js").createActiveRoomRegistry>;
  roomService: ReturnType<typeof createRoomService>;
  send: (socket: WebSocket, message: ServerMessage) => void;
  logEvent: LogEvent;
  now: () => number;
  adminConfig?: AdminConfig;
  serviceVersion: string;
}) {
  const authService = args.adminConfig
    ? createAdminAuthService(args.adminConfig, createInMemoryAuthStore(), args.now)
    : undefined;
  const auditLogService = createAuditLogService();
  const overviewService = createAdminOverviewService({
    instanceId: args.persistenceConfig.instanceId,
    serviceName: "bili-syncplay-server",
    serviceVersion: args.serviceVersion,
    persistenceConfig: args.persistenceConfig,
    roomStore: args.roomStore,
    runtimeRegistry: args.runtimeRegistry,
    eventStore: args.eventStore,
    now: args.now,
  });
  const roomQueryService = createAdminRoomQueryService({
    instanceId: args.persistenceConfig.instanceId,
    roomStore: args.roomStore,
    runtimeRegistry: args.runtimeRegistry,
    eventStore: args.eventStore,
  });
  const metricsService = createMetricsService({
    runtimeRegistry: args.runtimeRegistry,
    roomStore: args.roomStore,
  });
  const configService = createAdminConfigService({
    adminConfig: args.adminConfig ?? null,
    persistenceConfig: args.persistenceConfig,
    securityConfig: args.securityConfig,
  });

  async function broadcastRoomState(roomCode: string): Promise<void> {
    const state = await args.roomService.getRoomStateByCode(roomCode);
    if (!state) {
      return;
    }
    for (const session of args.runtimeRegistry.listSessionsByRoom(roomCode)) {
      args.send(session.socket, {
        type: "room:state",
        payload: state,
      });
    }
  }

  function disconnectSessionSocket(session: Session, reason: string): void {
    if (session.socket.readyState === session.socket.OPEN) {
      session.socket.close(1000, reason);
      return;
    }
    session.socket.terminate();
  }

  const actionService = createAdminActionService({
    instanceId: args.persistenceConfig.instanceId,
    roomStore: args.roomStore,
    runtimeRegistry: args.runtimeRegistry,
    auditLogService,
    getRoomStateByCode: (roomCode) => args.roomService.getRoomStateByCode(roomCode),
    broadcastRoomState,
    disconnectSessionSocket,
    blockMemberToken: (roomCode, memberToken, expiresAt) =>
      args.activeRooms.blockMemberToken(roomCode, memberToken, expiresAt),
    logEvent: args.logEvent,
    now: args.now,
  });

  const adminRouter = createAdminRouter({
    getConfigSummary: () => configService.getSummary(),
    getMetrics: () => metricsService.render(),
    authService,
    roomStoreReady: () => args.roomStore.isReady(),
    getOverview: () => overviewService.getOverview(),
    listRooms: (query: import("../admin/types.js").RoomListQuery) =>
      roomQueryService.listRooms(query),
    getRoomDetail: (roomCode: string) => roomQueryService.getRoomDetail(roomCode),
    listAuditLogs: (query: import("../admin/types.js").AuditLogQuery) =>
      auditLogService.query(query),
    closeRoom: (actor: AdminSession, roomCode: string, reason?: string) =>
      actionService.closeRoom(actor, roomCode, reason),
    expireRoom: (actor: AdminSession, roomCode: string, reason?: string) =>
      actionService.expireRoom(actor, roomCode, reason),
    clearRoomVideo: (
      actor: AdminSession,
      roomCode: string,
      reason?: string,
    ) =>
      actionService.clearRoomVideo(actor, roomCode, reason),
    kickMember: (
      actor: AdminSession,
      roomCode: string,
      memberId: string,
      reason?: string,
    ) =>
      actionService.kickMember(actor, roomCode, memberId, reason),
    disconnectSession: (
      actor: AdminSession,
      sessionId: string,
      reason?: string,
    ) =>
      actionService.disconnectSession(actor, sessionId, reason),
    eventStore: args.eventStore,
    serviceName: "bili-syncplay-server",
    now: args.now,
  });

  return { adminRouter };
}
