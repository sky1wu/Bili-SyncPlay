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

export type Session = {
  id: string;
  socket: WebSocket;
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

export type PersistedRoom = {
  code: string;
  joinToken: string;
  createdAt: number;
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
  emptyRoomTtlMs: number;
  roomCleanupIntervalMs: number;
  redisUrl: string;
  instanceId: string;
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
};

export type SecurityConfig = {
  allowedOrigins: string[];
  allowMissingOriginInDev: boolean;
  trustProxyHeaders: boolean;
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

export type LogEvent = (event: string, data: Record<string, unknown>) => void;

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
