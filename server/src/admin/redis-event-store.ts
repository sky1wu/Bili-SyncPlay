import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import type {
  GlobalEventStore,
  GlobalEventStoreAppendInput,
  GlobalEventStoreQuery,
  GlobalEventStoreQueryResult,
} from "./global-event-store.js";
import type { RuntimeEvent } from "./types.js";

const DEFAULT_EVENT_STREAM_KEY = "bsp:events";
const DEFAULT_EVENT_STREAM_MAX_LEN = 1_000;

function normalizeNullable(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function encodeNullable(value: string | null | undefined): string {
  return value ?? "";
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

function matchesQuery(
  event: RuntimeEvent,
  query: GlobalEventStoreQuery,
): boolean {
  const timestamp = eventTime(event);
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
    maxLen?: number;
  } = {},
): Promise<GlobalEventStore & { close: () => Promise<void> }> {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const streamKey = options.streamKey ?? DEFAULT_EVENT_STREAM_KEY;
  const maxLen = options.maxLen ?? DEFAULT_EVENT_STREAM_MAX_LEN;
  let closing = false;
  let pendingAppend = Promise.resolve();

  await redis.connect();

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
            typeof input.data.roomCode === "string" ? input.data.roomCode : null,
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
          throw new Error("Redis did not return a stream id for appended event.");
        }
        await redis.xtrim(streamKey, "MAXLEN", "=", maxLen);

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
    async close() {
      closing = true;
      await pendingAppend;
      await redis.quit();
    },
  };
}
