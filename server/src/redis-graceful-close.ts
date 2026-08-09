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
 * (#264, #267).
 *
 * Extracted rather than written a third time: the event store, the audit store
 * and the admin session store all close a Redis connection inside the same kind
 * of budget, and four hand-rolled copies of a timeout mechanism is what #242
 * cost six duplicate review findings.
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
  const quitting = connection.quit().then(
    () => undefined,
    () => {
      failed = true;
    },
  );
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
    connection.disconnect();
  }
  return outcome;
}
