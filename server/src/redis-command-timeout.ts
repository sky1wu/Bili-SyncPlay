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
 * ## And they do not compose: the backstop is admissible on FEWER connections
 * ## than it looks
 *
 * Nearly every deadline in this server is built on one mechanism (`retry-pacer`,
 * and the admission gate and maintenance passes over it): **the cap does not
 * cancel the call, so the call stays tracked, and the fact that it has still not
 * answered is the evidence that stops the next attempt.** That is why
 * `ensurePendingCapacity` counts `commandPacer.trackedCount()`, why
 * `maintenance-pass` reports `stalled`, why `pending-resync-queue` waits on
 * `inFlight` "rather than pile another on top", and why `append-chain` refuses a
 * read on `writeIsStalled`.
 *
 * A backstop SETTLES those calls. Every one of those bounds then reads the
 * connection as idle and lets the next attempt out — so the bound stops being a
 * bound and becomes a rate: one more command per timeout window, for as long as
 * the stall lasts. Each of them was a review round in its own right (#242, #261,
 * #263, #266), and the option would undo all four at once.
 *
 * So the criterion is not "does this connection already have a bound" — it is:
 *
 *   **A connection may take the backstop only if NO caller on it derives a
 *   bound from a command's failure to answer.**
 *
 * Three connections pass: the admin session store (one command per HTTP
 * request, no retry, no pacer) and the admin command bus's publisher and
 * subscriber (a reply timer on a `setTimeout`, which is not evidence about the
 * connection). The other five do not.
 *
 * {@link RedisCommandBound} therefore demands a NAMED deadline rather than a
 * boolean: "this one is bounded" was believed about the runtime store for as
 * long as nobody had to write down by what — while `trackAwaitedOperation` had
 * no bound at all.
 *
 * ## What that leaves open, deliberately
 *
 * The five exempt connections still have command paths with no caller-side
 * bound: the room store's request path, the runtime store's
 * `trackAwaitedOperation` and its two plain reads. A stalled Redis still hangs
 * a join there. That gap is real and it is NOT closeable by this option — the
 * fix is a cap that keeps the call tracked, or a separate connection for the
 * paths that want a backstop, and both are derivations with their own review.
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
 * unanswered commands the connection accumulates. Every caller-side depth
 * limit in this server — `append-chain`'s `maxPendingAppends`, the runtime
 * store's command admission — remains essential and none may be retired on the
 * strength of this option. The three backstopped connections instead pair it
 * with a stalled-connection reset that disables replay of ioredis's saved
 * `prevCommandQueue`; the timeout alone still supplies no queue bound.
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
import { settleWithin } from "./retry-pacer.js";
import type { ClosableRedisConnection } from "./redis-graceful-close.js";

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
      ? {
          commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
          // A timed-out command stays in ioredis's commandQueue. When the
          // stalled-connection guard drops that socket, ioredis moves the queue
          // to prevCommandQueue; its default is to replay every entry after the
          // reconnect. Backstopped callers have already received their timeout,
          // so replaying only preserves the unbounded real queue the reset is
          // meant to retire. Caller-bounded clients keep the default because
          // their in-flight command is evidence that gates later work.
          autoResendUnfulfilledCommands: false,
          // The command bus has both durable command channels and one-shot reply
          // channels. ioredis cannot distinguish them and would resubscribe both,
          // including a reply-channel UNSUBSCRIBE that timed out just before the
          // reset. The bus restores only its durable handlers and still-active
          // result channels on `ready`; caller-bounded pub/sub keeps ioredis's
          // default policy.
          autoResubscribe: false,
        }
      : {}),
  });
}

/**
 * How long a `caller`-bounded connection may take to become ready.
 *
 * ioredis's `connectTimeout` bounds the TCP connect, not the handshake that
 * follows it, and `connect()` resolves on `ready`. Against a host that accepts
 * the socket and never answers `INFO`, a connection with no `commandTimeout`
 * therefore stays pending forever — measured, not inferred. A backstopped
 * connection needs nothing here, because the handshake is a command like any
 * other and the backstop is armed the moment it is submitted.
 *
 * Ten seconds because this is a startup path with no user waiting on it, and
 * because ioredis's own default for the connect it does bound is the same.
 */
export const REDIS_CONNECT_TIMEOUT_MS = 10_000;

export class RedisConnectTimeoutError extends Error {
  constructor(budgetMs: number) {
    super(`Redis connection was not ready within ${budgetMs}ms.`);
    this.name = "RedisConnectTimeoutError";
  }
}

export class RedisStartupTimeoutError extends Error {
  constructor(
    readonly operation: string,
    budgetMs: number,
  ) {
    super(
      `Redis startup operation "${operation}" did not complete within ${budgetMs}ms.`,
    );
    this.name = "RedisStartupTimeoutError";
  }
}

