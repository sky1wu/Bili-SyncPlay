export const RECONNECT_WATCHDOG_ALARM = "reconnect-watchdog";
export const RECONNECT_WATCHDOG_PERIOD_MINUTES = 1;

/** The subset of `chrome.alarms` the watchdog needs, injectable for tests. */
export interface ReconnectWatchdogAlarms {
  create(name: string, alarmInfo: { periodInMinutes: number }): void;
  onAlarm: {
    addListener(callback: (alarm: { name: string }) => void): void;
  };
}

/**
 * Periodic reconnect fallback for the MV3 service worker. In-memory reconnect
 * timers die with the worker: once Chrome suspends it (~30s idle with no open
 * socket), a scheduled backoff retry never fires and the session stays offline
 * until a popup open or a content-script message happens to wake the worker.
 * An alarm is the only timer that survives suspension — each firing wakes the
 * worker (whose bootstrap auto-connects a restored room session) and, when the
 * worker was alive but offline, nudges `connect()` directly.
 */
export function registerReconnectWatchdog(args: {
  alarms: ReconnectWatchdogAlarms;
  shouldReconnect: () => boolean;
  connect: () => void;
  log: (message: string) => void;
}): void {
  args.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== RECONNECT_WATCHDOG_ALARM) {
      return;
    }
    if (!args.shouldReconnect()) {
      return;
    }
    args.log("Reconnect watchdog triggered a connection attempt");
    args.connect();
  });
  // Recreating an existing alarm with the same name just resets it, so this is
  // safe to run on every service-worker start.
  args.alarms.create(RECONNECT_WATCHDOG_ALARM, {
    periodInMinutes: RECONNECT_WATCHDOG_PERIOD_MINUTES,
  });
}
