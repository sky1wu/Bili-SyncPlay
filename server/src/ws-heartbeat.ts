import { clampTimerIntervalMs } from "./timers.js";
import type { LogEvent, Session } from "./types.js";

const MISSED_PONG_THRESHOLD = 2;

export type HeartbeatSocket = {
  readyState?: number;
  OPEN?: number;
  ping?: () => void;
  terminate: () => void;
  on: (event: "pong" | "close", listener: () => void) => unknown;
};

export type WsHeartbeat = {
  track: (socket: HeartbeatSocket, session: Session) => void;
  sweepNow: () => number;
  start: () => void;
  stop: () => void;
};

export function createWsHeartbeat(options: {
  enabled: boolean;
  intervalMs: number;
  logEvent: LogEvent;
}): WsHeartbeat {
  const tracked = new Map<
    HeartbeatSocket,
    { session: Session; missedPongs: number }
  >();
  let timer: NodeJS.Timeout | null = null;

  function track(socket: HeartbeatSocket, session: Session): void {
    if (!options.enabled) {
      return;
    }
    tracked.set(socket, { session, missedPongs: 0 });
    socket.on("pong", () => {
      const entry = tracked.get(socket);
      if (entry) {
        entry.missedPongs = 0;
      }
    });
    socket.on("close", () => {
      tracked.delete(socket);
    });
  }

  function isSocketOpen(socket: HeartbeatSocket): boolean {
    if (socket.readyState === undefined || socket.OPEN === undefined) {
      return true;
    }
    return socket.readyState === socket.OPEN;
  }

  function sweepNow(): number {
    let terminatedCount = 0;
    for (const [socket, entry] of tracked) {
      // Per-socket guard: sweepNow runs inside a bare setInterval, so an
      // exception here would otherwise crash the process and skip the
      // remaining sockets in this sweep.
      try {
        if (entry.missedPongs >= MISSED_PONG_THRESHOLD) {
          // Half-open TCP connections never emit "close" on their own, so this
          // terminate() is what finally triggers the existing close-path
          // cleanup (leaveRoom, session unregister, room expiry scheduling).
          // Untrack only after terminate() succeeds: if it throws, the entry
          // stays tracked and the next sweep retries, so the ghost is never
          // silently abandoned.
          options.logEvent("ws_heartbeat_timeout_terminated", {
            sessionId: entry.session.id,
            roomCode: entry.session.roomCode,
            memberId: entry.session.memberId,
            remoteAddress: entry.session.remoteAddress,
            origin: entry.session.origin,
            missedPongs: entry.missedPongs,
            result: "terminated",
          });
          socket.terminate();
          tracked.delete(socket);
          terminatedCount += 1;
          continue;
        }

        entry.missedPongs += 1;
        if (isSocketOpen(socket)) {
          try {
            socket.ping?.();
          } catch {
            // A socket racing into CLOSING/CLOSED state may reject the ping;
            // the pending close event will untrack it.
          }
        }
      } catch (error) {
        options.logEvent("ws_heartbeat_sweep_failed", {
          sessionId: entry.session.id,
          roomCode: entry.session.roomCode,
          result: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return terminatedCount;
  }

  return {
    track,
    sweepNow,
    start() {
      if (!options.enabled || timer) {
        return;
      }
      timer = setInterval(() => {
        sweepNow();
      }, clampTimerIntervalMs(options.intervalMs));
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
