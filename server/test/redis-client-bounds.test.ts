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
  createBoundedRedisClient,
  REDIS_COMMAND_TIMEOUT_MS,
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
      // Three exemptions, each naming a caller-side deadline that already
      // answers every caller on that connection.
      "admin/redis-audit-store.ts": ["caller"],
      "admin/redis-event-store.ts": ["caller"],
      "redis-runtime-store.ts": ["caller"],
      // Four connections' worth: the pub/sub factory builds a publisher and a
      // subscriber, and both buses call it.
      "redis-admin-session-store.ts": ["command_timeout"],
      "redis-pubsub-client.ts": ["command_timeout"],
      "redis-room-store.ts": ["command_timeout"],
    },
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
