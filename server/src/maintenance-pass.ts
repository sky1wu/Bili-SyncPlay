import { createRetryPacer } from "./retry-pacer.js";
import { clampTimerIntervalMs } from "./timers.js";

/**
 * A background maintenance job on a timer, bounded in every direction.
 *
 * `room-reaper`, `room-index-reconciler` and `node-heartbeat` are the same
 * shape: an interval fires, one async pass runs against Redis, its outcome is
 * logged, and a shutdown step waits the pass out before that Redis connection
 * is closed. All three grew that shape by hand, and all three had the same hole
 * — nothing on the path had a timeout, so a stalled connection (TCP half-open,
 * a blocked Redis) left the pass pending forever. `maxRetriesPerRequest` does
 * not help: it bounds retries, not how long a command that was already accepted
 * may take to answer.
 *
 * What that cost (#261): the reaper stopped collecting expired rooms and said
 * nothing — the `ok` and `error` series of
 * `bili_syncplay_room_reaper_sweeps_total` both went flat, so an alert on the
 * failure rate never fired, and recovery meant restarting the process by hand.
 * And (#263): the heartbeat stopped beating just as quietly, while other nodes
 * aged this one out of the cluster index and reaped the sessions of a process
 * that was still serving clients.
 *
 * The rules that fix it, in one place rather than three hand-written copies
 * (#242's lesson):
 *
 * - **Every pass answers.** A pass that outlives {@link timeoutMs} is reported
 *   as `timed_out` — the call is NOT cancelled, because nothing can cancel an
 *   in-flight Redis command, but the caller stops waiting and records an
 *   outcome. A stall is now a rising failure counter instead of silence.
 * - **A pass never runs on top of another.** While the previous call is still
 *   unanswered, a tick reports it instead of issuing a second command. Without
 *   that a hung dependency accumulates one command per interval for as long as
 *   it stays hung — and every tick would overwrite the promise the shutdown
 *   step waits on, so shutdown would wait on the newest pass while older ones
 *   were still writing. It also keeps the outcome series moving at one record
 *   per tick, which is what makes "the rate went flat" mean "the timer is gone"
 *   and nothing else. The report distinguishes `stalled` (the call is past its
 *   cap) from `overlapped` (still inside it) — only the first is a failure.
 * - **Shutdown is bounded, and says so when the budget is not enough.** `stop`
 *   waits for the real call to settle, because the next step closes the Redis
 *   connection under it, but only for `settleTimeoutMs` — a wait that cannot
 *   end just moves the overrun into the shutdown step and gets it recorded as
 *   failed. Giving up quietly would be the same trade in reverse: the overrun
 *   used to be visible precisely BECAUSE the step timed out, so a bounded
 *   `stop` owes the caller `onSettleTimeout`.
 */
export type MaintenancePassFailureReason =
  /** `run` itself rejected — the dependency answered, with an error. */
  | "run_failed"
  /** The cap expired first. The call is still in flight. */
  | "timed_out"
  /**
   * A previous call outlived its cap and STILL has not answered, so this pass
   * never started. Always follows a `timed_out` on the same call.
   */
  | "stalled"
  /**
   * A previous call is still running, inside its cap, so this pass never
   * started. Not a failure — the interval is simply shorter than a pass takes,
   * which only happens where the interval is configured below the cap. Kept
   * apart from `stalled` because filing it under the failure series would raise
   * the failure rate on a dependency that is answering (#262 review).
   */
  | "overlapped";

export type MaintenancePassFailure = {
  reason: MaintenancePassFailureReason;
  error: unknown;
};

export type MaintenancePass<T> = {
  /**
   * Arm the timer. Idempotent, and only needed with `autoStart: false` — a
   * caller that owns its own enable flag arms it after deciding.
   */
  start: () => void;
  /**
   * Stop the timer and wait, bounded, for the call in flight.
   *
   * Resolves either once that call settles or once the settle budget runs out,
   * whichever comes first — never later. The second case is reported through
   * `onSettleTimeout` rather than by rejecting: the shutdown step did its part,
   * and failing it would stop nothing that follows.
   */
  stop: () => Promise<void>;
  /** Run one pass now, under the same cap and the same overlap rule. */
  runNow: () => Promise<T>;
};

/**
 * How long `stop` may wait for a call that outlived its cap.
 *
 * Comfortably inside the default shutdown step timeout, which is what keeps a
 * hung pass from turning an orderly shutdown into a failed step.
 */
export const DEFAULT_MAINTENANCE_SETTLE_TIMEOUT_MS = 2_000;

/** Distinguishes "the cap won the race" from "the dependency threw". */
export class MaintenancePassTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`${name} did not answer within ${timeoutMs}ms.`);
    this.name = "MaintenancePassTimeoutError";
  }
}

