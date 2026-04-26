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
