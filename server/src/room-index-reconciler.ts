import { clampTimerIntervalMs } from "./timers.js";
import type { LogEvent } from "./types.js";

export type RoomIndexReconciler = {
  stop: () => void;
  runNow: () => Promise<boolean>;
};

/**
 * Drives the Redis room store's index reconcile on its own timer.
 *
 * The pass used to run lazily, charged to whichever read first arrived after
 * a cooldown lapsed. That made a background maintenance walk look like tail
 * latency on `delete_expired_rooms` or `count_rooms` — and left it invisible
 * whenever the caller that paid for it was not instrumented. Here it has one
 * schedule, one owner, and one histogram label.
 */
export function createRoomIndexReconciler(options: {
  intervalMs: number;
  reconcileRoomIndex: () => Promise<void>;
  logEvent: LogEvent;
}): RoomIndexReconciler {
  /** Resolves false when the pass failed; the timer path ignores the result. */
  async function runNow(): Promise<boolean> {
    try {
      await options.reconcileRoomIndex();
      return true;
    } catch (error) {
      // Swallowed rather than rethrown: an unhandled rejection out of a timer
      // takes the process down, and a failed pass is not fatal — reads still
      // answer from the index as it stands, and the next tick retries.
      options.logEvent("room_index_reconcile_failed", {
        result: "error",
        reason: "room_index_reconcile_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
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
