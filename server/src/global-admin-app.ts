import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createEventStore } from "./admin/event-store.js";
import { createGlobalAdminOverviewService } from "./admin/global-overview-service.js";
import { createGlobalAdminRoomQueryService } from "./admin/global-room-query-service.js";
import { createRedisEventStore } from "./admin/redis-event-store.js";
import { createAdminServices } from "./bootstrap/admin-services.js";
import { createHttpRequestHandler } from "./bootstrap/http-handler.js";
import { createStructuredLogger } from "./logger.js";
import {
  createInMemoryAdminCommandBus,
  createNoopAdminCommandBus,
  type AdminCommandBus,
} from "./admin-command-bus.js";
import {
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
} from "./app.js";
import { createRedisAdminCommandBus } from "./redis-admin-command-bus.js";
import { createRedisRoomEventBus } from "./redis-room-event-bus.js";
import { createInMemoryRoomStore, type RoomStore } from "./room-store.js";
import { createRoomService } from "./room-service.js";
import type { RoomEventBus, RoomEventBusMessage } from "./room-event-bus.js";
import {
  createInMemoryRoomEventBus,
  createNoopRoomEventBus,
} from "./room-event-bus.js";
import {
  createInMemoryRuntimeStore,
  type RuntimeStore,
} from "./runtime-store.js";
import { createSecurityPolicy } from "./security.js";
import { createRedisRoomStore } from "./redis-room-store.js";
import { createRedisRuntimeStore } from "./redis-runtime-store.js";
import {
  getRedisAdminCommandChannelPrefix,
  getRedisAdminCommandResultChannelPrefix,
  getRedisEventStreamKey,
  getRedisRoomEventChannel,
  getRedisRuntimeKeyPrefix,
} from "./redis-namespace.js";
import type { GlobalEventStore } from "./admin/global-event-store.js";
import type {
  AdminConfig,
  AdminUiConfig,
  LogEvent,
  PersistenceConfig,
  SecurityConfig,
} from "./types.js";

export type GlobalAdminServer = {
  httpServer: HttpServer;
  close: () => Promise<void>;
};

export type GlobalAdminServerDependencies = {
  roomStore?: RoomStore;
  logEvent?: LogEvent;
  generateToken?: () => string;
  now?: () => number;
  adminConfig?: AdminConfig;
  adminUiConfig?: AdminUiConfig;
  serviceVersion?: string;
};

export async function createGlobalAdminServer(
  securityConfig: SecurityConfig = getDefaultSecurityConfig(),
  persistenceConfig: PersistenceConfig = getDefaultPersistenceConfig(),
  dependencies: GlobalAdminServerDependencies = {},
): Promise<GlobalAdminServer> {
  const now = dependencies.now ?? Date.now;
  const generateToken =
    dependencies.generateToken ?? (() => randomBytes(24).toString("base64url"));
  const roomStore =
    dependencies.roomStore ??
    (persistenceConfig.provider === "redis"
      ? await createRedisRoomStore(persistenceConfig.redisUrl, {
          namespace: persistenceConfig.redisNamespace,
        })
      : createInMemoryRoomStore({ now }));
  const runtimeStore =
    persistenceConfig.runtimeStoreProvider === "redis"
      ? await createRedisRuntimeStore(persistenceConfig.redisUrl, {
          now,
          keyPrefix: getRedisRuntimeKeyPrefix(persistenceConfig.redisNamespace),
        })
      : createInMemoryRuntimeStore(now);
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
  const logEvent =
    dependencies.logEvent ??
    createStructuredLogger(undefined, eventStore, runtimeStore);
  const roomService = createRoomService({
    config: securityConfig,
    persistence: persistenceConfig,
    roomStore,
    runtimeStore,
    generateToken,
    logEvent,
    now,
  });
  const securityPolicy = createSecurityPolicy(securityConfig);
  const { adminRouter, close: closeAdminServices } = await createAdminServices({
    securityConfig,
    persistenceConfig,
    roomStore,
    runtimeStore,
    eventStore,
    roomService,
    send() {},
    publishRoomEvent: (message: RoomEventBusMessage) =>
      roomEventBus.publish(message),
    requestAdminCommand: (command, timeoutMs) =>
      adminCommandBus.request(command, timeoutMs),
    logEvent,
    now,
    adminConfig: dependencies.adminConfig,
    serviceName: "bili-syncplay-global-admin",
    createOverviewService: createGlobalAdminOverviewService,
    createRoomQueryService: createGlobalAdminRoomQueryService,
    serviceVersion: dependencies.serviceVersion ?? "0.0.0-global-admin",
  });

  const httpServer = createServer(
    createHttpRequestHandler({
      adminRouter,
      securityPolicy,
      adminUiConfig: dependencies.adminUiConfig,
    }),
  );

  return {
    httpServer,
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      const maybeClosableRoomStore = roomStore as RoomStore & {
        close?: () => Promise<void>;
      };
      if (typeof maybeClosableRoomStore.close === "function") {
        await maybeClosableRoomStore.close();
      }
      const maybeClosableRuntimeStore = runtimeStore as RuntimeStore & {
        close?: () => Promise<void>;
      };
      if (typeof maybeClosableRuntimeStore.close === "function") {
        await maybeClosableRuntimeStore.close();
      }
      const maybeClosableEventStore = eventStore as GlobalEventStore & {
        close?: () => Promise<void>;
      };
      if (typeof maybeClosableEventStore.close === "function") {
        await maybeClosableEventStore.close();
      }
      const maybeClosableAdminCommandBus =
        adminCommandBus as AdminCommandBus & {
          close?: () => Promise<void>;
        };
      if (typeof maybeClosableAdminCommandBus.close === "function") {
        await maybeClosableAdminCommandBus.close();
      }
      const maybeClosableRoomEventBus = roomEventBus as RoomEventBus & {
        close?: () => Promise<void>;
      };
      if (typeof maybeClosableRoomEventBus.close === "function") {
        await maybeClosableRoomEventBus.close();
      }
      await closeAdminServices();
    },
  };
}
