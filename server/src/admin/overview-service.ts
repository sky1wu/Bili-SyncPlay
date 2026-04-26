import type { GlobalEventStore } from "./global-event-store.js";
import type { RoomStore } from "../room-store.js";
import type { RuntimeStore } from "../runtime-store.js";
import type {
  ClusterNodeStatus,
  PersistenceConfig,
  Session,
} from "../types.js";

const OVERVIEW_EVENT_NAMES = [
  "room_created",
  "room_joined",
  "rate_limited",
  "ws_connection_rejected",
] as const;

const EVENT_WINDOWS = {
  lastMinute: 60_000,
  lastHour: 60 * 60_000,
  lastDay: 24 * 60 * 60_000,
} as const;

type NodeWorkload = {
  connectionCount: number;
  currentMemberCount: number;
  roomCodes: Set<string>;
};

function summarizeNodeWorkloads(
  sessions: Session[],
  fallbackInstanceId: string,
): Map<string, NodeWorkload> {
  const workloads = new Map<string, NodeWorkload>();
  for (const session of sessions) {
    const instanceId = session.instanceId || fallbackInstanceId;
    const workload = workloads.get(instanceId) ?? {
      connectionCount: 0,
      currentMemberCount: 0,
      roomCodes: new Set<string>(),
    };

    workload.connectionCount += 1;
    if (session.roomCode) {
      workload.currentMemberCount += 1;
      workload.roomCodes.add(session.roomCode);
    }

    workloads.set(instanceId, workload);
  }
  return workloads;
}

function synthesizeNodeStatus(
  instanceId: string,
  workload: NodeWorkload | undefined,
  options: {
    currentTime: number;
    fallbackInstanceId: string;
    serviceVersion: string;
    startedAt: number;
  },
): ClusterNodeStatus {
  return {
    instanceId,
    version: options.serviceVersion,
    startedAt:
      instanceId === options.fallbackInstanceId ? options.startedAt : 0,
    lastHeartbeatAt: options.currentTime,
    staleAt: options.currentTime,
    expiresAt: options.currentTime,
    connectionCount: workload?.connectionCount ?? 0,
    activeRoomCount: workload?.roomCodes.size ?? 0,
    activeMemberCount: workload?.currentMemberCount ?? 0,
    health: "ok",
  };
}

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

  async function collectEventCounts(
    fetcher: (eventName: string) => Promise<number>,
  ): Promise<Record<(typeof OVERVIEW_EVENT_NAMES)[number], number>> {
    const results = await Promise.all(
      OVERVIEW_EVENT_NAMES.map(
        async (name) => [name, await fetcher(name)] as const,
      ),
    );
    return Object.fromEntries(results) as Record<
      (typeof OVERVIEW_EVENT_NAMES)[number],
      number
    >;
  }

  return {
    async getOverview() {
      const currentTime = now();
      const [
        lastMinuteEventCounts,
        lastHourEventCounts,
        lastDayEventCounts,
        totalEventCounts,
      ] = await Promise.all([
        ...Object.values(EVENT_WINDOWS).map((windowMs) =>
          collectEventCounts(async (name) => {
            const result = await options.eventStore.query({
              event: name,
              from: currentTime - windowMs,
              to: currentTime,
              page: 1,
              pageSize: 1,
            });
            return result.total;
          }),
        ),
        options.eventStore.totalCountsByEvent(OVERVIEW_EVENT_NAMES) as Promise<
          Record<(typeof OVERVIEW_EVENT_NAMES)[number], number>
        >,
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
      const clusterSessions = await options.runtimeStore.listClusterSessions();
      const nodeWorkloads = summarizeNodeWorkloads(
        clusterSessions,
        options.instanceId,
      );
      const nodeStatusByInstanceId = new Map(
        nodeStatuses.map((status) => [status.instanceId, status]),
      );
      const nodeInstanceIds = new Set<string>([
        options.instanceId,
        ...nodeStatuses.map((status) => status.instanceId),
        ...nodeWorkloads.keys(),
      ]);
      const nodeItems = Array.from(nodeInstanceIds)
        .sort((left, right) => left.localeCompare(right))
        .map((instanceId) => {
          const workload = nodeWorkloads.get(instanceId);
          const status =
            nodeStatusByInstanceId.get(instanceId) ??
            synthesizeNodeStatus(instanceId, workload, {
              currentTime,
              fallbackInstanceId: options.instanceId,
              serviceVersion: options.serviceVersion,
              startedAt: options.runtimeStore.getStartedAt(),
            });
          const roomCodes = Array.from(workload?.roomCodes ?? []).sort();
          return {
            ...status,
            connectionCount:
              workload?.connectionCount ?? status.connectionCount,
            currentRoomCount: workload
              ? roomCodes.length
              : status.activeRoomCount,
            currentMemberCount:
              workload?.currentMemberCount ?? status.activeMemberCount,
            roomCodes,
          };
        });
      const activeNodeStatuses =
        nodeItems.length === 0
          ? null
          : nodeItems.filter((status) => status.health !== "offline");
      const connectionCount =
        activeNodeStatuses?.reduce(
          (total, status) => total + status.connectionCount,
          0,
        ) ?? options.runtimeStore.getConnectionCount();
      const activeRoomCount = activePersistedRoomCodes.length;
      const activeMemberCount =
        activeNodeStatuses?.reduce(
          (total, status) => total + status.currentMemberCount,
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
          total: nodeItems.length,
          online: nodeItems.filter((status) => status.health === "ok").length,
          stale: nodeItems.filter((status) => status.health === "stale").length,
          offline: nodeItems.filter((status) => status.health === "offline")
            .length,
          items: nodeItems,
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
          lastHour: {
            room_created: lastHourEventCounts.room_created,
            room_joined: lastHourEventCounts.room_joined,
            rate_limited: lastHourEventCounts.rate_limited,
            ws_connection_rejected: lastHourEventCounts.ws_connection_rejected,
          },
          lastDay: {
            room_created: lastDayEventCounts.room_created,
            room_joined: lastDayEventCounts.room_joined,
            rate_limited: lastDayEventCounts.rate_limited,
            ws_connection_rejected: lastDayEventCounts.ws_connection_rejected,
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
