import { clampTimerIntervalMs } from "./timers.js";
import type { LogEvent } from "./types.js";

export type RoomReaper = {
  /** Resolves once the sweep in flight, if any, has settled. */
  stop: () => Promise<void>;
  runNow: () => Promise<number>;
};

export function createRoomReaper(options: {
  intervalMs: number;
  deleteExpiredRooms: (now: number) => Promise<number>;
  logEvent: LogEvent;
  now?: () => number;
}): RoomReaper {
  const now = options.now ?? Date.now;

  async function runNow(): Promise<number> {
    try {
      const deletedCount = await options.deleteExpiredRooms(now());
      if (deletedCount > 0) {
        // Once per sweep, not once per room: this event answers "is the reaper
        // still collecting", and its `deletedCount` field does not survive into
        // events_total. The room count is metered in `room-service`, which is
        // also where the lazy read-path expiry lives.
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

  // Same reason as `room-index-reconciler`: shutdown closes the room store
  // right after this timer is stopped, so a sweep still in flight would race
  // `redis.quit()` and issue its EVAL on a closed connection.
  let pendingSweep: Promise<number> | null = null;

  const intervalId = setInterval(() => {
    pendingSweep = runNow();
  }, clampTimerIntervalMs(options.intervalMs));

  return {
    async stop() {
      clearInterval(intervalId);
      // runNow never rejects, so awaiting it cannot fail the shutdown step.
      await pendingSweep;
      pendingSweep = null;
    },
    runNow,
  };
}
