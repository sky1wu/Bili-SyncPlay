import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { createRetryPacer, settleWithin } from "../retry-pacer.js";
import { shouldIncludeRuntimeEvent } from "./event-visibility.js";
import {
  isWindowIndexedEvent,
  type GlobalEventStore,
  type GlobalEventStoreAppendInput,
  type GlobalEventStoreQuery,
  type GlobalEventStoreQueryResult,
} from "./global-event-store.js";
import type {
  EventStoreAppendDropReason,
  MetricsCollector,
} from "./metrics.js";
import type { RuntimeEvent } from "./types.js";

const DEFAULT_EVENT_STREAM_KEY = "bsp:events";
const DEFAULT_EVENT_COUNTS_KEY = "bsp:event_counts";
const DEFAULT_EVENT_WINDOW_INDEX_KEY_PREFIX = "bsp:event_window_index";
const DEFAULT_EVENT_STREAM_MAX_LEN = 1_000;
const MINUTE_MS = 60_000;
const WINDOW_RETENTION_MS = 24 * 60 * 60_000;
const LEGACY_COUNTS_MIGRATION_SNAPSHOT_SUFFIX = ":legacy_migrated";

/**
 * How long ONE event's Redis writes may take before the store stops queueing
 * behind them.
 *
 * Does not shorten the write — nothing can cancel a command already on the
 * connection, same as everywhere else in this server. What it bounds is the
 * QUEUE: past this the store sheds new appends instead of chaining another
 * closure onto a write that may never answer.
 *
 * Same order as the runtime store's `pendingOperationTimeoutMs`, and for the
 * same reason: it has to be long enough that ordinary Redis latency never trips
 * it, because tripping it costs events.
 */
const APPEND_TIMEOUT_MS = 5_000;

/**
 * How many events may be waiting on the chain before the store sheds.
 *
 * Matched to the stream's own default retention: queueing more than the stream
 * keeps buys nothing, because `XTRIM MAXLEN` would drop the surplus the moment
 * it landed. This is the bound that makes the queue's memory cost finite when
 * Redis is slow but still answering — the append timeout never fires in that
 * case, so nothing else would stop it growing.
 */
const MAX_PENDING_APPENDS = 1_000;

/**
 * How long a read may wait for the appends queued ahead of it.
 *
 * Read-your-writes for the admin console is worth a short wait and nothing
 * more: under the failure this bound exists for, the queued writes have not
 * landed anyway, so waiting converts a slightly stale answer into no answer —
 * on the page an operator opens precisely to find out what is going wrong.
 */
const READ_APPEND_SETTLE_TIMEOUT_MS = 1_000;

/**
 * How long `close` may wait for the chain to drain, and separately for `QUIT`.
 *
 * Both, so the arithmetic matters: worst case is twice this, and it has to stay
 * comfortably inside the default 5s shutdown step budget — which is the whole
 * point, because an unbounded wait made `close_event_store` a guaranteed
 * `server_shutdown_step_failed` whenever Redis was hung (#264). Same trade as
 * `maintenance-pass.stop`, including the part where giving up quietly would
 * only move the silence — hence `onAppendsAbandonedAtShutdown`.
 */
const CLOSE_APPEND_SETTLE_TIMEOUT_MS = 1_500;

/** Reported once per incident, unlike the metric, which counts every drop. */
export type EventStoreSheddingReason = EventStoreAppendDropReason;

/** Distinguishes "the cap won the race" from "the write failed". */
class EventStoreAppendTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Event store append did not answer within ${timeoutMs}ms.`);
    this.name = "EventStoreAppendTimeoutError";
  }
}

const MERGE_LEGACY_COUNTS_LUA = `
if KEYS[1] == KEYS[2] then
  return 0
end
local snapshotType = redis.call("TYPE", KEYS[3]).ok
if snapshotType == "string" then
  local countsExists = redis.call("EXISTS", KEYS[2])
  redis.call("DEL", KEYS[3])
  if countsExists == 1 then
    local seedFields = redis.call("HGETALL", KEYS[1])
    for index = 1, #seedFields, 2 do
      redis.call("HSET", KEYS[3], seedFields[index], seedFields[index + 1])
    end
    return 0
  end
  snapshotType = "none"
