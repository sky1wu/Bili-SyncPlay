/**
 * A shared, waiting concurrency budget for work that has already been accepted.
 *
 * This is deliberately different from a refusal-style admission cap. A hard
 * cap protects a dependency from unbounded state and rejects overload; this
 * limiter coordinates trusted callers before they reach that cap. Keeping the
 * two roles separate prevents normal fan-out from turning a safety boundary
 * into a partial business operation.
 */
export type ConcurrencyLimiter = {
  run: <T>(work: () => Promise<T>) => Promise<T>;
};

export function createConcurrencyLimiter(
  maxConcurrent: number,
): ConcurrencyLimiter {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("Concurrency limit must be a positive integer.");
  }

  let active = 0;
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }

  function release(): void {
    const next = waiters.shift();
    if (next) {
      // Transfer this slot directly. Decrementing first would expose it to a
      // newly arriving caller before the queued continuation can run.
      next();
      return;
    }
    active -= 1;
  }

  return {
    async run(work) {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}
