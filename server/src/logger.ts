import type { LogEvent, LogLevel } from "./types.js";
import type { GlobalEventStore } from "./admin/global-event-store.js";
import type { MetricsCollector } from "./admin/metrics.js";
import type { RuntimeStore } from "./runtime-store.js";

/**
 * The event store reporting on its own write queue. Two rules, one list,
 * because they have one reason (#266 review).
 *
 * **Never into the event store.** Routing them through the queue they describe
 * is reflexive: the report competes for the capacity it is reporting about — a
 * resumed line takes the slot that just freed, which puts the store one event
 * away from shedding again and yields a resumed/dropped pair per completed
 * write at a steady overload. The dropped line could never land anyway; it is
 * emitted precisely when the store is shedding.
 *
 * **Always `error`.** Not a severity claim about a recovery, a routing one:
 * these lines bracket an incident, and the pair has to survive the same
 * `LOG_LEVEL`. `result: "ok"` on the closing line infers `info`, which
 * `LOG_LEVEL=warn` drops from stdout — and with the store excluded above, that
 * left it no output path at all while the opening line stayed visible. A pair
 * where only the start survives reads as an incident that never ended, which is
 * the exact failure this whole area exists to prevent.
 */
const EVENT_STORE_BACKPRESSURE_EVENTS = new Set([
  "runtime_event_appends_abandoned_at_shutdown",
  "runtime_event_appends_dropped",
  "runtime_event_appends_resumed",
]);

/** Excluded for volume rather than for reflexivity. */
const HIGH_VOLUME_EXCLUDED_EVENTS = new Set(["node_heartbeat_sent"]);

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
  // Before the result map, which would call the closing line `info` and let a
  // raised threshold drop it. See EVENT_STORE_BACKPRESSURE_EVENTS.
  if (EVENT_STORE_BACKPRESSURE_EVENTS.has(event)) {
    return "error";
  }
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
  } = options;

  const threshold = LEVEL_PRIORITY[logLevel];
  const sampleCounters = new Map<string, number>();
  const emitLine = (line: string) => {
    (writeLine ?? console.log)(line);
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
          emitLine(
            JSON.stringify({
              event: "runtime_event_append_failed",
              level: "error" satisfies LogLevel,
              timestamp: new Date().toISOString(),
              result: "error",
              failedEvent: event,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        });
    }
    runtimeStore?.recordEvent(event, Date.parse(timestamp));
    metricsCollector?.recordEvent(event);
  };
}