async function settleStartupWithin(
  connection: ClosableRedisConnection,
  work: () => Promise<unknown>,
  budgetMs: number,
  createTimeoutError: () => Error,
): Promise<void> {
  let failed: unknown;
  const running = work().then(
    () => undefined,
    (error: unknown) => {
      failed = error;
    },
  );

  if (!(await settleWithin(running, budgetMs))) {
    // Nothing can cancel the startup operation, so the socket goes instead —
    // leaving it open would keep a client retrying behind a process that is
    // already failing to start.
    try {
      connection.disconnect();
    } catch {
      // The throw below is what the caller acts on.
    }
    throw createTimeoutError();
  }
  if (failed !== undefined) {
    throw failed;
  }
}

/**
 * Open a `caller`-bounded connection, or fail loudly.
 *
 * The exemption from {@link RedisCommandBound} is about the commands a store
 * issues, and every one of those is bounded by the store. `connect()` is not
 * one of them: it runs before the store exists, is awaited by bootstrap, and an
 * unbounded wait there is a process that never starts listening and never says
 * why — the same silence in a different place.
 */
export async function connectWithin(
  connection: ClosableRedisConnection & { connect: () => Promise<unknown> },
  budgetMs: number = REDIS_CONNECT_TIMEOUT_MS,
): Promise<void> {
  await settleStartupWithin(
    connection,
    () => connection.connect(),
    budgetMs,
    () => new RedisConnectTimeoutError(budgetMs),
  );
}

/**
 * Run one step of a store's construction under the same bound.
 *
 * `connectWithin` closes the handshake; it does not close everything bootstrap
 * awaits. A store that migrates or backfills at construction issues ORDINARY
 * commands before it exists, so they are covered by none of the caller-side
 * deadlines its exemption names — and a Redis that completes the handshake and
 * then stops answering hangs startup just as completely as one that never
 * shook hands (#271 review).
 */
export async function startWithin(
  connection: ClosableRedisConnection,
  operation: string,
  work: () => Promise<unknown>,
  budgetMs: number = REDIS_CONNECT_TIMEOUT_MS,
): Promise<void> {
  await settleStartupWithin(
    connection,
    work,
    budgetMs,
    () => new RedisStartupTimeoutError(operation, budgetMs),
  );
}

/**
 * How many consecutive failures mark a backstopped connection as dead.
 *
 * Three, so an isolated error — a `WRONGTYPE`, one dropped packet — never
 * costs a reconnect, while a connection that has stopped answering reaches it
 * in one backstop window per failure.
 */
export const REDIS_STALL_DROP_THRESHOLD = 3;

/** A connection that can be reset without being retired. */
export type ResettableRedisConnection = {
  /**
   * `disconnect(true)` drops the socket and leaves ioredis's retry strategy in
   * place. Backstopped clients also disable replay of the resulting
   * `prevCommandQueue`; plain `disconnect()` sets `manuallyClosing` and would
   * retire the connection for good — the difference between a reset and an
   * outage.
   */
  disconnect: (reconnect?: boolean) => void;
};

export type StalledConnectionGuard = {
  /** A command answered. */
  recordSuccess: () => void;
  /** A command failed. Returns true when this failure dropped the socket. */
  recordFailure: () => boolean;
};

/**
 * The companion every backstopped connection needs.
 *
 * `commandTimeout` answers the CALLER and leaves the command in ioredis's
 * `commandQueue`, where nothing this side of the socket can remove it. On a
 * connection with no admission or depth limit — and neither of the two that
 * take the backstop has one — that turns a half-open Redis into unbounded
 * growth at the request rate: every caller is answered in five seconds, retries
 * immediately, and leaves one more command behind (#271 review).
 *
 * A depth limit cannot be built on top of the backstop either, because after it
 * fires a settled command and a queued one look the same from here. What DOES
 * retire the queue is closing the socket on a backstopped client: ioredis moves
 * `commandQueue` to `prevCommandQueue`, and the centralized client policy
 * disables command replay and automatic subscription replay before the
 * reconnect. So the bound on the real queue is "a connection that keeps failing
 * gets reset without replay", and that is this.
 *
 * Consecutive, not cumulative: the count is what distinguishes a connection
 * that has stopped answering from one that is merely returning errors, and a
 * single success is enough to say it is alive.
 */
export function createStalledConnectionGuard(
  connection: ResettableRedisConnection,
  options: {
    threshold?: number;
    /** The socket was dropped. Bounded and silent is not the trade here. */
    onDropped?: (info: { consecutiveFailures: number }) => void;
  } = {},
): StalledConnectionGuard {
  const threshold = options.threshold ?? REDIS_STALL_DROP_THRESHOLD;
  let consecutiveFailures = 0;

  return {
    recordSuccess() {
      consecutiveFailures = 0;
    },
    recordFailure() {
      consecutiveFailures += 1;
      if (consecutiveFailures < threshold) {
        return false;
      }
      const dropped = consecutiveFailures;
      // Reset first: commands whose timers are landing alongside this one still
      // come back through here. Without this the guard could trip again on the
      // same stalled batch while the socket is being replaced.
      consecutiveFailures = 0;
      try {
        connection.disconnect(true);
      } catch {
        // The report below is what the operator acts on.
      }
      options.onDropped?.({ consecutiveFailures: dropped });
      return true;
    },
  };
}
