import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createBoundedRedisClient } from "../src/redis-command-timeout.js";
import {
  REDIS_CONNECTION_ERROR_EVENT,
  REDIS_CONNECTION_ERROR_REPORT_INTERVAL_MS,
  logRedisConnectionErrorToStdout,
} from "../src/redis-connection-error.js";
import { createStructuredLogger } from "../src/logger.js";
import type { GlobalEventStore } from "../src/admin/global-event-store.js";
import type { LogEvent, LogEventOptions } from "../src/types.js";

const UNREACHABLE_REDIS_URL = "redis://127.0.0.1:6399/0";

type Report = {
  event: string;
  data: Record<string, unknown>;
  options?: LogEventOptions;
};

function capturingLogEvent(reports: Report[]): LogEvent {
  return (event, data, options) => {
    reports.push({ event, data, options });
  };
}

test("a connection built by the factory reports its own socket failures", () => {
  const reports: Report[] = [];
  const client = createBoundedRedisClient(
    UNREACHABLE_REDIS_URL,
    { bound: "command_timeout" },
    { component: "room_store", logEvent: capturingLogEvent(reports) },
  );

  try {
    // Exactly one: ioredis prints `[ioredis] Unhandled error event` to bare
    // stdout when a connection has none, which is how seven of nine connections
    // stayed invisible to every monitoring surface (#280).
    assert.equal(client.listenerCount("error"), 1);

    client.emit(
      "error",
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    );

    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.event, REDIS_CONNECTION_ERROR_EVENT);
    assert.equal(reports[0]?.data.component, "room_store");
    assert.equal(reports[0]?.data.code, "ECONNREFUSED");
    assert.equal(reports[0]?.data.result, "error");
  } finally {
    client.disconnect();
  }
});

test("each half of a pub/sub pair reports under its own role", async () => {
  const { createRedisPubSubClientPair } =
    await import("../src/redis-pubsub-client.js");
  const reports: Report[] = [];
  const { publisher, subscriber } = createRedisPubSubClientPair(
    UNREACHABLE_REDIS_URL,
    { bound: "command_timeout" },
    { component: "room_event_bus", logEvent: capturingLogEvent(reports) },
  );

  try {
    const failure = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    (publisher as unknown as { emit: (e: string, v: unknown) => void }).emit(
      "error",
      failure,
    );
    (subscriber as unknown as { emit: (e: string, v: unknown) => void }).emit(
      "error",
      failure,
    );

    // A pair whose publisher is refused while its subscriber is fine is a
    // different incident from both being down; one report for the pair hides it.
    assert.deepEqual(
      reports.map((report) => report.data.role),
      ["publisher", "subscriber"],
    );
  } finally {
    publisher.disconnect();
    subscriber.disconnect();
  }
});

test("a reconnect burst is one line, and every failure is still counted", () => {
  const writtenLines: string[] = [];
  const countedEvents: string[] = [];
  let clock = 1_000;
  const logger = createStructuredLogger({
    writeLine: (line) => writtenLines.push(line),
    metricsCollector: {
      recordEvent: (event) => {
        countedEvents.push(event);
      },
    },
    diagnosisNow: () => clock,
  });
  const client = createBoundedRedisClient(
    UNREACHABLE_REDIS_URL,
    { bound: "command_timeout" },
    { component: "runtime_store", logEvent: logger },
  );

  try {
    // The 2026-08-11 incident: ioredis emits one `error` per reconnect attempt,
    // nine of them inside 1.3 seconds.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      client.emit(
        "error",
        Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      );
    }

    assert.equal(writtenLines.length, 1);
    // Counted every time: a throttled counter cannot tell nine failures from
    // nine million, which is the pairing #266 established.
    assert.equal(
      countedEvents.filter((event) => event === REDIS_CONNECTION_ERROR_EVENT)
        .length,
      9,
    );

    clock += REDIS_CONNECTION_ERROR_REPORT_INTERVAL_MS;
    client.emit(
      "error",
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    );
    assert.equal(writtenLines.length, 2, "the outage is still reported later");
  } finally {
    client.disconnect();
  }
});

