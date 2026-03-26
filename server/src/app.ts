import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  isClientMessage,
  type ErrorCode,
  type ServerMessage,
} from "@bili-syncplay/protocol";
import { createEventStore } from "./admin/event-store.js";
import { createRedisEventStore } from "./admin/redis-event-store.js";
import { createAdminServices } from "./bootstrap/admin-services.js";
import { createHttpRequestHandler } from "./bootstrap/http-handler.js";
import { createStructuredLogger } from "./logger.js";
import { createMessageHandler } from "./message-handler.js";
import { createNodeHeartbeat } from "./node-heartbeat.js";
import { createSessionRateLimitState } from "./rate-limit.js";
import { createInMemoryRoomStore, type RoomStore } from "./room-store.js";
import { createRoomReaper } from "./room-reaper.js";
import { createRoomService } from "./room-service.js";
import { createRedisRoomStore } from "./redis-room-store.js";
import { createRedisRuntimeStore } from "./redis-runtime-store.js";
import {
  createInMemoryRuntimeStore,
  type RuntimeStore,
} from "./runtime-store.js";
import { createSecurityPolicy } from "./security.js";
import type { GlobalEventStore } from "./admin/global-event-store.js";
import type {
  AdminConfig,
  AdminUiConfig,
  LogEvent,
  PersistenceConfig,
  SecurityConfig,
  Session,
} from "./types.js";
import {
  INTERNAL_SERVER_ERROR_MESSAGE,
  INVALID_CLIENT_MESSAGE_MESSAGE,
  INVALID_JSON_MESSAGE,
} from "./messages.js";

export type {
  AdminConfig,
  AdminUiConfig,
  PersistenceConfig,
  SecurityConfig,
} from "./types.js";
export {
  INTERNAL_SERVER_ERROR_MESSAGE,
  INVALID_CLIENT_MESSAGE_MESSAGE,
  INVALID_JSON_MESSAGE,
} from "./messages.js";

const CLOSE_CODE_POLICY_VIOLATION = 1008;
const PACKAGE_JSON_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../package.json",
);

let cachedServiceVersion: string | null = null;

export type SyncServer = {
  httpServer: HttpServer;
  close: () => Promise<void>;
};

export type SyncServerDependencies = {
  roomStore?: RoomStore;
  logEvent?: LogEvent;
  generateToken?: () => string;
  now?: () => number;
  adminConfig?: AdminConfig;
  adminUiConfig?: AdminUiConfig;
  serviceVersion?: string;
};

