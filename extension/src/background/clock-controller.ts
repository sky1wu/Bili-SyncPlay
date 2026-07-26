import type {
  ClientMessage,
  PlaybackState,
  RoomState,
} from "@bili-syncplay/protocol";
import {
  extrapolatePlayingRoomState,
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

/**
 * Identity of a playback snapshot. Two broadcasts of the same snapshot share it;
 * a playing room always advances `currentTime`, so consecutive snapshots differ.
 */
function playbackSnapshotKey(playback: PlaybackState): string {
  return [
    playback.actorId,
    playback.seq,
    playback.playState,
    playback.url,
    playback.currentTime,
    playback.playbackRate,
  ].join("|");
}

export function createClockController(args: {
  connectionState: ConnectionState;
  clockState: ClockState;
  sendToServer: (message: ClientMessage) => void;
  log: (scope: "background", message: string) => void;
  /**
   * Monotonic time source for anchoring snapshots. Must not be the wall clock:
   * the whole point of the anchor is to be immune to clock adjustments, and
   * `Date.now()` moves when the clock is stepped.
   */
  getMonotonicNow?: () => number;
}): ClockController {
  const monotonicNow = () => args.getMonotonicNow?.() ?? performance.now();
  // When the snapshot we are currently extrapolating from first reached us.
  let playbackAnchor: { key: string; atMs: number } | null = null;
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

  /**
   * Advance a room state's playback position to now.
   *
   * The elapsed time is measured from when this snapshot first arrived, on a
   * monotonic local clock — never by comparing `serverTime` against a local
   * timestamp, which spans two clocks (see `extrapolatePlayingRoomState`). A
   * freshly arrived snapshot is therefore passed through as the sender reported
   * it, and a replay (a tab binding late, a popup asking for current state) is
   * advanced by the time that genuinely passed since it arrived.
   *
   * The cost is that we no longer know how stale a snapshot already was when it
   * reached us — on joining a room mid-playback that can be up to one broadcast
   * interval, which the receiver closes with a single seek. Recovering it needs
   * the server to report the snapshot's age as a *duration*, which is safe to
   * send across disagreeing clocks; `serverTime` is not.
   */
  function compensateRoomState(state: RoomState): RoomState {
    if (!state.playback || state.playback.playState !== "playing") {
      return state;
    }

    const key = playbackSnapshotKey(state.playback);
    const now = monotonicNow();
    if (!playbackAnchor || playbackAnchor.key !== key) {
      playbackAnchor = { key, atMs: now };
    }
    return extrapolatePlayingRoomState(state, now - playbackAnchor.atMs);
  }

  return {
    syncClock,
    startClockSyncTimer,
    stopClockSyncTimer,
    updateClockOffset,
    compensateRoomState,
  };
}
