import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import {
  createAppendChain,
  type AppendChainCloseReport,
  type AppendChainQuitOutcome,
} from "./append-chain.js";
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
 * How long the read's own commands may take once it has been let through.
 *
 * A liveness backstop, not a health judgement: the judgement is the
 * head-of-connection check, and this catches the one read that slips past it
 * because the stall began after the check and before the command. Same order
 * and same reasoning as {@link APPEND_TIMEOUT_MS} — long enough that ordinary
 * latency never trips it, short enough that the answer does not wait on Node's
 * default 300s `requestTimeout` (#269 review).
 */
const READ_COMMAND_TIMEOUT_MS = 5_000;

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

/**
 * How often a shedding line may repeat, per reason.
 *
 * The log carries FACTS, not an incident. An earlier version of this reported a
 * start and a matching end, and #266 spent four review rounds finding states
 * where the pair broke: a node whose traffic went quiet, a shutdown that
 * arrived first, a write that answered with an error, a stage change that
 * produced a second start, an end that a raised `LOG_LEVEL` filtered away. That
 * was the wrong shape — a paired span has an invariant, and nothing in a log
 * stream can enforce one, least of all in the component whose dependency is
 * broken. `maintenance-pass` gets away with it because a timer guarantees each
 * tick is discrete and completes; the append path is a caller-driven stream and
 * inherits no such guarantee. So: one throttled line saying what is happening,
 * and `bili_syncplay_event_store_appends_dropped_total` for "still happening?"
 * and "how much?", which it already answered without any state at all.
 */
const SHEDDING_REPORT_INTERVAL_MS = 60_000;

/**
 * How often the shutdown abandonment report may repeat.
 *
 * Its own constant, not {@link SHEDDING_REPORT_INTERVAL_MS}: the shedding line
 * paces a failure that can last hours, this one paces a report that only exists
 * between `close()` returning and the process leaving — bounded by the force-exit
 * watchdog. Two behaviours, two constants, even where the value agrees today.
 *
 * The value is derived from that watchdog (150s): short enough that a shutdown
 * tail which keeps losing appends says so more than once, long enough that a
 * producer logging per session cannot turn each of those log lines into an error
 * line of its own (#268 review).
 */
const CLOSE_REPORT_INTERVAL_MS = 60_000;

export type EventStoreSheddingReason = EventStoreAppendDropReason;

/**
 * A read refused because the connection is not answering.
 *
 * Refused, not attempted: a read issued now joins ioredis's command queue
 * behind a write that has already outlived its cap, never answers, and holds
 * its closure there for good. The admin console polls events and the overview
 * every 15s, so that is timer-driven growth of exactly the kind this store was
 * fixed to stop having (#266 review) — the fix cannot be a longer wait, it has
 * to be not sending the command.
 */
export class EventStoreUnavailableError extends Error {
  constructor() {
    super("Event store is not answering; its Redis connection is stalled.");
    this.name = "EventStoreUnavailableError";
  }
}

/**
 * How the graceful close went. See {@link AppendChainQuitOutcome} — three
 * outcomes, not two, because a `QUIT` that settles with a REJECTION settled
 * just fine while leaving the connection in a state nobody checked (#266
 * review).
 */
export type EventStoreQuitOutcome = AppendChainQuitOutcome;

export type EventStoreCloseReport = AppendChainCloseReport & {
  /** Appends refused because `close()` had already started. */
  closingAppends: number;
};

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
  readCommandTimeoutMs?: number;
  closeSettleTimeoutMs?: number;
  metricsCollector?: Pick<
    MetricsCollector,
    "declareEventStoreAppends" | "recordEventStoreAppendDropped"
  >;
  /** Injectable so the throttle can be tested without waiting out a minute. */
  now?: () => number;
  /**
   * The store is shedding events, for this reason.
   *
   * Throttled per reason, not paired with anything: at most one line per
   * {@link SHEDDING_REPORT_INTERVAL_MS}, so a stage change gets its own line
   * without any notion of an incident that has to be opened and closed. A line
   * per drop is out of the question — the report is itself a log line, on the
   * one path already established to be overloaded.
   *
   * Deliberately no "resumed" counterpart. Whether it is still happening and
   * how much it cost are `bili_syncplay_event_store_appends_dropped_total`'s
   * questions, and it answers them with no state to get wrong.
   */
  onAppendsDropped?: (info: { reason: EventStoreSheddingReason }) => void;
  /**
   * `close` finished with something unfinished. The one degraded-shutdown
   * signal, and the only thing standing between a bounded close and a silent
   * one — the overrun used to be visible only because the step itself timed
   * out.
   */
  onAppendsAbandonedAtShutdown?: (info: EventStoreCloseReport) => void;
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
  const now = options.now ?? Date.now;
  const readSettleTimeoutMs =
    options.readSettleTimeoutMs ?? READ_APPEND_SETTLE_TIMEOUT_MS;
  const readCommandTimeoutMs =
    options.readCommandTimeoutMs ?? READ_COMMAND_TIMEOUT_MS;
  const closeSettleTimeoutMs =
    options.closeSettleTimeoutMs ?? CLOSE_APPEND_SETTLE_TIMEOUT_MS;
  const metricsCollector = options.metricsCollector;
  let unfinishedCloseReport: AppendChainCloseReport | undefined;
  let closingAppends = 0;
  let closeFinished = false;
  let closeReportEmitted = false;
  let reportedClosingAppends = 0;
  /** Throttle only, for the repeats; nothing depends on it being right. */
  let lastCloseReportAt: number | undefined;
  const chain = createAppendChain({
    // Arrows, not the methods themselves: a test replaces `quit` after the
    // store exists, and ioredis's methods need their receiver anyway.
    connection: {
      quit: () => redis.quit(),
      disconnect: () => {
        redis.disconnect();
      },
    },
    appendTimeoutMs,
    maxPendingAppends,
    readSettleTimeoutMs,
    readCommandTimeoutMs,
    closeSettleTimeoutMs,
    makeUnavailableError: () => new EventStoreUnavailableError(),
    onCloseUnfinished: (report) => {
      unfinishedCloseReport = report;
    },
  });

  function reportCloseAbandonment(): void {
    if (!unfinishedCloseReport && closingAppends === 0) {
      return;
    }
    if (closeReportEmitted && closingAppends === reportedClosingAppends) {
      return;
    }
    // Throttled, because a producer whose own shutdown step timed out is not
    // cancelled and keeps logging: one update per late append is one error line
    // per log line, on the exact path this issue exists to stop amplifying —
    // `shedAppend`'s shape reappearing under a different event name in the
    // shutdown tail (#268 review). Each line supersedes the previous one, so a
    // process that exits inside the window reports a floor, not a wrong number.
    const at = now();
    if (
      closeReportEmitted &&
      lastCloseReportAt !== undefined &&
      at - lastCloseReportAt < CLOSE_REPORT_INTERVAL_MS
    ) {
      return;
    }
    lastCloseReportAt = at;
    closeReportEmitted = true;
    reportedClosingAppends = closingAppends;
    options.onAppendsAbandonedAtShutdown?.({
      ...(unfinishedCloseReport ?? {
        pendingWrites: 0,
        queuedAppends: 0,
        quitOutcome: "ok",
        budgetMs: closeSettleTimeoutMs,
      }),
      closingAppends,
    });
  }
  /** Throttle only. Two entries at most, and nothing depends on them being right. */
  const lastSheddingReportAtByReason = new Map<
    EventStoreSheddingReason,
    number
  >();
  const lastPrunedMinuteByEvent = new Map<string, number>();

  await redis.connect();
  // After the connection, not before it: a construction that throws leaves no
  // store behind, and a declared series with nothing feeding it is exactly the
  // permanent zero the declaration gate exists to avoid.
  metricsCollector?.declareEventStoreAppends();

  function shedAppend(reason: EventStoreSheddingReason): void {
    metricsCollector?.recordEventStoreAppendDropped(reason);
    const at = now();
    const lastReportedAt = lastSheddingReportAtByReason.get(reason);
    if (
      lastReportedAt !== undefined &&
      at - lastReportedAt < SHEDDING_REPORT_INTERVAL_MS
    ) {
      return;
    }
    // Stamped BEFORE the callback, which is a log line that comes back here as
    // another append: without this the report would re-enter and report itself.
    lastSheddingReportAtByReason.set(reason, at);
    options.onAppendsDropped?.({ reason });
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

  async function queryEvents(
    query: GlobalEventStoreQuery,
  ): Promise<GlobalEventStoreQueryResult> {
    const rawEntries = await chain.runRead(() =>
      redis.xrevrange(streamKey, "+", "-"),
    );
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

      return chain.run(
        () => performAppendWrite(input, timestamp, details, runtimeEvent),
        {
          // A dropped event still answers with the record the caller built. The
          // caller is the structured logger, which turns a rejection into a
          // `runtime_event_append_failed` line on stdout. That line is now
          // throttled, but rejecting would still make every caller handle the
          // same dependency failure. Drops are reported in aggregate instead,
          // by `shedAppend`. This is the policy half the chain deliberately
          // does not own; `redis-audit-store` chose the opposite for records
          // that may not go missing quietly.
          onRefused: (reason) => {
            // Shutdown is not a fault, and the events it loses are reported by
            // `onAppendsAbandonedAtShutdown` instead — counting them here would
            // move a metric nothing can scrape any more (the metrics server is
            // already closed) and file an orderly close under a failure reason.
            if (reason === "closing") {
              closingAppends += 1;
              // A shutdown-step timeout answers the orchestrator without
              // cancelling the real producer. If that producer logs only after
              // this store's own close step returned, there is no later "final"
              // callback to include it in; publish a cumulative update now.
              if (closeFinished) {
                reportCloseAbandonment();
              }
            } else {
              shedAppend(reason);
            }
            return runtimeEvent;
          },
          onAbandonedAtShutdown: () => runtimeEvent,
        },
      );
    },
    async query(query) {
      return await queryEvents(query);
    },
    async totalCountsByEvent(eventNames: readonly string[]) {
      if (eventNames.length === 0) {
        return {};
      }
      // The whole read, not just the last command: `mergeLegacyCountsIfNeeded`
      // is an `EVAL` on this same connection and hangs exactly as readily.
      const values = await chain.runRead(async () => {
        await mergeLegacyCountsIfNeeded();
        return await redis.hmget(countsKey, ...eventNames);
      });
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
      return Object.fromEntries(
        await chain.runRead(async () => {
          if (
            !Number.isFinite(fromMs) ||
            !Number.isFinite(toMs) ||
            fromMs > toMs
          ) {
            return eventNames.map((name) => [name, 0] as const);
          }
          return await Promise.all(
            eventNames.map(async (name) => {
              // A ZREMRANGEBYSCORE, on the read path and on this connection —
              // inside the bound with everything else it is queued behind.
              if (isWindowIndexedEvent(name)) {
                await pruneEventWindowIndexIfNeeded(name, toMs);
              }
              const total = await redis.zcount(
                eventWindowIndexKey(windowIndexKeyPrefix, name),
                fromMs,
                toMs,
              );
              return [name, total] as const;
            }),
          );
        }),
      );
    },
    async close() {
      await chain.close();
      closeFinished = true;
      reportCloseAbandonment();
    },
  };
}
