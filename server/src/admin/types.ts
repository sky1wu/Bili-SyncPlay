import type { PlaybackState, SharedVideo } from "@bili-syncplay/protocol";

export type AdminRole = "viewer" | "operator" | "admin";

export type AdminSession = {
  id: string;
  adminId: string;
  username: string;
  role: AdminRole;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
};

export type RuntimeEvent = {
  id: string;
  timestamp: string;
  event: string;
  roomCode: string | null;
  sessionId: string | null;
  remoteAddress: string | null;
  origin: string | null;
  result: string | null;
  details: Record<string, unknown>;
};

export type AuditLogRecord = {
  id: string;
  timestamp: string;
  actor: {
    adminId: string;
    username: string;
    role: AdminRole;
  };
  action: string;
  targetType: "room" | "session" | "member" | "config" | "block";
  targetId: string;
  request: Record<string, unknown>;
  result: "ok" | "rejected" | "error";
  reason?: string;
  instanceId?: string;
  targetInstanceId?: string;
  executorInstanceId?: string;
  commandRequestId?: string;
  commandStatus?: "ok" | "not_found" | "stale_target" | "error";
  commandCode?: string;
};

export type AdminSuccessResponse<T> = {
  ok: true;
  data: T;
};

export type AdminErrorResponse = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type RoomListStatus = "active" | "idle" | "all";
export type RoomSortBy = "createdAt" | "lastActiveAt";
export type SortOrder = "asc" | "desc";

export type RoomListQuery = {
  status: RoomListStatus;
  keyword?: string;
  includeExpired?: boolean;
  page: number;
  pageSize: number;
  sortBy: RoomSortBy;
  sortOrder: SortOrder;
};

export type EventListQuery = {
  event?: string;
  roomCode?: string;
  sessionId?: string;
  remoteAddress?: string;
  origin?: string;
  result?: string;
  includeSystem?: boolean;
  from?: number;
  to?: number;
  page: number;
  pageSize: number;
};

export type AuditLogQuery = {
  actor?: string;
  action?: string;
  targetId?: string;
  targetType?: AuditLogRecord["targetType"];
  result?: AuditLogRecord["result"];
  from?: number;
  to?: number;
  page: number;
  pageSize: number;
};

export type RoomSummary = {
  instanceId?: string;
  instanceIds?: string[];
  roomCode: string;
  createdAt: number;
  ownerMemberId: string | null;
  ownerDisplayName: string | null;
  lastActiveAt: number;
  expiresAt: number | null;
  sharedVideo: SharedVideo | null;
  playback: PlaybackState | null;
  memberCount: number;
  isActive: boolean;
};

export type RoomDetailMember = {
  sessionId: string;
  memberId: string;
  instanceId?: string;
  displayName: string;
  joinedAt: number | null;
  remoteAddress: string | null;
  origin: string | null;
};

export type RoomDetail = {
  instanceId?: string;
  room: RoomSummary;
  members: RoomDetailMember[];
  recentEvents: RuntimeEvent[];
};
