import assert from "node:assert/strict";
import test from "node:test";
import type { RoomState } from "@bili-syncplay/protocol";
import {
  CLOCK_OFFSET_DEADBAND_MS,
  CLOCK_SAMPLE_MAX_AGE_MS,
  CLOCK_SAMPLE_MIN_TRUSTED_SIZE,
  CLOCK_SAMPLE_WINDOW_SIZE,
  compensateRoomStateForClock,
  updateClockSample,
  type ClockSample,
} from "../src/background/clock-sync";

/**
 * A round trip that took `rttMs` while the server clock ran `offsetMs` ahead,
 * with the delay split evenly between the two directions (the case the
 * estimator is exact for).
 */
function pingRoundTrip(args: {
  clientSendTime: number;
  offsetMs: number;
  rttMs: number;
  serverProcessingMs?: number;
}): {
  clientSendTime: number;
  serverReceiveTime: number;
  serverSendTime: number;
  now: number;
} {
  const oneWay = args.rttMs / 2;
  const processing = args.serverProcessingMs ?? 0;
  return {
    clientSendTime: args.clientSendTime,
    serverReceiveTime: args.clientSendTime + oneWay + args.offsetMs,
    serverSendTime: args.clientSendTime + oneWay + args.offsetMs + processing,
    now: args.clientSendTime + args.rttMs + processing,
  };
}

/** Feed a series of samples through the estimator, threading its state. */
function runSamples(
  samples: { offsetMs: number; rttMs: number; atMs: number }[],
): {
  clockOffsetMs: number | null;
  rttMs: number | null;
  window: ClockSample[];
} {
  let clockOffsetMs: number | null = null;
  let rttMs: number | null = null;
  let window: ClockSample[] = [];

  for (const sample of samples) {
    const result = updateClockSample({
      ...pingRoundTrip({
        clientSendTime: sample.atMs,
        offsetMs: sample.offsetMs,
        rttMs: sample.rttMs,
      }),
      previousRttMs: rttMs,
      previousClockOffsetMs: clockOffsetMs,
      previousSamples: window,
    });
    clockOffsetMs = result.clockOffsetMs;
    rttMs = result.rttMs;
    window = result.samples;
  }

  return { clockOffsetMs, rttMs, window };
}

test("recovers the clock offset and round trip from a single sample", () => {
  const result = updateClockSample({
    ...pingRoundTrip({ clientSendTime: 1_000, offsetMs: 200, rttMs: 40 }),
    previousRttMs: null,
    previousClockOffsetMs: null,
  });

  assert.equal(result.clockOffsetMs, 200);
  assert.equal(result.rttMs, 40);
  assert.equal(result.sample.offsetMs, 200);
  assert.equal(result.samples.length, 1);
});

test("server processing time is excluded from the round trip", () => {
  const result = updateClockSample({
    ...pingRoundTrip({
      clientSendTime: 1_000,
      offsetMs: 0,
      rttMs: 30,
      serverProcessingMs: 500,
    }),
    previousRttMs: null,
    previousClockOffsetMs: null,
  });

  assert.equal(result.rttMs, 30);
  assert.equal(result.sample.offsetMs, 0);
});

test("an isolated wild sample does not move the published offset", () => {
  const steady = Array.from({ length: 5 }, (_value, index) => ({
    offsetMs: 200,
    rttMs: 10,
    atMs: 1_000 + index * 15_000,
  }));
  const settled = runSamples(steady);
  assert.equal(settled.clockOffsetMs, 200);

  const withOutlier = runSamples([
    ...steady,
    { offsetMs: 900, rttMs: 10, atMs: 1_000 + 5 * 15_000 },
  ]);

  assert.equal(withOutlier.clockOffsetMs, 200);
});

