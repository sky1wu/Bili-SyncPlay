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
 * - **One stop switch**, readable as a flag and awaitable as a promise, because
 *   callers need both (`if (stopped())` in a loop, `race([call, whenStopped()])`
 *   when parked on someone else's promise).
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
  /** Calls that have not answered yet. */
  trackedCount: () => number;
  /**
   * Wait, bounded, for the calls that outlived their cap.
   *
   * Bounded because an unbounded wait only moves a shutdown overrun from
   * whatever closes next to this step instead.
   */
  settleTracked: (timeoutMs: number) => Promise<void>;
  stopped: () => boolean;
  /** Resolves once {@link RetryPacer.stop} is called; never rejects. */
  whenStopped: () => Promise<void>;
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
  let signalStopped = (): void => {};
  const stoppedSignal = new Promise<void>((resolve) => {
    signalStopped = resolve;
  });

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
      const answered = call.then(
        () => undefined,
        () => undefined,
      );
      trackedCalls.add(answered);
      void answered.finally(() => {
        trackedCalls.delete(answered);
      });
      return (await bounded(call, timeoutMs, (_resolve, reject) => {
        reject(makeTimeoutError());
      })) as Awaited<typeof call>;
    },
    trackedCount() {
      return trackedCalls.size;
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
    whenStopped() {
      return stoppedSignal;
    },
    stop() {
      isStopped = true;
      signalStopped();
      for (const release of Array.from(pendingWaits)) {
        release();
      }
      pendingWaits.clear();
    },
  };
}
