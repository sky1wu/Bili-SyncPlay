/**
 * A serial append chain over ONE Redis connection, with the two bounds a
 * stalled dependency needs.
 *
 * Both admin stores that write a Redis stream — `redis-event-store` and
 * `redis-audit-store` — chain each write onto the previous one so entries land
 * in order on a single connection. That chain is a queue, and until #264 it had
 * no bound at any link: a Redis that accepted commands and stopped answering
 * turned every caller into another closure parked on a promise that could only
 * settle when Redis did, while reads and `close()` queued behind it.
 *
 * What this module owns is the MECHANISM, which is identical in both stores:
 *
 * - **A per-write cap that does NOT cancel the call.** Nothing can take a
 *   command back off the connection. What the cap buys is knowing the write is
 *   not coming back, so new appends stop queueing behind it — and the chain
 *   itself does not move on, because running the next write on top of an
 *   unanswered one would leave two outstanding and land them out of order if
 *   Redis recovered.
 * - **A queue depth limit.** The cap never fires while Redis answers every
 *   write, just slower than they arrive; nothing else would stop the queue
 *   growing in that case. Neither bound substitutes for the other.
 * - **A read that is refused, not delayed, while the connection is stalled.**
 *   A read issued now joins ioredis's queue behind the write that already
 *   outlived its cap and never comes back. The fix for an unbounded queue is
 *   never a bound on how long you wait for it.
 * - **A bounded `close`.** Drain inside a budget; past it, stop the links that
 *   have not started and drop the socket, because `QUIT` is a command on the
 *   same ordered queue and would inherit the exact wait that was just bounded.
 *
 * What it deliberately does NOT own is POLICY — what a refused append means.
 * The event store sheds: an event is observability data, the stream trims
 * itself anyway, and rejecting would answer a Redis stall with one stdout error
 * line per log line. The audit store refuses out loud: an audit record is an
 * accountability record, and losing one quietly is not a trade anybody may make
 * on an operator's behalf. Hence {@link AppendChainHandlers} — the store
 * decides, the chain only says which bound was hit.
 */

import { createRetryPacer, settleWithin } from "../retry-pacer.js";
import {
  quitWithin,
  type ClosableRedisConnection,
  type RedisQuitOutcome,
} from "../redis-graceful-close.js";

/** Which bound refused the append, which is also the diagnosis. */
export type AppendChainRefusal =
  /** `close()` has started; the connection is on its way down. */
  | "closing"
  /** The write in flight is past its own cap, so it is not coming back. */
  | "stalled"
  /** Redis is answering, just slower than appends arrive, and the queue is full. */
  | "overflow";

/**
 * How the connection was closed.
 *
 * `skipped` is the path that never tried: the drain had already run out of
 * budget, so the socket went down instead of a `QUIT` that would have queued
 * behind the write nobody is waiting for any more.
 */
export type AppendChainQuitOutcome = RedisQuitOutcome | "skipped";

export type AppendChainCloseReport = {
  /**
   * Appends whose Redis commands had not all answered when the socket was
   * dropped.
   *
   * Appends, not commands: one append may issue an `XADD` and then two or three
   * more in parallel, and the cap tracks the batch as one call. The
   * operationally useful unit is records anyway — one append is one record
   * (#266 review).
   */
  pendingWrites: number;
  /** Appends chained but not yet settled, at the moment the report was made. */
  queuedAppends: number;
  quitOutcome: AppendChainQuitOutcome;
  budgetMs: number;
};

export type AppendChainOptions = {
  connection: ClosableRedisConnection;
  /**
   * How long ONE append's Redis commands may take before the chain stops
   * queueing behind them. Long enough that ordinary Redis latency never trips
   * it, because tripping it costs records.
   */
  appendTimeoutMs: number;
  /** How many appends may be waiting on the chain before it refuses. */
  maxPendingAppends: number;
  /** How long a read may wait for the appends queued ahead of it. */
  readSettleTimeoutMs: number;
  /**
   * How long `close` may wait for the chain to drain, and separately for
   * `QUIT`. Both, so the arithmetic matters: worst case is twice this, and it
   * has to stay comfortably inside the shutdown step's budget.
   */
  closeSettleTimeoutMs: number;
  /** Thrown by {@link AppendChain.settleForRead} when the write path is stalled. */
  makeUnavailableError: () => Error;
  /**
   * `close` finished with something unfinished. The one degraded-shutdown
   * signal, and the only thing standing between a bounded close and a silent
   * one.
   */
  onCloseUnfinished?: (report: AppendChainCloseReport) => void;
};

export type AppendChainHandlers<T> = {
  /**
   * A bound refused this append. May return a substitute answer or throw —
   * that choice is the store's, not the chain's.
   */
  onRefused: (reason: AppendChainRefusal) => T;
  /**
   * This append was still queued when `close` gave up, and the connection it
   * would have written on is gone. Same freedom as {@link onRefused}.
   */
  onAbandonedAtShutdown: () => T;
};

