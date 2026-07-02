import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { shouldIncludeRuntimeEvent } from "./event-visibility.js";
import {
  isWindowIndexedEvent,
  type GlobalEventStore,
  type GlobalEventStoreAppendInput,
  type GlobalEventStoreQuery,
  type GlobalEventStoreQueryResult,
} from "./global-event-store.js";
import type { RuntimeEvent } from "./types.js";

const DEFAULT_EVENT_STREAM_KEY = "bsp:events";
const DEFAULT_EVENT_COUNTS_KEY = "bsp:event_counts";
const DEFAULT_EVENT_WINDOW_INDEX_KEY_PREFIX = "bsp:event_window_index";
const DEFAULT_EVENT_STREAM_MAX_LEN = 1_000;
const MINUTE_MS = 60_000;
const WINDOW_RETENTION_MS = 24 * 60 * 60_000;
const LEGACY_COUNTS_MIGRATION_SNAPSHOT_SUFFIX = ":legacy_migrated";

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

export async function createRedisEventStore(
  redisUrl: string,
  options: {
    streamKey?: string;
    countsKey?: string;
    legacyCountsKey?: string;
    windowIndexKeyPrefix?: string;
    maxLen?: number;
  } = {},
): Promise<GlobalEventStore & { close: () => Promise<void> }> {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const streamKey = options.streamKey ?? DEFAULT_EVENT_STREAM_KEY;
  const countsKey = options.countsKey ?? DEFAULT_EVENT_COUNTS_KEY;
  const legacyCountsKey =
    options.legacyCountsKey && options.legacyCountsKey !== countsKey
      ? options.legacyCountsKey
      : undefined;
  const windowIndexKeyPrefix =
    options.windowIndexKeyPrefix ?? DEFAULT_EVENT_WINDOW_INDEX_KEY_PREFIX;
  const maxLen = options.maxLen ?? DEFAULT_EVENT_STREAM_MAX_LEN;
  let closing = false;
  let pendingAppend = Promise.resolve();
  const lastPrunedMinuteByEvent = new Map<string, number>();

  await redis.connect();

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

  async function queryEvents(
    query: GlobalEventStoreQuery,
  ): Promise<GlobalEventStoreQueryResult> {
    await pendingAppend;
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

      if (closing) {
        return Promise.resolve(runtimeEvent);
      }

      const appendPromise = pendingAppend.then(async () => {
        const streamId = await redis.xadd(
          streamKey,
          "*",
          "event",
          input.event,
          "timestamp",
          timestamp,
          "roomCode",
          encodeNullable(
            typeof input.data.roomCode === "string"
              ? input.data.roomCode
              : null,
          ),
          "sessionId",
          encodeNullable(
            typeof input.data.sessionId === "string"
              ? input.data.sessionId
              : null,
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
          throw new Error(
            "Redis did not return a stream id for appended event.",
          );
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
      await pendingAppend;
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
      await pendingAppend;
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
      closing = true;
      await pendingAppend;
      await redis.quit();
    },
  };
}