end
if snapshotType ~= "none" and snapshotType ~= "hash" then
  return redis.error_reply("legacy counts migration snapshot has unsupported type")
end
local fields = redis.call("HGETALL", KEYS[1])
if #fields == 0 then
  return 0
end
local migrated = 0
for index = 1, #fields, 2 do
  local value = tonumber(fields[index + 1])
  if value ~= nil then
    local previousValue = redis.call("HGET", KEYS[3], fields[index])
    local previous = tonumber(previousValue)
    if previous == nil then
      previous = 0
    end
    local delta = value - previous
    if delta > 0 then
      redis.call("HINCRBY", KEYS[2], fields[index], delta)
      migrated = migrated + delta
    end
    redis.call("HSET", KEYS[3], fields[index], value)
  end
end
return migrated
`;

function normalizeNullable(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function encodeNullable(value: string | null | undefined): string {
  return value ?? "";
}

function parseStreamFields(fieldValues: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let i = 0; i < fieldValues.length; i += 2) {
    const key = fieldValues[i];
    const value = fieldValues[i + 1];
    if (key !== undefined && value !== undefined) {
      fields[key] = value;
    }
  }
  return fields;
}

function parseEvent(
  id: string,
  fields: Record<string, string>,
): RuntimeEvent | null {
  const event = fields.event;
  const timestamp = fields.timestamp;
  const details = fields.details;
  if (!event || !timestamp || !details) {
    return null;
  }

  return {
    id,
    timestamp,
    event,
    roomCode: normalizeNullable(fields.roomCode),
    sessionId: normalizeNullable(fields.sessionId),
    remoteAddress: normalizeNullable(fields.remoteAddress),
    origin: normalizeNullable(fields.origin),
    result: normalizeNullable(fields.result),
    details: JSON.parse(details) as Record<string, unknown>,
  };
}

function eventTime(event: RuntimeEvent): number {
  return Date.parse(event.timestamp);
}

function eventWindowIndexKey(prefix: string, eventName: string): string {
  return `${prefix}:${encodeURIComponent(eventName)}`;
}

// SCAN MATCH takes a glob-style pattern, so a configured prefix (via
// REDIS_NAMESPACE) containing *, ?, [ or \ would match keys outside this
// store's namespace and the startup cleanup could UNLINK another
// namespace's indexes on a shared Redis.
function escapeRedisGlob(value: string): string {
  return value.replace(/[\\*?[\]]/g, "\\$&");
}

function retentionReferenceTimestamp(timestampMs: number): number {
  return Math.min(timestampMs, Date.now());
}

function matchesQuery(
  event: RuntimeEvent,
  query: GlobalEventStoreQuery,
): boolean {
  const timestamp = eventTime(event);
  if (!shouldIncludeRuntimeEvent(event.event, query.includeSystem === true)) {
    return false;
  }
  if (query.event && event.event !== query.event) {
    return false;
  }
  if (query.roomCode && event.roomCode !== query.roomCode) {
    return false;
  }
  if (query.sessionId && event.sessionId !== query.sessionId) {
    return false;
  }
  if (query.remoteAddress && event.remoteAddress !== query.remoteAddress) {
    return false;
  }
  if (query.origin && event.origin !== query.origin) {
    return false;
  }
  if (query.result && event.result !== query.result) {
    return false;
  }
  if (query.from !== undefined && timestamp < query.from) {
    return false;
  }
  if (query.to !== undefined && timestamp > query.to) {
    return false;
  }
  return true;
}

/**
 * The commands this store issues, named so a test can supply a client whose
 * `xadd` never answers — the failure the whole shedding path exists for, and
 * one no reachable real Redis reproduces on demand.
 */
export type RedisEventStoreClient = {
  connect: () => Promise<unknown>;
  quit: () => Promise<unknown>;
  /** Tears the socket down without waiting for a reply. Synchronous. */
  disconnect: () => void;
  eval: (
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ) => Promise<unknown>;
  exists: (key: string) => Promise<number>;
  scan: (
    cursor: string,
    matchToken: "MATCH",
    pattern: string,
    countToken: "COUNT",
    count: number,
  ) => Promise<[string, string[]]>;
  unlink: (...keys: string[]) => Promise<unknown>;
  multi: () => RedisEventStoreMulti;
  xadd: (
    key: string,
    id: "*",
    ...fieldValues: string[]
  ) => Promise<string | null>;
  xtrim: (
    key: string,
    strategy: "MAXLEN",
    exact: "=",
    threshold: number,
  ) => Promise<unknown>;
  xrange: (
    key: string,
    start: "-",
    end: "+",
  ) => Promise<Array<[string, string[]]>>;
  xrevrange: (
    key: string,
    start: "+",
    end: "-",
  ) => Promise<Array<[string, string[]]>>;
  hset: (key: string, ...fieldValues: string[]) => Promise<unknown>;
  hmget: (key: string, ...fields: string[]) => Promise<Array<string | null>>;
  hincrby: (key: string, field: string, increment: number) => Promise<unknown>;
  zadd: (key: string, score: string, member: string) => Promise<unknown>;
  zcount: (key: string, min: number, max: number) => Promise<number>;
  zremrangebyscore: (key: string, min: string, max: string) => Promise<unknown>;
};

export type RedisEventStoreMulti = {
  zadd: (key: string, score: string, member: string) => RedisEventStoreMulti;
  exec: () => Promise<unknown>;
};

export type RedisEventStoreOptions = {
  streamKey?: string;
  countsKey?: string;
  legacyCountsKey?: string;
  windowIndexKeyPrefix?: string;
  maxLen?: number;
  redisClient?: RedisEventStoreClient;
  appendTimeoutMs?: number;
  maxPendingAppends?: number;
  readSettleTimeoutMs?: number;
  closeSettleTimeoutMs?: number;
  metricsCollector?: Pick<
    MetricsCollector,
    "declareEventStoreAppends" | "recordEventStoreAppendDropped"
  >;
  /**
   * The store started shedding events. Exactly once per incident.
   *
   * Fired on the transition, not per drop: the report is itself a log line, and
   * a report per dropped log line would put the loudest possible output on the
   * one path already established to be overloaded. It is also NOT fired again
   * when the diagnosis changes mid-incident — one start, one end, so the two
   * can be matched up. The live per-stage picture belongs to
   * `bili_syncplay_event_store_appends_dropped_total`, and the total to
   * {@link RedisEventStoreOptions.onAppendsResumed}.
   */
  onAppendsDropped?: (info: { reason: EventStoreSheddingReason }) => void;
  /**
   * Shedding ended. Exactly once per incident, closing the line above.
   *
   * `reason` is what it ended as and `startedAsReason` what it began as; they
   * differ when the incident changed stage, which is the whole arc in one line.
   * `droppedEvents` is what it cost across every stage.
   */
  onAppendsResumed?: (info: {
    reason: EventStoreSheddingReason;
    startedAsReason: EventStoreSheddingReason;
    droppedEvents: number;
  }) => void;
  /**
   * `close` finished with something unfinished. The one degraded-shutdown
   * signal, and the only thing standing between a bounded close and a silent
   * one — the overrun used to be visible only because the step itself timed
   * out.
   */
  onAppendsAbandonedAtShutdown?: (info: {
    /** Commands still unanswered on the connection when the socket was dropped. */
    pendingWrites: number;
    queuedAppends: number;
    /** What an incident still open at shutdown had cost. 0 when none was open. */
    droppedEvents: number;
    /** The graceful close ran out of budget too: a half-open socket. */
    quitTimedOut: boolean;
    budgetMs: number;
  }) => void;
};

export async function createRedisEventStore(
  redisUrl: string,
  options: RedisEventStoreOptions = {},
): Promise<GlobalEventStore & { close: () => Promise<void> }> {
  const redis =
    options.redisClient ??
    (new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      // Deliberately no `commandTimeout`: it would bound the admin console's
      // reads on this connection too, and that is the same decision deferred by
      // #261 and #263 for the room store and the runtime store. The bound this
      // store owns is on its own queue, which is what made the stall unbounded.
    }) as RedisEventStoreClient);
  const streamKey = options.streamKey ?? DEFAULT_EVENT_STREAM_KEY;
  const countsKey = options.countsKey ?? DEFAULT_EVENT_COUNTS_KEY;
  const legacyCountsKey =
    options.legacyCountsKey && options.legacyCountsKey !== countsKey
      ? options.legacyCountsKey
      : undefined;
  const windowIndexKeyPrefix =
    options.windowIndexKeyPrefix ?? DEFAULT_EVENT_WINDOW_INDEX_KEY_PREFIX;
  const maxLen = options.maxLen ?? DEFAULT_EVENT_STREAM_MAX_LEN;
  const appendTimeoutMs = options.appendTimeoutMs ?? APPEND_TIMEOUT_MS;
  const maxPendingAppends =
    options.maxPendingAppends ?? Math.min(maxLen, MAX_PENDING_APPENDS);
  /** The low watermark. See {@link endSheddingIfRecovered} for why it is not the limit. */
  const resumeAtQueuedAppends = Math.floor(maxPendingAppends / 2);
  const readSettleTimeoutMs =
    options.readSettleTimeoutMs ?? READ_APPEND_SETTLE_TIMEOUT_MS;
  const closeSettleTimeoutMs =
    options.closeSettleTimeoutMs ?? CLOSE_APPEND_SETTLE_TIMEOUT_MS;
  const metricsCollector = options.metricsCollector;
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
  /** The incident in progress, or null. Closed by {@link endSheddingIfRecovered}. */
  let shedding: {
    /** What it is shedding for now. Can change without ending the incident. */
    reason: EventStoreSheddingReason;
    /** What it was shedding for when the start line went out. */
    startedAsReason: EventStoreSheddingReason;
    droppedEvents: number;
  } | null = null;
  const lastPrunedMinuteByEvent = new Map<string, number>();

  await redis.connect();
  // After the connection, not before it: a construction that throws leaves no
  // store behind, and a declared series with nothing feeding it is exactly the
  // permanent zero the declaration gate exists to avoid.
  metricsCollector?.declareEventStoreAppends();

  function shedAppend(reason: EventStoreSheddingReason): void {
    metricsCollector?.recordEventStoreAppendDropped(reason);
    if (shedding !== null) {
      // The diagnosis can change mid-incident: `overflow` becoming `stalled` is
      // Redis going from behind to not answering at all, and the two need
      // different repairs. It does NOT open a second incident and does NOT get
      // a second start line — two starts against one end is a pair an operator
      // cannot match up (#266 review). Which stage it is in RIGHT NOW is the
      // metric's job, per `reason`; all this has to do is make sure the line
      // that closes the incident names what it ended as.
      shedding.reason = reason;
      shedding.droppedEvents += 1;
      return;
    }
    // Recorded BEFORE the callback, which is a log line and could come back
    // here as another append: a second transition report would be the start of
    // a loop rather than a second incident.
    shedding = { reason, startedAsReason: reason, droppedEvents: 1 };
    options.onAppendsDropped?.({ reason });
  }

  function resumeAppends(): void {
    if (shedding === null) {
      return;
    }
    const { reason, startedAsReason, droppedEvents } = shedding;
    shedding = null;
    options.onAppendsResumed?.({ reason, startedAsReason, droppedEvents });
  }

  /**
   * End the incident once the store is comfortably accepting again.
   *
   * Driven by a write LANDING rather than by the next `append`, because that
   * append may never come: a node whose traffic went quiet during the stall
   * would log a start with no end, and an operator reading that has no way to
   * tell an incident that ended from one still running (#266 review).
   *
   * Landing, not merely settling. A write that finally answers with a rejection
   * — ioredis rejecting after a disconnect and its retries — leaves the store
   * able to accept appends but not able to store them, and calling that a
   * recovery puts a cheerful line immediately before a run of
   * `runtime_event_append_failed`. Only a write that succeeded shows the store
   * works again.
   *
   * Well below the depth limit, not at it. Resuming the moment one slot frees
   * leaves the store one event away from shedding again, which under a steady
   * overload is a resumed/dropped pair per completed write — the per-line noise
   * this whole design exists to avoid, moved to the other edge.
   */
  function endSheddingIfRecovered(): void {
    if (writeIsStalled || queuedAppends > resumeAtQueuedAppends) {
      return;
    }
    resumeAppends();
  }

  /**
   * The one degraded-shutdown report, at the end of `close`.
   *
   * Three things can be unfinished, and any one of them on its own is worth a
   * line:
   *
   * - commands still on the connection that is about to go;
   * - an incident whose start line would otherwise never be closed —
   *   `resumeAppends` cannot close it, because the store did not recover, the
   *   process is leaving, so every `runtime_event_appends_dropped` gets exactly
   *   one of these two endings (#266 review);
   * - a `QUIT` that never came back, which is a half-open socket with no write
   *   left to blame and which just spent the whole budget. Bounded and silent
   *   is the trade this whole area exists to refuse: the overrun used to be
   *   visible only because the shutdown step timed out, so a `close` that
   *   returns cleanly owes the line instead.
   */
  function reportUnfinishedAtShutdown(outcome: {
    pendingWrites: number;
    quitTimedOut: boolean;
  }): void {
    const incident = shedding;
    shedding = null;
    if (
      outcome.pendingWrites === 0 &&
      !outcome.quitTimedOut &&
      incident === null
    ) {
      return;
    }
    options.onAppendsAbandonedAtShutdown?.({
      pendingWrites: outcome.pendingWrites,
      queuedAppends,
      droppedEvents: incident?.droppedEvents ?? 0,
      quitTimedOut: outcome.quitTimedOut,
      budgetMs: closeSettleTimeoutMs,
    });
  }

  async function mergeLegacyCountsIfNeeded() {
    if (!legacyCountsKey) {
      return;
    }
    await redis.eval(
      MERGE_LEGACY_COUNTS_LUA,
      3,
      legacyCountsKey,
      countsKey,
      `${countsKey}${LEGACY_COUNTS_MIGRATION_SNAPSHOT_SUFFIX}`,
    );
  }

  await mergeLegacyCountsIfNeeded();

  // Backfill cumulative counts from existing stream entries if the hash
  // does not exist yet (first startup after upgrade).
  const hashExists = await redis.exists(countsKey);
  if (!hashExists) {
    const allEntries = await redis.xrange(streamKey, "-", "+");
    if (allEntries.length > 0) {
      const counts = new Map<string, number>();
      for (const [, fieldValues] of allEntries) {
        for (let i = 0; i < fieldValues.length; i += 2) {
          if (fieldValues[i] === "event" && fieldValues[i + 1]) {
            const name = fieldValues[i + 1];
            counts.set(name, (counts.get(name) ?? 0) + 1);
          }
        }
      }
      if (counts.size > 0) {
        const args: string[] = [];
        for (const [name, count] of counts) {
          args.push(name, String(count));
        }
        await redis.hset(countsKey, ...args);
      }
    }
  }

  // Drop window indexes for event names that are no longer indexed. Nothing
  // prunes those keys once appends stop touching them, so a deploy that
  // narrows the allowlist would otherwise leave the old high-volume ZSETs
  // (24h of per-heartbeat system events) in Redis forever. UNLINK reclaims
  // them off the main thread. A node still running the previous version may
  // recreate a key during a rolling restart; the next startup removes it.
  {
    let cursor = "0";
    const staleKeys: string[] = [];
    const literalKeyPrefix = `${windowIndexKeyPrefix}:`;
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${escapeRedisGlob(windowIndexKeyPrefix)}:*`,
        "COUNT",
        100,
      );
      cursor = nextCursor;
      for (const key of keys) {
        // Literal-prefix backstop in case the glob escaping above ever
        // diverges from Redis's matching rules.
        if (!key.startsWith(literalKeyPrefix)) {
          continue;
        }
        const encodedEventName = key.slice(literalKeyPrefix.length);
        let eventName = encodedEventName;
        try {
          eventName = decodeURIComponent(encodedEventName);
        } catch {
          // Not produced by eventWindowIndexKey; treat the raw suffix as the
          // event name so unknown keys under the prefix still get removed.
        }
        if (!isWindowIndexedEvent(eventName)) {
          staleKeys.push(key);
        }
      }
    } while (cursor !== "0");
    if (staleKeys.length > 0) {
      await redis.unlink(...staleKeys);
    }
  }

  // Backfill the window indexes from retained stream entries on every startup.
  // ZADD by stream id is idempotent, so this cannot overwrite or double-count
  // entries written concurrently by another node during a rolling restart.
  {
    const allEntries = await redis.xrange(streamKey, "-", "+");
    if (allEntries.length > 0) {
      const touchedEvents = new Map<string, number>();
      const transaction = redis.multi();
      for (const [id, fieldValues] of allEntries) {
        const fields = parseStreamFields(fieldValues);
        const eventName = fields.event;
        const timestamp = fields.timestamp;
        if (!eventName || !timestamp) continue;
        if (!isWindowIndexedEvent(eventName)) continue;
        const ts = Date.parse(timestamp);
        if (!Number.isFinite(ts)) continue;
        transaction.zadd(
          eventWindowIndexKey(windowIndexKeyPrefix, eventName),
          String(ts),
          id,
        );
        touchedEvents.set(
          eventName,
          Math.max(
            touchedEvents.get(eventName) ?? Number.NEGATIVE_INFINITY,
            ts,
          ),
        );
      }
      if (touchedEvents.size > 0) {
        await transaction.exec();
        await Promise.all(
          Array.from(touchedEvents, ([eventName, timestampMs]) =>
            pruneEventWindowIndexIfNeeded(eventName, timestampMs),
          ),
        );
      }
    }
  }

  async function pruneEventWindowIndexIfNeeded(
    eventName: string,
    currentTimestampMs: number,
  ) {
    if (!Number.isFinite(currentTimestampMs)) {
      return;
    }
    const retentionReferenceMs =
      retentionReferenceTimestamp(currentTimestampMs);
    const currentMinute = Math.floor(retentionReferenceMs / MINUTE_MS);
    if (lastPrunedMinuteByEvent.get(eventName) === currentMinute) {
      return;
    }
    lastPrunedMinuteByEvent.set(eventName, currentMinute);
    const oldestKeptMs = retentionReferenceMs - WINDOW_RETENTION_MS;
    await redis.zremrangebyscore(
      eventWindowIndexKey(windowIndexKeyPrefix, eventName),
      "-inf",
      `(${oldestKeptMs}`,
    );
  }

  /**
   * Read-your-writes, best effort.
   *
   * The reason it is only best effort: the chain is the write path, and joining
   * it unconditionally is what made every admin read hang for exactly as long
   * as Redis was hung — the read had no stake in those writes beyond seeing
   * them, and under a stall it would not have seen them by waiting anyway.
   */
  async function settleQueuedAppendsForRead(): Promise<void> {
    await settleWithin(pendingAppend, readSettleTimeoutMs);
  }

  /** Every Redis command one event costs, as one promise for the cap to race. */
  async function performAppendWrite(
    input: GlobalEventStoreAppendInput,
    timestamp: string,
    details: string,
    runtimeEvent: RuntimeEvent,
  ): Promise<RuntimeEvent> {
    const streamId = await redis.xadd(
      streamKey,
      "*",
      "event",
      input.event,
      "timestamp",
      timestamp,
      "roomCode",
      encodeNullable(
        typeof input.data.roomCode === "string" ? input.data.roomCode : null,
      ),
      "sessionId",
      encodeNullable(
        typeof input.data.sessionId === "string" ? input.data.sessionId : null,
      ),
      "remoteAddress",
      encodeNullable(
        typeof input.data.remoteAddress === "string"
          ? input.data.remoteAddress
          : null,
      ),
      "origin",
      encodeNullable(
        typeof input.data.origin === "string" ? input.data.origin : null,
      ),
      "result",
      encodeNullable(
        typeof input.data.result === "string" ? input.data.result : null,
      ),
      "details",
      details,
    );
    if (!streamId) {
      throw new Error("Redis did not return a stream id for appended event.");
    }
    const timestampMs = Date.parse(timestamp);
    const writeOperations: Promise<unknown>[] = [
      redis.xtrim(streamKey, "MAXLEN", "=", maxLen),
      redis.hincrby(countsKey, input.event, 1),
    ];
    const shouldIndexWindow = isWindowIndexedEvent(input.event);
    if (shouldIndexWindow && Number.isFinite(timestampMs)) {
      writeOperations.push(
        redis.zadd(
          eventWindowIndexKey(windowIndexKeyPrefix, input.event),
          String(timestampMs),
          streamId,
        ),
      );
    }
    await Promise.all(writeOperations);
    if (shouldIndexWindow) {
      await pruneEventWindowIndexIfNeeded(input.event, timestampMs);
    }

    return {
      ...runtimeEvent,
      id: streamId,
    } satisfies RuntimeEvent;
  }

  async function writeEvent(
    input: GlobalEventStoreAppendInput,
    timestamp: string,
    details: string,
    runtimeEvent: RuntimeEvent,
  ): Promise<RuntimeEvent> {
    const call = performAppendWrite(input, timestamp, details, runtimeEvent);
    try {
      return await pacer.capAttempt(
        call,
        appendTimeoutMs,
        () => new EventStoreAppendTimeoutError(appendTimeoutMs),
      );
    } catch (error) {
      if (!(error instanceof EventStoreAppendTimeoutError)) {
        throw error;
      }
      // The commands are still on the connection and nothing can cancel them.
      // So the chain does NOT move on — running the next event's XADD on top
      // would leave two writes outstanding against a dependency that has
      // answered neither, and would land them out of order if it recovered.
      // What changes is only that `append` stops queueing behind this write.
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

  async function queryEvents(
    query: GlobalEventStoreQuery,
  ): Promise<GlobalEventStoreQueryResult> {
    await settleQueuedAppendsForRead();
    const rawEntries = await redis.xrevrange(streamKey, "+", "-");
    const parsedEvents = rawEntries
      .map(([id, fieldValues]) => {
        const fields: Record<string, string> = {};
        for (let index = 0; index < fieldValues.length; index += 2) {
          const key = fieldValues[index];
          const value = fieldValues[index + 1];
          if (key !== undefined && value !== undefined) {
            fields[key] = value;
          }
        }
        return parseEvent(id, fields);
      })
      .filter((event): event is RuntimeEvent => event !== null)
      .filter((event) => matchesQuery(event, query));

    const start = (query.page - 1) * query.pageSize;
    return {
      items: parsedEvents.slice(start, start + query.pageSize),
      total: parsedEvents.length,
    };
  }

  return {
    append(input: GlobalEventStoreAppendInput) {
      const timestamp = input.timestamp ?? new Date().toISOString();
      const details = JSON.stringify(input.data);
      const runtimeEvent: RuntimeEvent = {
        id: randomUUID(),
        timestamp,
        event: input.event,
        roomCode:
          typeof input.data.roomCode === "string" ? input.data.roomCode : null,
        sessionId:
          typeof input.data.sessionId === "string"
            ? input.data.sessionId
            : null,
        remoteAddress:
          typeof input.data.remoteAddress === "string"
            ? input.data.remoteAddress
            : null,
        origin:
          typeof input.data.origin === "string" ? input.data.origin : null,
        result:
          typeof input.data.result === "string" ? input.data.result : null,
        details: { ...input.data },
      };

      // A dropped event still answers with the record the caller built. The
      // caller is the structured logger, which turns a rejection into one
      // `runtime_event_append_failed` line on stdout — so rejecting here would
      // answer a Redis stall with one error line per log line, on the exact
      // path already established to be overloaded. Drops are reported in
      // aggregate instead, by `shedAppend`.
      if (closing) {
        return Promise.resolve(runtimeEvent);
      }
      if (writeIsStalled) {
        shedAppend("stalled");
        return Promise.resolve(runtimeEvent);
      }
      if (queuedAppends >= maxPendingAppends) {
        // Redis is answering, just slower than events arrive. Nothing else
        // would ever stop this queue growing: the per-write cap never fires
        // while every write eventually lands.
        shedAppend("overflow");
        return Promise.resolve(runtimeEvent);
      }

      queuedAppends += 1;
      const appendPromise = pendingAppend.then(async () => {
        let landed = false;
        try {
          if (abandonQueuedAppends) {
            return runtimeEvent;
          }
          const written = await writeEvent(
            input,
            timestamp,
            details,
            runtimeEvent,
          );
          landed = true;
          return written;
        } finally {
          queuedAppends -= 1;
          // Only a write that landed. A rejection settles the queue just as
          // well but proves nothing about the store working again.
          if (landed) {
            endSheddingIfRecovered();
          }
        }
      });

      pendingAppend = appendPromise.then(
        () => undefined,
        () => undefined,
      );

      return appendPromise;
    },
    async query(query) {
      return await queryEvents(query);
    },
    async totalCountsByEvent(eventNames: readonly string[]) {
      if (eventNames.length === 0) {
        return {};
      }
      await settleQueuedAppendsForRead();
      await mergeLegacyCountsIfNeeded();
      const values = await redis.hmget(countsKey, ...eventNames);
      return Object.fromEntries(
        eventNames.map((name, i) => [
          name,
          values[i] ? parseInt(values[i], 10) : 0,
        ]),
      );
    },
    async countsByEventInWindow(
      eventNames: readonly string[],
      fromMs: number,
      toMs: number,
    ) {
      if (eventNames.length === 0) {
        return {};
      }
      await settleQueuedAppendsForRead();
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
        return Object.fromEntries(eventNames.map((name) => [name, 0]));
      }

      return Object.fromEntries(
        await Promise.all(
          eventNames.map(async (name) => {
            if (isWindowIndexedEvent(name)) {
              await pruneEventWindowIndexIfNeeded(name, toMs);
            }
            const total = await redis.zcount(
              eventWindowIndexKey(windowIndexKeyPrefix, name),
              fromMs,
              toMs,
            );
            return [name, total];
          }),
        ),
      );
    },
    async close() {
      // Blocks new appends, but deliberately not the ones already chained: on a
      // healthy shutdown the queue is a write or two deep and drains in
      // milliseconds, and dropping those would lose the shutdown's own events
      // every single time.
      closing = true;
      const drained = await settleWithin(pendingAppend, closeSettleTimeoutMs);
      let pendingWrites = 0;
      let quitTimedOut = false;
      if (!drained) {
        // Nothing that has not started may start now: the connection is about
        // to go, and ioredis answers a command issued after it with a rejection
        // — which the logger would turn into one `runtime_event_append_failed`
        // line per queued event, after shutdown reported it was done.
        abandonQueuedAppends = true;
        // Read before the socket goes, and after the wait: this is what
        // outlived the budget, and `disconnect()` rejects those commands, which
        // would settle them out of the very count that describes them.
        pendingWrites = pacer.trackedCount();
        // NOT `quit()`. `QUIT` is an ordinary command on this connection:
        // ioredis appends it to the same `commandQueue` and matches replies in
        // order, so it cannot answer before the write we just gave up on. A
        // graceful close would inherit the exact wait that was just bounded and
        // hand `close_event_store` its timeout back (#264 review). The socket
        // goes instead — there is nothing left to be graceful about.
        redis.disconnect();
      } else if (!(await settleWithin(redis.quit(), closeSettleTimeoutMs))) {
        // The chain drained, so nothing was queued ahead of `QUIT` and it
        // should have answered at once. A reply that never came is a half-open
        // socket with no write left to blame — and it just spent the whole
        // budget, which is exactly the overrun that has to be reported rather
        // than swallowed.
        quitTimedOut = true;
        redis.disconnect();
      }
      reportUnfinishedAtShutdown({ pendingWrites, quitTimedOut });
    },
  };
}
