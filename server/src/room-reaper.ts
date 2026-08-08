import type { MetricsCollector } from "./admin/metrics.js";
import {
  createMaintenancePass,
  type MaintenancePassFailureReason,
} from "./maintenance-pass.js";
import type { ExpiredRoomSweepCounts } from "./room-service.js";
import type { LogEvent } from "./types.js";

export type RoomReaper = {
  /** Resolves once the sweep in flight, if any, has settled. */
  stop: () => Promise<void>;
  runNow: () => Promise<number>;
};

/**
 * Caps ONE sweep, so a stalled Redis connection is reported instead of waited
 * on forever (#261).
 *
 * Generous on purpose, and well under the 60s default `ROOM_CLEANUP_INTERVAL_MS`
 * so a hang is reported within the tick it happened in. `deleteExpiredRooms` is
 * a single EVAL over the expiry index; the one pass that can legitimately take
 * longer is the first after a startup that still owes the bootstrap keyspace
 * walk, and that pass reports a timeout, keeps running, and is followed by
 * `still_running` ticks until it finishes — noisy, but honest: the reaper
 * really is not sweeping yet.
 */
const SWEEP_TIMEOUT_MS = 30_000;

/**
 * Three of the four failures land on the same `result="error"` series — a
 * stalled sweep is no less broken than one that threw — and are told apart in
 * the log by `reason`.
 *
 * `overlapped` is the exception and gets no entry: nothing failed, the previous
 * sweep was simply still inside its cap. See {@link RoomReaper} wiring below.
 */
const SWEEP_FAILURE_REASON: Record<
  Exclude<MaintenancePassFailureReason, "overlapped">,
  string
> = {
  run_failed: "room_reaper_failed",
  timed_out: "room_reaper_sweep_timeout",
  stalled: "room_reaper_sweep_stalled",
};

export function createRoomReaper(options: {
  intervalMs: number;
  deleteExpiredRooms: (now: number) => Promise<ExpiredRoomSweepCounts>;
  logEvent: LogEvent;
  metricsCollector?: Pick<
    MetricsCollector,
    "declareRoomReaper" | "recordRoomReaperSweep"
  >;
  now?: () => number;
  // Injectable only so a test does not have to spend the real cap in wall
  // clock; production always uses the constant.
  sweepTimeoutMs?: number;
}): RoomReaper {
  const now = options.now ?? Date.now;
  const sweepTimeoutMs = options.sweepTimeoutMs ?? SWEEP_TIMEOUT_MS;

  // Declared here rather than at the wiring site: existing is what makes the
  // series meaningful, so the two cannot drift apart. A process without a
  // reaper never reaches this line and never exports the series.
  options.metricsCollector?.declareRoomReaper();

  return createMaintenancePass<ExpiredRoomSweepCounts, number>({
    name: "room expiry sweep",
    intervalMs: options.intervalMs,
    timeoutMs: sweepTimeoutMs,
    run: () => options.deleteExpiredRooms(now()),
    onSuccess: (swept) => {
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
    },
    onFailure: ({ reason, error }) => {
      if (reason === "overlapped") {
        // A tick that found the previous sweep still inside its cap. Counted,
        // because every tick owes the series one record and this one collected
        // nothing; NOT an error, because the sweep is answering — it is only
        // slower than `ROOM_CLEANUP_INTERVAL_MS`, which is the operator's
        // signal to lengthen the interval (#262 review). Deliberately not
        // logged either: at a short interval this is per-tick chatter, and the
        // counter already carries it.
        options.metricsCollector?.recordRoomReaperSweep("skipped");
        return 0;
      }
      options.metricsCollector?.recordRoomReaperSweep("error");
      options.logEvent("room_persist_failed", {
        result: "error",
        reason: SWEEP_FAILURE_REASON[reason],
        // Only where the cap is what produced the record; on a sweep that threw
        // it would name a limit nothing came near.
        ...(reason === "run_failed" ? {} : { timeoutMs: sweepTimeoutMs }),
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    },
    onSettleTimeout: ({ pendingCalls, budgetMs }) => {
      // Shutdown goes on to `close_room_store`, so this says an EVAL is still
      // on the connection `redis.quit()` will close. Not a metric: it is a
      // property of this shutdown, not of the sweep series. `result: "timeout"`
      // puts it at error level — before the cap existed the same situation was
      // visible as a `server_shutdown_step_failed`, and a bounded stop must not
      // buy an orderly shutdown with a silent one.
      options.logEvent("room_reaper_sweep_abandoned_at_shutdown", {
        pendingSweeps: pendingCalls,
        budgetMs,
        result: "timeout",
      });
    },
  });
}
