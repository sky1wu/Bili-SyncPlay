import assert from "node:assert/strict";
import test from "node:test";
import { derivePlaybackSyncIntent } from "../src/content/playback-broadcast";
import type { LocalPlaybackEventSource } from "../src/content/runtime-state";

function deriveAfterSeek(
  eventSource: LocalPlaybackEventSource,
  now: number,
): ReturnType<typeof derivePlaybackSyncIntent> {
  return derivePlaybackSyncIntent({
    eventSource,
    lastExplicitUserAction: { kind: "seek", at: 20_000 },
    lastForcedPauseAt: 0,
    now,
    userGestureGraceMs: 1_200,
  });
}

test("the seek's own events carry explicit-seek", () => {
  for (const eventSource of [
    "seeking",
    "seeked",
    "play",
    "playing",
    "canplay",
  ] as const) {
    assert.equal(
      deriveAfterSeek(eventSource, 20_100),
      "explicit-seek",
      `${eventSource} should carry the seek intent`,
    );
  }
});

test("the periodic timeupdate heartbeat never carries explicit-seek", () => {
  // `timeupdate` broadcasts fire once ~2s have passed since the last one, so
  // after a seek there is reliably one inside the 2.5s intent window. Receivers
  // turn `playing` + `explicit-seek` into an unconditional hard-seek that also
  // tears down in-flight corrections, so tagging the heartbeat made every peer
  // jump ~2s after each seek even when already in sync.
  assert.equal(deriveAfterSeek("timeupdate", 22_100), undefined);
  // Not merely a window question — it must not carry the intent at any point.
  assert.equal(deriveAfterSeek("timeupdate", 20_100), undefined);
});

test("explicit-seek still expires once the broadcast grace elapses", () => {
  assert.equal(deriveAfterSeek("seeked", 22_400), "explicit-seek");
  assert.equal(deriveAfterSeek("seeked", 22_600), undefined);
});

test("an unrelated action kind never produces explicit-seek", () => {
  assert.equal(
    derivePlaybackSyncIntent({
      eventSource: "seeked",
      lastExplicitUserAction: { kind: "play", at: 20_000 },
      lastForcedPauseAt: 0,
      now: 20_100,
      userGestureGraceMs: 1_200,
    }),
    undefined,
  );
});

test("a ratechange gesture is reported as explicit-ratechange", () => {
  assert.equal(
    derivePlaybackSyncIntent({
      eventSource: "ratechange",
      lastExplicitUserAction: { kind: "ratechange", at: 20_000 },
      lastForcedPauseAt: 0,
      now: 20_100,
      userGestureGraceMs: 1_200,
    }),
    "explicit-ratechange",
  );
});

test("an action that predates a forced pause is not an active user intent", () => {
  assert.equal(
    derivePlaybackSyncIntent({
      eventSource: "seeked",
      lastExplicitUserAction: { kind: "seek", at: 20_000 },
      lastForcedPauseAt: 20_050,
      now: 20_100,
      userGestureGraceMs: 1_200,
    }),
    undefined,
  );
});
