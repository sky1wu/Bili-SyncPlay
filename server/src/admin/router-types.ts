import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminAuthService } from "./auth-service.js";
import type { AdminWriteOriginPolicy } from "./csrf.js";
import type { GlobalAuditQueryResult } from "./global-audit-store.js";
import type { GlobalEventStore } from "./global-event-store.js";
import type { AdminLoginRateLimiter } from "./login-rate-limit.js";
import type {
  AdminRole,
  AdminSession,
  AuditLogQuery,
  IpBlockListResult,
  RoomListQuery,
} from "./types.js";

export type AdminRouterOptions = {
  getConfigSummary: () => unknown;
  getMetrics: () => Promise<string>;
  authService?: AdminAuthService;
  roomStoreReady: () => Promise<boolean>;
  getOverview: () => Promise<unknown>;
  listRooms: (query: RoomListQuery) => Promise<unknown>;
  getRoomDetail: (roomCode: string) => Promise<unknown | null>;
  listIpBlocks: () => Promise<IpBlockListResult>;
  listAuditLogs: (query: AuditLogQuery) => Promise<GlobalAuditQueryResult>;
  blockIp: (
    actor: AdminSession,
    ip: string,
    reason?: string,
  ) => Promise<unknown>;
  unblockIp: (
    actor: AdminSession,
    ip: string,
    reason?: string,
  ) => Promise<unknown>;
  closeRoom: (
    actor: AdminSession,
    roomCode: string,
    reason?: string,
  ) => Promise<unknown>;
  expireRoom: (
    actor: AdminSession,
    roomCode: string,
    reason?: string,
  ) => Promise<unknown>;
  clearRoomVideo: (
    actor: AdminSession,
    roomCode: string,
    reason?: string,
  ) => Promise<unknown>;
  kickMember: (
    actor: AdminSession,
    roomCode: string,
    memberId: string,
    reason?: string,
  ) => Promise<unknown>;
  disconnectSession: (
    actor: AdminSession,
    sessionId: string,
    reason?: string,
  ) => Promise<unknown>;
  eventStore: GlobalEventStore;
  serviceName: string;
  now?: () => number;
  writeOriginPolicy: AdminWriteOriginPolicy;
  loginRateLimiter?: AdminLoginRateLimiter;
  getRequestIpKey?: (request: IncomingMessage) => string;
};

export type AdminRouteHelpers = {
  requireAdmin: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<AdminSession | null>;
  requireRole: (
    session: AdminSession,
    role: AdminRole,
    response: ServerResponse,
  ) => boolean;
  requireWriteOrigin: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => boolean;
  getIpKey: (request: IncomingMessage) => string;
};

export type AdminRouteInput = {
  request: IncomingMessage;
  response: ServerResponse;
  pathname: string;
  segments: string[];
  options: AdminRouterOptions;
  helpers: AdminRouteHelpers;
};

export type AdminRouteHandler = (input: AdminRouteInput) => Promise<boolean>;
