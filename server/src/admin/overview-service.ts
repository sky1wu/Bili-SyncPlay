import { createRoomFanOutLimiter } from "./room-fanout.js";
import {
  WINDOW_INDEXED_EVENTS,
  type GlobalEventStore,
} from "./global-event-store.js";
import type { RoomStore } from "../room-store.js";
import type { RuntimeStore } from "../runtime-store.js";
import type {
  ClusterNodeStatus,
  PersistenceConfig,
  Session,
} from "../types.js";

// The overview reads windowed counts, so it may only ask for event names the
// stores actually index — reusing the allowlist keeps the two in lockstep.
const OVERVIEW_EVENT_NAMES = WINDOW_INDEXED_EVENTS;

const EVENT_WINDOWS_MS = {
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
  fallbackInstanceId: string | null,
): Map<string, NodeWorkload> {
  const workloads = new Map<string, NodeWorkload>();
  for (const session of sessions) {
    const instanceId = session.instanceId || fallbackInstanceId;
    if (!instanceId) {
      continue;
    }
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
    localInstanceId: string | null;
    localUptimeMs: number;
    serviceVersion: string;
    startedAt: number;
  },
): ClusterNodeStatus {
  const isLocalNode = instanceId === options.localInstanceId;
  return {
    instanceId,
    version: options.serviceVersion,
    startedAt: isLocalNode ? options.startedAt : 0,
    ...(isLocalNode ? { uptimeMs: options.localUptimeMs } : {}),
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
  includeLocalNodeFallback?: boolean;
  now?: () => number;
  uptimeMs?: () => number;
}) {
  const now = options.now ?? Date.now;
  const uptimeMs = options.uptimeMs ?? (() => process.uptime() * 1_000);
  const includeLocalNodeFallback = options.includeLocalNodeFallback ?? true;
  const roomFanOut = createRoomFanOutLimiter();

  return {
    async getOverview() {
      const currentTime = now();
      const localUptimeMs = Math.max(0, uptimeMs());
      // Use the literal ms window [now - windowMs, now]. Event stores keep a
      // timestamp index for recent events, so these counters stay precise even
      // after the query buffer or Redis stream has trimmed older entries.
      const [
        lastMinuteEventCounts,
        lastHourEventCounts,
        lastDayEventCounts,
        totalEventCounts,
      ] = (await Promise.all([
        ...Object.values(EVENT_WINDOWS_MS).map((windowMs) =>
          options.eventStore.countsByEventInWindow(
            OVERVIEW_EVENT_NAMES,
            currentTime - windowMs,
            currentTime,
          ),
        ),
        options.eventStore.totalCountsByEvent(OVERVIEW_EVENT_NAMES),
      ])) as [
        Record<(typeof OVERVIEW_EVENT_NAMES)[number], number>,
        Record<(typeof OVERVIEW_EVENT_NAMES)[number], number>,
        Record<(typeof OVERVIEW_EVENT_NAMES)[number], number>,
        Record<(typeof OVERVIEW_EVENT_NAMES)[number], number>,
      ];
      const totalNonExpired = await options.roomStore.countRooms({
        keyword: undefined,
        includeExpired: false,
      });
      const clusterActiveRoomCodes =
        await options.runtimeStore.listClusterActiveRoomCodes();
      // Sized by the cluster's room count, so it goes through the shared
      // budget rather than into the room store's command admission (#277).
      const activePersistedRoomCodes = (
        await Promise.all(
          clusterActiveRoomCodes.map(async (roomCode) =>
            roomFanOut.run(async () => {
              const room = await options.roomStore.getRoom(roomCode);
              if (!room) {
                return null;
              }
              if (room.expiresAt !== null && room.expiresAt <= currentTime) {
                return null;
              }
              return roomCode;
            }),
          ),
        )
      ).filter((roomCode): roomCode is string => typeof roomCode === "string");
      const nodeStatuses = await options.runtimeStore.listNodeStatuses(
        "request",
        currentTime,
      );
      const clusterSessions =
        await options.runtimeStore.listClusterSessions("request");
      const nodeWorkloads = summarizeNodeWorkloads(
        clusterSessions,
        includeLocalNodeFallback ? options.instanceId : null,
      );
      if (includeLocalNodeFallback && !nodeWorkloads.has(options.instanceId)) {
        // A standalone room node may run with heartbeats disabled (the
        // default), and a shared session read may also be unavailable while
        // the local runtime remains authoritative for its own workload.
        nodeWorkloads.set(options.instanceId, {
          connectionCount: options.runtimeStore.getConnectionCount(),
          currentMemberCount: options.runtimeStore.getActiveMemberCount(),
          roomCodes: options.runtimeStore.getActiveRoomCodes(),
        });
      }
      const nodeStatusByInstanceId = new Map(
        nodeStatuses.map((status) => [status.instanceId, status]),
      );
      const nodeInstanceIds = new Set<string>([
        ...nodeStatuses.map((status) => status.instanceId),
        ...nodeWorkloads.keys(),
      ]);
      if (includeLocalNodeFallback) {
        nodeInstanceIds.add(options.instanceId);
      }
      const nodeItems = Array.from(nodeInstanceIds)
        .sort((left, right) => left.localeCompare(right))
        .map((instanceId) => {
          const workload = nodeWorkloads.get(instanceId);
          const status =
            nodeStatusByInstanceId.get(instanceId) ??
            synthesizeNodeStatus(instanceId, workload, {
              currentTime,
              localInstanceId: includeLocalNodeFallback
                ? options.instanceId
                : null,
              localUptimeMs,
              serviceVersion: options.serviceVersion,
              startedAt: options.runtimeStore.getStartedAt(),
            });
          const roomCodes = Array.from(workload?.roomCodes ?? []).sort();
          return {
            ...status,
            uptimeMs:
              status.uptimeMs !== undefined &&
              Number.isFinite(status.uptimeMs) &&
              status.uptimeMs >= 0
                ? status.uptimeMs
                : null,
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
          uptimeMs: localUptimeMs,
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
