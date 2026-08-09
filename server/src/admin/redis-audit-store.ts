import {
  connectWithin,
  createBoundedRedisClient,
} from "../redis-command-timeout.js";
import {
  createAppendChain,
  type AppendChainCloseReport,
  type AppendChainRefusal,
} from "./append-chain.js";
import type {
  GlobalAuditAppendInput,
  GlobalAuditQueryResult,
  GlobalAuditStore,
} from "./global-audit-store.js";
import type { AuditLogQuery, AuditLogRecord } from "./types.js";

const DEFAULT_AUDIT_STREAM_KEY = "bsp:audit-logs";
const DEFAULT_AUDIT_STREAM_MAX_LEN = 1_000;

/**
 * How long ONE audit record's Redis writes may take before the store stops
 * queueing behind them.
 *
 * Same value and same reasoning as the event store's: it does not shorten the
 * write — nothing can cancel a command already on the connection — it bounds
 * the QUEUE, and it has to be long enough that ordinary Redis latency never
 * trips it, because tripping it costs a record.
 */
const APPEND_TIMEOUT_MS = 5_000;

/**
 * How many records may be waiting on the chain before the store refuses.
 *
 * Matched to the stream's own retention, as in the event store: queueing more
 * than the stream keeps buys nothing. It is the far less likely of the two
 * bounds here — the audit chain is fed by admin actions, not by every log line,
 * so a human-rate writer reaches the per-write cap long before it reaches this.
 * It stays because "unlikely at today's rate" is not a bound.
 */
const MAX_PENDING_APPENDS = 1_000;

/** How long an audit query may wait for the records queued ahead of it. */
const READ_APPEND_SETTLE_TIMEOUT_MS = 1_000;

/**
 * How long the query's own commands may take once it has been let through.
 *
 * Same backstop, same value and same reasoning as the event store's: the health
 * judgement is the head-of-connection check, and this catches the one read that
 * slips past it because the stall began after the check (#269 review).
 */
const READ_COMMAND_TIMEOUT_MS = 5_000;

/**
 * How long `close` may wait for the chain to drain, and separately for `QUIT`.
 *
 * Worst case is twice this, and it shares `close_admin_services`' default 5s
 * budget with the admin session store's own bounded close — 3s here plus 1s
 * there leaves the step a margin it did not have before, when either half could
 * spend the whole thing waiting on a Redis that never answers (#267).
 */
const CLOSE_APPEND_SETTLE_TIMEOUT_MS = 1_500;

/**
 * Why an audit operation did not happen.
 *
 * `read` is the query path; the rest are the write path, and name which bound
 * refused the record.
 */
export type AuditStoreUnavailableReason = AppendChainRefusal | "read";

const UNAVAILABLE_MESSAGES: Record<AuditStoreUnavailableReason, string> = {
  read: "Audit store is not answering; its Redis connection is stalled.",
  stalled:
    "Audit store did not record this entry: its Redis connection is stalled.",
  overflow: "Audit store did not record this entry: its write queue is full.",
  closing: "Audit store did not record this entry: it is shutting down.",
};

/**
 * The audit store could not do what was asked, and said so.
 *
 * **This is where the audit store parts company with the event store.** Both
 * sit on the same append chain and hit the same bounds, but a runtime event is
 * observability data on a self-trimming stream, so `redis-event-store` sheds it
 * and answers the caller successfully — rejecting would turn a Redis stall into
 * one stdout error line per log line, on the path already established to be
 * overloaded.
 *
 * An audit record is an accountability record. Nothing else in the system says
 * who closed a room or kicked a member, nobody may lose one on an operator's
 * behalf without saying so, and the write rate is admin actions rather than log
 * lines — several orders of magnitude lower, so one line per refusal is a cost
 * this path can pay. So the refusal is loud: `action-service.writeAudit`
 * already catches it into `admin_audit_log_append_failed`, which reaches stdout
 * unconditionally and moves
 * `bili_syncplay_events_total{event="admin_audit_log_append_failed"}` on the
 * way. That counter is why this store needs no drop counter and no throttled
 * shedding line of its own — the questions those answer for the event store
 * ("still happening?", "how much?") are already answered here, statelessly, by
 * a series that exists (#266, #267).
 */
export class AuditStoreUnavailableError extends Error {
  readonly reason: AuditStoreUnavailableReason;

  constructor(reason: AuditStoreUnavailableReason) {
    super(UNAVAILABLE_MESSAGES[reason]);
    this.name = "AuditStoreUnavailableError";
    this.reason = reason;
  }
}

/**
 * The commands this store issues, named so a test can supply a client whose
 * `xadd` never answers — the failure the whole bounded path exists for, and one
 * no reachable real Redis reproduces on demand.
 */
