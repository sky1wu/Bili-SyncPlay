import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type {
  ErrorCode,
  PlaybackState,
  RoomState,
  ServerMessage,
  SharedVideo,
} from "@bili-syncplay/protocol";
import type { AdminRole } from "./admin/types.js";

export type WindowCounter = {
  windowStart: number;
  count: number;
};

export type TokenBucket = {
  tokens: number;
  lastRefillAt: number;
};

export type SessionRateLimitState = {
  roomCreate: WindowCounter;
  roomJoin: WindowCounter;
  videoShare: WindowCounter;
  syncRequest: WindowCounter;
  playbackUpdate: TokenBucket;
  syncPing: TokenBucket;
};

export type SessionBase = {
  id: string;
  instanceId?: string | null;
  remoteAddress: string | null;
  origin: string | null;
  roomCode: string | null;
  memberId: string | null;
  displayName: string;
  memberToken: string | null;
  joinedAt: number | null;
  invalidMessageCount: number;
  rateLimitState: SessionRateLimitState;
};

export type AttachedSession = SessionBase & {
  connectionState: "attached";
  socket: WebSocket;
};

export type DetachedSession = SessionBase & {
  connectionState: "detached";
  socket: null;
};

export type Session = AttachedSession | DetachedSession;

export function hasAttachedSocket(
  session: Session,
): session is AttachedSession {
  return session.connectionState === "attached" && session.socket !== null;
}

export type PersistedRoom = {
  code: string;
  joinToken: string;
  createdAt: number;
  ownerMemberId?: string | null;
  ownerDisplayName?: string | null;
  sharedVideo: SharedVideo | null;
  playback: PlaybackState | null;
  version: number;
  lastActiveAt: number;
  expiresAt: number | null;
};

export type ActiveRoom = {
  code: string;
  members: Map<string, Session>;
  memberTokens: Map<string, string>;
};

export type PlaybackAuthority = {
  actorId: string;
  until: number;
  kind: "share" | "play" | "pause" | "seek" | "ratechange";
  source: "video:share" | "playback:update";
};

export type RequestContext = {
  remoteAddress: string | null;
  origin: string | null;
};

export type PersistenceConfig = {
  provider: "memory" | "redis";
  runtimeStoreProvider: "memory" | "redis";
  roomEventBusProvider: "none" | "memory" | "redis";
  adminCommandBusProvider: "none" | "memory" | "redis";
  redisNamespace?: string;
  nodeHeartbeatEnabled: boolean;
  nodeHeartbeatIntervalMs: number;
  nodeHeartbeatTtlMs: number;
  emptyRoomTtlMs: number;
  roomCleanupIntervalMs: number;
  redisUrl: string;
  instanceId: string;
};

export type ClusterNodeHealth = "ok" | "stale" | "offline";

export type ClusterNodeStatus = {
  instanceId: string;
  version: string;
  startedAt: number;
  lastHeartbeatAt: number;
  staleAt: number;
  expiresAt: number;
  connectionCount: number;
  activeRoomCount: number;
  activeMemberCount: number;
  health: ClusterNodeHealth;
};

export type AdminConfig = {
  username: string;
  passwordHash: string;
  sessionSecret: string;
  sessionTtlMs: number;
  role: AdminRole;
  sessionStoreProvider: "memory" | "redis";
  eventStoreProvider: "memory" | "redis";
  auditStoreProvider: "memory" | "redis";
} | null;

export type AdminUiConfig = {
  demoEnabled: boolean;
  apiBaseUrl?: string;
  enabled?: boolean;
};

export type SecurityConfig = {
  allowedOrigins: string[];
  allowMissingOriginInDev: boolean;
  trustedProxyAddresses: string[];
  maxConnectionsPerIp: number;
  connectionAttemptsPerMinute: number;
  maxMembersPerRoom: number;
  maxMessageBytes: number;
  invalidMessageCloseThreshold: number;
  rateLimits: {
    roomCreatePerMinute: number;
    roomJoinPerMinute: number;
    videoSharePer10Seconds: number;
    playbackUpdatePerSecond: number;
    playbackUpdateBurst: number;
    syncRequestPer10Seconds: number;
    syncPingPerSecond: number;
    syncPingBurst: number;
  };
};

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEventOptions = {
  level?: LogLevel;
};

export type LogEvent = (
  event: string,
  data: Record<string, unknown>,
  options?: LogEventOptions,
) => void;

export type SendMessage = (socket: WebSocket, message: ServerMessage) => void;

export type SendError = (
  socket: WebSocket,
  code: ErrorCode,
  message: string,
) => void;

declare module "node:http" {
  interface IncomingMessage {
    biliSyncPlayContext?: RequestContext;
  }
}

export type UpgradeDecision =
  | {
      ok: true;
      context: RequestContext;
    }
  | {
      ok: false;
      statusCode: number;
      statusText: string;
      context: RequestContext;
      reason: string;
    };

export type UpgradeRequest = IncomingMessage;

export type RoomStoreRoomState = RoomState;