test("alternating noise leaves the published offset still", () => {
  // The observed failure mode: samples swinging by hundreds of ms while the
  // round trip stays flat. Every one of these would have been mixed straight
  // into an EWMA and re-timed each extrapolated playback target.
  const noisy = [-200, 550, 120, 480, 210, 330, 150, 520, 190].map(
    (offsetMs, index) => ({
      offsetMs,
      rttMs: 10,
      atMs: 1_000 + index * 15_000,
    }),
  );

  const published: (number | null)[] = [];
  let clockOffsetMs: number | null = null;
  let window: ClockSample[] = [];
  for (const sample of noisy) {
    const result = updateClockSample({
      ...pingRoundTrip({
        clientSendTime: sample.atMs,
        offsetMs: sample.offsetMs,
        rttMs: sample.rttMs,
      }),
      previousRttMs: null,
      previousClockOffsetMs: clockOffsetMs,
      previousSamples: window,
    });
    clockOffsetMs = result.clockOffsetMs;
    window = result.samples;
    published.push(clockOffsetMs);
  }

  // Once the window has a majority to appeal to, the published offset stops
  // moving: the median of a symmetric spread never travels a full deadband from
  // where it settled, so extrapolated targets keep advancing at exactly 1x.
  const settled = published.slice(CLOCK_SAMPLE_MIN_TRUSTED_SIZE);
  assert.ok(settled.length >= 5, "expected enough samples past warm-up");
  assert.deepEqual(
    [...new Set(settled)],
    [settled[0]],
    `expected the published offset to hold, saw: ${published.join(",")}`,
  );
});

test("follows a sustained offset change once the window turns over", () => {
  const settled = runSamples(
    Array.from({ length: CLOCK_SAMPLE_WINDOW_SIZE }, (_value, index) => ({
      offsetMs: 100,
      rttMs: 10,
      atMs: 1_000 + index * 15_000,
    })),
  );
  assert.equal(settled.clockOffsetMs, 100);

  const shifted = runSamples([
    ...Array.from({ length: CLOCK_SAMPLE_WINDOW_SIZE }, (_value, index) => ({
      offsetMs: 100,
      rttMs: 10,
      atMs: 1_000 + index * 15_000,
    })),
    ...Array.from({ length: CLOCK_SAMPLE_WINDOW_SIZE }, (_value, index) => ({
      offsetMs: 900,
      rttMs: 10,
      atMs: 1_000 + (CLOCK_SAMPLE_WINDOW_SIZE + index) * 15_000,
    })),
  ]);

  assert.equal(shifted.clockOffsetMs, 900);
});

test("a slow round trip loses to the faster samples in the window", () => {
  const result = runSamples([
    { offsetMs: 100, rttMs: 8, atMs: 1_000 },
    { offsetMs: 100, rttMs: 8, atMs: 16_000 },
    // Asymmetric delay: a 600ms round trip can skew a sample by up to 300ms.
    { offsetMs: 400, rttMs: 600, atMs: 31_000 },
  ]);

  assert.equal(result.clockOffsetMs, 100);
});

test("an impossible round trip cannot disqualify the honest samples", () => {
  // A negative round trip means the four timestamps disagree; such a sample must
  // not become the bar that every other sample is measured against.
  let clockOffsetMs: number | null = null;
  let window: ClockSample[] = [];
  const steady = [
    { offsetMs: 100, rttMs: 10, atMs: 1_000 },
    { offsetMs: 100, rttMs: 10, atMs: 16_000 },
    { offsetMs: 100, rttMs: 10, atMs: 31_000 },
  ];
  for (const sample of steady) {
    const result = updateClockSample({
      ...pingRoundTrip({
        clientSendTime: sample.atMs,
        offsetMs: sample.offsetMs,
        rttMs: sample.rttMs,
      }),
      previousRttMs: null,
      previousClockOffsetMs: clockOffsetMs,
      previousSamples: window,
    });
    clockOffsetMs = result.clockOffsetMs;
    window = result.samples;
  }
  assert.equal(clockOffsetMs, 100);

  // Reported server processing (800ms) exceeds the whole round trip the client
  // measured (0ms), so the derived round trip comes out negative.
  const withImpossible = updateClockSample({
    clientSendTime: 46_000,
    serverReceiveTime: 46_100,
    serverSendTime: 46_900,
    now: 46_000,
    previousRttMs: 10,
    previousClockOffsetMs: clockOffsetMs,
    previousSamples: window,
  });

  assert.ok(withImpossible.sample.rttMs < 0);
  assert.equal(withImpossible.clockOffsetMs, 100);
});

