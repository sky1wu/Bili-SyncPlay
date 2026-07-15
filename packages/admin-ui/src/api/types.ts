export type AdminRole = "viewer" | "operator" | "admin";

export type AdminIdentity = {
  id: string;
  username: string;
  role: AdminRole;
};

export type AdminLoginRequest = {
  username: string;
  password: string;
};

export type AdminLoginResult = {
  token: string;
  expiresAt: number;
  admin: AdminIdentity;
};

export type AdminMeResult = AdminIdentity & {
  expiresAt: number;
  lastSeenAt: number;
};

export type AdminLogoutResult = {
  success: boolean;
};

export type OverviewEventCounts = {
  room_created: number;
  room_joined: number;
  rate_limited: number;
  ws_connection_rejected: number;
};

export type NodeHealth = "ok" | "stale" | "offline";

export type OverviewNode = {
  instanceId: string;
  version: string;
  startedAt: number;
  lastHeartbeatAt: number;
  staleAt: number;
  expiresAt: number;
  connectionCount: number;
  activeRoomCount: number;
  activeMemberCount: number;
  health: NodeHealth;
  currentRoomCount: number;
  currentMemberCount: number;
  roomCodes: string[];
};

export type AdminOverview = {
  service: {
    instanceId: string;
    name: string;
    version: string;
    startedAt: number;
    uptimeMs: number;
  };
  storage: {
    provider: string;
    redisConnected: boolean;
  };
  runtime: {
    connectionCount: number;
    activeRoomCount: number;
    activeMemberCount: number;
  };
  rooms: {
    totalNonExpired: number;
    active: number;
    idle: number;
    orphanRuntimeCount: number;
  };
  nodes: {
    total: number;
    online: number;
    stale: number;
    offline: number;
    items: OverviewNode[];
  };
  events: {
    lastMinute: OverviewEventCounts;
    lastHour: OverviewEventCounts;
    lastDay: OverviewEventCounts;
    totals: OverviewEventCounts;
  };
};

export type ReadyStatus = {
  status: "ready" | "not_ready";
  checks: {
    httpServer: string;
    roomStore: string;
    redis: string;
  };
};
