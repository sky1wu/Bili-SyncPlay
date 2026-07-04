// Node timers store the delay as a signed 32-bit integer; anything larger
// overflows and fires after ~1ms, turning a long interval into a hot loop.
export const MAX_TIMER_INTERVAL_MS = 2_147_483_647;

export function clampTimerIntervalMs(intervalMs: number): number {
  return Math.min(intervalMs, MAX_TIMER_INTERVAL_MS);
}
