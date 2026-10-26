import type { LogEvent } from "../types.js";
import type { AdminSession, AuditLogQuery, AuditLogRecord } from "./types.js";

export type GlobalAuditAppendInput = {
  actor: AdminSession;
  action: string;
  targetType: AuditLogRecord["targetType"];
  targetId: string;
  request?: Record<string, unknown>;
  result: AuditLogRecord["result"];
  reason?: string;
  instanceId?: string;
  targetInstanceId?: string;
  executorInstanceId?: string;
  commandRequestId?: string;
  commandStatus?: AuditLogRecord["commandStatus"];
  commandConfirmation?: AuditLogRecord["commandConfirmation"];
  commandCode?: string;
};

export type GlobalAuditQueryResult = {
  items: AuditLogRecord[];
  total: number;
};

export type GlobalAuditStore = {
  append: (
    input: GlobalAuditAppendInput,
  ) => AuditLogRecord | Promise<AuditLogRecord>;
  query: (
    query: AuditLogQuery,
  ) => GlobalAuditQueryResult | Promise<GlobalAuditQueryResult>;
};

/**
 * Appends an audit record without letting the audit store decide the outcome
 * of the action it records.
 *
 * `.then()` defers the call so a synchronous throw is routed to `.catch()`
 * instead of escaping into the admin action's call site, and a rejection turns
 * into `admin_audit_log_append_failed` rather than a failed request: the
 * action already happened, and the store sheds by design (#267).
 */
export function appendAuditDetached(
  store: GlobalAuditStore,
  logEvent: LogEvent,
  input: GlobalAuditAppendInput,
): void {
  void Promise.resolve()
    .then(() => store.append(input))
    .catch((error: unknown) => {
      logEvent("admin_audit_log_append_failed", {
        actor: input.actor.username,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        result: "error",
        instanceId: input.instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