test("samples older than the retention window are dropped", () => {
  const result = updateClockSample({
    ...pingRoundTrip({ clientSendTime: 10_000_000, offsetMs: 300, rttMs: 10 }),
    previousRttMs: 10,
    previousClockOffsetMs: 100,
    previousSamples: [
      {
        offsetMs: 100,
        rttMs: 10,
        at: 10_000_000 - CLOCK_SAMPLE_MAX_AGE_MS - 1,
      },
      {
        offsetMs: 100,
        rttMs: 10,
        at: 10_000_000 - CLOCK_SAMPLE_MAX_AGE_MS - 2,
      },
    ],
  });

  assert.equal(result.samples.length, 1);
  assert.equal(result.clockOffsetMs, 300);
});

test("the window is bounded", () => {
  const result = runSamples(
    Array.from({ length: CLOCK_SAMPLE_WINDOW_SIZE + 6 }, (_value, index) => ({
      offsetMs: 50,
      rttMs: 10,
      atMs: 1_000 + index * 15_000,
    })),
  );

  assert.equal(result.window.length, CLOCK_SAMPLE_WINDOW_SIZE);
});

test("a move just inside the deadband is ignored, just outside is taken", () => {
  const base = Array.from(
    { length: CLOCK_SAMPLE_WINDOW_SIZE },
    (_v, index) => ({
      offsetMs: 0,
      rttMs: 10,
      atMs: 1_000 + index * 15_000,
    }),
  );
  const shiftBy = (delta: number) =>
    runSamples([
      ...base,
      ...Array.from({ length: CLOCK_SAMPLE_WINDOW_SIZE }, (_v, index) => ({
        offsetMs: delta,
        rttMs: 10,
        atMs: 1_000 + (CLOCK_SAMPLE_WINDOW_SIZE + index) * 15_000,
      })),
    ]).clockOffsetMs;

  assert.equal(shiftBy(CLOCK_OFFSET_DEADBAND_MS), 0);
  assert.equal(
    shiftBy(CLOCK_OFFSET_DEADBAND_MS + 1),
    CLOCK_OFFSET_DEADBAND_MS + 1,
  );
});

function playingRoomState(args: {
  currentTime: number;
  serverTime: number;
  playbackRate?: number;
}): RoomState {
  return {
    roomCode: "ABC123",
    members: [],
    sharedVideo: null,
    playback: {
      actorId: "actor",
      seq: 1,
      url: "https://www.bilibili.com/video/BV1",
      playState: "playing",
      currentTime: args.currentTime,
      playbackRate: args.playbackRate ?? 1,
      serverTime: args.serverTime,
    },
  } as unknown as RoomState;
}

test("extrapolates a playing snapshot by the estimated elapsed time", () => {
  const compensated = compensateRoomStateForClock(
    playingRoomState({ currentTime: 100, serverTime: 5_000 }),
    200,
    6_000,
  );

  // 6000 + 200 - 5000 = 1200ms of room time has passed since the snapshot.
  assert.ok(Math.abs(compensated.playback!.currentTime - 101.2) < 0.001);
});

test("scales the extrapolation by the room playback rate", () => {
  const compensated = compensateRoomStateForClock(
    playingRoomState({ currentTime: 100, serverTime: 5_000, playbackRate: 2 }),
    0,
    6_000,
  );

  assert.ok(Math.abs(compensated.playback!.currentTime - 102) < 0.001);
});

test("a snapshot that would predate its own stamp is treated as current", () => {
  const compensated = compensateRoomStateForClock(
    playingRoomState({ currentTime: 100, serverTime: 5_000 }),
    -800,
    5_200,
  );

  assert.equal(compensated.playback!.currentTime, 100);
});

test("leaves paused states and unknown offsets untouched", () => {
  const paused = playingRoomState({ currentTime: 100, serverTime: 5_000 });
  paused.playback!.playState = "paused";
  assert.equal(
    compensateRoomStateForClock(paused, 200, 9_000).playback!.currentTime,
    100,
  );

  const playing = playingRoomState({ currentTime: 100, serverTime: 5_000 });
  assert.equal(
    compensateRoomStateForClock(playing, null, 9_000).playback!.currentTime,
    100,
  );
});
