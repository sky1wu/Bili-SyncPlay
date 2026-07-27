import type { ShutdownStepFailure } from "./server-bootstrap.js";

// Entry points run as PID 1 in the container image (`CMD ["node", ...]`), and
// PID 1 does not get the kernel default action for a signal it has no handler
// for — SIGTERM is simply ignored. Without this module `docker stop` waits out
// its grace period and then SIGKILLs (exit 137), so none of the shutdown steps
// in `createSyncServer().close()` ever run: WebSocket clients are dropped
// without a close frame and Redis-backed runtime/session state is left for the
// reapers to expire instead of being released at exit.
const DEFAULT_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

// A last-resort watchdog, not a shutdown budget: it must sit *above* the
// longest legitimate teardown or it truncates one. The steps in `app.ts` are
// individually capped and add up to ~135s in the worst case (two 30s drains for
// session cleanup and room-event flushing, the rest 5s each), so a busy node
// under Redis backpressure is still within budget well past any value that
// would fit inside Docker's 10s default grace period. Deployments choose how
// much of that budget they actually grant via the orchestrator's grace period
// (`stop_grace_period` / `docker stop -t`); this timer only guarantees the
// process eventually exits on its own if `close()` wedges outside those caps.
const DEFAULT_FORCE_EXIT_TIMEOUT_MS = 150_000;

// A signal that lands before startup finished has nothing to close yet, so it
// waits for `attachCloseTarget`. Startup is normally sub-second; when it is
// blocked (an unreachable Redis retrying its connect), waiting out the full
// force-exit timeout would be indistinguishable from the hang this module
// exists to prevent, so give startup a short window and then abort.
const DEFAULT_STARTUP_ABORT_TIMEOUT_MS = 5_000;

export type ShutdownCloseTarget = () => Promise<ShutdownStepFailure[] | void>;

export type ShutdownSignalTarget = {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
};

export type GracefulShutdownOptions = {
  /** Prefix used in the shutdown log lines, e.g. "Bili-SyncPlay server". */
  name: string;
  /** Teardown, when it is already available at install time. */
  close?: ShutdownCloseTarget;
  signals?: NodeJS.Signals[];
  forceExitTimeoutMs?: number;
  startupAbortTimeoutMs?: number;
  log?: (message: string) => void;
  logError?: (message: string, error?: unknown) => void;
  exit?: (code: number) => void;
  signalTarget?: ShutdownSignalTarget;
};

export type GracefulShutdownHandle = {
  /**
   * Hands over the teardown once startup finished.
   *
   * Returns `false` when a stop signal already arrived: shutdown starts
   * immediately with the target just attached, and the caller must not continue
   * bringing the server up (no `listen`).
   */
  attachCloseTarget: (close: ShutdownCloseTarget) => boolean;
  /** Uninstalls the signal handlers; also called once shutdown finishes. */
  detach: () => void;
};

/**
 * Installs signal handlers that run the teardown once and then exit.
 *
 * Install this *before* any awaited startup work: the entry point runs as PID 1,
 * so a SIGTERM arriving while `createSyncServer()` is still connecting to Redis
 * would otherwise be ignored, and the container would hang until SIGKILL.
 */
export function installGracefulShutdown(
  options: GracefulShutdownOptions,
): GracefulShutdownHandle {
  const {
    name,
    signals = DEFAULT_SIGNALS,
    forceExitTimeoutMs = DEFAULT_FORCE_EXIT_TIMEOUT_MS,
    startupAbortTimeoutMs = DEFAULT_STARTUP_ABORT_TIMEOUT_MS,
    log = (message: string) => console.log(message),
    logError = (message: string, error?: unknown) => {
      if (error === undefined) {
        console.error(message);
        return;
      }
      console.error(message, error);
    },
    exit = (code: number) => process.exit(code),
    signalTarget = process,
  } = options;

  let closeTarget = options.close;
  let shuttingDown = false;
  let pendingStartupSignal: NodeJS.Signals | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Map<NodeJS.Signals, () => void>();

  const detach = (): void => {
    for (const [signal, listener] of listeners) {
      signalTarget.off(signal, listener);
    }
    listeners.clear();
  };

  const finish = (code: number): void => {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    detach();
    exit(code);
  };

  // Deliberately not unref()'d: a `close()` that never settles does not keep the
  // event loop alive by itself, so an unref'd watchdog would let the process
  // slip out with code 0 and no timeout log — exactly the silent hang this
  // guards against. Both terminal paths clear it.
  const armWatchdog = (timeoutMs: number, onTimeout: () => void): void => {
    watchdog = setTimeout(onTimeout, timeoutMs);
  };

  const armForceExitWatchdog = (): void => {
    armWatchdog(forceExitTimeoutMs, () => {
      watchdog = null;
      logError(
        `${name} shutdown timed out after ${forceExitTimeoutMs}ms; exiting immediately.`,
      );
      finish(1);
    });
  };

  const runShutdown = (close: ShutdownCloseTarget): void => {
    void (async () => {
      let exitCode = 0;
      try {
        const failures = (await close()) ?? [];
        if (failures.length > 0) {
          logError(
            `${name} shutdown finished with failed steps: ${failures
              .map((failure) => `${failure.step} (${failure.result})`)
              .join(", ")}.`,
          );
          exitCode = 1;
        } else {
          log(`${name} shutdown complete.`);
        }
      } catch (error) {
        logError(`${name} shutdown failed:`, error);
        exitCode = 1;
      }
      finish(exitCode);
    })();
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      // A second signal means the operator is done waiting; stop immediately
      // rather than making them reach for SIGKILL.
      logError(
        `${name} received ${signal} while shutting down; exiting immediately.`,
      );
      finish(1);
      return;
    }
    shuttingDown = true;

    if (!closeTarget) {
      pendingStartupSignal = signal;
      log(
        `${name} received ${signal} during startup; shutting down as soon as startup finishes.`,
      );
      armWatchdog(startupAbortTimeoutMs, () => {
        watchdog = null;
        logError(
          `${name} startup did not finish within ${startupAbortTimeoutMs}ms after ${signal}; exiting immediately.`,
        );
        finish(1);
      });
      return;
    }

    log(`${name} received ${signal}, shutting down gracefully...`);
    armForceExitWatchdog();
    runShutdown(closeTarget);
  };

  const attachCloseTarget = (close: ShutdownCloseTarget): boolean => {
    closeTarget = close;
    if (pendingStartupSignal === null) {
      return true;
    }

    log(
      `${name} startup finished after ${pendingStartupSignal}; shutting down gracefully...`,
    );
    pendingStartupSignal = null;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    armForceExitWatchdog();
    runShutdown(close);
    return false;
  };

  for (const signal of signals) {
    const listener = (): void => {
      handleSignal(signal);
    };
    listeners.set(signal, listener);
    signalTarget.on(signal, listener);
  }

  return { attachCloseTarget, detach };
}
