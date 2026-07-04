import assert from "node:assert/strict";
import test from "node:test";
import { clampTimerIntervalMs, MAX_TIMER_INTERVAL_MS } from "../src/timers.js";

test("clampTimerIntervalMs passes through intervals within the 32-bit timer range", () => {
  assert.equal(clampTimerIntervalMs(30_000), 30_000);
  assert.equal(
    clampTimerIntervalMs(MAX_TIMER_INTERVAL_MS),
    MAX_TIMER_INTERVAL_MS,
  );
});

test("clampTimerIntervalMs clamps intervals that would overflow Node timers", () => {
  assert.equal(
    clampTimerIntervalMs(MAX_TIMER_INTERVAL_MS + 1),
    MAX_TIMER_INTERVAL_MS,
  );
  assert.equal(clampTimerIntervalMs(2_592_000_000), MAX_TIMER_INTERVAL_MS);
});
