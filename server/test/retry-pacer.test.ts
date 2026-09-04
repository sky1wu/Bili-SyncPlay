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

test("raceStopped parks one waiter per call and releases it when the call answers", async () => {
  const pacer = createRetryPacer({ initialDelayMs: 1, maxDelayMs: 1 });

  // The defect this guards (#312): the stop side used to be ONE
  // process-lifetime promise every caller raced against. A promise that only
  // settles at shutdown never releases the `PromiseReaction` each race attaches
  // to it, so five call sites accumulated a reaction, two closures, a context
  // and two promises per call — ~349 bytes a time — until major GC pauses grew
  // 25x over four days of uptime.
  //
  // Two properties have to hold, and one without the other still leaks:
  // the stop side is per CALL (so it dies with the call), and the Set that
  // `stop` reaches those calls through is PRUNED (so it is not the same leak
  // one level up).
  const parked = Array.from({ length: 3 }, () => {
    let resolve = (): void => {};
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  });
  const races = parked.map((work) => pacer.raceStopped(work.promise));
  await delay(10);

  // Per call, not one shared entry: a shared signal would sit at 1 here.
  assert.equal(pacer.stopWaiterCount(), 3);

  for (const work of parked) {
    work.resolve();
  }
  await Promise.all(races);

  // And back down. Leaving them in the Set would retain every closure the
  // races captured, for as long as the pacer lives.
  assert.equal(pacer.stopWaiterCount(), 0);
  pacer.stop();
});

test("raceStopped gives up the wait when stop is called, and keeps rejections", async () => {
  const pacer = createRetryPacer({ initialDelayMs: 1, maxDelayMs: 1 });

  // Shutdown still cuts a parked wait short — the reason the stop side exists
  // at all. `raceStopped` resolves rather than rejects, so callers keep the
  // `if (stopped())` re-check they had when they wrote the race by hand.
  const neverAnswers = new Promise<void>(() => {});
  const parked = pacer.raceStopped(neverAnswers);
  await delay(10);
  assert.equal(pacer.stopWaiterCount(), 1);

  pacer.stop();
  await parked;
  assert.equal(pacer.stopWaiterCount(), 0);
  assert.equal(pacer.stopped(), true);

  // Already stopped: answer without attaching anything, which is what racing an
  // already-resolved signal did.
  await pacer.raceStopped(new Promise<void>(() => {}));
  assert.equal(pacer.stopWaiterCount(), 0);
});

test("raceStopped propagates the work's rejection", async () => {
  const pacer = createRetryPacer({ initialDelayMs: 1, maxDelayMs: 1 });

  // The five call sites were hand-written races, and a race rejects when its
  // work rejects. `durable-write-queue`'s `settle()` and `pending-resync-queue`'s
  // `inFlight` both can — swallowing that here would change their control flow
  // silently.
  await assert.rejects(
    pacer.raceStopped(Promise.reject(new Error("work failed"))),
    /work failed/,
  );
  assert.equal(pacer.stopWaiterCount(), 0);
  pacer.stop();
});

test("raceStopped consumes a rejection it stops waiting on, on both paths", async () => {
  // `Promise.race` attaches to BOTH arms even when one has already settled, so
  // the hand-written races consumed a `work` rejection that lost. Answering
  // early without a handler instead leaves it unhandled, and Node's default is
  // to terminate the process on one — turning a leak fix into a crash on the
  // shutdown path (#313 review).
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    // Path 1: parked, then stop wins, then the work fails late.
    const parkedPacer = createRetryPacer({ initialDelayMs: 1, maxDelayMs: 1 });
    let failLate = (): void => {};
    const losesTheRace = new Promise<void>((_resolve, reject) => {
      failLate = () => reject(new Error("late failure"));
    });
    const parked = parkedPacer.raceStopped(losesTheRace);
    await delay(5);
    parkedPacer.stop();
    await parked;
    failLate();
    await delay(20);

    // Path 2: already stopped when the call arrives.
    const stoppedPacer = createRetryPacer({ initialDelayMs: 1, maxDelayMs: 1 });
    stoppedPacer.stop();
    const answer = await stoppedPacer.raceStopped(
      Promise.reject(new Error("failed after stop")),
    );
    assert.equal(answer, undefined);
    await delay(20);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.deepEqual(unhandled, []);
});
