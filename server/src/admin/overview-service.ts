import type { GlobalEventStore } from "./global-event-store.js";
import type { RoomStore } from "../room-store.js";
import type { RuntimeStore } from "../runtime-store.js";
import type { PersistenceConfig } from "../types.js";

export function createAdminOverviewService(options: {
  instanceId: string;
  serviceName: string;
  serviceVersion: string;
  persistenceConfig: PersistenceConfig;
  roomStore: RoomStore;
  runtimeStore: RuntimeStore;
  eventStore: GlobalEventStore;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;

  return {
    async getOverview() {
      const currentTime = now();
      const totalNonExpired = await options.roomStore.countRooms({
        keyword: undefined,
        includeExpired: false,
      });
      const nodeStatuses = await options.runtimeStore.listNodeStatuses(currentTime);
      const clusterActiveRoomCount =
        await options.runtimeStore.countClusterActiveRooms();
      const activeNodeStatuses =
        nodeStatuses.length === 0
          ? null
          : nodeStatuses.filter((status) => status.health !== "offline");
      const connectionCount =
        activeNodeStatuses?.reduce(
          (total, status) => total + status.connectionCount,
          0,
        ) ?? options.runtimeStore.getConnectionCount();
      const activeRoomCount =
        activeNodeStatuses !== null
          ? clusterActiveRoomCount
          : options.runtimeStore.getActiveRoomCount();
      const activeMemberCount =
        activeNodeStatuses?.reduce(
          (total, status) => total + status.activeMemberCount,
          0,
        ) ?? options.runtimeStore.getActiveMemberCount();

      return {
        service: {
          instanceId: options.instanceId,
          name: options.serviceName,
          version: options.serviceVersion,
          startedAt: options.runtimeStore.getStartedAt(),
          uptimeMs: currentTime - options.runtimeStore.getStartedAt(),
        },
        storage: {
          provider: options.persistenceConfig.provider,
          redisConnected:
            options.persistenceConfig.provider === "redis"
              ? await options.roomStore.isReady()
              : true,
        },
        runtime: {
          connectionCount,
          activeRoomCount,
          activeMemberCount,
        },
        rooms: {
          totalNonExpired,
          active: activeRoomCount,
          idle: Math.max(0, totalNonExpired - activeRoomCount),
        },
        nodes: {
          total: nodeStatuses.length,
          online: nodeStatuses.filter((status) => status.health === "ok").length,
          stale: nodeStatuses.filter((status) => status.health === "stale")
            .length,
          offline: nodeStatuses.filter((status) => status.health === "offline")
            .length,
          items: nodeStatuses,
        },
        events: {
          lastMinute: {
            room_created: 0,
            room_joined: 0,
            rate_limited: 0,
            ws_connection_rejected: 0,
            error: 0,
            ...options.runtimeStore.getRecentEventCounts(currentTime),
          },
          totals: {
            room_created: 0,
            room_joined: 0,
            ws_connection_rejected: 0,
            rate_limited: 0,
            ...options.runtimeStore.getLifetimeEventCounts(),
          },
        },
      };
    },
  };
}
