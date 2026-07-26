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
 * Stability matters more here than absolute accuracy. A residual bias shifts a
 * receiver a fixed amount from the room and is invisible while watching; an
 * offset that wanders re-times every extrapolated target, which the drift
 * controller cannot tell apart from real drift — it answers with a playback-rate
 * correction, and a wandering offset therefore produces a permanent rate wobble
 * (see PLAYING_CATCH_UP_IGNORE_THRESHOLD_SECONDS, whose 0.05s exit threshold sits
 * far below the noise this filter exists to remove). Holding the published value
 * still inside the deadband keeps extrapolated targets advancing at exactly real
 * time, which is what makes a measured drift mean real drift.
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
  clockOffsetMs: number;
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
 * The offset the window agrees on: the median of the samples whose round trip
 * was competitive, which drops both a slow (and therefore likely asymmetric)
 * round trip and an isolated wild reading.
 */
function estimateOffsetMs(samples: ClockSample[]): number {
  // Floored at zero: a negative round trip is impossible, so an inconsistent
  // sample must not be allowed to set a bar that excludes every honest one.
  const fastestRtt = Math.max(
    0,
    Math.min(...samples.map((sample) => sample.rttMs)),
  );
  const competing = samples.filter(
    (sample) => sample.rttMs <= fastestRtt + CLOCK_SAMPLE_RTT_TOLERANCE_MS,
  );
  return median(competing.map((sample) => sample.offsetMs));
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

  const estimatedOffset = estimateOffsetMs(samples);
  // Only follow the estimate once it has moved beyond the deadband, so routine
  // sample noise leaves the published offset — and every target extrapolated
  // from it — untouched.
  const clockOffsetMs =
    args.previousClockOffsetMs === null ||
    samples.length < CLOCK_SAMPLE_MIN_TRUSTED_SIZE ||
    Math.abs(estimatedOffset - args.previousClockOffsetMs) >
      CLOCK_OFFSET_DEADBAND_MS
      ? Math.round(estimatedOffset)
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

export function compensateRoomStateForClock(
  state: RoomState,
  clockOffsetMs: number | null,
  now = Date.now(),
): RoomState {
  if (
    !state.playback ||
    clockOffsetMs === null ||
    state.playback.playState !== "playing"
  ) {
    return state;
  }

  const estimatedServerNow = now + clockOffsetMs;
  // A state cannot reach us before the server stamped it, so a negative estimate
  // is always offset error rather than information: pinning it to zero (i.e.
  // "this snapshot is current") is strictly the better guess, and it bounds how
  // far a bad offset can drag the target. The clamp is one-sided on purpose —
  // the upper side has to stay open because `serverTime` is legitimately old
  // whenever a stored state is replayed (a member joining a room that has been
  // playing for a while, or a tab binding late), and those must extrapolate the
  // full elapsed time.
  //
  // It does mean an offset estimate crossing zero steps the target by whatever
  // the estimate was off by. That is why the estimate is filtered for stability
  // rather than just smoothed (see CLOCK_OFFSET_DEADBAND_MS); the clamp cannot
  // paper over a wandering offset, it only bounds one side of it.
  const elapsedMs = Math.max(0, estimatedServerNow - state.playback.serverTime);
  return {
    ...state,
    playback: {
      ...state.playback,
      currentTime:
        state.playback.currentTime +
        (elapsedMs / 1000) * state.playback.playbackRate,
    },
  };
}
