/**
 * Test doubles for the two clocks the background reads.
 *
 * These stub the GLOBALS rather than injecting a time source, because that is
 * the only way to test *which* clock a default reads: a controller that takes
 * `getMonotonicNow` and is handed one in the test passes whether its fallback is
 * `performance.now()` or `Date.now()`. Move the two clocks in opposite
 * directions and only the correct source survives.
 */

export interface StubbedClocks {
  /** What `Date.now()` returns. Step it to simulate an NTP correction. */
  wall: number;
  /** What `performance.now()` returns. Only ever advance it. */
  monotonic: number;
}

export function installClockStubs(initial: StubbedClocks): {
  clocks: StubbedClocks;
  restore: () => void;
} {
  const clocks = { ...initial };
  const originalDateNow = Date.now;
  const originalPerformanceNow = performance.now;
  Date.now = () => clocks.wall;
  performance.now = () => clocks.monotonic;

  return {
    clocks,
    restore() {
      Date.now = originalDateNow;
      performance.now = originalPerformanceNow;
    },
  };
}

export interface FakeTimer {
  id: number;
  delayMs: number;
  fn: () => void;
}

/**
 * Replaces `self.setTimeout` with a queue the test drains by hand, so a 10s
 * backstop can be observed firing without waiting 10s — and so a test can assert
 * that nothing was left armed afterwards.
 *
 * The global `clearTimeout` is deliberately left alone: production clears these
 * ids through it, but a test that arms one timer and drains it never reaches
 * that path, and stubbing a global the test runner also uses buys nothing here.
 */
export function installFakeSelfTimers(): {
  pending: () => FakeTimer[];
  runAll: () => void;
  restore: () => void;
} {
  const originalSelf = (globalThis as { self?: unknown }).self;
  let timers: FakeTimer[] = [];
  let nextId = 1;

  Object.assign(globalThis, {
    self: {
      setTimeout(fn: () => void, delayMs: number): number {
        const id = nextId;
        nextId += 1;
        timers.push({ id, delayMs, fn });
        return id;
      },
      clearTimeout(id: number): void {
        timers = timers.filter((timer) => timer.id !== id);
      },
    },
  });

  return {
    pending: () => [...timers],
    runAll() {
      const due = timers;
      timers = [];
      for (const timer of due) {
        timer.fn();
      }
    },
    restore() {
      Object.assign(globalThis, { self: originalSelf });
    },
  };
}
