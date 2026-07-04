import type { LogEvent, Session } from "./types.js";

export const WS_HEARTBEAT_MISSED_PONG_THRESHOLD = 2;

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
  missedPongThreshold?: number;
  logEvent: LogEvent;
}): WsHeartbeat {
  const missedPongThreshold =
    options.missedPongThreshold ?? WS_HEARTBEAT_MISSED_PONG_THRESHOLD;
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
      if (entry.missedPongs >= missedPongThreshold) {
        // Half-open TCP connections never emit "close" on their own, so this
        // terminate() is what finally triggers the existing close-path cleanup
        // (leaveRoom, session unregister, room expiry scheduling).
        tracked.delete(socket);
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
      }, options.intervalMs);
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