test("one connection's window never hides another connection or another code", () => {
  const writtenLines: string[] = [];
  const logger = createStructuredLogger({
    writeLine: (line) => writtenLines.push(line),
    diagnosisNow: () => 1_000,
  });
  const roomStore = createBoundedRedisClient(
    UNREACHABLE_REDIS_URL,
    { bound: "command_timeout" },
    { component: "room_store", logEvent: logger },
  );
  const auditStore = createBoundedRedisClient(
    UNREACHABLE_REDIS_URL,
    { bound: "command_timeout" },
    { component: "audit_store", logEvent: logger },
  );

  try {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    roomStore.emit("error", refused);
    auditStore.emit("error", refused);
    roomStore.emit(
      "error",
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    );

    assert.deepEqual(
      writtenLines.map((line) => {
        const parsed = JSON.parse(line) as { component: string; code: string };
        return `${parsed.component}:${parsed.code}`;
      }),
      [
        "room_store:ECONNREFUSED",
        "audit_store:ECONNREFUSED",
        "room_store:ECONNRESET",
      ],
    );
  } finally {
    roomStore.disconnect();
    auditStore.disconnect();
  }
});

test("the report never routes through the store it is reported over", async () => {
  const appendedEvents: string[] = [];
  const eventStore: GlobalEventStore = {
    append(input) {
      appendedEvents.push(input.event);
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
  };
  const logger = createStructuredLogger({
    writeLine: () => undefined,
    eventStore,
    diagnosisNow: () => 1_000,
  });
  const client = createBoundedRedisClient(
    UNREACHABLE_REDIS_URL,
    { bound: "command_timeout" },
    { component: "event_store", logEvent: logger },
  );

  try {
    client.emit(
      "error",
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    );
    logger("room_created", { result: "ok" });
    // Appends are deferred one microtask so a synchronous throw lands in the
    // logger's own catch; wait for that turn before judging what was appended.
    await new Promise((resolve) => setImmediate(resolve));

    // The event store is on the far side of the very transport this describes,
    // and for its own connection the append would be reflexive outright (#266).
    assert.deepEqual(appendedEvents, ["room_created"]);
  } finally {
    client.disconnect();
  }
});

test("every module that opens a connection hands it the caller's logger", () => {
  const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
  const sourceFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        sourceFiles.push(full);
      }
    }
  };
  walk(sourceRoot);

  const offenders = sourceFiles.filter((file) => {
    if (
      file.endsWith("redis-command-timeout.ts") ||
      file.endsWith("redis-pubsub-client.ts")
    ) {
      return false;
    }
    const source = readFileSync(file, "utf8");
    if (
      !source.includes("createBoundedRedisClient(") &&
      !source.includes("createRedisPubSubClientPair(")
    ) {
      return false;
    }
    // The identity says WHICH connection of WHICH node broke; the logger is
    // where the report goes. A connection missing either is a report an
    // operator cannot act on.
    return !source.includes("...options.connection");
  });

  assert.deepEqual(
    offenders.map((file) => path.relative(sourceRoot, file)),
    [],
    "a module opening its own Redis connection must pass its caller's logEvent and instanceId",
  );
});

test("a connection that fails before the logger exists still reports", () => {
  // The bootstrap opens its Redis connections BEFORE the structured logger
  // exists, so the placeholder that stands in for it decides whether an
  // unreachable Redis at startup is reported or silently dropped. Asserted on
  // the reporter the bootstrap installs for that window rather than on a whole
  // boot, which needs a Redis to fail against.
  const writtenLines: string[] = [];
  const previousLog = console.log;
  console.log = (line: string) => {
    writtenLines.push(line);
  };
  const client = createBoundedRedisClient(
    UNREACHABLE_REDIS_URL,
    { bound: "command_timeout" },
    { component: "room_store", logEvent: logRedisConnectionErrorToStdout },
  );

  try {
    client.emit(
      "error",
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    );
    const reported = writtenLines.map(
      (line) => JSON.parse(line) as { event: string; code: string },
    );
    assert.deepEqual(
      reported.map((entry) => `${entry.event}:${entry.code}`),
      [`${REDIS_CONNECTION_ERROR_EVENT}:ECONNREFUSED`],
    );
  } finally {
    console.log = previousLog;
    client.disconnect();
  }
});

