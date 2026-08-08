import type { MetricsCollector } from "./admin/metrics.js";
import type { ExpiredRoomSweepCounts } from "./room-service.js";
import { clampTimerIntervalMs } from "./timers.js";
import type { LogEvent } from "./types.js";

export type RoomReaper = {
  /** Resolves once the sweep in flight, if any, has settled. */
  stop: () => Promise<void>;
  runNow: () => Promise<number>;
};

export function createRoomReaper(options: {
  intervalMs: number;
  deleteExpiredRooms: (now: number) => Promise<ExpiredRoomSweepCounts>;
  logEvent: LogEvent;
  metricsCollector?: Pick<MetricsCollector, "recordRoomReaperSweep">;
  now?: () => number;
}): RoomReaper {
  const now = options.now ?? Date.now;

  async function runNow(): Promise<number> {
    try {
      const swept = await options.deleteExpiredRooms(now());
      // Every pass, whatever it found. This is the only signal that separates a
      // healthy idle reaper from a stopped one: the deletion event below fires
      // only when a sweep collected something, and continuous traffic can make
      // `resolveRoom` lazily delete every expired room before each sweep gets
      // to it, so a perfectly alive reaper can go hours without emitting it
      // (#254 review).
      options.metricsCollector?.recordRoomReaperSweep("ok");
      if (swept.deletedRooms > 0 || swept.orphanedIndexEntries > 0) {
        // Once per sweep, not once per room, and its counts do not survive into
        // events_total. Rooms are metered in `room-service`, which is also
        // where the lazy read-path expiry lives.
        options.logEvent("room_expired_deleted", {
          deletedCount: swept.deletedRooms,
          orphanedIndexEntries: swept.orphanedIndexEntries,
          result: "ok",
        });
      }
      return swept.deletedRooms;
    } catch (error) {
      options.metricsCollector?.recordRoomReaperSweep("error");
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
