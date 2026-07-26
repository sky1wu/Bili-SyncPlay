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
  compensateRoomState(state: RoomState, receivedAtMs?: number): RoomState;
}

/**
 * Identity of a playback snapshot. Two broadcasts of the same snapshot share it;
 * two different snapshots must not.
 *
 * `serverTime` is in here as the server's version tag for the snapshot — compared
 * only for equality, never subtracted from a local timestamp, which is the thing
 * this module exists to avoid. Without it the identity is forgeable: `seq` is a
 * per-content-script counter that restarts at 0 on every page load (see
 * `content/index.ts`), so a member who reloads the page and resumes at a position
 * an early-`seq` snapshot already reported would produce a key that has been seen
 * before, and the anchor from that older snapshot would still be standing — adding
 * everything that happened in between to the playback position.
 */
function playbackSnapshotKey(playback: PlaybackState): string {
  return [
    playback.actorId,
    playback.seq,
    playback.serverTime,
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
   * `receivedAtMs` (monotonic, same source as this controller's) is when the
   * snapshot actually arrived, and callers handling a fresh `room:state` must
   * pass it: work between arrival and here — persisting state, opening the shared
   * video's tab — is not instant, and anchoring at this call instead would credit
   * that time to nobody. The room kept playing through it, so the receiver would
   * apply a position already that stale as though it were current and then have to
   * seek. Omit it only when replaying a snapshot that was anchored on arrival.
   *
   * The cost is that we no longer know how stale a snapshot already was when it
   * reached us — on joining a room mid-playback that can be up to one broadcast
   * interval, which the receiver closes with a single seek. Recovering it needs
   * the server to report the snapshot's age as a *duration*, which is safe to
   * send across disagreeing clocks; `serverTime` is not.
   */
  function compensateRoomState(
    state: RoomState,
    receivedAtMs?: number,
  ): RoomState {
    if (!state.playback || state.playback.playState !== "playing") {
      // An anchor only ever describes the snapshot the room is currently playing
      // out. Dropping it here keeps a stale one from outliving a pause, so no
      // future snapshot can be extrapolated across the paused interval.
      playbackAnchor = null;
      return state;
    }

    const key = playbackSnapshotKey(state.playback);
    const now = monotonicNow();
    if (!playbackAnchor || playbackAnchor.key !== key) {
      playbackAnchor = { key, atMs: receivedAtMs ?? now };
    } else if (
      receivedAtMs !== undefined &&
      receivedAtMs < playbackAnchor.atMs
    ) {
      // A snapshot becomes readable before its own handler finishes: it is written
      // to the room state, then persisted and the shared video's tab opened. A
      // content script rehydrating in that window (`content:get-room-state`) asks
      // for it with no arrival time, which anchors it at *request* time — later
      // than it really arrived. When the handler then supplies the real arrival,
      // correct the anchor backwards, or the interval between the two is lost for
      // as long as the snapshot lasts.
      //
      // Only ever earlier: an arrival cannot postdate a reading of the same
      // snapshot, so the earliest evidence is the best evidence.
      playbackAnchor = { key, atMs: receivedAtMs };
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
