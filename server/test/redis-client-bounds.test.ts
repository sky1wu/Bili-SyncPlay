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
  REDIS_COMMAND_TIMEOUT_MS,
  RedisConnectTimeoutError,
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
      // one — the runtime store passes that test while `trackAwaitedOperation`
      // has no bound at all, and the room store's request path has none either
      // (#271 review).
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
    assert.equal(callerBounded.options.commandTimeout, undefined);
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