test("the startup window reporter is the one bootstrap installs", () => {
  const bootstrapSource = readFileSync(
    fileURLToPath(
      new URL("../src/bootstrap/server-bootstrap.ts", import.meta.url),
    ),
    "utf8",
  );
  // The placeholder `logEvent` is a no-op until the structured logger is built,
  // and the connections are built first. Forwarding connection reports into it
  // restores exactly the silence this issue is about, so the window has its own
  // reporter that is swapped for the real logger once there is one.
  assert.ok(
    bootstrapSource.includes(
      "dependencies.logEvent ?? logRedisConnectionErrorToStdout",
    ),
    "connection reports must not start out in the no-op placeholder",
  );
  assert.ok(
    bootstrapSource.includes("connectionLogEvent = logEvent;"),
    "and must move to the real logger once it exists",
  );
});

test("every connection and code a deployment can produce keeps its own line", () => {
  const writtenLines: string[] = [];
  const logger = createStructuredLogger({
    writeLine: (line) => writtenLines.push(line),
    diagnosisNow: () => 1_000,
  });
  const components = [
    "admin_command_bus",
    "admin_session_store",
    "audit_store",
    "event_store",
    "room_event_bus",
    "room_store",
    "runtime_store",
  ] as const;
  const codes = [
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "ENOTFOUND",
    "EHOSTUNREACH",
  ];

  const clients = components.map((component) =>
    createBoundedRedisClient(
      UNREACHABLE_REDIS_URL,
      { bound: "command_timeout" },
      { component, logEvent: logger },
    ),
  );

  try {
    for (const client of clients) {
      for (const code of codes) {
        client.emit("error", Object.assign(new Error(code), { code }));
      }
    }

    // 42 distinct (connection, code) pairs inside one window. Past the tracked
    // cap they share one overflow cooldown, and the report stops saying WHICH
    // connection broke — the one thing the key exists to say.
    assert.equal(writtenLines.length, components.length * codes.length);
    assert.equal(
      new Set(
        writtenLines.map((line) => {
          const parsed = JSON.parse(line) as {
            component: string;
            code: string;
          };
          return `${parsed.component}:${parsed.code}`;
        }),
      ).size,
      components.length * codes.length,
    );
  } finally {
    for (const client of clients) {
      client.disconnect();
    }
  }
});

test("every bootstrap that builds a Redis component names its node", () => {
  // The admin services run as their own process and reach these stores through
  // a different bootstrap, so "the bootstrap wraps the logger to add the node"
  // was a per-call-site responsibility — the same shape that left seven
  // connections without a listener. Reporting is one bundled value now, so a
  // bootstrap cannot supply the logger and forget the node; what it can still
  // do is supply neither, which is what this checks (#280 review).
  const bootstrapFiles = [
    "../src/bootstrap/server-bootstrap.ts",
    "../src/bootstrap/admin-services.ts",
  ];
  const offenders: string[] = [];

  for (const relative of bootstrapFiles) {
    const source = readFileSync(
      fileURLToPath(new URL(relative, import.meta.url)),
      "utf8",
    );
    const pattern = /createRedis[A-Za-z]*\(/g;
    let match = pattern.exec(source);
    while (match !== null) {
      const start = match.index + match[0].length - 1;
      let depth = 0;
      let end = start;
      for (let index = start; index < source.length; index += 1) {
        const character = source[index];
        if (character === "(") {
          depth += 1;
        } else if (character === ")") {
          depth -= 1;
          if (depth === 0) {
            end = index;
            break;
          }
        }
      }
      const call = source.slice(start, end);
      if (!call.includes("connection:")) {
        offenders.push(`${relative}: ${match[0]}`);
      }
      match = pattern.exec(source);
    }
  }

  assert.deepEqual(offenders, []);
});

test("a connection reports which node it belongs to", () => {
  const reports: Report[] = [];
  const client = createBoundedRedisClient(
    UNREACHABLE_REDIS_URL,
    { bound: "command_timeout" },
    {
      component: "audit_store",
      instanceId: "node-b",
      logEvent: capturingLogEvent(reports),
    },
  );

  try {
    client.emit(
      "error",
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    );
    // Aggregated logs from several nodes: "the audit store's connection was
    // refused" is not actionable without saying whose.
    assert.equal(reports[0]?.data.instanceId, "node-b");
  } finally {
    client.disconnect();
  }
});
