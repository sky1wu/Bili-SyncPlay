import { clampTimerIntervalMs } from "./timers.js";
import type { LogEvent } from "./types.js";

export type RoomReaper = {
  stop: () => void;
  runNow: () => Promise<number>;
};

export function createRoomReaper(options: {
  intervalMs: number;
  deleteExpiredRooms: (now?: number) => Promise<number>;
  logEvent: LogEvent;
  now?: () => number;
}): RoomReaper {
  const now = options.now ?? Date.now;

  async function runNow(): Promise<number> {
    try {
      const deletedCount = await options.deleteExpiredRooms(now());
      if (deletedCount > 0) {
        options.logEvent("room_expired_deleted", {
          deletedCount,
          result: "ok",
        });
      }
      return deletedCount;
    } catch (error) {
      options.logEvent("room_persist_failed", {
        result: "error",
        reason: "room_reaper_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  const intervalId = setInterval(() => {
    void runNow();
  }, clampTimerIntervalMs(options.intervalMs));

  return {
    stop() {
      clearInterval(intervalId);
    },
    runNow,
  };
}