export type AppendChain = {
  /**
   * Chain one write, or hand it to a handler if a bound refuses it.
   *
   * Never throws synchronously — a refusal handler that throws produces a
   * rejected promise — so callers keep one shape whichever policy they chose.
   */
  run: <T>(
    write: () => Promise<T>,
    handlers: AppendChainHandlers<T>,
  ) => Promise<T>;
  /**
   * Read-your-writes, best effort, bounded.
   *
   * Rejects with `makeUnavailableError()` rather than waiting when the write
   * path is stalled: under that failure the queued writes have not landed
   * anyway, so waiting converts a slightly stale answer into no answer — on the
   * page an operator opens precisely to find out what is going wrong.
   */
  settleForRead: () => Promise<void>;
  close: () => Promise<void>;
};

/** Distinguishes "the cap won the race" from "the write failed". */
class AppendChainTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Append did not answer within ${timeoutMs}ms.`);
    this.name = "AppendChainTimeoutError";
  }
}

export function createAppendChain(options: AppendChainOptions): AppendChain {
  const {
    appendTimeoutMs,
    maxPendingAppends,
    readSettleTimeoutMs,
    closeSettleTimeoutMs,
  } = options;
  // Only for the per-write cap and the record of writes that outlived one; the
  // chain paces itself, so the backoff schedule goes unused. Same use as
  // `maintenance-pass`.
  const pacer = createRetryPacer({
    initialDelayMs: appendTimeoutMs,
    maxDelayMs: appendTimeoutMs,
  });
  let closing = false;
  /**
   * Set once `close` gave up waiting. Read by every link that has not started
   * yet, because the line after it closes the connection they would write on.
   */
  let abandonQueuedAppends = false;
  let pendingAppend = Promise.resolve();
  /** Appends chained but not yet settled, including the one writing right now. */
  let queuedAppends = 0;
  /** Whether the write in flight has already lost its race against the cap. */
  let writeIsStalled = false;

  async function capped<T>(write: () => Promise<T>): Promise<T> {
    const call = write();
    try {
      return await pacer.capAttempt(
        call,
        appendTimeoutMs,
        () => new AppendChainTimeoutError(appendTimeoutMs),
      );
    } catch (error) {
      if (!(error instanceof AppendChainTimeoutError)) {
        throw error;
      }
      // The commands are still on the connection and nothing can cancel them.
      // So the chain does NOT move on — running the next write on top would
      // leave two outstanding against a dependency that has answered neither,
      // and would land them out of order if it recovered. What changes is only
      // that new appends stop queueing behind this write.
      writeIsStalled = true;
      try {
        return await call;
      } finally {
        // Safe as a plain flag rather than a per-call token: the chain runs one
        // write at a time, so the write that set this is the write that clears
        // it.
        writeIsStalled = false;
      }
    }
  }

  return {
    async run(write, handlers) {
      if (closing) {
        return handlers.onRefused("closing");
      }
      if (writeIsStalled) {
        return handlers.onRefused("stalled");
      }
      if (queuedAppends >= maxPendingAppends) {
        return handlers.onRefused("overflow");
      }

      queuedAppends += 1;
      const appendPromise = pendingAppend.then(async () => {
        try {
          if (abandonQueuedAppends) {
            return handlers.onAbandonedAtShutdown();
          }
          return await capped(write);
        } finally {
          queuedAppends -= 1;
        }
      });

      pendingAppend = appendPromise.then(
        () => undefined,
        () => undefined,
      );

      return await appendPromise;
    },
    async settleForRead() {
      // Refused, not delayed. Waiting longer was the wrong lever: the read that
      // follows goes out on the same connection, behind the write that is not
      // answering, and never comes back — while the admin console polls on a
      // timer, so ioredis's queue grows a read and a closure per poll for as
      // long as the stall lasts (#266 review).
      if (writeIsStalled) {
        throw options.makeUnavailableError();
      }
      await settleWithin(pendingAppend, readSettleTimeoutMs);
    },
    async close() {
      // Blocks new appends, but deliberately not the ones already chained: on a
      // healthy shutdown the queue is a write or two deep and drains in
      // milliseconds, and dropping those would lose the shutdown's own records
      // every single time.
      closing = true;
      const drained = await settleWithin(pendingAppend, closeSettleTimeoutMs);
      let pendingWrites = 0;
      let quitOutcome: AppendChainQuitOutcome = "skipped";
      if (!drained) {
        // Nothing that has not started may start now: the connection is about
        // to go, and ioredis answers a command issued after it with a
        // rejection.
        abandonQueuedAppends = true;
        // Read before the socket goes, and after the wait: this is what
        // outlived the budget, and `disconnect()` rejects those commands, which
        // would settle them out of the very count that describes them.
        pendingWrites = pacer.trackedCount();
        // NOT `quit()`. It is an ordinary command on this connection and cannot
        // answer before the write we just gave up on, so a graceful close would
        // inherit the exact wait that was just bounded (#264 review). The socket
        // goes instead — there is nothing left to be graceful about.
        options.connection.disconnect();
      } else {
        // The chain drained, so nothing was queued ahead of `QUIT` and it should
        // have answered at once.
        quitOutcome = await quitWithin(
          options.connection,
          closeSettleTimeoutMs,
        );
      }

      const quitWorked = quitOutcome === "ok" || quitOutcome === "skipped";
      if (pendingWrites === 0 && quitWorked) {
        return;
      }
      options.onCloseUnfinished?.({
        pendingWrites,
        queuedAppends,
        quitOutcome,
        budgetMs: closeSettleTimeoutMs,
      });
    },
  };
}
