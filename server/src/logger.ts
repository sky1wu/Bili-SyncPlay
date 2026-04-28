import type { LogEvent, LogLevel } from "./types.js";
import type { GlobalEventStore } from "./admin/global-event-store.js";
import type { MetricsCollector } from "./admin/metrics.js";
import type { RuntimeStore } from "./runtime-store.js";

const EVENT_STORE_EXCLUDED_EVENTS = new Set(["node_heartbeat_sent"]);

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

    if (eventStore && !EVENT_STORE_EXCLUDED_EVENTS.has(event)) {
      void Promise.resolve(
        eventStore.append({ event, timestamp, data: { level, ...data } }),
      ).catch((error: unknown) => {
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
