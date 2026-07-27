// Entry points run as PID 1 in the container image (`CMD ["node", ...]`), and
// PID 1 does not get the kernel default action for a signal it has no handler
// for — SIGTERM is simply ignored. Without this module `docker stop` waits out
// its grace period and then SIGKILLs (exit 137), so none of the shutdown steps
// in `createSyncServer().close()` ever run: WebSocket clients are dropped
// without a close frame and Redis-backed runtime/session state is left for the
// reapers to expire instead of being released at exit.
const DEFAULT_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

// Individual shutdown steps carry their own (much longer) caps, but a stop
// signal comes from an orchestrator that will not wait forever: Docker's
// default grace period is 10s. Force the exit before that so we exit on our own
// terms, and keep `stop_grace_period` in docker-compose.yml above this value.
const DEFAULT_FORCE_EXIT_TIMEOUT_MS = 15_000;

export type ShutdownSignalTarget = {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
};

export type GracefulShutdownOptions = {
  /** Server teardown, typically `createSyncServer().close`. */
  close: () => Promise<void>;
  /** Prefix used in the shutdown log lines, e.g. "Bili-SyncPlay server". */
  name: string;
  signals?: NodeJS.Signals[];
  forceExitTimeoutMs?: number;
  log?: (message: string) => void;
  logError?: (message: string, error?: unknown) => void;
  exit?: (code: number) => void;
  signalTarget?: ShutdownSignalTarget;
};

/**
 * Installs signal handlers that run `close()` once and then exit the process.
 *
 * Returns a detach function so callers (and tests) can uninstall the handlers;
 * it is also called automatically once shutdown finishes.
 */
export function installGracefulShutdown(
  options: GracefulShutdownOptions,
): () => void {
  const {
    close,
    name,
    signals = DEFAULT_SIGNALS,
    forceExitTimeoutMs = DEFAULT_FORCE_EXIT_TIMEOUT_MS,
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

  let shuttingDown = false;
  const listeners = new Map<NodeJS.Signals, () => void>();

  const detach = (): void => {
    for (const [signal, listener] of listeners) {
      signalTarget.off(signal, listener);
    }
    listeners.clear();
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      // A second signal means the operator is done waiting; stop immediately
      // rather than making them reach for SIGKILL.
      logError(
        `${name} received ${signal} while shutting down; exiting immediately.`,
      );
      exit(1);
      return;
    }
    shuttingDown = true;
    log(`${name} received ${signal}, shutting down gracefully...`);

    const forceExitTimer = setTimeout(() => {
      logError(
        `${name} shutdown timed out after ${forceExitTimeoutMs}ms; exiting immediately.`,
      );
      detach();
      exit(1);
    }, forceExitTimeoutMs);
    // Never let the watchdog itself hold the event loop open: if shutdown is
    // done and nothing else is pending, the process should be free to exit.
    forceExitTimer.unref();

    void (async () => {
      let exitCode = 0;
      try {
        await close();
        log(`${name} shutdown complete.`);
      } catch (error) {
        logError(`${name} shutdown failed:`, error);
        exitCode = 1;
      }
      clearTimeout(forceExitTimer);
      detach();
      exit(exitCode);
    })();
  };

  for (const signal of signals) {
    const listener = (): void => {
      handleSignal(signal);
    };
    listeners.set(signal, listener);
    signalTarget.on(signal, listener);
  }

  return detach;
}
