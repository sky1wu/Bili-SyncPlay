import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { quitWithin } from "../src/redis-graceful-close.js";

function createConnection(quit: () => Promise<unknown>): {
  connection: { quit: () => Promise<unknown>; disconnect: () => void };
  disconnectCalls: () => number;
} {
  let disconnectCalls = 0;
  return {
    connection: {
      quit,
      disconnect: () => {
        disconnectCalls += 1;
      },
    },
    disconnectCalls: () => disconnectCalls,
  };
}

test("a QUIT that answers cleanly leaves the socket alone", async () => {
  const { connection, disconnectCalls } = createConnection(async () => "OK");

  assert.equal(await quitWithin(connection, 200), "ok");
  // Dropping a socket the server just closed for us would abandon replies for
  // no reason.
  assert.equal(disconnectCalls(), 0);
});

test("a QUIT that never answers is given up on, not waited out", async () => {
  const { connection, disconnectCalls } = createConnection(
    () => new Promise(() => undefined),
  );

  // The whole point: unbounded, this is where a shutdown step spends its entire
  // budget and reports a failed step every time Redis is hung (#264, #267).
  const startedAt = Date.now();
  assert.equal(await quitWithin(connection, 20), "timed_out");
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(disconnectCalls(), 1);
});

test("a QUIT that answers with an error is not a graceful close", async () => {
  const { connection, disconnectCalls } = createConnection(() =>
    Promise.reject(new Error("Connection is closed.")),
  );

  // A rejection settles just as promptly as a success, so "did it settle" would
  // call this graceful — with the connection left in a state nobody checked
  // (#266 review).
  assert.equal(await quitWithin(connection, 200), "failed");
  assert.equal(disconnectCalls(), 1);
});

test("a QUIT that answers late, but inside the budget, still counts as graceful", async () => {
  const { connection, disconnectCalls } = createConnection(async () => {
    await delay(20);
    return "OK";
  });

  // The other half of the bound: it must not have turned every close into a
  // socket drop on a Redis that is merely a little slow.
  assert.equal(await quitWithin(connection, 500), "ok");
  assert.equal(disconnectCalls(), 0);
});
