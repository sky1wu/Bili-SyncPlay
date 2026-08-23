import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createRetryPacer, settleWithin } from "../src/retry-pacer.js";
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

test("settleWithin reports whether the work settled or the budget ran out", async () => {
  // Both answers matter to the caller, and they lead somewhere different:
  // `redis-event-store.close` closes the connection either way, but only the
  // second case owes an operator a line saying a command was still on it.
  assert.equal(await settleWithin(delay(5, "done"), 200), true);
  assert.equal(await settleWithin(new Promise(() => undefined), 5), false);
});

test("settleWithin absorbs a rejection rather than reporting it as a timeout", async () => {
  // "It failed" is still an answer. Reporting a rejected write as abandoned
  // would send a shutdown looking for a command that is no longer on the
  // connection — and would leak the rejection as unhandled besides.
  assert.equal(
    await settleWithin(Promise.reject(new Error("boom")), 200),
    true,
  );
});

test("settleWithin does not hold the event loop open after the work settles", async () => {
  const countRefdTimers = (): number =>
    process.getActiveResourcesInfo().filter((kind) => kind === "Timeout")
      .length;

  // A delta, not an absolute count: earlier tests in this file leave their own
  // timers armed, and this measures only the one `settleWithin` arms.
  const before = countRefdTimers();
  const settling = settleWithin(Promise.resolve(), 60_000);
  const armed = countRefdTimers();
  await settling;

  assert.equal(armed, before + 1);
  // A budget timer left armed after an early answer would keep the process
  // alive for a full minute past a shutdown that already finished — the same
  // defect an `unref`'d timer hides and this one would not.
  assert.equal(countRefdTimers(), before);
});

test("trackCall preserves the real outcome while counting an unanswered call", async () => {
  const pacer = createRetryPacer({ initialDelayMs: 1, maxDelayMs: 1 });
  let resolveCall!: (value: string) => void;
  const call = new Promise<string>((resolve) => {
    resolveCall = resolve;
  });

  const tracked = pacer.trackCall(call);
  assert.equal(pacer.trackedCount(), 1);
  resolveCall("answered");
  assert.equal(await tracked, "answered");
  await Promise.resolve();
  assert.equal(pacer.trackedCount(), 0);
  pacer.stop();
});

test("capWait does not track repeated waits on an already tracked call", async () => {
  const pacer = createRetryPacer({ initialDelayMs: 1, maxDelayMs: 1 });
  let resolveCall!: (value: string) => void;
  const call = new Promise<string>((resolve) => {
    resolveCall = resolve;
  });
  const tracked = pacer.trackCall(call);

  await assert.rejects(
    pacer.capWait(tracked, 1, () => new Error("first wait capped")),
    /first wait capped/,
  );
  await assert.rejects(
    pacer.capWait(tracked, 1, () => new Error("second wait capped")),
    /second wait capped/,
  );
  assert.equal(pacer.trackedCount(), 1);

  resolveCall("answered");
  assert.equal(await tracked, "answered");
  await Promise.resolve();
  assert.equal(pacer.trackedCount(), 0);
  pacer.stop();
});
