import assert from "node:assert/strict";
import test from "node:test";
import { createEventStore } from "../src/admin/event-store.js";

test("in-memory event store keeps query semantics through the global interface", async () => {
  const store = createEventStore(2);

  const created = await store.append({
    event: "room_created",
    timestamp: "2026-03-26T10:00:00.000Z",
    data: {
      roomCode: "ROOM01",
      sessionId: "session-1",
      remoteAddress: "127.0.0.1",
      origin: "chrome-extension://allowed-extension",
      result: "ok",
    },
  });
  const joined = await store.append({
    event: "room_joined",
    timestamp: "2026-03-26T10:00:01.000Z",
    data: {
      roomCode: "ROOM01",
      sessionId: "session-2",
      remoteAddress: "127.0.0.2",
      result: "ok",
    },
  });
  await store.append({
    event: "room_closed",
    timestamp: "2026-03-26T10:00:02.000Z",
    data: {
      roomCode: "ROOM02",
      sessionId: "session-3",
      result: "ok",
    },
  });

  const room01Events = await store.query({
    roomCode: "ROOM01",
    page: 1,
    pageSize: 10,
  });
  assert.equal(room01Events.total, 1);
  assert.equal(room01Events.items[0]?.id, joined.id);

  const joinedEvents = await store.query({
    event: "room_joined",
    from: Date.parse("2026-03-26T10:00:00.500Z"),
    to: Date.parse("2026-03-26T10:00:01.500Z"),
    page: 1,
    pageSize: 10,
  });
  assert.equal(joinedEvents.total, 1);
  assert.equal(joinedEvents.items[0]?.sessionId, "session-2");

  const evicted = await store.query({
    event: "room_created",
    page: 1,
    pageSize: 10,
  });
  assert.equal(evicted.total, 0);
  assert.notEqual(created.id, joined.id);
});

test("totalCountsByEvent persists counts after events are evicted from the ring buffer", async () => {
  const store = createEventStore(2);

  await store.append({
    event: "room_created",
    timestamp: "2026-03-26T10:00:00.000Z",
    data: { roomCode: "ROOM01", result: "ok" },
  });
  await store.append({
    event: "room_created",
    timestamp: "2026-03-26T10:00:01.000Z",
    data: { roomCode: "ROOM02", result: "ok" },
  });

  const midCounts = await store.totalCountsByEvent(["room_created"]);
  assert.equal(midCounts.room_created, 2);

  await store.append({
    event: "room_joined",
    timestamp: "2026-03-26T10:00:02.000Z",
    data: { roomCode: "ROOM01", result: "ok" },
  });
  await store.append({
    event: "room_joined",
    timestamp: "2026-03-26T10:00:03.000Z",
    data: { roomCode: "ROOM02", result: "ok" },
  });

  const queryResult = await store.query({
    event: "room_created",
    page: 1,
    pageSize: 10,
  });
  assert.equal(queryResult.total, 0);

  const counts = await store.totalCountsByEvent([
    "room_created",
    "room_joined",
    "nonexistent",
  ]);
  assert.equal(counts.room_created, 2);
  assert.equal(counts.room_joined, 2);
  assert.equal(counts.nonexistent, 0);
});

test("countsByEventInWindow keeps accurate counts after the ring buffer evicts old entries", async () => {
  const store = createEventStore(2);

  await store.append({
    event: "rate_limited",
    timestamp: "2026-03-26T10:00:30.000Z",
    data: { result: "blocked" },
  });
  await store.append({
    event: "rate_limited",
    timestamp: "2026-03-26T10:00:45.000Z",
    data: { result: "blocked" },
  });
  // These two evict the earlier ring-buffer entries, but the timestamp index
  // must still remember both rate_limited events from 10:00.
  await store.append({
    event: "room_joined",
    timestamp: "2026-03-26T10:05:00.000Z",
    data: { roomCode: "ROOM01", result: "ok" },
  });
  await store.append({
    event: "rate_limited",
    timestamp: "2026-03-26T10:07:00.000Z",
    data: { result: "blocked" },
  });

  const now = Date.parse("2026-03-26T10:07:30.000Z");

  const lastMinute = await store.countsByEventInWindow(
    ["rate_limited", "room_joined"],
    now - 60_000,
    now,
  );
  assert.equal(lastMinute.rate_limited, 1);
  assert.equal(lastMinute.room_joined, 0);

  const lastTenMinutes = await store.countsByEventInWindow(
    ["rate_limited", "room_joined"],
    now - 10 * 60_000,
    now,
  );
  assert.equal(lastTenMinutes.rate_limited, 3);
  assert.equal(lastTenMinutes.room_joined, 1);

  const queryResult = await store.query({
    event: "rate_limited",
    page: 1,
    pageSize: 10,
  });
  assert.equal(queryResult.total, 1);
});

test("countsByEventInWindow stays ms-accurate after boundary entries leave the ring buffer", async () => {
  const store = createEventStore(1);

  await store.append({
    event: "rate_limited",
    timestamp: "2026-03-26T10:06:15.000Z",
    data: { result: "blocked" },
  });
  await store.append({
    event: "rate_limited",
    timestamp: "2026-03-26T10:06:45.000Z",
    data: { result: "blocked" },
  });
  await store.append({
    event: "rate_limited",
    timestamp: "2026-03-26T10:07:10.000Z",
    data: { result: "blocked" },
  });

  const now = Date.parse("2026-03-26T10:07:30.000Z");
  const lastMinute = await store.countsByEventInWindow(
    ["rate_limited"],
    now - 60_000,
    now,
  );
  assert.equal(lastMinute.rate_limited, 2);

  const queryResult = await store.query({
    event: "rate_limited",
    page: 1,
    pageSize: 10,
  });
  assert.equal(queryResult.total, 1);
});

