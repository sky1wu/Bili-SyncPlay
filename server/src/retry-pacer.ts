/**
 * The timing rules every retrying facility in this server needs, in one place.
 *
 * `durable-write-queue`, `pending-resync-queue` and `runtime-index-reaper` all
 * retry work against a dependency that can hang, and all three have to wind
 * down inside a shutdown step. They grew their own copies of the same four
 * mechanisms, and #242's review found the same defect in whichever copy the
 * previous round had not touched — six times. A fix has to land once.
 *
 * What is shared:
 *
 * - **The backoff schedule.** Exponential from `initialDelayMs`, capped at
 *   `maxDelayMs`.
 * - **A wait that shutdown can cut short.** The backoff timer is the only thing
 *   keeping a retry alive, so it is never `unref`'d; `stop` is what ends it
 *   early, or a close step sits through the whole delay.
 * - **A per-attempt cap that does NOT cancel the call.** Racing a timeout
 *   against a dependency call gives up on the wrapper, never on the call. Every
 *   caller therefore has to answer two questions the cap cannot: do not start
 *   another call while this one is unanswered, and do not close the connection
 *   under it. {@link RetryPacer.settleTracked} is the second answer, and
 *   {@link settleWithin} is the same answer for a caller holding its own
 *   promise (`redis-event-store`'s append chain).
 * - **One stop switch**, readable as a flag and raceable against someone else's
 *   promise, because callers need both (`if (stopped())` in a loop,
 *   {@link RetryPacer.raceStopped} when parked on a call they do not own).
 *   Raceable, never exposed AS a promise: see {@link RetryPacer.raceStopped}.
 *
 * What is NOT here, on purpose: ordering, supersession, confirmation, dedupe,
 * and who decides to retry. Those differ per facility and belong to it.
 */

import { clampTimerIntervalMs } from "./timers.js";

function bounded<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: (resolve: () => void, reject: (error: Error) => void) => void,
): Promise<T | void> {
  let handle: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    work,
    new Promise<void>((resolve, reject) => {
      handle = setTimeout(
        () => {
          onTimeout(resolve, reject);
        },
        // Clamped at BOTH ends, and the upper one is the surprising half: a
        // delay past the 32-bit limit does not mean "very late", it makes
        // Node fire after ~1ms. Every cap here is derived from a caller's
        // configuration — `heartbeatTimeoutMs` from `NODE_HEARTBEAT_TTL_MS`,
        // for one — and those settings only have to be positive integers, so
        // one absurd value would turn every capped call into an instant
        // timeout instead of a slow one (#265 review). Same limit
        // `clampTimerIntervalMs` exists for; this is the other place a delay
        // reaches `setTimeout`.
        clampTimerIntervalMs(Math.max(timeoutMs, 1)),
      );
    }),
  ]).finally(() => {
    if (handle !== null) {
      clearTimeout(handle);
    }
  });
}

/**
 * Wait for `work` to settle, but never longer than `timeoutMs`.
 *
 * Answers the caller's real question — "did it finish, or did I give up on
 * it?" — rather than resolving indistinguishably either way, because the two
 * cases lead somewhere different: a caller that gave up is about to close a
 * connection under a command that is still on it, and owes somebody a word
 * about that.
 *
 * The standalone half of {@link RetryPacer.settleTracked}, for a caller that
 * already holds the promise it needs to wait on and does not need the pacer to
 * remember it. `work`'s rejection is absorbed: giving up and failing are
 * different answers, and this function only reports the first.
 */
export async function settleWithin(
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let settled = false;
  const answered = work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await bounded(answered, timeoutMs, (resolve) => {
    resolve();
  });
  return settled;
}

export type RetryPacerOptions = {
  initialDelayMs: number;
  maxDelayMs: number;
  /** Injectable so tests do not pay the backoff in wall-clock time. */
  sleep?: (delayMs: number) => Promise<void>;
};

