import type { RoomState } from "@bili-syncplay/protocol";

export const CLOCK_SYNC_INTERVAL_MS = 15000;

/**
 * How many ping samples the robust offset estimate is drawn from (~2 minutes at
 * `CLOCK_SYNC_INTERVAL_MS`).
 */
export const CLOCK_SAMPLE_WINDOW_SIZE = 8;
/**
 * Samples older than this are dropped before estimating. Also the recovery path
 * for a genuine clock step: after a suspend/resume (or any gap longer than this)
 * the whole window ages out, so the estimate reseeds from fresh samples instead
 * of being held back by pre-step ones.
 */
export const CLOCK_SAMPLE_MAX_AGE_MS = 150_000;
/**
 * A sample only competes for the estimate if its round trip is within this much
 * of the fastest one in the window. A slow round trip is asymmetric far more
 * often than not, and its offset is skewed by up to half the excess delay.
 */
export const CLOCK_SAMPLE_RTT_TOLERANCE_MS = 20;
/**
 * Samples needed before the deadband is trusted to reject anything. Below this
 * the window has no majority to appeal to, so the estimate keeps tracking it —
 * otherwise a wild first sample would be published and then *held* by the very
 * deadband meant to protect against it.
 */
export const CLOCK_SAMPLE_MIN_TRUSTED_SIZE = 3;
/**
 * How far the robust estimate has to move before the *published* offset follows
 * it.
 *
 * The offset is a diagnostic here, not an input to playback: positions are
 * extrapolated from a local monotonic anchor instead (see
 * `extrapolatePlayingRoomState`), precisely because no filter can make a
 * two-clock comparison trustworthy. It is still filtered rather than smoothed so
 * that the number shown in the popup reflects what the clocks are doing instead
 * of jumping with every sample.
 */
export const CLOCK_OFFSET_DEADBAND_MS = 120;

export interface ClockSample {
  offsetMs: number;
  rttMs: number;
  at: number;
}

