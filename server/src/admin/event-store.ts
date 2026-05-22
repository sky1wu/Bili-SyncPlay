import { randomUUID } from "node:crypto";
import { shouldIncludeRuntimeEvent } from "./event-visibility.js";
import type { RuntimeEvent } from "./types.js";
import type {
  GlobalEventStore,
  GlobalEventStoreQuery,
} from "./global-event-store.js";

export type EventStore = GlobalEventStore;
export type EventStoreQuery = GlobalEventStoreQuery;

const MINUTE_MS = 60_000;
const WINDOW_RETENTION_MS = 24 * 60 * 60_000;
const FUTURE_TIMESTAMP_PRUNE_GRACE_MS = 5 * 60_000;

type TimestampCount = {
  timestampMs: number;
  count: number;
};

function lowerBoundTimestamp(
  entries: readonly TimestampCount[],
  timestampMs: number,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (entries[mid].timestampMs < timestampMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function pruneTimestampEntries(
  entries: TimestampCount[],
  oldestKeptMs: number,
): void {
  const firstKeptIndex = lowerBoundTimestamp(entries, oldestKeptMs);
  if (firstKeptIndex > 0) {
    entries.splice(0, firstKeptIndex);
  }
}

function countTimestampEntriesInWindow(
  entries: readonly TimestampCount[],
  fromMs: number,
  toMs: number,
): number {
  let total = 0;
  for (
    let index = lowerBoundTimestamp(entries, fromMs);
    index < entries.length && entries[index].timestampMs <= toMs;
    index += 1
  ) {
    total += entries[index].count;
  }
  return total;
}

function retentionReferenceTimestamp(timestampMs: number): number {
  const nowMs = Date.now();
  return timestampMs > nowMs + FUTURE_TIMESTAMP_PRUNE_GRACE_MS
    ? nowMs
    : timestampMs;
}

export function createEventStore(capacity = 1_000): EventStore {
  const events: RuntimeEvent[] = [];
  const cumulativeCounts = new Map<string, number>();
  const windowEventTimes = new Map<string, TimestampCount[]>();
  let latestWindowTimestampMs = Number.NEGATIVE_INFINITY;
  let lastPrunedMinute: number | null = null;

  function eventTime(event: RuntimeEvent): number {
    return Date.parse(event.timestamp);
  }

  function pruneWindowEventTimesIfNeeded(currentTimestampMs: number): void {
    const currentMinute = Math.floor(currentTimestampMs / MINUTE_MS);
    if (lastPrunedMinute === currentMinute) {
      return;
    }
    lastPrunedMinute = currentMinute;
    const oldestKeptMs = currentTimestampMs - WINDOW_RETENTION_MS;
    for (const [eventName, entries] of windowEventTimes) {
      pruneTimestampEntries(entries, oldestKeptMs);
      if (entries.length === 0) {
        windowEventTimes.delete(eventName);
      }
    }
  }

  function recordWindowEventTime(eventName: string, timestampMs: number): void {
    if (!Number.isFinite(timestampMs)) {
      return;
    }
    const retentionReferenceMs = retentionReferenceTimestamp(timestampMs);
    latestWindowTimestampMs = Math.max(
      latestWindowTimestampMs,
      retentionReferenceMs,
    );
    const oldestKeptMs = latestWindowTimestampMs - WINDOW_RETENTION_MS;
    if (timestampMs < oldestKeptMs) {
      return;
    }

    let entries = windowEventTimes.get(eventName);
    if (!entries) {
      entries = [];
      windowEventTimes.set(eventName, entries);
    }
    const index = lowerBoundTimestamp(entries, timestampMs);
    if (entries[index]?.timestampMs === timestampMs) {
      entries[index].count += 1;
    } else {
      entries.splice(index, 0, { timestampMs, count: 1 });
    }
    pruneWindowEventTimesIfNeeded(latestWindowTimestampMs);
  }

  return {
    async append(input) {
      const event: RuntimeEvent = {
        id: randomUUID(),
        timestamp: input.timestamp ?? new Date().toISOString(),
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

      events.push(event);
      cumulativeCounts.set(
        event.event,
        (cumulativeCounts.get(event.event) ?? 0) + 1,
      );
      recordWindowEventTime(event.event, eventTime(event));
      if (events.length > capacity) {
        events.shift();
      }
      return event;
    },
    async query(query) {
      const filtered = events.filter((event) => {
        const timestamp = eventTime(event);
        if (
          !shouldIncludeRuntimeEvent(event.event, query.includeSystem === true)
        ) {
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
        if (
          query.remoteAddress &&
          event.remoteAddress !== query.remoteAddress
        ) {
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
      });

      filtered.sort((left, right) => eventTime(right) - eventTime(left));
      const start = (query.page - 1) * query.pageSize;
      return {
        items: filtered.slice(start, start + query.pageSize),
        total: filtered.length,
      };
    },
    totalCountsByEvent(eventNames) {
      return Object.fromEntries(
        eventNames.map((name) => [name, cumulativeCounts.get(name) ?? 0]),
      );
    },
    countsByEventInWindow(eventNames, fromMs, toMs) {
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
        return Object.fromEntries(eventNames.map((name) => [name, 0]));
      }

      return Object.fromEntries(
        eventNames.map((name) => {
          const entries = windowEventTimes.get(name);
          if (!entries) {
            return [name, 0];
          }
          return [name, countTimestampEntriesInWindow(entries, fromMs, toMs)];
        }),
      );
    },
  };
}