export type RetryPacer = {
  /** Exponential, capped. `attempt` is 1-based. */
  delayFor: (attempt: number) => number;
  /**
   * Wait out a backoff. Resolves EARLY — not rejects — once {@link RetryPacer.stop}
   * is called, so callers keep one shape: wait, then re-check `stopped()`.
   */
  wait: (delayMs: number) => Promise<void>;
  /**
   * Run `call` under a cap, and remember it until it really answers.
   *
   * Rejects with `makeTimeoutError()` when the cap wins; `call` keeps running,
   * which is the whole reason {@link RetryPacer.settleTracked} exists.
   */
  capAttempt: <T>(
    call: Promise<T>,
    timeoutMs: number,
    makeTimeoutError: () => Error,
  ) => Promise<T>;
  /**
   * Cap only this caller's wait on a call already owned and tracked elsewhere.
   * Repeated waiters therefore add bounded timers, never duplicate entries to
   * the shutdown-tracked set while the one real call remains unanswered.
   */
  capWait: <T>(
    call: Promise<T>,
    timeoutMs: number,
    makeTimeoutError: () => Error,
  ) => Promise<T>;
  /** Remember an uncapped call until it really answers, preserving its result. */
  trackCall: <T>(call: Promise<T>) => Promise<T>;
  /** Calls that have not answered yet. */
  trackedCount: () => number;
  /**
   * {@link RetryPacer.raceStopped} calls currently parked, for the regression
   * test that this number comes back DOWN. One per parked call, never one
   * shared entry: a count that stays at 1 while ten calls are parked is the
   * shared-signal shape (#312) wearing this Set as a disguise.
   */
  stopWaiterCount: () => number;
  /**
   * Wait, bounded, for the calls that outlived their cap.
   *
   * Bounded because an unbounded wait only moves a shutdown overrun from
   * whatever closes next to this step instead.
   */
  settleTracked: (timeoutMs: number) => Promise<void>;
  stopped: () => boolean;
  /**
   * Wait for `work`, giving up the wait once {@link RetryPacer.stop} is called.
   *
   * Resolves with `work`'s value, or with `undefined` when stopping won the
   * race; rejects exactly when `work` rejects, so callers keep the semantics
   * they had when they wrote the race by hand. Callers still re-check
   * {@link RetryPacer.stopped} afterwards to tell the two resolutions apart.
   *
   * The pacer owns the race because the stop side must be a promise that DIES
   * WITH THE CALL. The obvious shape — one process-lifetime `stoppedSignal`
   * that callers `race` against — attaches a `PromiseReaction` to it per call,
   * and a promise that only settles at shutdown never releases one: four call
   * sites leaked a reaction, two closures, a context and two promises apiece,
   * ~349 bytes a time, until major GC pauses grew 25x over four days (#312).
   * A per-call promise becomes unreachable when the call is done, so nothing
   * accumulates. `stopWaiters` is what `stop` still reaches them through, and
   * it is pruned in `finally` — an unpruned Set is the same leak wearing a
   * different hat.
   */
  raceStopped: <T>(work: Promise<T>) => Promise<T | void>;
  /** Stop retrying and cut short every backoff in flight. Irreversible. */
  stop: () => void;
};

export function createRetryPacer(options: RetryPacerOptions): RetryPacer {
  const { initialDelayMs, maxDelayMs } = options;
  /** `resolve` for every backoff currently being waited out. */
  const pendingWaits = new Set<() => void>();
  /** Calls still owed an answer, each error-swallowed so it stays quiet. */
  const trackedCalls = new Set<Promise<void>>();
  let isStopped = false;
  /** `resolve` for every {@link RetryPacer.raceStopped} currently parked. */
  const stopWaiters = new Set<() => void>();

  function trackCall<T>(call: Promise<T>): Promise<T> {
    const answered = call.then(
      () => undefined,
      () => undefined,
    );
    trackedCalls.add(answered);
    void answered.finally(() => {
      trackedCalls.delete(answered);
    });
    return call;
  }

  async function capWait<T>(
    call: Promise<T>,
    timeoutMs: number,
    makeTimeoutError: () => Error,
  ): Promise<T> {
    return (await bounded(call, timeoutMs, (_resolve, reject) => {
      reject(makeTimeoutError());
    })) as Awaited<typeof call>;
  }

  return {
    delayFor(attempt) {
      return Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
    },
    wait(delayMs) {
      if (options.sleep) {
        // A test clock resolves on its own; there is nothing to cancel, and
        // re-checking `stopped()` after it is enough.
        return options.sleep(delayMs);
      }
      let release = (): void => {};
      const waited = new Promise<void>((resolve) => {
        // Deliberately NOT `unref`'d: this timer is the only thing keeping the
        // retry alive, and an idle event loop would otherwise drain past it and
        // lose the work silently.
        const timer = setTimeout(resolve, delayMs);
        release = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      pendingWaits.add(release);
      return waited.finally(() => {
        pendingWaits.delete(release);
      });
    },
    async capAttempt(call, timeoutMs, makeTimeoutError) {
      return capWait(trackCall(call), timeoutMs, makeTimeoutError);
    },
    capWait,
    trackCall,
    trackedCount() {
      return trackedCalls.size;
    },
    stopWaiterCount() {
      return stopWaiters.size;
    },
    async settleTracked(timeoutMs) {
      if (trackedCalls.size === 0) {
        return;
      }
      await bounded(
        Promise.allSettled(Array.from(trackedCalls)).then(() => undefined),
        timeoutMs,
        (resolve) => {
          resolve();
        },
      );
    },
    stopped() {
      return isStopped;
    },
    async raceStopped(work) {
      // Already stopping: answer without attaching anything, which is also what
      // racing an already-resolved signal did.
      if (isStopped) {
        return undefined;
      }
      let release = (): void => {};
      const stopping = new Promise<void>((resolve) => {
        release = resolve;
      });
      stopWaiters.add(release);
      try {
        return await Promise.race([work, stopping]);
      } finally {
        stopWaiters.delete(release);
        // `stopping` is unreachable from here on, so its reaction would go with
        // it either way; settling it keeps that true even if a future caller
        // holds the promise longer than the call.
        release();
      }
    },
    stop() {
      isStopped = true;
      for (const release of Array.from(stopWaiters)) {
        release();
      }
      stopWaiters.clear();
      for (const release of Array.from(pendingWaits)) {
        release();
      }
      pendingWaits.clear();
    },
  };
}