function createMirroredRuntimeStore(
  localRuntimeStore: RuntimeStore,
  sharedRuntimeStore: RuntimeStore,
): RuntimeStore {
  return {
    registerSession(session) {
      localRuntimeStore.registerSession(session);
      sharedRuntimeStore.registerSession(session);
    },
    unregisterSession(sessionId) {
      localRuntimeStore.unregisterSession(sessionId);
      sharedRuntimeStore.unregisterSession(sessionId);
    },
    markSessionJoinedRoom(sessionId, roomCode) {
      localRuntimeStore.markSessionJoinedRoom(sessionId, roomCode);
      sharedRuntimeStore.markSessionJoinedRoom(sessionId, roomCode);
    },
    markSessionLeftRoom(sessionId, roomCode) {
      localRuntimeStore.markSessionLeftRoom(sessionId, roomCode);
      sharedRuntimeStore.markSessionLeftRoom(sessionId, roomCode);
    },
    recordEvent(event, timestamp) {
      localRuntimeStore.recordEvent(event, timestamp);
      sharedRuntimeStore.recordEvent(event, timestamp);
    },
    getSession(sessionId) {
      return localRuntimeStore.getSession(sessionId);
    },
    listSessionsByRoom(roomCode) {
      return localRuntimeStore.listSessionsByRoom(roomCode);
    },
    getConnectionCount() {
      return localRuntimeStore.getConnectionCount();
    },
    getActiveRoomCount() {
      return localRuntimeStore.getActiveRoomCount();
    },
    getActiveMemberCount() {
      return localRuntimeStore.getActiveMemberCount();
    },
    getStartedAt() {
      return localRuntimeStore.getStartedAt();
    },
    getRecentEventCounts(currentTime) {
      return localRuntimeStore.getRecentEventCounts(currentTime);
    },
    getLifetimeEventCounts() {
      return localRuntimeStore.getLifetimeEventCounts();
    },
    getActiveRoomCodes() {
      return localRuntimeStore.getActiveRoomCodes();
    },
    getRoom(code) {
      return localRuntimeStore.getRoom(code);
    },
    getOrCreateRoom(code) {
      return localRuntimeStore.getOrCreateRoom(code);
    },
    addMember(code, memberId, session, memberToken) {
      const room = localRuntimeStore.addMember(code, memberId, session, memberToken);
      sharedRuntimeStore.addMember(code, memberId, session, memberToken);
      return room;
    },
    findMemberIdByToken(code, memberToken) {
      return localRuntimeStore.findMemberIdByToken(code, memberToken);
    },
    blockMemberToken(code, memberToken, expiresAt) {
      localRuntimeStore.blockMemberToken(code, memberToken, expiresAt);
      sharedRuntimeStore.blockMemberToken(code, memberToken, expiresAt);
    },
    isMemberTokenBlocked(code, memberToken, currentTime) {
      return localRuntimeStore.isMemberTokenBlocked(code, memberToken, currentTime);
    },
    removeMember(code, memberId, session) {
      const removal = localRuntimeStore.removeMember(code, memberId, session);
      void sharedRuntimeStore.removeMember(code, memberId, session);
      return removal;
    },
    deleteRoom(code) {
      localRuntimeStore.deleteRoom(code);
      sharedRuntimeStore.deleteRoom(code);
    },
    heartbeatNode(status) {
      return sharedRuntimeStore.heartbeatNode(status);
    },
    listNodeStatuses(currentTime) {
      return sharedRuntimeStore.listNodeStatuses(currentTime);
    },
    countClusterActiveRooms() {
      return sharedRuntimeStore.countClusterActiveRooms();
    },
    listClusterSessionsByRoom(roomCode) {
      return sharedRuntimeStore.listClusterSessionsByRoom(roomCode);
    },
  };
}

