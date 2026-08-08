import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createRetryPacer } from "../src/retry-pacer.js";
import { MAX_TIMER_INTERVAL_MS } from "../src/timers.js";

test("a cap past the 32-bit timer limit does not fire immediately", async () => {
  const pacer = createRetryPacer({ initialDelayMs: 1, maxDelayMs: 1 });

  // Node stores a timer delay as a signed 32-bit integer: anything larger is
  // not "very late", it fires after ~1ms with a TimeoutOverflowWarning. Every
  // cap on this pacer is derived from configuration that only has to be a
  // positive integer — `heartbeatTimeoutMs` from `NODE_HEARTBEAT_TTL_MS`, for
  // one — so one absurd setting would turn every capped call into an INSTANT
  // timeout rather than a generous one, and a healthy Redis would look dead
  // (#265 review).
  //
  // The work answers well after that ~1ms and well before any honest reading of
  // the cap, so an unclamped delay rejects here and a clamped one resolves.
  const answered = await pacer.capAttempt(
    delay(30, "answered"),
    MAX_TIMER_INTERVAL_MS + 1,
    () => new Error("capped"),
  );

  assert.equal(answered, "answered");
  pacer.stop();
});

test("a cap inside the limit still fires", async () => {
  const pacer = createRetryPacer({ initialDelayMs: 1, maxDelayMs: 1 });

  // The other half of the clamp: it must not have turned every cap into a
  // no-op. Same call, an ordinary budget, work that takes far longer.
  await assert.rejects(
    pacer.capAttempt(delay(200, "answered"), 5, () => new Error("capped")),
    /capped/,
  );
  pacer.stop();
  // The call outlived its cap and is still pending — exactly the state
  // `settleTracked` exists for. Bounded, so this test does not sit out the 200ms.
  await pacer.settleTracked(10);
});
