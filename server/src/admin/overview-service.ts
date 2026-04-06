import type { GlobalEventStore } from "./global-event-store.js";
import type { RoomStore } from "../room-store.js";
import type { RuntimeStore } from "../runtime-store.js";
import type { PersistenceConfig } from "../types.js";

const OVERVIEW_EVENT_NAMES = [
  "room_created",
  "room_joined",
  "rate_limited",
  "ws_connection_rejected",
] as const;

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

  async function getEventCounts(
    query: {
      from?: number;
      to?: number;
    } = {},
  ): Promise<Record<(typeof OVERVIEW_EVENT_NAMES)[number], number>> {
    const results = await Promise.all(
      OVERVIEW_EVENT_NAMES.map(async (eventName) => {
        const result = await options.eventStore.query({
          event: eventName,
          from: query.from,
          to: query.to,
          page: 1,
          pageSize: 1,
        });
        return [eventName, result.total] as const;
      }),
    );

    return Object.fromEntries(results) as Record<
      (typeof OVERVIEW_EVENT_NAMES)[number],
      number
    >;
  }

  return {
    async getOverview() {
      const currentTime = now();
      const [lastMinuteEventCounts, totalEventCounts] = await Promise.all([
        getEventCounts({ from: currentTime - 60_000, to: currentTime }),
        getEventCounts(),
      ]);
      const totalNonExpired = await options.roomStore.countRooms({
        keyword: undefined,
        includeExpired: false,
      });
      const clusterActiveRoomCodes =
        await options.runtimeStore.listClusterActiveRoomCodes();
      const activePersistedRoomCodes = (
        await Promise.all(
          clusterActiveRoomCodes.map(async (roomCode) => {
            const room = await options.roomStore.getRoom(roomCode);
            if (!room) {
              return null;
            }
            if (room.expiresAt !== null && room.expiresAt <= currentTime) {
              return null;
            }
            return roomCode;
          }),
        )
      ).filter((roomCode): roomCode is string => typeof roomCode === "string");
      const nodeStatuses =
        await options.runtimeStore.listNodeStatuses(currentTime);
      const activeNodeStatuses =
        nodeStatuses.length === 0
          ? null
          : nodeStatuses.filter((status) => status.health !== "offline");
      const connectionCount =
        activeNodeStatuses?.reduce(
          (total, status) => total + status.connectionCount,
          0,
        ) ?? options.runtimeStore.getConnectionCount();
      const activeRoomCount = activePersistedRoomCodes.length;
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
          orphanRuntimeCount: Math.max(
            0,
            clusterActiveRoomCodes.length - activePersistedRoomCodes.length,
          ),
        },
        nodes: {
          total: nodeStatuses.length,
          online: nodeStatuses.filter((status) => status.health === "ok")
            .length,
          stale: nodeStatuses.filter((status) => status.health === "stale")
            .length,
          offline: nodeStatuses.filter((status) => status.health === "offline")
            .length,
          items: nodeStatuses,
        },
        events: {
          lastMinute: {
            room_created: lastMinuteEventCounts.room_created,
            room_joined: lastMinuteEventCounts.room_joined,
            rate_limited: lastMinuteEventCounts.rate_limited,
            ws_connection_rejected:
              lastMinuteEventCounts.ws_connection_rejected,
            error: 0,
          },
          totals: {
            room_created: totalEventCounts.room_created,
            room_joined: totalEventCounts.room_joined,
            ws_connection_rejected: totalEventCounts.ws_connection_rejected,
            rate_limited: totalEventCounts.rate_limited,
          },
        },
      };
    },
  };
}
