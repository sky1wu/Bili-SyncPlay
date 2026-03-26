import { Redis } from "ioredis";
import type {
  GlobalAuditAppendInput,
  GlobalAuditQueryResult,
  GlobalAuditStore,
} from "./global-audit-store.js";
import type { AuditLogQuery, AuditLogRecord } from "./types.js";

const DEFAULT_AUDIT_STREAM_KEY = "bsp:audit-logs";
const DEFAULT_AUDIT_STREAM_MAX_LEN = 1_000;

function normalizeNullable(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function encodeNullable(value: string | undefined): string {
  return value ?? "";
}

function parseAuditRecord(
  id: string,
  fields: Record<string, string>,
): AuditLogRecord | null {
  const timestamp = fields.timestamp;
  const action = fields.action;
  const targetType = fields.targetType;
  const targetId = fields.targetId;
  const result = fields.result;
  const actor = fields.actor;
  const request = fields.request;
  if (
    !timestamp ||
    !action ||
    !targetType ||
    !targetId ||
    !result ||
    !actor ||
    !request
  ) {
    return null;
  }

  return {
    id,
    timestamp,
    actor: JSON.parse(actor) as AuditLogRecord["actor"],
    action,
    targetType: targetType as AuditLogRecord["targetType"],
    targetId,
    request: JSON.parse(request) as Record<string, unknown>,
    result: result as AuditLogRecord["result"],
    reason: normalizeNullable(fields.reason),
    instanceId: normalizeNullable(fields.instanceId),
    targetInstanceId: normalizeNullable(fields.targetInstanceId),
    executorInstanceId: normalizeNullable(fields.executorInstanceId),
    commandRequestId: normalizeNullable(fields.commandRequestId),
    commandStatus: normalizeNullable(
      fields.commandStatus,
    ) as AuditLogRecord["commandStatus"],
    commandCode: normalizeNullable(fields.commandCode),
  };
}

function recordTime(record: AuditLogRecord): number {
  return Date.parse(record.timestamp);
}

function matchesQuery(record: AuditLogRecord, query: AuditLogQuery): boolean {
  const timestamp = recordTime(record);
  if (
    query.actor &&
    record.actor.username !== query.actor &&
    record.actor.adminId !== query.actor
  ) {
    return false;
  }
  if (query.action && record.action !== query.action) {
    return false;
  }
  if (query.targetId && record.targetId !== query.targetId) {
    return false;
  }
  if (query.targetType && record.targetType !== query.targetType) {
    return false;
  }
  if (query.result && record.result !== query.result) {
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

export async function createRedisAuditStore(
  redisUrl: string,
  options: {
    streamKey?: string;
    maxLen?: number;
  } = {},
): Promise<GlobalAuditStore & { close: () => Promise<void> }> {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const streamKey = options.streamKey ?? DEFAULT_AUDIT_STREAM_KEY;
  const maxLen = options.maxLen ?? DEFAULT_AUDIT_STREAM_MAX_LEN;
  let pendingAppend = Promise.resolve();

  await redis.connect();

  return {
    append(input: GlobalAuditAppendInput) {
      const timestamp = new Date().toISOString();
      const actor = JSON.stringify({
        adminId: input.actor.adminId,
        username: input.actor.username,
        role: input.actor.role,
      });
      const request = JSON.stringify(input.request ?? {});

      const appendPromise = pendingAppend.then(async () => {
        const streamId = await redis.xadd(
          streamKey,
          "*",
          "timestamp",
          timestamp,
          "actor",
          actor,
          "action",
          input.action,
          "targetType",
          input.targetType,
          "targetId",
          input.targetId,
          "request",
          request,
          "result",
          input.result,
          "reason",
          encodeNullable(input.reason),
          "instanceId",
          encodeNullable(input.instanceId),
          "targetInstanceId",
          encodeNullable(input.targetInstanceId),
          "executorInstanceId",
          encodeNullable(input.executorInstanceId),
          "commandRequestId",
          encodeNullable(input.commandRequestId),
          "commandStatus",
          encodeNullable(input.commandStatus),
          "commandCode",
          encodeNullable(input.commandCode),
        );
        if (!streamId) {
          throw new Error(
            "Redis did not return a stream id for appended audit log.",
          );
        }
        await redis.xtrim(streamKey, "MAXLEN", "=", maxLen);

        return {
          id: streamId,
          timestamp,
          actor: JSON.parse(actor) as AuditLogRecord["actor"],
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          request: JSON.parse(request) as Record<string, unknown>,
          result: input.result,
          reason: input.reason,
          instanceId: input.instanceId,
          targetInstanceId: input.targetInstanceId,
          executorInstanceId: input.executorInstanceId,
          commandRequestId: input.commandRequestId,
          commandStatus: input.commandStatus,
          commandCode: input.commandCode,
        } satisfies AuditLogRecord;
      });

      pendingAppend = appendPromise.then(
        () => undefined,
        () => undefined,
      );

      return appendPromise;
    },
    async query(query: AuditLogQuery): Promise<GlobalAuditQueryResult> {
      await pendingAppend;
      const rawEntries = await redis.xrevrange(streamKey, "+", "-");
      const parsedRecords = rawEntries
        .map(([id, fieldValues]) => {
          const fields: Record<string, string> = {};
          for (let index = 0; index < fieldValues.length; index += 2) {
            const key = fieldValues[index];
            const value = fieldValues[index + 1];
            if (key !== undefined && value !== undefined) {
              fields[key] = value;
            }
          }
          return parseAuditRecord(id, fields);
        })
        .filter((record): record is AuditLogRecord => record !== null)
        .filter((record) => matchesQuery(record, query));

      const start = (query.page - 1) * query.pageSize;
      return {
        items: parsedRecords.slice(start, start + query.pageSize),
        total: parsedRecords.length,
      };
    },
    async close() {
      await pendingAppend;
      await redis.quit();
    },
  };
}
