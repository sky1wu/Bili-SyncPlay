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

import { createRetryPacer } from "./retry-pacer.js";

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
  /**
   * Awaited before the KEY is released to the next write — never before the
   * caller is answered.
   *
   * A `run` that gives up on a command it cannot cancel (a timeout races the
   * command, it does not abort it) must report that here, or the command lands
   * AFTER whatever the caller did about the failure. That is not a harmless
   * duplicate: the caller's compensating write is queued on this same key, so
   * an abandoned join would be re-applied on top of its own rollback and leave
   * a member the client was told does not exist (#242 review).
   */
  settle?: () => Promise<void>;
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
  /**
   * Every write queued so far has released its key — which is later than "its
   * caller was answered", because a command a timeout gave up on is still in
   * flight until Redis answers. Use it when the point is that the store is
   * quiet; `confirm` is the one that reports.
   */
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
   * Wind down: writes already running finish the attempt they are on, backoffs
   * in flight are cut short, and writes that have not started yet are dropped
   * without one. Irreversible.
   *
   * Shutdown needs it, and needs all three. A close step gets a few seconds; a
   * queue that kept retrying through a Redis outage — or that let each queued
   * write open one more attempt of its own — would overrun that step, and an
   * overrun step is recorded as a FAILURE, so the process exits non-zero over
   * writes that were never going to land anyway (#242). What is left after
   * this call is bounded by ONE attempt.
   */
  stopRetrying: () => void;
  /** Writes still in flight or waiting to retry. */
  size: () => number;
};

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 50;
const DEFAULT_MAX_RETRY_DELAY_MS = 1_000;
const MAX_REMEMBERED_FAILURES = 64;

type ChainEntry = {
  settled: Promise<void>;
  supersede: () => void;
};

export function createDurableWriteQueue(
  options: DurableWriteQueueOptions = {},
): DurableWriteQueue {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

  const pacer = createRetryPacer({
    initialDelayMs:
      options.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS,
    maxDelayMs: options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
    sleep: options.sleep,
  });

  const chains = new Map<string, ChainEntry>();
  /** The REAL outcomes, each pre-marked handled so a rejection stays quiet. */
  const outcomes = new Set<Promise<void>>();
  /**
   * One per write, resolving when its KEY is released — i.e. after `settle`.
   * `drain` waits on these rather than on `outcomes`, because a write whose
   * command is still in flight has not finished with the store just because its
   * caller has been answered.
   */
  const released = new Set<Promise<void>>();
  /**
   * Writes given up on since the last {@link DurableWriteQueue.confirm}. Capped
   * so a store-wide outage cannot turn the record of it into a leak; the count
   * that matters is "any", and the first few carry the diagnosis.
   */
  const abandoned: unknown[] = [];
  async function runWithRetries(
    request: DurableWriteRequest,
    isSuperseded: () => boolean,
  ): Promise<void> {
    // Shutdown is the one thing that stops a write before it has tried at all.
    // A queue can hold several writes for one session, and each would otherwise
    // still start an attempt and hold the close step for a whole attempt
    // timeout apiece — so the step times out and the process exits non-zero
    // over writes nobody is waiting for any more (#242 review).
    if (pacer.stopped()) {
      throw new Error(
        `Durable write ${request.operationName} for ${request.key} was dropped: the queue is shutting down.`,
      );
    }
    let lastError: unknown;
    // Supersession, by contrast, never skips the FIRST attempt: the queue
    // cannot know that the newer write covers the same fields, and skipping
    // outright would silently lose writes that touch disjoint state. Only the
    // retries are given up.
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await request.run();
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof NonRetryableWriteError) {
          throw error;
        }
        if (attempt === maxAttempts || pacer.stopped()) {
          break;
        }
        if (isSuperseded()) {
          throw new SupersededWriteError(request.key, request.operationName);
        }
        const delayMs = pacer.delayFor(attempt);
        options.onRetryScheduled?.({
          key: request.key,
          operationName: request.operationName,
          attempt,
          delayMs,
          error,
        });
        await pacer.wait(delayMs);
        // The attempt that just failed may have failed by TIMEOUT, which races
        // its command rather than aborting it. Starting the next attempt now
        // would leave up to `maxAttempts` uncancellable commands out at once
        // for a single write — and the internal retries never go back through
        // `ensurePendingCapacity`, so the configured cap would not see them
        // (#242 review). `settle` is exactly "every command started so far has
        // answered"; the stop signal is what keeps shutdown from waiting on it.
        await Promise.race([
          request.settle?.() ?? Promise.resolve(),
          pacer.whenStopped(),
        ]);
        if (isSuperseded()) {
          throw new SupersededWriteError(request.key, request.operationName);
        }
        // Re-checked after the wait, not only before it: a write already parked
        // in its backoff when the queue was told to stop would otherwise wake up
        // and start one more attempt — which is exactly the attempt the close
        // step has no time for.
        if (pacer.stopped()) {
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
      const reported = outcome.then(
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
      // The chain is released only once the underlying commands have really
      // finished — see `settle`. The caller still gets `outcome` on time.
      const settled = reported
        .then(() => request.settle?.())
        .then(
          () => undefined,
          () => undefined,
        );
      const entry: ChainEntry = {
        settled,
        supersede: () => {
          superseded = true;
        },
      };
      chains.set(request.key, entry);

      outcomes.add(outcome);
      released.add(settled);
      // Marks the rejection handled without consuming it, so a caller that DOES
      // await `enqueue` still sees it while a fire-and-forget caller does not
      // crash the process.
      void outcome.catch(() => undefined);
      void settled.then(() => {
        outcomes.delete(outcome);
        released.delete(settled);
        if (chains.get(request.key) === entry) {
          chains.delete(request.key);
        }
      });
      return outcome;
    },
    async drain() {
      while (released.size > 0) {
        await Promise.allSettled(Array.from(released));
      }
    },
    async confirm() {
      // Settling the outstanding writes first is what folds THEIR failures into
      // `abandoned`, so the check below covers both the writes that had already
      // been given up on and the ones still running when this was called.
      // The callers' answers, not the key releases: a command that is still in
      // flight has already reported whether it can be confirmed, and waiting
      // for it to finish would make this hang exactly when the store is sick.
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
      pacer.stop();
    },
    size() {
      return released.size;
    },
  };
}