export function createMaintenancePass<Value, Reported>(options: {
  /** Used in the timeout error's message; a noun phrase, e.g. "room expiry sweep". */
  name: string;
  intervalMs: number;
  /** Caps ONE pass. Does not cancel it — nothing can. */
  timeoutMs: number;
  settleTimeoutMs?: number;
  /** Leave the timer disarmed until `start()`. Defaults to arming on creation. */
  autoStart?: boolean;
  /**
   * `unref` the timer, for a job the process need not stay alive for.
   *
   * Off by default: the reaper and the reconciler are the only thing keeping
   * their own work scheduled, so an idle event loop draining past them would
   * lose it silently. The heartbeat opts in — it only reports state, and a
   * process with nothing else to do must still be able to exit.
   */
  unrefTimer?: boolean;
  run: () => Promise<Value>;
  /** Called only for a pass that answered inside its cap. */
  onSuccess: (value: Value) => Reported;
  /**
   * Called for every pass that did not. Owns the logging and the metric — the
   * driver deliberately knows about neither.
   */
  onFailure: (failure: MaintenancePassFailure) => Reported;
  /**
   * `stop` ran out of budget with a command still unanswered.
   *
   * Says nothing about the pass — it says the next shutdown step is about to
   * close the connection under a live command. Before the cap existed this
   * showed up as a `server_shutdown_step_failed` timeout, because `stop` simply
   * never returned; a bounded `stop` returns cleanly instead and would
   * otherwise have traded a loud shutdown for a silent one.
   */
  onSettleTimeout?: (info: { pendingCalls: number; budgetMs: number }) => void;
}): MaintenancePass<Reported> {
  // The interval drives the retries here, so the pacer's backoff goes unused;
  // what this needs from it is the per-attempt cap that does NOT cancel the
  // call and the record of calls that outlived one. Same use as
  // `runtime-index-reaper`.
  const pacer = createRetryPacer({
    initialDelayMs: options.timeoutMs,
    maxDelayMs: options.timeoutMs,
  });

  /** The call still owed an answer, or null. Set and cleared on the call itself. */
  let inFlight: Promise<Value> | null = null;
  /** Whether {@link inFlight} has already lost its own race against the cap. */
  let inFlightIsStalled = false;

  async function runNow(): Promise<Reported> {
    if (inFlight !== null) {
      return options.onFailure({
        reason: inFlightIsStalled ? "stalled" : "overlapped",
        error: new MaintenancePassTimeoutError(
          `The previous ${options.name}`,
          options.timeoutMs,
        ),
      });
    }

    let call: Promise<Value>;
    try {
      call = options.run();
    } catch (error) {
      // A `run` that throws synchronously never produced a promise, so there is
      // nothing to track and nothing to clear.
      return options.onFailure({ reason: "run_failed", error });
    }

    inFlight = call;
    inFlightIsStalled = false;
    const release = (): void => {
      if (inFlight === call) {
        inFlight = null;
        inFlightIsStalled = false;
      }
    };
    // On the call itself, and registered before it is handed to the cap:
    // handlers run in registration order, so the slot is free by the time
    // `capAttempt` resolves below no matter how many microtask hops its race
    // adds. Clearing the slot from `runNow`'s own continuation instead would
    // tie the guard to the timing of a mechanism that is allowed to change, and
    // a slot released one hop late skips the NEXT pass as `overlapped`.
    void call.then(release, release);

    let value: Value;
    try {
      value = await pacer.capAttempt(
        call,
        options.timeoutMs,
        () => new MaintenancePassTimeoutError(options.name, options.timeoutMs),
      );
    } catch (error) {
      if (error instanceof MaintenancePassTimeoutError) {
        // Only if the call has not answered in the meantime: `release` runs
        // before this continuation, so `inFlight === call` here means the cap
        // won and the command really is still out there. That is what makes the
        // NEXT tick a `stalled` rather than an `overlapped`.
        if (inFlight === call) {
          inFlightIsStalled = true;
        }
        return options.onFailure({ reason: "timed_out", error });
      }
      return options.onFailure({ reason: "run_failed", error });
    }
    // Outside the try: a throwing `onSuccess` is a bug in the caller, not a
    // failed pass, and reporting it as one would hide it behind a metric.
    return options.onSuccess(value);
  }

  let intervalId: ReturnType<typeof setInterval> | null = null;

  function start(): void {
    if (intervalId !== null) {
      return;
    }
    intervalId = setInterval(() => {
      // The handlers own their own error reporting; swallowing here only stops
      // a throwing one from surfacing as an unhandled rejection out of a timer,
      // which would take the process down over a log line.
      void runNow().catch(() => undefined);
    }, clampTimerIntervalMs(options.intervalMs));
    if (options.unrefTimer) {
      intervalId.unref?.();
    }
  }

  if (options.autoStart !== false) {
    start();
  }

  return {
    start,
    async stop() {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      // Waits on the underlying calls, not on `runNow`: a pass that already hit
      // its cap has answered its caller while its Redis command is still in the
      // air, and that command is exactly what the next shutdown step —
      // `redis.quit()` — would otherwise be closing the connection under.
      const budgetMs =
        options.settleTimeoutMs ?? DEFAULT_MAINTENANCE_SETTLE_TIMEOUT_MS;
      await pacer.settleTracked(budgetMs);
      // Read AFTER the wait: whatever is still tracked here outlived the
      // budget, and shutdown is about to close the connection it is using.
      const pendingCalls = pacer.trackedCount();
      if (pendingCalls > 0) {
        options.onSettleTimeout?.({ pendingCalls, budgetMs });
      }
    },
    runNow,
  };
}
