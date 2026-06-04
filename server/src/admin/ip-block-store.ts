import type { IpBlockRecord } from "./types.js";
import { normalizeIpAddress } from "../ip-address.js";

export type { IpBlockRecord } from "./types.js";

export type IpBlockAddResult = {
  record: IpBlockRecord;
  created: boolean;
};

export type IpBlockStore = {
  add: (record: IpBlockRecord) => Promise<IpBlockAddResult>;
  list: () => Promise<IpBlockRecord[]>;
  get: (ip: string) => Promise<IpBlockRecord | null>;
  has: (ip: string) => Promise<boolean>;
  delete: (ip: string) => Promise<boolean>;
};

function cloneRecord(record: IpBlockRecord): IpBlockRecord {
  return {
    ...record,
    actor: record.actor ? { ...record.actor } : undefined,
  };
}

export function createInMemoryIpBlockStore(): IpBlockStore {
  const records = new Map<string, IpBlockRecord>();

  return {
    async add(record) {
      const normalizedIp = normalizeIpAddress(record.ip);
      if (!normalizedIp) {
        throw new Error("invalid_ip");
      }
      const existing = records.get(normalizedIp);
      if (existing) {
        return { record: cloneRecord(existing), created: false };
      }
      const saved = cloneRecord({ ...record, ip: normalizedIp });
      records.set(normalizedIp, saved);
      return { record: cloneRecord(saved), created: true };
    },
    async list() {
      return Array.from(records.values())
        .sort((left, right) => left.createdAt - right.createdAt)
        .map(cloneRecord);
    },
    async get(ip) {
      const normalizedIp = normalizeIpAddress(ip);
      if (!normalizedIp) {
        return null;
      }
      const record = records.get(normalizedIp);
      return record ? cloneRecord(record) : null;
    },
    async has(ip) {
      const normalizedIp = normalizeIpAddress(ip);
      return normalizedIp ? records.has(normalizedIp) : false;
    },
    async delete(ip) {
      const normalizedIp = normalizeIpAddress(ip);
      return normalizedIp ? records.delete(normalizedIp) : false;
    },
  };
}