test("countsByEventInWindow ignores far-future timestamps when pruning the window index", async () => {
  const store = createEventStore(1);
  const now = Date.now();

  await store.append({
    event: "rate_limited",
    timestamp: new Date(now - 30_000).toISOString(),
    data: { result: "blocked" },
  });
  await store.append({
    event: "rate_limited",
    timestamp: new Date(now - 10_000).toISOString(),
    data: { result: "blocked" },
  });
  await store.append({
    event: "rate_limited",
    timestamp: new Date(now + 25 * 60 * 60_000).toISOString(),
    data: { result: "blocked" },
  });
  await store.append({
    event: "rate_limited",
    timestamp: new Date(now - 5_000).toISOString(),
    data: { result: "blocked" },
  });

  const lastMinute = await store.countsByEventInWindow(
    ["rate_limited"],
    now - 60_000,
    now + 1_000,
  );
  assert.equal(lastMinute.rate_limited, 3);

  const queryResult = await store.query({
    event: "rate_limited",
    page: 1,
    pageSize: 10,
  });
  assert.equal(queryResult.total, 1);
});

test("countsByEventInWindow uses current time when pruning slightly future timestamps", async () => {
  const store = createEventStore(1);
  const now = Date.now();

  await store.append({
    event: "rate_limited",
    timestamp: new Date(now - 24 * 60 * 60_000 + 60_000).toISOString(),
    data: { result: "blocked" },
  });
  await store.append({
    event: "rate_limited",
    timestamp: new Date(now + 4 * 60_000).toISOString(),
    data: { result: "blocked" },
  });

  const lastDay = await store.countsByEventInWindow(
    ["rate_limited"],
    now - 24 * 60 * 60_000,
    now,
  );
  assert.equal(lastDay.rate_limited, 1);

  const queryResult = await store.query({
    event: "rate_limited",
    page: 1,
    pageSize: 10,
  });
  assert.equal(queryResult.total, 1);
});

test("countsByEventInWindow keeps the 24h boundary timestamp alive", async () => {
  // The 24h ms range includes an event exactly at the start boundary.
  // Retention must keep that timestamp so an inclusive query does not
  // under-count.
  const store = createEventStore();

  await store.append({
    event: "rate_limited",
    timestamp: "2026-03-26T10:00:00.000Z",
    data: { result: "blocked" },
  });
  // Exactly 24 hours later: pruning must keep the 03-26 10:00 event because
  // it sits on the inclusive lower boundary.
  await store.append({
    event: "rate_limited",
    timestamp: "2026-03-27T10:00:00.000Z",
    data: { result: "blocked" },
  });

  const now = Date.parse("2026-03-27T10:00:00.000Z");
  const lastDay = await store.countsByEventInWindow(
    ["rate_limited"],
    now - 24 * 60 * 60_000,
    now,
  );
  assert.equal(lastDay.rate_limited, 2);
});

test("countsByEventInWindow drops timestamps older than the 24-hour retention", async () => {
  const store = createEventStore();

  await store.append({
    event: "rate_limited",
    timestamp: "2026-03-26T10:00:00.000Z",
    data: { result: "blocked" },
  });
  // Append something more than 24 hours later, which triggers pruning of the
  // 10:00 event from the previous day.
  await store.append({
    event: "rate_limited",
    timestamp: "2026-03-27T10:01:00.000Z",
    data: { result: "blocked" },
  });

  const now = Date.parse("2026-03-27T10:01:30.000Z");
  const lastDay = await store.countsByEventInWindow(
    ["rate_limited"],
    now - 24 * 60 * 60_000,
    now,
  );
  assert.equal(lastDay.rate_limited, 1);
});

test("in-memory event store hides system events by default and can include them on demand", async () => {
  const store = createEventStore();

  await store.append({
    event: "room_created",
    timestamp: "2026-03-26T12:00:00.000Z",
    data: { roomCode: "ROOM01", result: "ok" },
  });
  await store.append({
    event: "room_event_bus_error",
    timestamp: "2026-03-26T12:00:01.000Z",
    data: { result: "error" },
  });
  await store.append({
    event: "room_event_consumed",
    timestamp: "2026-03-26T12:00:02.000Z",
    data: { roomCode: "ROOM01", result: "ok" },
  });

  const defaultView = await store.query({
    page: 1,
    pageSize: 10,
  });
  assert.equal(defaultView.total, 1);
  assert.equal(defaultView.items[0]?.event, "room_created");

  const fullView = await store.query({
    includeSystem: true,
    page: 1,
    pageSize: 10,
  });
  assert.equal(fullView.total, 3);
});

test("countsByEventInWindow only indexes allowlisted events while totals count everything", async () => {
  const store = createEventStore();
  const base = Date.parse("2026-03-26T12:00:00.000Z");

  await store.append({
    event: "room_event_published",
    timestamp: new Date(base).toISOString(),
    data: { roomCode: "ROOM01", result: "ok" },
  });
  await store.append({
    event: "room_created",
    timestamp: new Date(base).toISOString(),
    data: { roomCode: "ROOM01", result: "ok" },
  });

  const counts = await store.countsByEventInWindow(
    ["room_event_published", "room_created"],
    base - 60_000,
    base,
  );
  assert.equal(counts.room_event_published, 0);
  assert.equal(counts.room_created, 1);

  const totals = await store.totalCountsByEvent([
    "room_event_published",
    "room_created",
  ]);
  assert.equal(totals.room_event_published, 1);
  assert.equal(totals.room_created, 1);
});
