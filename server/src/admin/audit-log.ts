import { randomUUID } from "node:crypto";
import type { AdminSession, AuditLogQuery, AuditLogRecord } from "./types.js";
import type { GlobalAuditStore } from "./global-audit-store.js";

export type AuditLogService = GlobalAuditStore;

export function createAuditLogService(capacity = 1_000): AuditLogService {
  const records: AuditLogRecord[] = [];

  function recordTime(record: AuditLogRecord): number {
    return Date.parse(record.timestamp);
  }

  return {
    async append(input) {
      const record: AuditLogRecord = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        actor: {
          adminId: input.actor.adminId,
          username: input.actor.username,
          role: input.actor.role,
        },
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        request: input.request ?? {},
        result: input.result,
        reason: input.reason,
        instanceId: input.instanceId,
      };

      records.push(record);
      if (records.length > capacity) {
        records.shift();
      }
      return record;
    },
    async query(query) {
      const filtered = records.filter((record) => {
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
      });

      filtered.sort((left, right) => recordTime(right) - recordTime(left));
      const start = (query.page - 1) * query.pageSize;
      return {
        items: filtered.slice(start, start + query.pageSize),
        total: filtered.length,
      };
    },
  };
}
