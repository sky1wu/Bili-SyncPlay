/**
 * Ordered, retrying, confirmable writes to a write-behind store.
 *
 * The runtime store updates this node's own maps synchronously and queues the
 * shared write behind them. Before this queue existed a queued write got exactly
 * one attempt: a transient Redis error dropped it on the floor, and every
 * "write, then read it back and decide something" path downstream could act on
 * data that never landed (#242).
 *
 * Three properties, none of which the old chain had:
 *
 * - **Retries with backoff.** A failed attempt is retried rather than dropped,
 *   so a blip no longer costs a write.
 * - **A real outcome.** `enqueue` resolves only once the write is confirmed and
 *   rejects when it is not. `drain` and `confirm` say two different things, so
 *   a caller can ask either "has the queue emptied" or "did everything land".
 * - **Order, per key.** Writes for one key never overlap, and a retry cannot
 *   overtake a newer write for the same key — see {@link SupersededWriteError}.
 */

/** A write that must not be retried, however many attempts are left. */
export class NonRetryableWriteError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "NonRetryableWriteError";
  }
}

/**
 * A newer write for the same key arrived while this one was waiting to retry.
 *
 * Retrying past that point would fight the newer write instead of helping it:
 * the writes this queue carries are ordered edits to one session's keys, so the
 * newest one describes the state the caller actually wants. It is reported as a
 * distinct error because it is NOT a durability failure — {@link
 * DurableWriteQueue.confirm} deliberately ignores it.
 */
export class SupersededWriteError extends Error {
  constructor(
    readonly key: string,
    readonly operationName: string,
  ) {
    super(
      `Durable write ${operationName} for ${key} was superseded by a newer write.`,
    );
    this.name = "SupersededWriteError";
  }
}

export type DurableWriteRetryInfo = {
  key: string;
  operationName: string;
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  delayMs: number;
  error: unknown;
};

export type DurableWriteRequest = {
  /** Writes sharing a key are serialized and may supersede one another. */
  key: string;
  operationName: string;
  run: () => Promise<void>;
};

export type DurableWriteQueueOptions = {
  /** Total attempts, including the first. */
  maxAttempts?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Injectable so tests do not pay the backoff in wall-clock time. */
  sleep?: (delayMs: number) => Promise<void>;
  onRetryScheduled?: (info: DurableWriteRetryInfo) => void;
};

export type DurableWriteQueue = {
  /**
   * Run `request.run()`, retrying it on failure. Resolves once the write is
   * confirmed; rejects with the last error when it is not, and with a
   * {@link SupersededWriteError} when a newer write for the same key took over.
   */
  enqueue: (request: DurableWriteRequest) => Promise<void>;
  /** Every write queued so far has settled, however it settled. */
  drain: () => Promise<void>;
  /**
   * Every write is CONFIRMED: the outstanding ones have landed, and none has
   * been given up on since the last call. Rejects with an `AggregateError`
   * carrying the ones that were not.
   *
   * The counterpart to {@link DurableWriteQueue.drain}, which only ever says
   * that the queue emptied — the distinction #242 exists to draw. A failure is
   * remembered rather than only observable while the write is still in the
   * queue, because the caller with the most reason to ask is the one who just
   * drained it; reading clears it, so the answer is "since you last asked".
   */
  confirm: () => Promise<void>;
  /**
   * Let every outstanding write finish its CURRENT attempt and then give up,
   * instead of backing off for another one. Irreversible.
   *
   * Shutdown needs it. A close step gets a few seconds; a queue that kept
   * retrying through a Redis outage would spend the whole retry budget there
   * and the step would be recorded as failed, so the process exits non-zero
   * over writes that were never going to land anyway (#242).
   */
  stopRetrying: () => void;
  /** Writes still in flight or waiting to retry. */
  size: () => number;
};

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 50;
const DEFAULT_MAX_RETRY_DELAY_MS = 1_000;
const MAX_REMEMBERED_FAILURES = 64;

/**
 * A backoff that can be cut short.
 *
 * Deliberately NOT `unref`'d: the timer is the only thing keeping a retry
 * alive, and unrefing it lets an otherwise idle event loop drain, silently
 * losing the write. That makes it the caller's job to end the wait — hence
 * `cancel`, which {@link DurableWriteQueue.stopRetrying} uses so a shutdown
 * does not have to sit through a backoff for a write it has already given up
 * on.
 */
type RetryWait = { promise: Promise<void>; cancel: () => void };

function startRetryWait(delayMs: number): RetryWait {
  let cancel = (): void => {};
  const promise = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    cancel = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { promise, cancel };
}

type ChainEntry = {
  settled: Promise<void>;
  supersede: () => void;
};

