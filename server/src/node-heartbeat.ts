import { clampTimerIntervalMs } from "./timers.js";
import type { LogEvent, ClusterNodeStatus } from "./types.js";
import type { RuntimeStore } from "./runtime-store.js";

export function createNodeHeartbeat(options: {
  enabled: boolean;
  instanceId: string;
  serviceVersion: string;
  runtimeStore: RuntimeStore;
  intervalMs: number;
  ttlMs: number;
  now?: () => number;
  logEvent?: LogEvent;
}) {
  const now = options.now ?? Date.now;
  const staleAfterMs = Math.max(
    options.intervalMs,
    Math.min(options.ttlMs, options.intervalMs * 2),
  );
  let timer: NodeJS.Timeout | null = null;
  let pendingBeat: Promise<void> | null = null;

  async function beat(): Promise<void> {
    if (!options.enabled) {
      return;
    }

    const currentTime = now();
    const status: ClusterNodeStatus = {
      instanceId: options.instanceId,
      version: options.serviceVersion,
      startedAt: options.runtimeStore.getStartedAt(),
      lastHeartbeatAt: currentTime,
      staleAt: currentTime + staleAfterMs,
      expiresAt: currentTime + options.ttlMs,
      connectionCount: options.runtimeStore.getConnectionCount(),
      activeRoomCount: options.runtimeStore.getActiveRoomCount(),
      activeMemberCount: options.runtimeStore.getActiveMemberCount(),
      health: "ok",
    };

    await options.runtimeStore.heartbeatNode(status);
    options.logEvent?.("node_heartbeat_sent", {
      instanceId: status.instanceId,
      version: status.version,
      connectionCount: status.connectionCount,
      activeRoomCount: status.activeRoomCount,
      activeMemberCount: status.activeMemberCount,
      ttlMs: options.ttlMs,
      result: "ok",
    });
  }

  function scheduleBeat(): void {
    pendingBeat = beat().catch((error) => {
      options.logEvent?.("node_heartbeat_failed", {
        instanceId: options.instanceId,
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return {
    start() {
      if (!options.enabled || timer) {
        return;
      }

      scheduleBeat();
      timer = setInterval(() => {
        scheduleBeat();
      }, clampTimerIntervalMs(options.intervalMs));
      timer.unref?.();
    },
    async beat() {
      await beat();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await pendingBeat;
      pendingBeat = null;
    },
  };
}
