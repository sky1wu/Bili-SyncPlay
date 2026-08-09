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
  /**
   * How long the read's OWN commands may take once it has been let through.
   *
   * A liveness backstop, not a health judgement — the health judgement is the
   * head-of-connection check in {@link AppendChain.runRead}. This exists for the
   * one read that slips past it: a stall that begins between the check and the
   * command, which no check made before issuing can see. Without it that
   * request ends only when Node's default 300s `requestTimeout` kills it (#269
   * review).
   *
   * Generous on purpose, and for the same reason the append cap is: it must
   * never trip on ordinary latency, only on a connection that has stopped
   * answering.
   */
  readCommandTimeoutMs: number;
  /**
   * Thrown by {@link AppendChain.runRead} when the connection is not answering:
   * either before the read is issued, or after its own bound ran out.
   */
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
   * Run a read against the same connection, under the two bounds it needs.
   *
   * Before: read-your-writes is best effort and bounded, and the read is not
   * issued at all when the connection is not answering — under that failure the
   * queued writes have not landed anyway, so waiting converts a slightly stale
   * answer into no answer, on the page an operator opens precisely to find out
   * what is going wrong.
   *
   * After: the read's own commands are bounded too. Neither bound substitutes
   * for the other — the first stops a read being issued per poll for the whole
   * length of a stall, the second stops the one read that was already in flight
   * when the stall began from hanging until Node's 300s request timeout.
   */
  runRead: <T>(read: () => Promise<T>) => Promise<T>;
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
    readCommandTimeoutMs,
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
  /**
   * The write at the head of the connection, error-swallowed, or a settled
   * promise when nothing is outstanding.
   *
   * The only thing that can tell a reader whether the connection is ANSWERING,
   * which is a different question from whether the queue drained — see
   * {@link AppendChain.settleForRead}.
   */
  let writeInFlight: Promise<void> = Promise.resolve();
  /**
   * Reads that outlived their own bound and have still not answered.
   *
   * A read that timed out is evidence of exactly the same thing a write past
   * its cap is — the connection has stopped answering — and until this existed
   * only the write side left any. On a node whose appends are quiet, or shed,
   * nothing was in flight for the head check to look at, so every poll issued
   * another read and left another closure in ioredis's queue: the per-poll
   * growth this whole path exists to stop, reappearing on the read side (#269
   * review).
   *
   * A count rather than a flag because reads, unlike the serial write chain,
   * can be outstanding several at a time.
   */
  let stalledReads = 0;

  async function capped<T>(write: () => Promise<T>): Promise<T> {
    const call = write();
    writeInFlight = call.then(
      () => undefined,
      () => undefined,
    );
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
    async runRead(read) {
      // Refused, not delayed. Waiting longer was the wrong lever: the read that
      // follows goes out on the same connection, behind the write that is not
      // answering, and never comes back — while the admin console polls on a
      // timer, so ioredis's queue grows a read and a closure per poll for as
      // long as the stall lasts (#266 review). This first check is only the
      // fast path: the cap has already fired, so there is nothing to wait for.
      // Two kinds of evidence, one question. `writeIsStalled` is a write past
      // its cap; `stalledReads` is a read past its own bound — both mean the
      // connection is not answering, and both make this the fast path that
      // refuses without waiting for anything.
      if (writeIsStalled || stalledReads > 0) {
        throw options.makeUnavailableError();
      }

      // Captured before the wait: this is the command the read would be queued
      // behind.
      const headWrite = writeInFlight;
      const [, headAnswered] = await Promise.all([
        // Read-your-writes, best effort. The chain is the write path, and
        // joining it unconditionally is what made every admin read hang for
        // exactly as long as Redis was hung.
        settleWithin(pendingAppend, readSettleTimeoutMs),
        settleWithin(headWrite, readSettleTimeoutMs),
      ]);

      // "Did the queue drain" is NOT the question, and answering it was the
      // defect: a deep queue on a Redis that is merely behind does not drain
      // inside this budget either, and refusing there would take the admin
      // console down on a Redis that is working. The question is whether the
      // connection is ANSWERING, and only the command at its head can say. If
      // that one has not come back inside the read's own budget, neither will
      // the read — and the console's next poll would leave another closure in
      // ioredis's queue, for as long as it lasts.
      //
      // Its own budget, deliberately, not the append cap: the cap is long
      // because tripping it costs records, while a read that waits that long
      // has already failed the operator. Two behaviours, two constants — and
      // waiting for the cap to fire first was the hole this closed (#269
      // review).
      if (!headAnswered) {
        throw options.makeUnavailableError();
      }

      // The check above is evidence about the past, and the only kind there is:
      // the read is queued behind whatever is on the connection at the instant
      // it is ISSUED, and a stall beginning in the gap between the two is
      // invisible to any check made before it (#269 review). Verifying the head
      // again right here would not close that gap and would break the case this
      // whole path protects — on a node with a queue the head is almost always
      // a write issued milliseconds ago and not yet answered, so requiring an
      // answered head would refuse every read on a Redis that is merely behind.
      //
      // So the residual is answered where it actually lands: the read's own
      // commands get a bound, and the caller gets an answer either way. It
      // costs one refused read at the onset of a stall — the next poll sees the
      // stalled write at the head and is refused before anything is issued.
      const call = read();
      if (!(await settleWithin(call, readCommandTimeoutMs))) {
        // The command cannot be cancelled, so the caller is answered and the
        // command is REMEMBERED. Forgetting it is what let the next poll sail
        // through the check above and queue another read behind this one.
        stalledReads += 1;
        const release = (): void => {
          stalledReads -= 1;
        };
        void call.then(release, release);
        throw options.makeUnavailableError();
      }
      return await call;
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