export type RedisAuditStoreClient = {
  connect: () => Promise<unknown>;
  quit: () => Promise<unknown>;
  /** Tears the socket down without waiting for a reply. Synchronous. */
  disconnect: () => void;
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
  xrevrange: (
    key: string,
    start: "+",
    end: "-",
  ) => Promise<Array<[string, string[]]>>;
};

export type RedisAuditStoreOptions = {
  streamKey?: string;
  maxLen?: number;
  redisClient?: RedisAuditStoreClient;
  appendTimeoutMs?: number;
  maxPendingAppends?: number;
  readSettleTimeoutMs?: number;
  readCommandTimeoutMs?: number;
  closeSettleTimeoutMs?: number;
  /**
   * `close` finished with something unfinished — records still on the wire, or
   * a `QUIT` that did not work. The one degraded-shutdown signal, and the only
   * thing standing between a bounded close and a silent one: the overrun used
   * to be visible only because `close_admin_services` timed out.
   */
  onCloseUnfinished?: (report: AppendChainCloseReport) => void;
};

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
  options: RedisAuditStoreOptions = {},
): Promise<GlobalAuditStore & { close: () => Promise<void> }> {
  const redis =
    options.redisClient ??
    // Exempted for exactly the event store's reason (#271): this is the same
    // `append-chain`, and a client-side backstop would race the per-write cap
    // and erase the `writeIsStalled` evidence the read path judges on. The
    // policies differ — an audit record is refused, never shed — but that is a
    // handler choice, not a connection one.
    (createBoundedRedisClient(redisUrl, {
      bound: "caller",
      boundedBy:
        "append-chain: APPEND_TIMEOUT_MS per write, READ_COMMAND_TIMEOUT_MS per read, CLOSE_APPEND_SETTLE_TIMEOUT_MS on close",
    }) as RedisAuditStoreClient);
  const streamKey = options.streamKey ?? DEFAULT_AUDIT_STREAM_KEY;
  const maxLen = options.maxLen ?? DEFAULT_AUDIT_STREAM_MAX_LEN;
  const chain = createAppendChain({
    connection: {
      quit: () => redis.quit(),
      disconnect: () => {
        redis.disconnect();
      },
    },
    appendTimeoutMs: options.appendTimeoutMs ?? APPEND_TIMEOUT_MS,
    maxPendingAppends:
      options.maxPendingAppends ?? Math.min(maxLen, MAX_PENDING_APPENDS),
    readSettleTimeoutMs:
      options.readSettleTimeoutMs ?? READ_APPEND_SETTLE_TIMEOUT_MS,
    readCommandTimeoutMs:
      options.readCommandTimeoutMs ?? READ_COMMAND_TIMEOUT_MS,
    closeSettleTimeoutMs:
      options.closeSettleTimeoutMs ?? CLOSE_APPEND_SETTLE_TIMEOUT_MS,
    makeUnavailableError: () => new AuditStoreUnavailableError("read"),
    onCloseUnfinished: (report) => {
      options.onCloseUnfinished?.(report);
    },
  });

  // The exemption above is about the commands this store issues; the
  // handshake is not one of them, and without a `commandTimeout` it never
  // times out on a host that accepts the socket and stops there — bootstrap
  // awaits this, so the process would never start listening and never say
  // why (#271 review).
  await connectWithin(redis);

  async function writeRecord(
    input: GlobalAuditAppendInput,
    timestamp: string,
    actor: string,
    request: string,
  ): Promise<AuditLogRecord> {
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
  }

  return {
    append(input: GlobalAuditAppendInput) {
      const timestamp = new Date().toISOString();
      const actor = JSON.stringify({
        adminId: input.actor.adminId,
        username: input.actor.username,
        role: input.actor.role,
      });
      const request = JSON.stringify(input.request ?? {});

      return chain.run(() => writeRecord(input, timestamp, actor, request), {
        // Both handlers throw, which is the whole difference from the event
        // store: a record that did not land must not be answered as if it had.
        onRefused: (reason) => {
          throw new AuditStoreUnavailableError(reason);
        },
        onAbandonedAtShutdown: () => {
          throw new AuditStoreUnavailableError("closing");
        },
      });
    },
    async query(query: AuditLogQuery): Promise<GlobalAuditQueryResult> {
      // Was `await pendingAppend` — an unbounded wait on the entire write
      // queue, which is why the audit page hung for exactly as long as Redis
      // did. Now bounded on both sides: not issued at all while the connection
      // is not answering, and bounded once it is (#267, #269 review).
      const rawEntries = await chain.runRead(() =>
        redis.xrevrange(streamKey, "+", "-"),
      );
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
      await chain.close();
    },
  };
}
