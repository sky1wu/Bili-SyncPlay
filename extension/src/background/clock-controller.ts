import type { ClientMessage, RoomState } from "@bili-syncplay/protocol";
import {
  compensateRoomStateForClock,
  CLOCK_SYNC_INTERVAL_MS,
  updateClockSample,
} from "./clock-sync";
import type { ClockState, ConnectionState } from "./runtime-state";

export interface ClockController {
  syncClock(): void;
  startClockSyncTimer(): void;
  stopClockSyncTimer(): void;
  updateClockOffset(
    clientSendTime: number,
    serverReceiveTime: number,
    serverSendTime: number,
  ): void;
  compensateRoomState(state: RoomState): RoomState;
}

export function createClockController(args: {
  connectionState: ConnectionState;
  clockState: ClockState;
  sendToServer: (message: ClientMessage) => void;
  log: (scope: "background", message: string) => void;
}): ClockController {
  function syncClock(): void {
    if (!args.connectionState.connected) {
      return;
    }
    args.sendToServer({
      type: "sync:ping",
      payload: {
        clientSendTime: Date.now(),
      },
    });
  }

  function startClockSyncTimer(): void {
    stopClockSyncTimer();
    args.clockState.clockSyncTimer = self.setInterval(() => {
      syncClock();
    }, CLOCK_SYNC_INTERVAL_MS);
  }

  function stopClockSyncTimer(): void {
    if (args.clockState.clockSyncTimer !== null) {
      clearInterval(args.clockState.clockSyncTimer);
      args.clockState.clockSyncTimer = null;
    }
  }

  function updateClockOffset(
    clientSendTime: number,
    serverReceiveTime: number,
    serverSendTime: number,
  ): void {
    const result = updateClockSample({
      clientSendTime,
      serverReceiveTime,
      serverSendTime,
      now: Date.now(),
      previousRttMs: args.clockState.rttMs,
      previousClockOffsetMs: args.clockState.clockOffsetMs,
      previousSamples: args.clockState.clockSamples,
    });
    args.clockState.rttMs = result.rttMs;
    args.clockState.clockOffsetMs = result.clockOffsetMs;
    args.clockState.clockSamples = result.samples;
    // The raw sample is logged alongside the published estimate: a sample that
    // swings while `rtt` stays flat is the signature of a late-written
    // timestamp, and `out`/`in` say which direction it came from.
    args.log(
      "background",
      `Clock sync offset=${args.clockState.clockOffsetMs}ms rtt=${args.clockState.rttMs}ms ` +
        `sample=${Math.round(result.sample.offsetMs)}ms sampleRtt=${result.sample.rttMs}ms ` +
        `out=${result.sample.outboundMs}ms in=${result.sample.inboundMs}ms window=${result.samples.length}`,
    );
  }

  function compensateRoomState(state: RoomState): RoomState {
    return compensateRoomStateForClock(state, args.clockState.clockOffsetMs);
  }

  return {
    syncClock,
    startClockSyncTimer,
    stopClockSyncTimer,
    updateClockOffset,
    compensateRoomState,
  };
}