export function toHealthcheckUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "ws:") {
      parsed.protocol = "http:";
    } else if (parsed.protocol === "wss:") {
      parsed.protocol = "https:";
    } else {
      return null;
    }
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function toConnectionCheckUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "ws:") {
      parsed.protocol = "http:";
    } else if (parsed.protocol === "wss:") {
      parsed.protocol = "https:";
    } else {
      return null;
    }
    parsed.pathname = "/api/connection-check";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export interface ClockSampleResult {
  rttMs: number;
  /** `null` while no sample has ever been believable. */
  clockOffsetMs: number | null;
  /** Retained window, oldest first. Feed back in as `previousSamples`. */
  samples: ClockSample[];
  /** The raw sample this call produced, for diagnostics. */
  sample: {
    offsetMs: number;
    rttMs: number;
    /**
     * `serverReceiveTime - clientSendTime` and `serverSendTime - now`: each is
     * the clock offset plus a one-way delay, with opposite signs. Their
     * half-sum is the offset, their difference the round trip — so a pair that
     * is large while the round trip stays small means one of the four
     * timestamps was written late rather than the clocks genuinely differing.
     */
    outboundMs: number;
    inboundMs: number;
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The offset the window agrees on: the median of the samples whose round trip was
 * competitive, which drops both a slow (and therefore likely asymmetric) round
 * trip and an isolated wild reading.
 *
 * Returns `null` when the window holds nothing worth believing.
 */
function estimateOffsetMs(
  samples: ClockSample[],
): { offsetMs: number; usableCount: number } | null {
  // A negative round trip means the four timestamps contradict each other, so the
  // offset that sample carries is not evidence of anything and is dropped outright
  // — flooring the *bar* at zero is not enough, because a negative round trip
  // always clears `0 + tolerance` and would keep competing for the median (and win
  // it outright once such samples are the majority). They stay in the raw log,
  // where an impossible round trip is itself the diagnostic.
  const usable = samples.filter((sample) => sample.rttMs >= 0);
  if (usable.length === 0) {
    return null;
  }

  const fastestRtt = Math.min(...usable.map((sample) => sample.rttMs));
  const competing = usable.filter(
    (sample) => sample.rttMs <= fastestRtt + CLOCK_SAMPLE_RTT_TOLERANCE_MS,
  );
  return {
    offsetMs: median(competing.map((sample) => sample.offsetMs)),
    usableCount: usable.length,
  };
}

export function updateClockSample(args: {
  clientSendTime: number;
  serverReceiveTime: number;
  serverSendTime: number;
  now: number;
  previousRttMs: number | null;
  previousClockOffsetMs: number | null;
  previousSamples?: ClockSample[];
}): ClockSampleResult {
  const outboundMs = args.serverReceiveTime - args.clientSendTime;
  const inboundMs = args.serverSendTime - args.now;
  const sampleRtt = outboundMs - inboundMs;
  const sampleOffset = (outboundMs + inboundMs) / 2;

  const samples = [
    ...(args.previousSamples ?? []).filter(
      (sample) => args.now - sample.at <= CLOCK_SAMPLE_MAX_AGE_MS,
    ),
    { offsetMs: sampleOffset, rttMs: sampleRtt, at: args.now },
  ].slice(-CLOCK_SAMPLE_WINDOW_SIZE);

  const estimate = estimateOffsetMs(samples);
  // Only follow the estimate once it has moved beyond the deadband, so routine
  // sample noise leaves the published offset untouched. With nothing believable in
  // the window, keep whatever was published rather than inventing a number.
  const clockOffsetMs =
    estimate === null
      ? args.previousClockOffsetMs
      : args.previousClockOffsetMs === null ||
          estimate.usableCount < CLOCK_SAMPLE_MIN_TRUSTED_SIZE ||
          Math.abs(estimate.offsetMs - args.previousClockOffsetMs) >
            CLOCK_OFFSET_DEADBAND_MS
        ? Math.round(estimate.offsetMs)
        : args.previousClockOffsetMs;

  return {
    rttMs:
      args.previousRttMs === null
        ? sampleRtt
        : Math.round(args.previousRttMs * 0.7 + sampleRtt * 0.3),
    clockOffsetMs,
    samples,
    sample: {
      offsetMs: sampleOffset,
      rttMs: sampleRtt,
      outboundMs,
      inboundMs,
    },
  };
}

/**
 * Largest snapshot age still treated as evidence of a room that is playing right
 * now. Roughly five broadcast intervals (a playing member re-broadcasts about
 * every 2.1s).
 *
 * Past that, no broadcast has refreshed the snapshot for long enough that the
 * simplest explanation is not a slow join but a room nobody is playing any more
 * — its last member closed the tab while the state still read `playing` — or a
 * server whose clock stepped between stamping the snapshot and sending it.
 * Crediting the whole gap would then hurl the position forward by however long
 * that lasted, so fall back to the conservative reading: take the position as
 * sent, the pre-#212 behaviour. Under a live room this bound is never anywhere
 * near reached.
 */
export const MAX_TRUSTED_PLAYBACK_AGE_MS = 10_000;

/**
 * Resolve the local monotonic time at which a received snapshot's position was
 * true, from when it arrived and how old the server said it already was.
 *
 * The age is what makes joining a playing room land on the right position: the
 * server hands a new member the last broadcast snapshot, which is up to one
 * broadcast interval old, and without this the receiver would take it as
 * current and start behind. A duration is the only form this can safely take —
 * a timestamp would have to be compared against this machine's clock, which is
 * the two-clock comparison `extrapolatePlayingRoomState` exists to avoid.
 *
 * Missing (legacy server), non-finite, negative, or beyond
 * `MAX_TRUSTED_PLAYBACK_AGE_MS` all resolve to the arrival time itself.
 */
export function resolvePlaybackAnchorAtMs(
  receivedAtMs: number,
  playbackAgeMs: number | undefined,
): number {
  if (
    playbackAgeMs === undefined ||
    !Number.isFinite(playbackAgeMs) ||
    playbackAgeMs <= 0 ||
    playbackAgeMs > MAX_TRUSTED_PLAYBACK_AGE_MS
  ) {
    return receivedAtMs;
  }
  return receivedAtMs - playbackAgeMs;
}

/**
 * Advance a playing snapshot by the time that has passed since it was taken.
 *
 * `elapsedMs` is measured locally — see `ClockController.compensateRoomState` —
 * rather than derived from `serverTime` and a clock offset. Comparing a server
 * timestamp against a local one spans two clocks, so their disagreement lands
 * directly in the extrapolated position: a client whose clock sits 500ms from
 * the server's aims 500ms away from the room, and every time that disagreement
 * moves, the target moves with it. The drift controller cannot tell that apart
 * from real drift and answers with a playback-rate correction, so a clock that
 * wanders produces a permanent rate wobble.
 *
 * Measuring the elapsed time on one clock removes the comparison — and with it
 * the entire class of failure. A dev setup with the server in WSL and the
 * browser on the Windows host (two clocks in one box, resynced by the
 * hypervisor) showed samples spanning -893ms to +1264ms within a minute over a
 * 1ms loopback round trip; no filter can recover a stable offset from that,
 * because there is no stable offset to find.
 */
export function extrapolatePlayingRoomState(
  state: RoomState,
  elapsedMs: number,
): RoomState {
  if (!state.playback || state.playback.playState !== "playing") {
    return state;
  }

  // Time does not run backwards on the clock this is measured with, so a
  // negative value would have to be a caller bug; ignore it rather than rewind
  // the room.
  const advanceMs = Math.max(0, elapsedMs);
  return {
    ...state,
    playback: {
      ...state.playback,
      currentTime:
        state.playback.currentTime +
        (advanceMs / 1000) * state.playback.playbackRate,
    },
  };
}
