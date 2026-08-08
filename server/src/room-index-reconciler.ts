import {
  createMaintenancePass,
  type MaintenancePassFailureReason,
} from "./maintenance-pass.js";
import type { LogEvent } from "./types.js";

export type RoomIndexReconciler = {
  /** Resolves once the pass in flight, if any, has settled. */
  stop: () => Promise<void>;
  runNow: () => Promise<boolean>;
};

/**
 * Caps ONE reconcile pass (#261).
 *
 * The pass walks the keyspace in chunks, so it is allowed to take far longer
 * than a reaper sweep — but not forever: without a cap a stalled connection
 * leaves the pass pending, every later tick piles another SCAN on top, and
 * `stop_room_index_reconciler` waits on it until the shutdown step itself times
 * out and is recorded as failed. Comfortably inside the 15-minute reconcile
 * interval.
 */
const RECONCILE_TIMEOUT_MS = 60_000;

const RECONCILE_FAILURE_REASON: Record<MaintenancePassFailureReason, string> = {
  run_failed: "room_index_reconcile_failed",
  timed_out: "room_index_reconcile_timeout",
  still_running: "room_index_reconcile_stalled",
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
  // Injectable only so a test does not have to spend the real cap in wall
  // clock; production always uses the constant.
  reconcileTimeoutMs?: number;
}): RoomIndexReconciler {
  const reconcileTimeoutMs = options.reconcileTimeoutMs ?? RECONCILE_TIMEOUT_MS;

  return createMaintenancePass<void, boolean>({
    name: "room index reconcile",
    intervalMs: options.intervalMs,
    timeoutMs: reconcileTimeoutMs,
    run: () => options.reconcileRoomIndex(),
    onSuccess: () => true,
    onFailure: ({ reason, error }) => {
      // Reported rather than rethrown: an unhandled rejection out of a timer
      // takes the process down, and a failed pass is not fatal — reads still
      // answer from the index as it stands, and the next tick retries.
      options.logEvent("room_index_reconcile_failed", {
        result: "error",
        reason: RECONCILE_FAILURE_REASON[reason],
        ...(reason === "run_failed" ? {} : { timeoutMs: reconcileTimeoutMs }),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    },
    onSettleTimeout: ({ pendingCalls, budgetMs }) => {
      // `close_room_store` runs immediately after `stop_room_index_reconciler`,
      // so a SCAN/GET still in the air here is about to meet `redis.quit()`.
      // Before the cap, that overrun was visible because the step itself timed
      // out; a bounded stop has to say it in its own words.
      options.logEvent("room_index_reconcile_abandoned_at_shutdown", {
        pendingPasses: pendingCalls,
        budgetMs,
        result: "timeout",
      });
    },
  });
}
