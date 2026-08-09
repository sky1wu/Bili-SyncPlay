import type { LogEvent, LogLevel } from "./types.js";
import type { GlobalEventStore } from "./admin/global-event-store.js";
import type { MetricsCollector } from "./admin/metrics.js";
import type { RuntimeStore } from "./runtime-store.js";

/**
 * The event store reporting on its own write queue, which must never go INTO
 * the event store: routing a report through the queue it describes is
 * reflexive — it would compete for the capacity it is reporting about — and the
 * shedding line could never land anyway, since it is emitted precisely when the
 * store is shedding (#266 review).
 *
 * With the store excluded, stdout is the only path these have, so both must
 * infer `error`: `LOG_LEVEL=warn` deletes anything inferred as `info`, and a
 * degradation signal a supported configuration silently deletes is not a
 * signal. Both carry a `result` that already means `error`
 * (`"error"`/`"timeout"`), so no special case is needed here — but the
 * requirement is real, and `logger.test.ts` asserts it rather than the
 * mechanism that happens to satisfy it.
 */
const EVENT_STORE_BACKPRESSURE_EVENTS = new Set([
  "runtime_event_appends_abandoned_at_shutdown",
  "runtime_event_appends_dropped",
]);

/** Excluded for volume rather than for reflexivity. */
const HIGH_VOLUME_EXCLUDED_EVENTS = new Set(["node_heartbeat_sent"]);

/**
 * An event-store outage is one failure no matter how many log lines happen
 * while it lasts. Reporting every rejected append turns the logger into an
 * error-line amplifier, so repeat diagnoses get one line per minute (#268).
 */
const APPEND_FAILURE_REPORT_INTERVAL_MS = 60_000;

/**
 * Failure messages come from an implementation outside the logger and are not
 * necessarily a finite vocabulary. Keep the throttle itself bounded too: once
 * this many diagnoses are live, new ones share one overflow bucket.
 */
const MAX_TRACKED_APPEND_FAILURE_REASONS = 32;

function isExcludedFromEventStore(event: string): boolean {
  return (
    HIGH_VOLUME_EXCLUDED_EVENTS.has(event) ||
    EVENT_STORE_BACKPRESSURE_EVENTS.has(event)
  );
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_BY_RESULT: Record<string, LogLevel> = {
  ok: "info",
  closed: "info",
  ignored: "info",
  conflict: "warn",
  rate_limited: "warn",
  rejected: "warn",
  error: "error",
  timeout: "error",
};

export function inferLogLevel(
  event: string,
  data: Record<string, unknown>,
): LogLevel {
  const result = data.result;
  if (typeof result === "string") {
    const mapped = LEVEL_BY_RESULT[result];
    if (mapped) {
      return mapped;
    }
  }
  if (event.endsWith("_failed") || event.endsWith("_error")) {
    return "error";
  }
  if (event.endsWith("_rejected")) {
    return "warn";
  }
  return "info";
}

export const DEFAULT_EVENT_SAMPLING: Readonly<Record<string, number>> =
  Object.freeze({
    sync_ping: 10,
  });

export type StructuredLoggerOptions = {
  writeLine?: (line: string) => void;
  eventStore?: GlobalEventStore;
  runtimeStore?: RuntimeStore;
  metricsCollector?: Pick<MetricsCollector, "recordEvent">;
  logLevel?: LogLevel;
  sampling?: Record<string, number>;
  /** Injectable monotonic clock for append-failure throttle tests. */
  appendFailureNow?: () => number;
};

export function createStructuredLogger(
  options: StructuredLoggerOptions = {},
): LogEvent {
  const {
    writeLine,
    eventStore,
    runtimeStore,
    metricsCollector,
    logLevel = "info",
    sampling = {},
    appendFailureNow = () => performance.now(),
  } = options;

  const threshold = LEVEL_PRIORITY[logLevel];
  const sampleCounters = new Map<string, number>();
  const lastAppendFailureReportAtByReason = new Map<string, number>();
  let lastUntrackedAppendFailureReportAt: number | undefined;
  const emitLine = (line: string) => {
    (writeLine ?? console.log)(line);
  };

  const reportAppendFailure = (failedEvent: string, error: unknown): void => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const reason =
      error instanceof Error ? `${error.name}:${errorMessage}` : errorMessage;
    const at = appendFailureNow();

    for (const [
      trackedReason,
      lastReportedAt,
    ] of lastAppendFailureReportAtByReason) {
      if (at - lastReportedAt >= APPEND_FAILURE_REPORT_INTERVAL_MS) {
        lastAppendFailureReportAtByReason.delete(trackedReason);
      }
    }

    const lastReportedAt = lastAppendFailureReportAtByReason.get(reason);
    if (lastReportedAt !== undefined) {
      return;
    }

    // Once high-cardinality failures have spilled into the shared bucket, its
    // cooldown applies to every diagnosis that was not already tracked. An old
    // tracked slot can expire before the bucket does; promoting an overflow
    // diagnosis into that newly free slot would otherwise print it twice inside
    // one minute (#268 review).
    if (
      lastUntrackedAppendFailureReportAt !== undefined &&
      at - lastUntrackedAppendFailureReportAt <
        APPEND_FAILURE_REPORT_INTERVAL_MS
    ) {
      return;
    }

    if (
      lastAppendFailureReportAtByReason.size >=
      MAX_TRACKED_APPEND_FAILURE_REASONS
    ) {
      lastUntrackedAppendFailureReportAt = at;
    } else {
      lastAppendFailureReportAtByReason.set(reason, at);
    }

    emitLine(
      JSON.stringify({
        event: "runtime_event_append_failed",
        level: "error" satisfies LogLevel,
        timestamp: new Date().toISOString(),
        result: "error",
        failedEvent,
        error: errorMessage,
      }),
    );
  };

  return (event, data, eventOptions) => {
    const level: LogLevel = eventOptions?.level ?? inferLogLevel(event, data);
    const timestamp = new Date().toISOString();
    const payload = { event, level, timestamp, ...data };

    const levelPassesThreshold =
      level === "error" || LEVEL_PRIORITY[level] >= threshold;

    let shouldWriteStdout = levelPassesThreshold;
    if (levelPassesThreshold && level !== "error") {
      const sampleRate = sampling[event];
      if (typeof sampleRate === "number" && sampleRate > 1) {
        const nextCounter = (sampleCounters.get(event) ?? 0) + 1;
        sampleCounters.set(event, nextCounter);
        shouldWriteStdout = (nextCounter - 1) % sampleRate === 0;
      }
    }

    if (shouldWriteStdout) {
      emitLine(JSON.stringify(payload));
    }

    if (eventStore && !isExcludedFromEventStore(event)) {
      // .then() defers the append call so a synchronous throw is routed to
      // .catch() instead of escaping into the logging call site.
      void Promise.resolve()
        .then(() =>
          eventStore.append({ event, timestamp, data: { level, ...data } }),
        )
        .catch((error: unknown) => {
          reportAppendFailure(event, error);
        });
    }
    runtimeStore?.recordEvent(event, Date.parse(timestamp));
    metricsCollector?.recordEvent(event);
  };
}
