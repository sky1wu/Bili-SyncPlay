/**
 * The mechanical half of #271.
 *
 * Five issues (#261, #263, #264, #267, #270) were the same defect found by five
 * different symptoms, and each was closed when its symptom stopped rather than
 * when the property held everywhere. What no review round produced was a way to
 * notice the sixth copy before it shipped. These tests are that: a connection
 * built outside the policy module, or built without declaring what bounds its
 * commands, fails here instead of being caught by whoever reads the diff.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  connectWithin,
  createBoundedRedisClient,
  createRedisCommandAdmission,
  createStalledConnectionGuard,
  REDIS_COMMAND_TIMEOUT_MS,
  RedisConnectTimeoutError,
  RedisCommandAdmissionError,
  RedisStartupTimeoutError,
  startWithin,
} from "../src/redis-command-timeout.js";

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src",
);
const policyModule = path.join(sourceRoot, "redis-command-timeout.ts");

function collectSourceFiles(directory: string): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      collected.push(...collectSourceFiles(full));
      continue;
    }
    if (full.endsWith(".ts")) {
      collected.push(full);
    }
  }
  return collected;
}

const sourceFiles = collectSourceFiles(sourceRoot);

test("every Redis connection is built in the policy module", () => {
  // Not style. `createBoundedRedisClient` takes a REQUIRED `RedisCommandBound`,
  // so as long as this is the only constructor call, "which bound does this
  // connection have?" is a question the compiler asks. A second `new Redis`
  // anywhere makes the answer optional again, and the option's absence is
  // exactly what stayed invisible through five review rounds.
  const offenders = sourceFiles.filter(
    (file) =>
      file !== policyModule &&
      readFileSync(file, "utf8").includes("new Redis("),
  );
  assert.deepEqual(
    offenders.map((file) => path.relative(sourceRoot, file)),
    [],
    "construct Redis clients through createBoundedRedisClient (server/src/redis-command-timeout.ts)",
  );
});

test("commandTimeout is set in one place", () => {
  // The other half of the same property: a connection that takes the backstop
  // must take THE backstop. A local literal would be a second constant for the
  // same behaviour, drifting from the one the runbook documents.
  const offenders = sourceFiles.filter(
    (file) =>
      file !== policyModule &&
      readFileSync(file, "utf8").includes("commandTimeout:"),
  );
  assert.deepEqual(
    offenders.map((file) => path.relative(sourceRoot, file)),
    [],
  );
});

test("every source file that builds a connection names its bound", () => {
  // The declaration is a type, so it cannot be omitted — but it CAN be answered
  // with `caller` by someone who has not checked. This pins the current answers
  // so flipping one is a deliberate edit to a test that says why, not a
  // one-word change in a constructor call.
  const declarations = new Map<string, string[]>();
  // The policy module defines the vocabulary; it declares nothing.
  for (const file of sourceFiles.filter((file) => file !== policyModule)) {
    const source = readFileSync(file, "utf8");
    const bounds = [
      ...source.matchAll(/bound:\s*"(command_timeout|caller)"/g),
    ].map((match) => match[1] as string);
    if (bounds.length > 0) {
      declarations.set(path.relative(sourceRoot, file), bounds);
    }
  }

  assert.deepEqual(
    Object.fromEntries(
      [...declarations].sort(([a], [b]) => a.localeCompare(b)),
    ),
    {
      // Five exemptions, all for ONE reason: some caller on that connection
      // derives a bound from EVIDENCE that a command has not answered, and a
      // backstop destroys that evidence by settling it — turning the bound into
      // a rate of one more command per timeout window.
      //
      //   append chains  → `writeIsStalled` gates the read refusal (#266, #269)
      //   runtime store  → `ensurePendingCapacity` counts tracked commands (#242)
      //   room store     → `maintenance-pass`'s `stalled` for two passes (#261, #263)
      //   room event bus → `pending-resync-queue` waits on `inFlight` (#242)
      //
      // "It is already bounded" is NOT the criterion and must never be read as
      // one — when #271 was written the runtime store passed that test while
      // `trackAwaitedOperation` had no bound at all, and the room store's
      // request path had none either.
      //
      // Those two gaps are what #277 closed, and it closed them WITHOUT moving
      // a line in this table: the request paths took a caller-side cap that
      // leaves the command tracked, so every bound listed above still reads the
      // same evidence. What each connection now bounds, and the durable writes
      // still deliberately left out, is proved in
      // `redis-store-command-bounds.test.ts`.
      "admin/redis-audit-store.ts": ["caller"],
      "admin/redis-event-store.ts": ["caller"],
      "redis-room-event-bus.ts": ["caller"],
      "redis-room-store.ts": ["caller"],
      "redis-runtime-store.ts": ["caller"],
      // Three connections: one HTTP-request-scoped store, and the command bus's
      // publisher and subscriber. Nothing on either reads a command's silence.
      "redis-admin-command-bus.ts": ["command_timeout"],
      "redis-admin-session-store.ts": ["command_timeout"],
    },
  );
});

test("every command_timeout owner has submission admission and a reset guard", () => {
  const backstoppedOwners = sourceFiles.filter((file) => {
    if (file === policyModule) {
      return false;
    }
    return readFileSync(file, "utf8").includes('bound: "command_timeout"');
  });
  const offenders = backstoppedOwners.filter((file) => {
    const source = readFileSync(file, "utf8");
    return (
      !source.includes("createRedisCommandAdmission(") ||
      !source.includes("createStalledConnectionGuard(")
    );
  });

  assert.deepEqual(
    offenders.map((file) => path.relative(sourceRoot, file)),
    [],
    "a command_timeout connection must bound its first timeout window and reset its timed-out tail",
  );
});

test("a caller-bounded module opens its connection through connectWithin", () => {
  // The exemption covers the commands a store issues; the handshake is not one
  // of them, and a `caller` module that calls `connect()` directly is pending
  // forever against a host that accepts the socket and answers nothing. This is
  // the part of that fix which survives the next module: declaring `caller`
  // now obliges you to bound the handshake, mechanically (#271 review).
  const offenders = sourceFiles.filter((file) => {
    if (file === policyModule) {
      return false;
    }
    const source = readFileSync(file, "utf8");
    return (
      source.includes('bound: "caller"') && !source.includes("connectWithin(")
    );
  });
  assert.deepEqual(
    offenders.map((file) => path.relative(sourceRoot, file)),
    [],
    "a caller-bounded connection must open through connectWithin",
  );
});

test("a command_timeout client carries the backstop and a caller-bounded one does not", () => {
  const backstopped = createBoundedRedisClient("redis://127.0.0.1:6399/0", {
    bound: "command_timeout",
  });
  const callerBounded = createBoundedRedisClient("redis://127.0.0.1:6399/0", {
    bound: "caller",
    boundedBy: "a test",
  });

  try {
    assert.equal(backstopped.options.commandTimeout, REDIS_COMMAND_TIMEOUT_MS);
    assert.equal(backstopped.options.autoResendUnfulfilledCommands, false);
    assert.equal(backstopped.options.autoResubscribe, false);
    assert.equal(callerBounded.options.commandTimeout, undefined);
    assert.equal(callerBounded.options.autoResendUnfulfilledCommands, true);
    assert.equal(callerBounded.options.autoResubscribe, true);
    // Both keep the connection policy that was already shared, and neither may
    // silently acquire the OTHER meaning of "bounded": `maxRetriesPerRequest`
    // caps re-queues across reconnects and says nothing about how long an
    // accepted command may go unanswered.
    for (const client of [backstopped, callerBounded]) {
      assert.equal(client.options.lazyConnect, true);
      assert.equal(client.options.maxRetriesPerRequest, 1);
    }
  } finally {
    // `lazyConnect` means neither ever opened a socket; this only releases the
    // ioredis bookkeeping so the test process can exit.
    backstopped.disconnect();
    callerBounded.disconnect();
  }
});

test("command admission refuses before invoking ioredis past its limit", async () => {
  let releaseFirst = (): void => {};
  const firstAnswer = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const admission = createRedisCommandAdmission(1);
  const first = admission.run(async () => {
    calls += 1;
    await firstAnswer;
  });

  await assert.rejects(
    admission.run(async () => {
      calls += 1;
    }),
    RedisCommandAdmissionError,
  );
  assert.equal(calls, 1);
  assert.equal(admission.pendingCount(), 1);

  releaseFirst();
  await first;
  assert.equal(admission.pendingCount(), 0);
});

test("a caller-bounded connection still bounds its own handshake", async () => {
  // The exemption is about the commands a store issues; `connect()` is not one
  // of them. ioredis's `connectTimeout` bounds the TCP connect and not the
  // handshake that follows, and `connect()` resolves on `ready` — so against a
  // host that accepts the socket and answers nothing, an exempt connection used
  // to stay pending forever, with bootstrap awaiting it. A process that never
  // starts listening and never says why is the same silence in a new place
  // (#271 review).
  let disconnectCalls = 0;
  const connection = {
    connect: () => new Promise<void>(() => undefined),
    quit: async () => "OK",
    disconnect: () => {
      disconnectCalls += 1;
    },
  };

  const startedAt = Date.now();
  await assert.rejects(connectWithin(connection, 20), RedisConnectTimeoutError);
  assert.ok(Date.now() - startedAt < 1_000);
  // The handshake cannot be cancelled, so the socket goes: leaving it open
  // keeps a half-connected client retrying behind a process that is already
  // failing to start.
  assert.equal(disconnectCalls, 1);
});

test("a handshake that fails on its own keeps its own error", async () => {
  // Giving up and failing are different answers, and only the first is this
  // helper's to report — an operator debugging `WRONGPASS` must not be handed a
  // timeout instead.
  const authFailure = new Error("WRONGPASS invalid username-password pair");
  let disconnectCalls = 0;
  await assert.rejects(
    connectWithin(
      {
        connect: () => Promise.reject(authFailure),
        quit: async () => "OK",
        disconnect: () => {
          disconnectCalls += 1;
        },
      },
      1_000,
    ),
    (error: unknown) => error === authFailure,
  );
  assert.equal(disconnectCalls, 0);
});

test("a handshake that lands inside the budget is left alone", async () => {
  let disconnectCalls = 0;
  await connectWithin(
    {
      connect: async () => "OK",
      quit: async () => "OK",
      disconnect: () => {
        disconnectCalls += 1;
      },
    },
    1_000,
  );
  assert.equal(disconnectCalls, 0);
});

test("a connection that keeps failing is reset without replaying ioredis's queue", () => {
  // The companion every backstopped connection needs. `commandTimeout` answers
  // the caller and leaves the command in `commandQueue`. Admission bounds the
  // first timeout window; dropping the socket while auto-resend is disabled
  // retires the timed-out tail instead of carrying it across reconnects.
  const disconnects: Array<boolean | undefined> = [];
  const dropped: Array<{ consecutiveFailures: number }> = [];
  const guard = createStalledConnectionGuard(
    {
      disconnect: (reconnect) => {
        disconnects.push(reconnect);
      },
    },
    { threshold: 3, onDropped: (info) => dropped.push(info) },
  );

  assert.equal(guard.beginAttempt()?.recordFailure(), false);
  assert.equal(guard.beginAttempt()?.recordFailure(), false);
  assert.equal(guard.beginAttempt()?.recordFailure(), true);
  // `disconnect(true)`, never a bare `disconnect()`: the latter sets
  // `manuallyClosing` and retires the connection for good, which would turn a
  // reset into an outage.
  assert.deepEqual(disconnects, [true]);
  assert.deepEqual(dropped, [{ consecutiveFailures: 3 }]);
});

test("one success is enough to say the connection is alive", () => {
  // Consecutive, not cumulative. A connection returning the occasional error is
  // not a connection that stopped answering, and resetting it would cost a
  // reconnect for nothing.
  let disconnectCalls = 0;
  const guard = createStalledConnectionGuard(
    {
      disconnect: () => {
        disconnectCalls += 1;
      },
    },
    { threshold: 3 },
  );

  guard.beginAttempt()?.recordFailure();
  guard.beginAttempt()?.recordFailure();
  guard.beginAttempt()?.recordSuccess();
  guard.beginAttempt()?.recordFailure();
  guard.beginAttempt()?.recordFailure();
  assert.equal(disconnectCalls, 0);
});

test("the guard does not trip again on the wreckage of its own reset", () => {
  // Commands whose timers land alongside the threshold failure still come back
  // through `recordFailure`. Without resetting the count first, one stalled
  // batch could drop the socket repeatedly while it is being replaced.
  let disconnectCalls = 0;
  const guard = createStalledConnectionGuard(
    {
      disconnect: () => {
        disconnectCalls += 1;
      },
    },
    { threshold: 2 },
  );

  const attempts = [
    guard.beginAttempt(),
    guard.beginAttempt(),
    guard.beginAttempt(),
  ];
  attempts[0]?.recordFailure();
  assert.equal(attempts[1]?.recordFailure(), true);
  assert.equal(attempts[2]?.recordFailure(), false);
  assert.equal(disconnectCalls, 1);
});

test("late failures from a reset generation cannot drop its ready replacement", () => {
  let readyListener = (): void => {};
  let disconnectCalls = 0;
  const guard = createStalledConnectionGuard(
    {
      disconnect: () => {
        disconnectCalls += 1;
      },
      on: (_event, listener) => {
        readyListener = listener;
      },
      off: () => undefined,
    },
    { threshold: 2 },
  );
  const oldAttempts = [
    guard.beginAttempt(),
    guard.beginAttempt(),
    guard.beginAttempt(),
    guard.beginAttempt(),
  ];

  oldAttempts[0]?.recordFailure();
  assert.equal(oldAttempts[1]?.recordFailure(), true);
  assert.equal(disconnectCalls, 1);
  assert.equal(guard.beginAttempt(), null);

  readyListener();
  oldAttempts[2]?.recordFailure();
  oldAttempts[3]?.recordFailure();
  assert.equal(disconnectCalls, 1);
  assert.ok(guard.beginAttempt());
});

test("a startup step that never answers fails the process instead of hanging it", () => {
  // `connectWithin` closes the handshake and nothing else. A store that
  // migrates at construction issues ordinary commands before it exists, so its
  // exemption's deadlines do not cover them — and bootstrap awaits the whole
  // construction (#271 review).
  let disconnectCalls = 0;
  return startWithin(
    {
      quit: async () => "OK",
      disconnect: () => {
        disconnectCalls += 1;
      },
    },
    "event store migration and window-index backfill",
    () => new Promise(() => undefined),
    20,
  ).then(
    () => assert.fail("startWithin should not resolve"),
    (error: unknown) => {
      assert.ok(error instanceof RedisStartupTimeoutError);
      assert.equal(
        error.message,
        'Redis startup operation "event store migration and window-index backfill" did not complete within 20ms.',
      );
      assert.equal(disconnectCalls, 1);
    },
  );
});
