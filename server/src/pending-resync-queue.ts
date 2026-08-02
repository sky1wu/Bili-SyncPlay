/**
 * At-least-once delivery for the one-shot `room_state_updated` broadcasts.
 *
 * Almost every `room_state_updated` is self-healing: `video:share`,
 * `playback:update` and `profile:update` all publish one, so losing a single
 * send is corrected by the next one. The share-ownership resync is the
 * exception. It goes out precisely because the room has stopped advancing, so
 * nothing follows it — and the extension only sends `sync:request` while a
 * content script hydrates, which an idle room never triggers. A dropped resync
 * therefore leaves every client caching a `sharedVideo.sharedByMemberId` that
 * names nobody until the user reloads the page (#242).
 *
 * Publishing cannot simply be awaited by its caller instead: the leave and join
 * handlers would then block on the bus for up to its publish timeout. So the
 * retry lives here, behind a `request` that returns immediately.
 *
 * Requests are deduplicated per room code because the event carries no payload
 * — the consumer rebuilds and broadcasts the room's CURRENT state — so one
 * successful publish satisfies every request made before it. A request that
 * arrives while an attempt is already in flight still schedules another
 * publish: that attempt may have been consumed before the change being
 * announced was visible.
 */

export type PendingResyncFailureInfo = {
  roomCode: string;
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  delayMs: number;
  error: unknown;
};

export type PendingResyncAbandonInfo = {
  roomCode: string;
  attempts: number;
  error: unknown;
};

export type PendingResyncQueueOptions = {
  publish: (roomCode: string) => Promise<void>;
  /** Total attempts per publish, including the first. */
  maxAttempts?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  /**
   * Caps a single attempt so a bus call that never settles cannot pin a record
   * forever. A timed-out attempt counts as a failure and is retried; the
   * underlying publish is left running, exactly as `firePublishRoomEvent` does.
   */
  attemptTimeoutMs?: number;
  /** Refuse new room codes past this many outstanding records. */
  maxPendingRooms?: number;
  /** Injectable so tests do not pay the backoff in wall-clock time. */
  sleep?: (delayMs: number) => Promise<void>;
  onAttemptFailed?: (info: PendingResyncFailureInfo) => void;
  onAbandoned?: (info: PendingResyncAbandonInfo) => void;
  onRejected?: (info: { roomCode: string; pendingRooms: number }) => void;
};

export type PendingResyncQueue = {
  /** Ask for a resync of `roomCode`. Returns immediately. */
  request: (roomCode: string) => void;
  /** Every outstanding record has settled, however it settled. */
  drain: () => Promise<void>;
  /**
   * Let each record finish the batch it is on and stop there, instead of
   * running another for the requests that arrived mid-batch. Irreversible.
   *
   * A drain is otherwise unbounded in the number of batches, and each batch
   * costs a full retry budget: two of them exceed the shutdown step that has to
   * wait for them, and an overrun step is a FAILED step — after which the bus
   * is torn down anyway, so the publish is lost AND the process exits non-zero
   * (#242 review). Batches for DIFFERENT rooms run concurrently, so bounding
   * each record to one batch bounds the whole drain to one.
   *
   * The cost is the mid-batch request itself: at shutdown it is dropped rather
   * than given the fresh budget it would get at runtime. Session cleanup has
   * already drained by the time this is called, so there should be nothing left
   * to make one.
   */
  stopAfterCurrentBatch: () => void;
  /** Room codes with an outstanding record. */
  size: () => number;
};

/**
 * The budget is sized against the shutdown step that drains this queue.
 * `flush_pending_room_event_publishes` gets 30s, and a drain has to fit inside
 * it or shutdown records a failed step and the process exits non-zero — so the
 * worst case (every attempt hanging its full timeout, plus the backoff between
 * them) has to stay under that: 4 × 5s + 1.75s ≈ 22s. Raising either constant
 * means revisiting that step's timeout in `app.ts`.
 */
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 5_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PENDING_ROOMS = 256;

/**
 * Deliberately NOT `unref`'d. The backoff timer is the only thing keeping a
 * retry alive; unrefing it lets an otherwise idle event loop drain and the
 * write is silently lost — the exact failure this queue exists to prevent.
 */
function defaultSleep(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

type PendingRecord = {
  /** Another publish is owed once the current attempt finishes. */
  pending: boolean;
  settled: Promise<void>;
};

export function createPendingResyncQueue(
  options: PendingResyncQueueOptions,
): PendingResyncQueue {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const initialRetryDelayMs =
    options.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const attemptTimeoutMs =
    options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const maxPendingRooms = options.maxPendingRooms ?? DEFAULT_MAX_PENDING_ROOMS;
  const sleep = options.sleep ?? defaultSleep;

  const records = new Map<string, PendingRecord>();
  let stoppedAfterCurrentBatch = false;

  function retryDelayMs(attempt: number): number {
    return Math.min(initialRetryDelayMs * 2 ** (attempt - 1), maxRetryDelayMs);
  }

  async function publishOnce(roomCode: string): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        options.publish(roomCode),
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error(`Room state resync publish timed out for ${roomCode}.`),
            );
          }, attemptTimeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Drives one room's record to completion.
   *
   * The `pending` flag is re-read synchronously after each publish settles, so
   * a request that landed mid-flight is picked up before the record is dropped
   * — there is no await between the final check and the `delete`.
   */
  async function drive(roomCode: string, record: PendingRecord): Promise<void> {
    try {
      while (record.pending && !stoppedAfterCurrentBatch) {
        record.pending = false;
        for (let attempt = 1; ; attempt += 1) {
          try {
            await publishOnce(roomCode);
            break;
          } catch (error) {
            if (attempt >= maxAttempts) {
              options.onAbandoned?.({ roomCode, attempts: attempt, error });
              // `break`, not `return`: a request that arrived while this batch
              // was retrying describes a LATER change and is owed a publish of
              // its own. Returning here dropped it along with the exhausted
              // batch, which is the same permanent loss this queue exists to
              // prevent — and the outer loop is what gives it a fresh budget.
              break;
            }
            const delayMs = retryDelayMs(attempt);
            options.onAttemptFailed?.({ roomCode, attempt, delayMs, error });
            await sleep(delayMs);
          }
        }
      }
    } finally {
      records.delete(roomCode);
    }
  }

  return {
    request(roomCode) {
      const existing = records.get(roomCode);
      if (existing) {
        existing.pending = true;
        return;
      }
      if (records.size >= maxPendingRooms) {
        options.onRejected?.({ roomCode, pendingRooms: records.size });
        return;
      }
      const record: PendingRecord = {
        pending: true,
        settled: Promise.resolve(),
      };
      records.set(roomCode, record);
      record.settled = drive(roomCode, record);
      void record.settled.catch(() => undefined);
    },
    stopAfterCurrentBatch() {
      stoppedAfterCurrentBatch = true;
    },
    async drain() {
      while (records.size > 0) {
        await Promise.allSettled(
          Array.from(records.values(), (record) => record.settled),
        );
      }
    },
    size() {
      return records.size;
    },
  };
}
