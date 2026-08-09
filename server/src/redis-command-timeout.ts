/**
 * Every Redis connection in this server is built here, and none may be built
 * without saying what stops its commands hanging forever.
 *
 * #261, #263, #264, #267 and #270 were the same defect found five times: a
 * Redis that accepts commands and stops answering left some caller waiting with
 * no bound. Each fix bounded one caller and deferred the same question — should
 * the client itself set `commandTimeout`? — with the same sentence: the bound
 * belongs to the caller, and the four sites should be evaluated together (#271).
 *
 * ## The answer: two layers, and they are not interchangeable
 *
 * - **A deadline** is per-behaviour and derived from what its caller can
 *   promise. `append-chain`'s per-write cap, its read bound, the runtime
 *   store's `pendingOperationTimeoutMs`, the admin command bus's reply timeout —
 *   each is a different number because each answers a different question, and
 *   each also decides what the caller does next (shed, refuse, retry).
 * - **`commandTimeout` is a liveness backstop.** It answers one question — has
 *   this connection stopped answering? — so it is ONE magnitude, derived from
 *   the dependency's latency distribution rather than from any caller's
 *   patience. It never decides what happens next; it only makes sure something
 *   does.
 *
 * A connection needs at least one. Four of them had neither, which is what
 * {@link RedisCommandBound} now makes impossible to reintroduce silently.
 *
 * ## What `commandTimeout` does NOT do
 *
 * Verified against ioredis 5.11.1, because the trade only makes sense with this
 * in hand. `Redis.sendCommand` arms a timer per command; when it fires,
 * `Command.reject` settles the CALLER's promise — and the `Command` object
 * stays in `commandQueue`, because `DataHandler.returnReply` shifts the front
 * entry for every reply and dropping it would misalign every later reply on
 * that connection.
 *
 * So it releases the caller and the closures the caller was holding. It does
 * NOT shorten the command, take it off the connection, or bound how many
 * unanswered commands the connection accumulates. Every depth limit in this
 * server — `append-chain`'s `maxPendingAppends`, the runtime store's command
 * admission — is still the only thing bounding memory, and none of them may be
 * retired on the strength of this option.
 *
 * ## Two consequences of arming the timer at submission
 *
 * `sendCommand` arms it whether the command goes to the socket or to the
 * offline queue, and `Command.setTimeout` is a no-op once armed, so it is a
 * deadline from submission and survives a reconnect that replays the offline
 * queue. Both follow from that:
 *
 * - A reconnect is now visible. ioredis's default retry schedule reconnects in
 *   well under a second and never later than 2s, so an ordinary blip stays far
 *   inside the budget; an outage longer than the budget surfaces as failed
 *   commands instead of an unbounded silent queue, which is the point.
 * - The handshake is bounded too, so a connect against a Redis that accepts TCP
 *   and never answers fails here rather than at ioredis's 10s `connectTimeout`.
 */

import { Redis } from "ioredis";

/**
 * How long a command may go unanswered before the connection is presumed dead.
 *
 * Derived from Redis's latency distribution, not from any caller's deadline —
 * that is what makes it one number for every connection that takes it. It has
 * to sit far above ordinary latency, because tripping it on a Redis that is
 * merely slow converts a degraded dependency into a failed one, and far below
 * the point where a caller has already failed its own user.
 *
 * Five seconds is the magnitude every caller-side bound in this server already
 * settled on independently — `APPEND_TIMEOUT_MS`, the audit store's
 * `READ_COMMAND_TIMEOUT_MS`, `DEFAULT_PENDING_OPERATION_TIMEOUT_MS`. Those are
 * separate constants and stay separate: they are deadlines, they answer
 * different questions, and any of them may move without this one moving.
 *
 * It also has to stay comfortably above ioredis's reconnect schedule, since a
 * command submitted during a reconnect spends that time on this budget.
 */
export const REDIS_COMMAND_TIMEOUT_MS = 5_000;

/**
 * What stops this connection's commands from hanging forever.
 *
 * Required, and that is its whole job: the option's absence is invisible in a
 * diff, and five separate issues were needed to notice it five times. A caller
 * that has its own bound has to say which one, so the next reader can check the
 * claim instead of assuming somebody did.
 */
export type RedisCommandBound =
  /** `commandTimeout`, at {@link REDIS_COMMAND_TIMEOUT_MS}. */
  | { readonly bound: "command_timeout" }
  /**
   * A caller-side deadline already answers every caller on this connection, and
   * a backstop behind it would only race it.
   *
   * `boundedBy` names that deadline. Nothing reads it at runtime; the type
   * requires it so the exemption cannot be taken by omission.
   */
  | { readonly bound: "caller"; readonly boundedBy: string };

/**
 * The one place `new Redis` is called.
 *
 * `server/test/redis-client-bounds.test.ts` enforces that, which is what turns
 * "every connection declares a bound" from a review-time habit into a
 * check — the lesson this family of issues cost five times over.
 */
export function createBoundedRedisClient(
  redisUrl: string,
  bound: RedisCommandBound,
): Redis {
  return new Redis(redisUrl, {
    lazyConnect: true,
    // Retries, not patience: this caps how often ioredis re-queues a command
    // across reconnects, and says nothing about how long an accepted command
    // may go unanswered. Mistaking the two is how four connections looked
    // bounded while having no bound at all.
    maxRetriesPerRequest: 1,
    ...(bound.bound === "command_timeout"
      ? { commandTimeout: REDIS_COMMAND_TIMEOUT_MS }
      : {}),
  });
}
