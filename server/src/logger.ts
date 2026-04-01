import type { LogEvent } from "./types.js";
import type { GlobalEventStore } from "./admin/global-event-store.js";
import type { RuntimeStore } from "./runtime-store.js";

const EVENT_STORE_EXCLUDED_EVENTS = new Set(["node_heartbeat_sent"]);

export function createStructuredLogger(
  writeLine?: (line: string) => void,
  eventStore?: GlobalEventStore,
  runtimeStore?: RuntimeStore,
): LogEvent {
  const emitLine = writeLine ?? console.log;

  return (event, data) => {
    const timestamp = new Date().toISOString();
    emitLine(JSON.stringify({ event, timestamp, ...data }));
    if (eventStore && !EVENT_STORE_EXCLUDED_EVENTS.has(event)) {
      void Promise.resolve(eventStore.append({ event, timestamp, data })).catch(
        (error: unknown) => {
          emitLine(
            JSON.stringify({
              event: "runtime_event_append_failed",
              timestamp: new Date().toISOString(),
              result: "error",
              failedEvent: event,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        },
      );
    }
    runtimeStore?.recordEvent(event, Date.parse(timestamp));
  };
}
