import assert from "node:assert/strict";
import test from "node:test";
import type {
  GlobalEventStore,
  GlobalEventStoreAppendInput,
} from "../src/admin/global-event-store.js";
import { createStructuredLogger, inferLogLevel } from "../src/logger.js";
import { createInMemoryRuntimeStore } from "../src/runtime-store.js";

function createCapturingEventStore(): {
  appendedEvents: GlobalEventStoreAppendInput[];
  store: GlobalEventStore;
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
      countsByEventInWindow() {
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

test("structured logger keeps the event store's own backpressure reports out of it", async () => {
  const writtenLines: string[] = [];
  const { appendedEvents, store } = createCapturingEventStore();
  const logger = createStructuredLogger({
    writeLine: (line) => {
      writtenLines.push(line);
    },
    eventStore: store,
  });

  logger("runtime_event_appends_dropped", {
    reason: "stalled",
    result: "error",
  });
  logger("runtime_event_appends_abandoned_at_shutdown", {
    pendingWrites: 1,
    result: "timeout",
  });
  await new Promise((resolve) => setImmediate(resolve));

  // These lines are the event store reporting on its own write queue, so
  // routing them through that queue is reflexive — and the shedding line could
  // never land anyway, since it is emitted precisely when the store is
  // shedding (#266 review).
  assert.deepEqual(appendedEvents, []);
  // Still on stdout, where an operator and the log pipeline can see them —
  // excluded from the store is not the same as silenced.
  assert.equal(writtenLines.length, 2);
});

test("structured logger throttles repeated event-store failures by diagnosis", async () => {
  const writtenLines: string[] = [];
  let clock = 1_000;
  const { store } = createCapturingEventStore();
  store.append = (input) =>
    Promise.reject(
      new Error(
        input.event === "admin_login_failed"
          ? "permission denied"
          : "Redis connection is closed",
      ),
    );
  const logger = createStructuredLogger({
    writeLine: (line) => {
      writtenLines.push(line);
    },
    eventStore: store,
    logLevel: "error",
    appendFailureNow: () => clock,
  });

  logger("room_created", { result: "ok" });
  logger("room_joined", { result: "ok" });
  logger("admin_login_failed", { result: "ok" });
  await new Promise((resolve) => setImmediate(resolve));

  // The failed event is deliberately different: keying on it would turn one
  // Redis outage back into one line per business event. A genuinely different
  // diagnosis still deserves its own first line.
  assert.deepEqual(
    writtenLines.map(
      (line) => (JSON.parse(line) as { failedEvent: string }).failedEvent,
    ),
    ["room_created", "admin_login_failed"],
  );

  clock += 59_999;
  logger("room_closed", { result: "ok" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writtenLines.length, 2);

  clock += 1;
  logger("room_closed", { result: "ok" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writtenLines.length, 3);
});

test("structured logger bounds high-cardinality append-failure diagnoses", async () => {
  const writtenLines: string[] = [];
  let clock = 1_000;
  const { store } = createCapturingEventStore();
  store.append = (input) =>
    Promise.reject(new Error(String(input.data.failureReason)));
  const logger = createStructuredLogger({
    writeLine: (line) => {
      writtenLines.push(line);
    },
    eventStore: store,
    logLevel: "error",
    appendFailureNow: () => clock,
  });

  for (let index = 0; index < 40; index += 1) {
    logger("room_created", { failureReason: `failure-${index}` });
  }
  await new Promise((resolve) => setImmediate(resolve));

  // Track 32 diagnoses independently, then let every additional diagnosis
  // share one overflow bucket. Without that second bound, an implementation
  // can avoid repeated-error spam while still holding attacker-controlled
  // error messages without a finite memory or output ceiling.
  assert.equal(writtenLines.length, 33);

  clock += 60_000;
  logger("room_created", { failureReason: "failure-40" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writtenLines.length, 34);
});

test("structured logger keeps the overflow cooldown when a tracked slot expires", async () => {
  const writtenLines: string[] = [];
  let clock = 1_000;
  const { store } = createCapturingEventStore();
  store.append = (input) =>
    Promise.reject(new Error(String(input.data.failureReason)));
  const logger = createStructuredLogger({
    writeLine: (line) => {
      writtenLines.push(line);
    },
    eventStore: store,
    logLevel: "error",
    appendFailureNow: () => clock,
  });

  logger("room_created", { failureReason: "tracked-0" });
  await new Promise((resolve) => setImmediate(resolve));
  clock = 30_000;
  for (let index = 1; index < 32; index += 1) {
    logger("room_created", { failureReason: `tracked-${index}` });
  }
  await new Promise((resolve) => setImmediate(resolve));

  clock = 31_000;
  logger("room_created", { failureReason: "overflow" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writtenLines.length, 33);

  // `tracked-0` has expired, but the shared overflow bucket is only 30s old.
  // Moving this diagnosis into the free slot must not reset that cooldown.
  clock = 61_000;
  logger("room_created", { failureReason: "overflow" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writtenLines.length, 33);

  clock = 91_000;
  logger("room_created", { failureReason: "overflow" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writtenLines.length, 34);
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

test("log level inference covers result field and event-name suffix fallbacks", () => {
  assert.equal(inferLogLevel("room_created", { result: "ok" }), "info");
  assert.equal(
    inferLogLevel("room_persist_failed", { result: "error" }),
    "error",
  );
  assert.equal(
    inferLogLevel("server_shutdown_step_failed", { result: "timeout" }),
    "error",
  );
  assert.equal(inferLogLevel("rate_limited", { result: "rejected" }), "warn");
  assert.equal(inferLogLevel("auth_failed", { result: "rejected" }), "warn");
  assert.equal(
    inferLogLevel("room_version_conflict", { result: "conflict" }),
    "warn",
  );
  assert.equal(
    inferLogLevel("ws_connection_closed", { result: "closed" }),
    "info",
  );
  // No result field: fall back to event-name suffix heuristic.
  assert.equal(inferLogLevel("ws_send_failed", {}), "error");
  assert.equal(inferLogLevel("room_event_bus_error", {}), "error");
  assert.equal(inferLogLevel("admin_room_close_rejected", {}), "warn");
  assert.equal(inferLogLevel("room_created", {}), "info");
});

test("LOG_LEVEL=warn keeps production error/warn events visible via inference", async () => {
  const writtenLines: string[] = [];
  const { appendedEvents, store } = createCapturingEventStore();
  const logger = createStructuredLogger({
    writeLine: (line) => {
      writtenLines.push(line);
    },
    eventStore: store,
    logLevel: "warn",
  });

  logger("room_created", { roomCode: "ROOM01", result: "ok" });
  logger("room_persist_failed", { result: "error", error: "disk full" });
  logger("rate_limited", { result: "rejected", messageType: "video:share" });
  logger("ws_send_failed", { error: "broken_pipe" });
  await new Promise((resolve) => setImmediate(resolve));

  const stdoutEvents = writtenLines.map(
    (line) => (JSON.parse(line) as { event: string }).event,
  );
  assert.deepEqual(stdoutEvents, [
    "room_persist_failed",
    "rate_limited",
    "ws_send_failed",
  ]);

  const storedEvents = appendedEvents.map((entry) => entry.event);
  assert.deepEqual(storedEvents, [
    "room_created",
    "room_persist_failed",
    "rate_limited",
    "ws_send_failed",
  ]);
});

test("explicit options.level overrides result-based inference", () => {
  const writtenLines: string[] = [];
  const logger = createStructuredLogger({
    writeLine: (line) => {
      writtenLines.push(line);
    },
    logLevel: "warn",
  });

  // Would infer "info" via result: "ok", but override forces "error" → still emitted at warn threshold.
  logger(
    "room_created",
    { roomCode: "ROOM01", result: "ok" },
    { level: "error" },
  );
  assert.equal(writtenLines.length, 1);
  const payload = JSON.parse(writtenLines[0]!) as { level: string };
  assert.equal(payload.level, "error");
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

test("the shedding line survives a raised log level", async () => {
  const writtenLines: string[] = [];
  const logger = createStructuredLogger({
    writeLine: (line) => {
      writtenLines.push(line);
    },
    logLevel: "warn",
  });

  // With the store excluded on purpose, stdout is the only path these have,
  // and this threshold drops anything inferred as `info`. A degradation signal
  // that a supported configuration silently deletes is not a signal.
  // No explicit level: these go through the same inference every caller uses,
  // which is where the rule has to live if bootstrap is not to be the only
  // thing carrying it.
  logger("runtime_event_appends_dropped", {
    reason: "stalled",
    result: "error",
  });
  logger("runtime_event_appends_abandoned_at_shutdown", {
    pendingWrites: 1,
    result: "timeout",
  });

  assert.equal(writtenLines.length, 2);
  assert.match(
    writtenLines[1] ?? "",
    /runtime_event_appends_abandoned_at_shutdown/,
  );
});

test("backpressure lines infer error level, whatever satisfies it", () => {
  // Asserted as the requirement, not as the mechanism: excluded from the event
  // store on purpose, stdout is all these have, and `LOG_LEVEL=warn` deletes
  // anything inferred as `info` (#266 review). Today their `result` already
  // means error; if a future line's does not, this is what says so.
  assert.equal(
    inferLogLevel("runtime_event_appends_dropped", { result: "error" }),
    "error",
  );
  assert.equal(
    inferLogLevel("runtime_event_appends_abandoned_at_shutdown", {
      result: "timeout",
    }),
    "error",
  );
});

test("both shutdown outcomes infer error, under the result each one deserves", () => {
  // `failed` is a `QUIT` that came back an error; `timed_out` and `skipped` are
  // budgets running out. A query aggregating on `result` would file the two
  // under one diagnosis if the field were hardcoded (#266 review).
  assert.equal(
    inferLogLevel("runtime_event_appends_abandoned_at_shutdown", {
      result: "error",
    }),
    "error",
  );
  assert.equal(
    inferLogLevel("runtime_event_appends_abandoned_at_shutdown", {
      result: "timeout",
    }),
    "error",
  );
});

test("every append failure moves the counter, not just the ones that get a line", async () => {
  const writtenLines: string[] = [];
  const recordedEvents: string[] = [];
  const clock = 1_000;
  const { store } = createCapturingEventStore();
  store.append = () => Promise.reject(new Error("Redis connection is closed"));
  const logger = createStructuredLogger({
    writeLine: (line) => {
      writtenLines.push(line);
    },
    eventStore: store,
    logLevel: "error",
    appendFailureNow: () => clock,
    metricsCollector: {
      recordEvent: (event) => {
        recordedEvents.push(event);
      },
    },
  });

  for (let index = 0; index < 5; index += 1) {
    logger("room_created", { result: "ok" });
  }
  await new Promise((resolve) => setImmediate(resolve));

  // One line for five failures — which is the point of the throttle, and also
  // why the magnitude has to live somewhere else. Without the counter an
  // operator cannot tell five rejections from five million, and the runbook's
  // own rule is that "how much" is the metric's question (#268 review).
  assert.equal(writtenLines.length, 1);
  assert.equal(
    recordedEvents.filter((event) => event === "runtime_event_append_failed")
      .length,
    5,
  );
});
