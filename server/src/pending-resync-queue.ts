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

export type PendingResyncQueueOptions = {
  publish: (roomCode: string) => Promise<void>;
  initialRetryDelayMs?: number;
  /**
   * The backoff ceiling, and therefore the pace at which a stranded record
   * keeps knocking. There is no attempt LIMIT — see `request`.
   */
  maxRetryDelayMs?: number;
  /**
   * Caps a single attempt so a bus call that never settles cannot pin a record
   * forever. A timed-out attempt counts as a failure and is retried; the
   * underlying publish is left running, exactly as `firePublishRoomEvent` does.
   */
  attemptTimeoutMs?: number;
  /** Backlog size that triggers {@link PendingResyncQueueOptions.onBacklog}. */
  backlogWarnThreshold?: number;
  /** Injectable so tests do not pay the backoff in wall-clock time. */
  sleep?: (delayMs: number) => Promise<void>;
  onAttemptFailed?: (info: PendingResyncFailureInfo) => void;
  /**
   * The backlog crossed {@link PendingResyncQueueOptions.backlogWarnThreshold}.
   * Reported, never used to shed: see `request`.
   */
  onBacklog?: (info: { roomCode: string; pendingRooms: number }) => void;
};

export type PendingResyncQueue = {
  /**
   * Ask for a resync of `roomCode`. Returns immediately, and never refuses.
   *
   * There is deliberately no cap. This notification fires precisely because a
   * room stopped advancing, so a room turned away here has nothing else coming
   * to fix a `sharedByMemberId` naming a member who is gone — dropping it is the
   * permanent loss the queue exists to prevent, and a log line does not restore
   * anyone's playback (#242 review). Growth is bounded by the number of rooms
   * whose ownership moved while the bus was rejecting publishes, each entry is
   * a room code, and the set drains as soon as the bus recovers; if that ever
   * stops being enough the answer is to persist the records, not to refuse them.
   *
   * For the same reason there is no attempt limit either. A per-record budget
   * is just a slower way to discard the notification: the room is idle by
   * definition, so nothing follows the give-up (#242 review). Records retry at
   * `maxRetryDelayMs` until they land or {@link PendingResyncQueue.stopRetrying}
   * ends them.
   */
  request: (roomCode: string) => void;
  /**
   * Every outstanding record has been published.
   *
   * Unbounded by design, because the retries are: it terminates when the bus
   * accepts the records or when {@link PendingResyncQueue.stopRetrying} has
   * been called, and shutdown does the latter first.
   */
  drain: () => Promise<void>;
  /**
   * Let each record finish the attempt it is on and stop there: no further
   * retries, no further batches, and the backoffs in flight are cut short.
   * Irreversible.
   *
   * This is what bounds shutdown. `drain` is deliberately unbounded — records
   * retry until they land — so the shutdown step calls this first, leaving at
   * most ONE in-flight attempt to wait for. An overrun step is not a harmless
   * delay: it is recorded as a FAILURE, and shutdown then closes the bus under
   * whatever was still trying (#242 review).
   */
  stopRetrying: () => void;
  /** Room codes with an outstanding record. */
  size: () => number;
};

const DEFAULT_INITIAL_RETRY_DELAY_MS = 250;
/**
 * The pace a stranded record settles into. Long enough that a room nobody can
 * reach is not a busy loop against a dead bus, short enough that recovery is
 * measured in seconds.
 */
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 5_000;
const DEFAULT_BACKLOG_WARN_THRESHOLD = 256;

type PendingRecord = {
  /** Another publish is owed once the current attempt finishes. */
  pending: boolean;
  settled: Promise<void>;
};

export function createPendingResyncQueue(
  options: PendingResyncQueueOptions,
): PendingResyncQueue {
  const initialRetryDelayMs =
    options.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const attemptTimeoutMs =
    options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const backlogWarnThreshold =
    options.backlogWarnThreshold ?? DEFAULT_BACKLOG_WARN_THRESHOLD;

  const records = new Map<string, PendingRecord>();
  /** `cancel` for every backoff currently being waited out. */
  const pendingWaits = new Set<() => void>();
  let retriesStopped = false;

  /**
   * An injected `sleep` is a test clock and resolves on its own; the real timer
   * has to be cancellable, or `stopRetrying` would still have to sit through a
   * 30s backoff before shutdown could move on.
   */
  function waitBeforeRetry(delayMs: number): Promise<void> {
    if (options.sleep) {
      return options.sleep(delayMs);
    }
    let cancel = (): void => {};
    const promise = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      cancel = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    pendingWaits.add(cancel);
    return promise.finally(() => {
      pendingWaits.delete(cancel);
    });
  }

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
   * Drives one room's record until the bus takes it.
   *
   * The attempt loop has no give-up branch on purpose. A per-record budget is
   * just a slower way to discard the notification — the room is idle by
   * definition, so nothing follows the give-up and the clients keep a
   * `sharedByMemberId` naming a member who left, until someone reloads (#242
   * review). Only `stopRetrying` ends it, and only at shutdown.
   *
   * The `pending` flag is re-read synchronously after each publish settles, so
   * a request that landed mid-flight is picked up before the record is dropped
   * — there is no await between the final check and the `delete`.
   */
  async function drive(roomCode: string, record: PendingRecord): Promise<void> {
    try {
      while (record.pending && !retriesStopped) {
        record.pending = false;
        for (let attempt = 1; ; attempt += 1) {
          try {
            await publishOnce(roomCode);
            break;
          } catch (error) {
            const delayMs = retryDelayMs(attempt);
            options.onAttemptFailed?.({ roomCode, attempt, delayMs, error });
            if (retriesStopped) {
              return;
            }
            await waitBeforeRetry(delayMs);
            if (retriesStopped) {
              return;
            }
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
      if (records.size >= backlogWarnThreshold) {
        options.onBacklog?.({ roomCode, pendingRooms: records.size });
      }
      const record: PendingRecord = {
        pending: true,
        settled: Promise.resolve(),
      };
      records.set(roomCode, record);
      record.settled = drive(roomCode, record);
      void record.settled.catch(() => undefined);
    },
    stopRetrying() {
      retriesStopped = true;
      // Cut the backoffs short too: a record parked on the 30s ceiling would
      // otherwise hold the drain for that long.
      for (const cancel of Array.from(pendingWaits)) {
        cancel();
      }
      pendingWaits.clear();
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