export function createDurableWriteQueue(
  options: DurableWriteQueueOptions = {},
): DurableWriteQueue {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const initialRetryDelayMs =
    options.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;

  const chains = new Map<string, ChainEntry>();
  /** The REAL outcomes, each pre-marked handled so a rejection stays quiet. */
  const outcomes = new Set<Promise<void>>();
  /**
   * Writes given up on since the last {@link DurableWriteQueue.confirm}. Capped
   * so a store-wide outage cannot turn the record of it into a leak; the count
   * that matters is "any", and the first few carry the diagnosis.
   */
  const abandoned: unknown[] = [];
  /** `cancel` for every backoff currently being waited out. */
  const pendingWaits = new Set<() => void>();
  let retriesStopped = false;

  /**
   * An injected `sleep` is a test clock and resolves on its own, so it needs no
   * canceller — stopping the LOOP is enough there. The real timer does need
   * one; see {@link startRetryWait}.
   */
  function waitBeforeRetry(delayMs: number): Promise<void> {
    if (options.sleep) {
      return options.sleep(delayMs);
    }
    const wait = startRetryWait(delayMs);
    pendingWaits.add(wait.cancel);
    return wait.promise.finally(() => {
      pendingWaits.delete(wait.cancel);
    });
  }

  function retryDelayMs(attempt: number): number {
    const backoff = initialRetryDelayMs * 2 ** (attempt - 1);
    return Math.min(backoff, maxRetryDelayMs);
  }

  async function runWithRetries(
    request: DurableWriteRequest,
    isSuperseded: () => boolean,
  ): Promise<void> {
    let lastError: unknown;
    // Every write gets its FIRST attempt regardless of supersession: the queue
    // cannot know that a newer write covers the same fields, and skipping the
    // attempt outright would silently lose writes that touch disjoint state.
    // Only the retries are given up.
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await request.run();
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof NonRetryableWriteError) {
          throw error;
        }
        if (attempt === maxAttempts || retriesStopped) {
          break;
        }
        if (isSuperseded()) {
          throw new SupersededWriteError(request.key, request.operationName);
        }
        const delayMs = retryDelayMs(attempt);
        options.onRetryScheduled?.({
          key: request.key,
          operationName: request.operationName,
          attempt,
          delayMs,
          error,
        });
        await waitBeforeRetry(delayMs);
        if (isSuperseded()) {
          throw new SupersededWriteError(request.key, request.operationName);
        }
        // Re-checked after the wait, not only before it: a write already parked
        // in its backoff when the queue was told to stop would otherwise wake up
        // and start one more attempt — which is exactly the attempt the close
        // step has no time for.
        if (retriesStopped) {
          break;
        }
      }
    }
    throw lastError;
  }

  return {
    enqueue(request) {
      const previous = chains.get(request.key);
      previous?.supersede();

      let superseded = false;
      const outcome = (previous?.settled ?? Promise.resolve()).then(() =>
        runWithRetries(request, () => superseded),
      );
      const settled = outcome.then(
        () => undefined,
        (error: unknown) => {
          // A superseded write is not an unconfirmed one: the newer write for
          // that key is what the caller wanted written, and it is queued behind
          // this one.
          if (
            !(error instanceof SupersededWriteError) &&
            abandoned.length < MAX_REMEMBERED_FAILURES
          ) {
            abandoned.push(error);
          }
        },
      );
      const entry: ChainEntry = {
        settled,
        supersede: () => {
          superseded = true;
        },
      };
      chains.set(request.key, entry);

      outcomes.add(outcome);
      // Marks the rejection handled without consuming it, so a caller that DOES
      // await `enqueue` still sees it while a fire-and-forget caller does not
      // crash the process.
      void outcome.catch(() => undefined);
      void settled.then(() => {
        outcomes.delete(outcome);
        if (chains.get(request.key) === entry) {
          chains.delete(request.key);
        }
      });
      return outcome;
    },
    async drain() {
      await Promise.allSettled(Array.from(outcomes));
    },
    async confirm() {
      // Settling the outstanding writes first is what folds THEIR failures into
      // `abandoned`, so the check below covers both the writes that had already
      // been given up on and the ones still running when this was called.
      await Promise.allSettled(Array.from(outcomes));
      if (abandoned.length === 0) {
        return;
      }
      const failures = abandoned.splice(0, abandoned.length);
      throw new AggregateError(
        failures,
        `${failures.length} durable write(s) were not confirmed.`,
      );
    },
    stopRetrying() {
      retriesStopped = true;
      // Cut the backoffs short as well as refusing new ones: a write already
      // parked in one would otherwise hold `drain` for the full delay, which is
      // the very wait the close step has no time for.
      for (const cancel of Array.from(pendingWaits)) {
        cancel();
      }
      pendingWaits.clear();
    },
    size() {
      return outcomes.size;
    },
  };
}
