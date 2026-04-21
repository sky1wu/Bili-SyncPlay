import assert from "node:assert/strict";
import test from "node:test";
import type { GlobalEventStoreAppendInput } from "../src/admin/global-event-store.js";
import type { RuntimeEvent } from "../src/admin/types.js";
import { createStructuredLogger } from "../src/logger.js";
import { createInMemoryRuntimeStore } from "../src/runtime-store.js";

function createCapturingEventStore(): {
  appendedEvents: GlobalEventStoreAppendInput[];
  store: {
    append: (input: GlobalEventStoreAppendInput) => Promise<RuntimeEvent>;
    query: () => never;
    totalCountsByEvent: () => Record<string, number>;
  };
} {
  const appendedEvents: GlobalEventStoreAppendInput[] = [];
  return {
    appendedEvents,
    store: {
      append(input) {
        appendedEvents.push(input);
        return Promise.resolve({
          id: `evt-${appendedEvents.length}`,
          timestamp: input.timestamp ?? new Date().toISOString(),
          event: input.event,
          roomCode: null,
          sessionId: null,
          remoteAddress: null,
          origin: null,
          result: null,
          details: { ...input.data },
        });
      },
      query() {
        throw new Error("query should not be called in this test");
      },
      totalCountsByEvent() {
        return {};
      },
    },
  };
}

test("structured logger excludes successful node heartbeats from event storage", async () => {
  const writtenLines: string[] = [];
  const { appendedEvents, store } = createCapturingEventStore();
  const runtimeStore = createInMemoryRuntimeStore(() => 0);
  const logger = createStructuredLogger({
    writeLine: (line) => {
      writtenLines.push(line);
    },
    eventStore: store,
    runtimeStore,
  });

  logger("node_heartbeat_sent", { instanceId: "node-1", result: "ok" });
  logger("room_created", { roomCode: "ROOM01", result: "ok" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(writtenLines.length, 2);
  assert.equal(appendedEvents.length, 1);
  assert.equal(appendedEvents[0]?.event, "room_created");
  assert.deepEqual(Object.keys(runtimeStore.getLifetimeEventCounts()), [
    "node_heartbeat_sent",
    "room_created",
  ]);
});

test("structured logger stamps default info level on emitted events", () => {
  const writtenLines: string[] = [];
  const logger = createStructuredLogger({
    writeLine: (line) => {
      writtenLines.push(line);
    },
  });

  logger("room_created", { roomCode: "ROOM01" });

  assert.equal(writtenLines.length, 1);
  const payload = JSON.parse(writtenLines[0]!) as Record<string, unknown>;
  assert.equal(payload.level, "info");
  assert.equal(payload.event, "room_created");
});

test("log level threshold suppresses lower-level events from stdout but event store still records them", async () => {
  const writtenLines: string[] = [];
  const { appendedEvents, store } = createCapturingEventStore();
  const logger = createStructuredLogger({
    writeLine: (line) => {
      writtenLines.push(line);
    },
    eventStore: store,
    logLevel: "warn",
  });

  logger("debug_event", { detail: 1 }, { level: "debug" });
  logger("info_event", { detail: 2 }, { level: "info" });
  logger("warn_event", { detail: 3 }, { level: "warn" });
  logger("error_event", { detail: 4 }, { level: "error" });
  await new Promise((resolve) => setImmediate(resolve));

  const stdoutEvents = writtenLines.map(
    (line) => (JSON.parse(line) as { event: string }).event,
  );
  assert.deepEqual(stdoutEvents, ["warn_event", "error_event"]);

  const storedEvents = appendedEvents.map((entry) => entry.event);
  assert.deepEqual(storedEvents, [
    "debug_event",
    "info_event",
    "warn_event",
    "error_event",
  ]);

  const storedLevels = appendedEvents.map((entry) => entry.data.level);
  assert.deepEqual(storedLevels, ["debug", "info", "warn", "error"]);
});

test("error-level events bypass sampling; non-error high-frequency events are sampled on stdout only", async () => {
  const writtenLines: string[] = [];
  const { appendedEvents, store } = createCapturingEventStore();
  const logger = createStructuredLogger({
    writeLine: (line) => {
      writtenLines.push(line);
    },
    eventStore: store,
    sampling: { playback_update_applied: 5 },
  });

  for (let index = 0; index < 12; index += 1) {
    logger("playback_update_applied", { seq: index });
  }
  logger(
    "playback_update_applied",
    { seq: "error-1", result: "error" },
    { level: "error" },
  );
  await new Promise((resolve) => setImmediate(resolve));

  const stdoutSeqs = writtenLines.map(
    (line) => (JSON.parse(line) as { seq: number | string }).seq,
  );
  // Sampling rate 5 => emit the 1st, 6th, 11th of the info batch, then the error.
  assert.deepEqual(stdoutSeqs, [0, 5, 10, "error-1"]);

  assert.equal(appendedEvents.length, 13);
});

test("sampling counter resets per event name and does not leak across names", () => {
  const writtenLines: string[] = [];
  const logger = createStructuredLogger({
    writeLine: (line) => {
      writtenLines.push(line);
    },
    sampling: { high_freq: 3 },
  });

  logger("high_freq", { tag: "a" });
  logger("other_event", { tag: "b" });
  logger("high_freq", { tag: "c" });
  logger("high_freq", { tag: "d" });
  logger("high_freq", { tag: "e" });

  const tags = writtenLines.map(
    (line) => (JSON.parse(line) as { tag: string }).tag,
  );
  assert.deepEqual(tags, ["a", "b", "e"]);
});
