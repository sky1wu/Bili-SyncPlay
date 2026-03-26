import type { LogEvent } from "./types.js";
import type { RuntimeStore } from "./runtime-store.js";

export function createRuntimeIndexReaper(options: {
  enabled: boolean;
  runtimeStore: RuntimeStore;
  intervalMs: number;
  now?: () => number;
  logEvent?: LogEvent;
}) {
  const now = options.now ?? Date.now;
  let timer: NodeJS.Timeout | null = null;
  let pendingSweep: Promise<number> | null = null;

  async function sweep(): Promise<number> {
    if (!options.enabled) {
      return 0;
    }

    const currentTime = now();
    const nodeStatuses =
      await options.runtimeStore.listNodeStatuses(currentTime);
    const offlineInstanceIds = new Set(
      nodeStatuses
        .filter((status) => status.health === "offline")
        .map((status) => status.instanceId),
    );
    if (offlineInstanceIds.size === 0) {
      return 0;
    }

    const sessions = await options.runtimeStore.listClusterSessions();
    let cleanedSessions = 0;
    for (const session of sessions) {
      if (!session.instanceId || !offlineInstanceIds.has(session.instanceId)) {
        continue;
      }

      if (session.roomCode && session.memberId) {
        await options.runtimeStore.removeMember(
          session.roomCode,
          session.memberId,
        );
        options.runtimeStore.markSessionLeftRoom(session.id, session.roomCode);
      } else if (session.roomCode) {
        options.runtimeStore.markSessionLeftRoom(session.id, session.roomCode);
      }

      options.runtimeStore.unregisterSession(session.id);
      cleanedSessions += 1;
    }

    if (cleanedSessions > 0) {
      options.logEvent?.("runtime_index_sessions_reaped", {
        offlineInstanceIds: Array.from(offlineInstanceIds).sort(),
        cleanedSessions,
        result: "ok",
      });
    }

    return cleanedSessions;
  }

  function scheduleSweep(): void {
    pendingSweep = sweep().catch((error) => {
      options.logEvent?.("runtime_index_reaper_failed", {
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    });
  }

  return {
    start() {
      if (!options.enabled || timer) {
        return;
      }
      timer = setInterval(() => {
        scheduleSweep();
      }, options.intervalMs);
      timer.unref?.();
    },
    async sweep() {
      return sweep();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await pendingSweep;
      pendingSweep = null;
    },
  };
}
