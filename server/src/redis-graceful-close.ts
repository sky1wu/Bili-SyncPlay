/**
 * Closing a Redis connection that may not answer.
 *
 * `QUIT` is an ordinary command. ioredis appends it to the same `commandQueue`
 * as everything else and matches replies front-first, so on a half-open socket
 * it inherits the wait of whatever is queued ahead of it — and even on an idle
 * connection it can still never come back, because the reply is the thing that
 * never arrives. Every `close()` in this server runs inside a shutdown step
 * with a budget, so an unbounded `await redis.quit()` spends the whole budget
 * and hands the step a `server_shutdown_step_failed` every time Redis is hung
 * (#264, #267, #270).
 *
 * Shared by every Redis-backed facility rather than copied at each call site:
 * four hand-rolled timeout mechanisms are what #242 cost six duplicate review
 * findings. The wait mechanism lives here; each facility still owns its budget
 * and its degraded-shutdown report.
 */

import { settleWithin } from "./retry-pacer.js";

/**
 * How the graceful close went.
 *
 * Three outcomes, not two, because "did it settle" is not the question:
 * a `QUIT` that settles with a REJECTION settled just fine while leaving the
 * connection in a state nobody checked, and reporting that as clean is how a
 * failed close became invisible (#266 review).
 */
export type RedisQuitOutcome = "ok" | "failed" | "timed_out";

export type ClosableRedisConnection = {
  quit: () => Promise<unknown>;
  /** Tears the socket down without waiting for a reply. Synchronous. */
  disconnect: () => void;
};

export type NamedRedisConnection<Role extends string> = {
  role: Role;
  connection: ClosableRedisConnection;
};

export type RedisQuitReport<Role extends string> = {
  role: Role;
  quitOutcome: RedisQuitOutcome;
  budgetMs: number;
};

/**
 * Send `QUIT`, wait no longer than `budgetMs`, and drop the socket if that did
 * not work.
 *
 * The caller gets the outcome rather than an exception because bounded and
 * silent is the trade this whole area exists to refuse: a close that overran
 * used to be visible only because the shutdown step timed out, so a `close()`
 * that now returns cleanly owes an operator a line instead.
 */
export async function quitWithin(
  connection: ClosableRedisConnection,
  budgetMs: number,
): Promise<RedisQuitOutcome> {
  let failed = false;
  // `quit()` itself can throw synchronously on a client that is already gone.
  // Letting that escape would skip the `disconnect()` below and leak the very
  // socket this function exists to close.
  let quitting: Promise<void>;
  try {
    quitting = connection.quit().then(
      () => undefined,
      () => {
        failed = true;
      },
    );
  } catch {
    failed = true;
    quitting = Promise.resolve();
  }
  const answered = await settleWithin(quitting, budgetMs);
  const outcome: RedisQuitOutcome = !answered
    ? "timed_out"
    : failed
      ? "failed"
      : "ok";
  if (outcome !== "ok") {
    // A reply that never came is a half-open socket that just spent the whole
    // budget; one that came back an error left the socket in a state nobody
    // vouched for. Either way it goes down here rather than outliving the
    // process's own shutdown.
    try {
      connection.disconnect();
    } catch {
      // Swallowed on purpose: the caller reports this outcome, and throwing
      // here would skip that report on the one connection that most needs it —
      // the process is exiting either way, so the answer is worth more than the
      // exception (#270 review).
    }
  }
  return outcome;
}

/**
 * Close independent Redis connections together, without letting one rejected
 * close hide another connection's outcome.
 *
 * Pub/sub facilities own two sockets. `Promise.all` used to reject on the
 * first close error and discard the other result, so shutdown could neither
 * report nor react to the whole facility. `allSettled` preserves both results;
 * after every close and report callback has settled, an unexpected rejection
 * is rethrown so the shutdown step still records a real implementation error.
 */
export async function quitAllWithin<Role extends string>(
  connections: ReadonlyArray<NamedRedisConnection<Role>>,
  budgetMs: number,
  onCloseUnfinished?: (report: RedisQuitReport<Role>) => void,
): Promise<void> {
  const closed = await Promise.allSettled(
    connections.map(async ({ role, connection }) => {
      const quitOutcome = await quitWithin(connection, budgetMs);
      if (quitOutcome !== "ok") {
        onCloseUnfinished?.({ role, quitOutcome, budgetMs });
      }
    }),
  );
  const failed = closed.find((outcome) => outcome.status === "rejected");
  if (failed?.status === "rejected") {
    throw failed.reason;
  }
}
