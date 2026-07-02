import type { RuntimeEvent } from "./types.js";

// Only these events get a windowed timestamp index. Indexing every logged
// event retained 24h of per-message system events (room_event_published /
// room_event_consumed arrive on every playback heartbeat) in Redis or the
// Node heap for windows no query ever reads — the admin overview is the
// only windowed-count consumer and it reads exactly these names.
export const WINDOW_INDEXED_EVENTS = [
  "room_created",
  "room_joined",
  "rate_limited",
  "ws_connection_rejected",
] as const;

export type WindowIndexedEventName = (typeof WINDOW_INDEXED_EVENTS)[number];

const windowIndexedEventNames: ReadonlySet<string> = new Set(
  WINDOW_INDEXED_EVENTS,
);

export function isWindowIndexedEvent(eventName: string): boolean {
  return windowIndexedEventNames.has(eventName);
}

export type GlobalEventStoreQuery = {
  event?: string;
  roomCode?: string;
  sessionId?: string;
  remoteAddress?: string;
  origin?: string;
  result?: string;
  includeSystem?: boolean;
  from?: number;
  to?: number;
  page: number;
  pageSize: number;
};

export type GlobalEventStoreQueryResult = {
  items: RuntimeEvent[];
  total: number;
};

export type GlobalEventStoreAppendInput = {
  event: string;
  timestamp?: string;
  data: Record<string, unknown>;
};

export type GlobalEventStore = {
  append: (
    input: GlobalEventStoreAppendInput,
  ) => RuntimeEvent | Promise<RuntimeEvent>;
  query: (
    query: GlobalEventStoreQuery,
  ) => GlobalEventStoreQueryResult | Promise<GlobalEventStoreQueryResult>;
  totalCountsByEvent: (
    eventNames: readonly string[],
  ) => Record<string, number> | Promise<Record<string, number>>;
  countsByEventInWindow: (
    eventNames: readonly string[],
    fromMs: number,
    toMs: number,
  ) => Record<string, number> | Promise<Record<string, number>>;
};
