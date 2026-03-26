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