async function resolveServiceVersion(): Promise<string> {
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

export function getDefaultSecurityConfig(): SecurityConfig {
  return {
    allowedOrigins: [],
    allowMissingOriginInDev: false,
    trustProxyHeaders: false,
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

export function getDefaultPersistenceConfig(): PersistenceConfig {
  return {
    provider: "memory",
    runtimeStoreProvider: "memory",
    nodeHeartbeatEnabled: false,
    nodeHeartbeatIntervalMs: 15_000,
    nodeHeartbeatTtlMs: 45_000,
    emptyRoomTtlMs: 15 * 60 * 1000,
    roomCleanupIntervalMs: 60 * 1000,
    redisUrl: "redis://localhost:6379",
    instanceId: "instance-1",
  };
}

export async function createSyncServer(
  securityConfig: SecurityConfig = getDefaultSecurityConfig(),
  persistenceConfig: PersistenceConfig = getDefaultPersistenceConfig(),
  dependencies: SyncServerDependencies = {},
): Promise<SyncServer> {
  const serviceVersion =
    dependencies.serviceVersion ?? (await resolveServiceVersion());
  const now = dependencies.now ?? Date.now;
  const generateToken =
    dependencies.generateToken ?? (() => randomBytes(24).toString("base64url"));
  const roomStore =
    dependencies.roomStore ??
    (persistenceConfig.provider === "redis"
      ? await createRedisRoomStore(persistenceConfig.redisUrl)
      : createInMemoryRoomStore({ now }));
  const localRuntimeStore = createInMemoryRuntimeStore(now);
  const sharedRuntimeStore =
    persistenceConfig.runtimeStoreProvider === "redis"
      ? await createRedisRuntimeStore(persistenceConfig.redisUrl, { now })
      : localRuntimeStore;
  const runtimeStore =
    sharedRuntimeStore === localRuntimeStore
      ? localRuntimeStore
      : createMirroredRuntimeStore(localRuntimeStore, sharedRuntimeStore);
  const eventStore =
    dependencies.adminConfig?.eventStoreProvider === "redis"
      ? await createRedisEventStore(persistenceConfig.redisUrl)
      : createEventStore();
  const logEvent =
    dependencies.logEvent ??
    createStructuredLogger(undefined, eventStore, runtimeStore);
  const securityPolicy = createSecurityPolicy(securityConfig);

  const roomService = createRoomService({
    config: securityConfig,
    persistence: persistenceConfig,
    roomStore,
    runtimeStore,
    generateToken,
    logEvent,
    now,
  });

  const messageHandler = createMessageHandler({
    config: securityConfig,
    roomService,
    logEvent,
    send,
    sendError,
    onRoomJoined: (session, roomCode) => {
      runtimeStore.registerSession(session);
      runtimeStore.markSessionJoinedRoom(session.id, roomCode);
    },
    onRoomLeft: (session, roomCode) => {
      runtimeStore.registerSession(session);
      runtimeStore.markSessionLeftRoom(session.id, roomCode);
    },
    now,
  });

  const roomReaper = createRoomReaper({
    intervalMs: persistenceConfig.roomCleanupIntervalMs,
    deleteExpiredRooms: roomService.deleteExpiredRooms,
    logEvent,
    now,
  });
  const nodeHeartbeat = createNodeHeartbeat({
    enabled: persistenceConfig.nodeHeartbeatEnabled,
    instanceId: persistenceConfig.instanceId,
    serviceVersion,
    runtimeStore,
    intervalMs: persistenceConfig.nodeHeartbeatIntervalMs,
    ttlMs: persistenceConfig.nodeHeartbeatTtlMs,
    now,
    logEvent,
  });
  nodeHeartbeat.start();
  const { adminRouter, close: closeAdminServices } = await createAdminServices({
    securityConfig,
    persistenceConfig,
    roomStore,
    runtimeStore,
    eventStore,
    roomService,
    send,
    logEvent,
    now,
    adminConfig: dependencies.adminConfig,
    serviceVersion,
  });

  const httpServer = createServer(
    createHttpRequestHandler({
      adminRouter,
      securityPolicy,
      adminUiConfig: dependencies.adminUiConfig,
    }),
  );

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: securityConfig.maxMessageBytes,
  });
  const pendingSessionCleanup = new Set<Promise<void>>();

  function send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function sendError(
    socket: WebSocket,
    code: ErrorCode,
    message: string,
  ): void {
    send(socket, {
      type: "error",
      payload: { code, message },
    });
  }

  function parseIncomingMessage(raw: RawData): unknown {
    return JSON.parse(raw.toString()) as unknown;
  }

  function decodeCloseReason(reason: Buffer): string {
    const decoded = reason.toString("utf8");
    return decoded.length > 0 ? decoded : "";
  }

  function countInvalidMessage(session: Session, reason: string): void {
    session.invalidMessageCount += 1;
    logEvent("invalid_message", {
      sessionId: session.id,
      roomCode: session.roomCode,
      remoteAddress: session.remoteAddress,
      origin: session.origin,
      result: "rejected",
      reason,
      invalidMessageCount: session.invalidMessageCount,
    });

    if (
      session.invalidMessageCount >= securityConfig.invalidMessageCloseThreshold
    ) {
      session.socket.close(
        CLOSE_CODE_POLICY_VIOLATION,
        "Too many invalid messages",
      );
    }
  }

  function rejectUpgrade(
    socket: import("node:stream").Duplex,
    statusCode: number,
    statusText: string,
    details: Record<string, unknown>,
  ): void {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
    logEvent("ws_connection_rejected", details);
  }

  httpServer.on("upgrade", (request, socket, head) => {
    const decision = securityPolicy.evaluateUpgrade(request);
    if (!decision.ok) {
      rejectUpgrade(socket, decision.statusCode, decision.statusText, {
        remoteAddress: decision.context.remoteAddress,
        origin: decision.context.origin,
        result: "rejected",
        reason: decision.reason,
      });
      return;
    }

    request.biliSyncPlayContext = decision.context;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket, request) => {
    const context = request.biliSyncPlayContext ?? {
      remoteAddress: securityPolicy.getRemoteAddress(request),
      origin:
        typeof request.headers.origin === "string"
          ? request.headers.origin
          : null,
    };
    const session: Session = {
      id: randomUUID(),
      socket,
      instanceId: persistenceConfig.instanceId,
      remoteAddress: context.remoteAddress,
      origin: context.origin,
      roomCode: null,
      memberId: null,
      displayName: `Guest-${Math.floor(Math.random() * 900 + 100)}`,
      memberToken: null,
      joinedAt: null,
      invalidMessageCount: 0,
      rateLimitState: createSessionRateLimitState(securityConfig),
    };

    securityPolicy.incrementConnectionCount(session.remoteAddress);
    runtimeStore.registerSession(session);
    logEvent("ws_connection_accepted", {
      sessionId: session.id,
      remoteAddress: session.remoteAddress,
      origin: session.origin,
      result: "ok",
    });
    let messageQueue = Promise.resolve();

    socket.on("message", (raw) => {
      messageQueue = messageQueue
        .catch(() => undefined)
        .then(async () => {
          let parsed: unknown;
          try {
            parsed = parseIncomingMessage(raw);
          } catch {
            sendError(socket, "invalid_message", INVALID_JSON_MESSAGE);
            countInvalidMessage(session, "invalid_json");
            return;
          }

          if (!isClientMessage(parsed)) {
            sendError(
              socket,
              "invalid_message",
              INVALID_CLIENT_MESSAGE_MESSAGE,
            );
            countInvalidMessage(session, "invalid_client_message");
            return;
          }

          try {
            await messageHandler.handleClientMessage(session, parsed);
          } catch (error) {
            console.error("Unhandled client message error", error);
            sendError(socket, "internal_error", INTERNAL_SERVER_ERROR_MESSAGE);
          }
        });
    });

    socket.on("error", (error) => {
      logEvent("ws_connection_error", {
        sessionId: session.id,
        remoteAddress: session.remoteAddress,
        origin: session.origin,
        roomCode: session.roomCode,
        result: "error",
        error: error.message,
      });
    });

    socket.on("close", (code, reason) => {
      const cleanup = (async () => {
        securityPolicy.decrementConnectionCount(session.remoteAddress);
        await messageHandler.leaveRoom(session);
        runtimeStore.unregisterSession(session.id);
        logEvent("ws_connection_closed", {
          sessionId: session.id,
          remoteAddress: session.remoteAddress,
          origin: session.origin,
          roomCode: session.roomCode,
          result: "closed",
          code,
          reason: decodeCloseReason(reason),
        });
      })();
      pendingSessionCleanup.add(cleanup);
      void cleanup.finally(() => {
        pendingSessionCleanup.delete(cleanup);
      });
    });
  });

  return {
    httpServer,
    close: async () => {
      roomReaper.stop();
      await nodeHeartbeat.stop();
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((wsError) => {
          if (wsError) {
            reject(wsError);
            return;
          }
          httpServer.close((httpError) => {
            if (httpError) {
              reject(httpError);
              return;
            }
            resolve();
          });
        });
      });
      await Promise.allSettled(Array.from(pendingSessionCleanup));
      const maybeClosableStore = roomStore as RoomStore & {
        close?: () => Promise<void>;
      };
      if (typeof maybeClosableStore.close === "function") {
        await maybeClosableStore.close();
      }
      const maybeClosableEventStore = eventStore as GlobalEventStore & {
        close?: () => Promise<void>;
      };
      if (typeof maybeClosableEventStore.close === "function") {
        await maybeClosableEventStore.close();
      }
      if (sharedRuntimeStore !== localRuntimeStore) {
        const maybeClosableRuntimeStore = sharedRuntimeStore as typeof sharedRuntimeStore & {
          close?: () => Promise<void>;
        };
        if (typeof maybeClosableRuntimeStore.close === "function") {
          await maybeClosableRuntimeStore.close();
        }
      }
      await closeAdminServices();
    },
  };
}
