import assert from "node:assert/strict";
import test from "node:test";
import {
  decidePlaybackReconcileMode,
  shouldTreatAsExplicitSeek,
} from "../src/content/playback-reconcile";

test("ignores small playback drift while playing", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 12,
    targetTime: 12.3,
    playState: "playing",
  });

  assert.equal(decision.mode, "ignore");
  assert.equal(decision.reason, "within-threshold");
  assert.ok(Math.abs(decision.delta - 0.3) < 0.001);
});

test("tolerates slightly larger playing drift before escalating to correction", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 12,
    targetTime: 12.42,
    playState: "playing",
  });

  assert.equal(decision.mode, "ignore");
  assert.equal(decision.reason, "within-threshold");
  assert.ok(Math.abs(decision.delta - 0.42) < 0.001);
});

test("widens the ignore window for high playback rates", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 12,
    targetTime: 12.55,
    playState: "playing",
    playbackRate: 2,
  });

  assert.equal(decision.mode, "ignore");
  assert.equal(decision.reason, "within-threshold");
  assert.ok(Math.abs(decision.delta - 0.55) < 0.001);
});

test("uses soft apply for medium playback drift while playing", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 12,
    targetTime: 13.1,
    playState: "playing",
  });

  assert.equal(decision.mode, "soft-apply");
  assert.equal(decision.reason, "playing-soft-drift");
  assert.ok(Math.abs(decision.delta - 1.1) < 0.001);
});

test("uses rate-only adjustment for light playing drift above the ignore window", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 12,
    targetTime: 12.55,
    playState: "playing",
  });

  assert.equal(decision.mode, "rate-only");
  assert.equal(decision.reason, "playing-rate-adjust");
  assert.ok(Math.abs(decision.delta - 0.55) < 0.001);
});

test("prefers rate-only correction for larger drift at 2x playback", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 12,
    targetTime: 13.3,
    playState: "playing",
    playbackRate: 2,
  });

  assert.equal(decision.mode, "rate-only");
  assert.equal(decision.reason, "playing-rate-adjust");
  assert.ok(Math.abs(decision.delta - 1.3) < 0.001);
});

test("forces hard seek for explicit jumps while playing", () => {
  assert.deepEqual(
    decidePlaybackReconcileMode({
      localCurrentTime: 12,
      targetTime: 20,
      playState: "playing",
      isExplicitSeek: true,
    }),
    {
      mode: "hard-seek",
      delta: 8,
      reason: "explicit-seek",
    },
  );
});

test("treats a three-second playing jump as an explicit seek", () => {
  assert.equal(
    shouldTreatAsExplicitSeek({
      syncIntent: "explicit-seek",
      playState: "playing",
    }),
    true,
  );
});

test("does not infer explicit seek from a small playing delta without sender intent", () => {
  assert.equal(
    shouldTreatAsExplicitSeek({
      playState: "playing",
    }),
    false,
  );
});

test("forces hard seek for explicit seek intent even within a one-second delta", () => {
  assert.deepEqual(
    decidePlaybackReconcileMode({
      localCurrentTime: 12,
      targetTime: 13,
      playState: "playing",
      isExplicitSeek: true,
    }),
    {
      mode: "hard-seek",
      delta: 1,
      reason: "explicit-seek",
    },
  );
});

test("uses hard seek once playing drift exceeds the tighter soft-apply window", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 12,
    targetTime: 13.35,
    playState: "playing",
  });

  assert.equal(decision.mode, "hard-seek");
  assert.equal(decision.reason, "playing-hard-drift");
  assert.ok(Math.abs(decision.delta - 1.35) < 0.001);
});

test("keeps paused playback on the fast hard-seek path", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 12,
    targetTime: 12.4,
    playState: "paused",
  });

  assert.equal(decision.mode, "hard-seek");
  assert.equal(decision.reason, "paused-or-buffering");
  assert.ok(Math.abs(decision.delta - 0.4) < 0.001);
});

test("playing ignore threshold has hysteresis while a catch-up is running", () => {
  const input = {
    localCurrentTime: 27.36,
    targetTime: 27.8,
    playState: "playing" as const,
    playbackRate: 1,
  };

  // 0.44s is inside the band that would never have started a correction...
  assert.equal(
    decidePlaybackReconcileMode({ ...input, hasActiveCatchUp: false }).mode,
    "ignore",
  );

  // ...but once one is running, stopping here is what left the residual drift
  // behind and let each buffer hiccup ratchet the offset up.
  const duringCatchUp = decidePlaybackReconcileMode({
    ...input,
    hasActiveCatchUp: true,
  });
  assert.equal(duringCatchUp.mode, "rate-only");
  assert.equal(duringCatchUp.reason, "playing-rate-adjust");
});

test("a catch-up still terminates once the drift is genuinely closed", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 29.78,
    targetTime: 29.8,
    playState: "playing",
    playbackRate: 1,
    hasActiveCatchUp: true,
  });

  assert.equal(decision.mode, "ignore");
  assert.equal(decision.reason, "within-threshold");
});

test("a buffering peer's frozen position never drags the local playhead", () => {
  // The peer stalled 3s ago and its reported position has not moved since.
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 514.9,
    targetTime: 511.94,
    playState: "buffering",
    playbackRate: 1,
  });

  assert.equal(decision.mode, "ignore");
  assert.equal(decision.reason, "buffering-not-authoritative");
});

test("a deliberate jump reported mid-buffer is still followed", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 514.9,
    targetTime: 480,
    playState: "buffering",
    isExplicitSeek: shouldTreatAsExplicitSeek({
      syncIntent: "explicit-seek",
      playState: "buffering",
    }),
  });

  // Guard, not a discriminator: this path hard-seeks both before and after the
  // buffering change. It exists so the new "never chase a buffering peer" rule
  // cannot later be widened into swallowing a deliberate jump.
  assert.equal(decision.mode, "hard-seek");
  assert.equal(decision.reason, "paused-or-buffering");
});

test("a paused peer still aligns the room on its position", () => {
  const decision = decidePlaybackReconcileMode({
    localCurrentTime: 514.9,
    targetTime: 511.94,
    playState: "paused",
    playbackRate: 1,
  });

  assert.equal(decision.mode, "hard-seek");
  assert.equal(decision.reason, "paused-or-buffering");
});
