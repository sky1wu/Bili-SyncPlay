import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnosisThrottle } from "../src/diagnosis-throttle.js";

function createClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 0;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

test("one diagnosis is reported once per interval, and each stands alone", () => {
  const clock = createClock();
  const throttle = createDiagnosisThrottle({
    intervalMs: 1_000,
    maxTrackedDiagnoses: 4,
    now: clock.now,
  });

  assert.equal(throttle.allow("get"), true);
  assert.equal(throttle.allow("get"), false);
  // A different diagnosis is a different fact, so it is not held back by its
  // neighbour's cooldown.
  assert.equal(throttle.allow("save"), true);

  clock.advance(999);
  assert.equal(throttle.allow("get"), false);
  clock.advance(1);
  assert.equal(throttle.allow("get"), true);
});

test("high-cardinality diagnoses share one bucket instead of growing a map", () => {
  // Diagnoses come from implementations outside the caller and are not
  // necessarily a finite vocabulary, so the throttle itself has to be bounded.
  const clock = createClock();
  const throttle = createDiagnosisThrottle({
    intervalMs: 1_000,
    maxTrackedDiagnoses: 2,
    now: clock.now,
  });

  assert.equal(throttle.allow("a"), true);
  assert.equal(throttle.allow("b"), true);
  // Third distinct diagnosis: tracked slots are full, so it takes the bucket.
  assert.equal(throttle.allow("c"), true);
  assert.equal(throttle.allow("d"), false);
});

test("the overflow bucket's cooldown outranks a slot that just freed up", () => {
  // A tracked slot can expire while the bucket is still cooling down.
  // Promoting an overflow diagnosis into that newly free slot would print it
  // twice inside one interval (#268 review) — which is the whole reason the
  // bucket is checked before the size test rather than after.
  const clock = createClock();
  const throttle = createDiagnosisThrottle({
    intervalMs: 1_000,
    maxTrackedDiagnoses: 1,
    now: clock.now,
  });

  assert.equal(throttle.allow("tracked"), true);
  clock.advance(600);
  // Slots are full, so this one goes to the bucket and starts its cooldown.
  assert.equal(throttle.allow("overflowed"), true);

  clock.advance(500);
  // `tracked` has now expired (1100ms) and its slot is free, but the bucket is
  // only 500ms old.
  assert.equal(throttle.allow("overflowed"), false);

  clock.advance(600);
  assert.equal(throttle.allow("overflowed"), true);
});

test("asking reserves the interval, so a caller may ask only once per report", () => {
  // `allow` is not a predicate that can be polled: answering true is what
  // starts the cooldown. A caller that asked twice and reported once would
  // silence the next interval for nothing.
  const clock = createClock();
  const throttle = createDiagnosisThrottle({
    intervalMs: 1_000,
    maxTrackedDiagnoses: 4,
    now: clock.now,
  });

  assert.equal(throttle.allow("get"), true);
  assert.equal(throttle.allow("get"), false);
});
