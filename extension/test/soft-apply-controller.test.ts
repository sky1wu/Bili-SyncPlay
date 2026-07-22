import assert from "node:assert/strict";
import test from "node:test";
import type { PlaybackState } from "@bili-syncplay/protocol";
import { createContentRuntimeState } from "../src/content/runtime-state";
import { createSoftApplyController } from "../src/content/soft-apply-controller";

function installWindowStub() {
  const originalWindow = globalThis.window;
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const windowStub = {
    setTimeout(callback: () => void) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  };
  Object.assign(globalThis, { window: windowStub });
  return {
    flushTimers() {
      const pending = Array.from(timers.values());
      timers.clear();
      for (const callback of pending) {
        callback();
      }
    },
    restore() {
      Object.assign(globalThis, { window: originalWindow });
    },
  };
}

function createPlayback(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    currentTime: 24,
    playState: "playing",
    playbackRate: 1,
    updatedAt: 1,
    serverTime: 1,
    actorId: "remote",
    seq: 1,
    ...overrides,
  };
}

function createVideo(
  overrides: Partial<HTMLVideoElement> = {},
): HTMLVideoElement {
  return {
    paused: false,
    readyState: 4,
    duration: 120,
    currentTime: 24,
    defaultPlaybackRate: 1,
    playbackRate: 1,
    pause() {},
    play: async () => undefined,
    ...overrides,
  } as HTMLVideoElement;
}

test("chained upsertActiveSoftApply preserves the first session's restore rate", () => {
  const windowStub = installWindowStub();
  try {
    const runtimeState = createContentRuntimeState();
    const video = createVideo({
      currentTime: 24,
      defaultPlaybackRate: 1.3,
      playbackRate: 1.3,
    });
    let now = 10_000;
    const controller = createSoftApplyController({
      runtimeState,
      normalizeUrl: (url) => url?.trim() ?? null,
      getVideoElement: () => video,
      debugLog: () => {},
      userGestureGraceMs: 300,
      programmaticApplyWindowMs: 700,
      getNow: () => now,
      armProgrammaticApplyWindow: () => {},
    });

    controller.upsertActiveSoftApply(
      createPlayback({ currentTime: 24.5, playbackRate: 1 }),
      0.5,
    );

    now = 10_200;
    controller.upsertActiveSoftApply(
      createPlayback({ currentTime: 24.6, playbackRate: 1.3 }),
      0.4,
    );

    video.currentTime = 24.55;
    controller.maintainActiveSoftApply(video);

    assert.ok(
      Math.abs(video.playbackRate - 1) < 0.001,
      `expected restore to original rate 1, got ${video.playbackRate}`,
    );
    assert.ok(
      Math.abs(video.defaultPlaybackRate - 1) < 0.001,
      `expected default restore rate 1, got ${video.defaultPlaybackRate}`,
    );
  } finally {
    windowStub.restore();
  }
});

test("upsertActiveSoftApply for a different url starts a fresh restore rate", () => {
  const windowStub = installWindowStub();
  try {
    const runtimeState = createContentRuntimeState();
    const video = createVideo({ currentTime: 24, playbackRate: 1.2 });
    const controller = createSoftApplyController({
      runtimeState,
      normalizeUrl: (url) => url?.trim() ?? null,
      getVideoElement: () => video,
      debugLog: () => {},
      userGestureGraceMs: 300,
      programmaticApplyWindowMs: 700,
      getNow: () => 10_000,
      armProgrammaticApplyWindow: () => {},
    });

    controller.upsertActiveSoftApply(
      createPlayback({
        url: "https://www.bilibili.com/video/BV1AAAAAAAAA?p=1",
        currentTime: 24,
        playbackRate: 1,
      }),
      0.2,
    );

    controller.upsertActiveSoftApply(
      createPlayback({
        url: "https://www.bilibili.com/video/BV1BBBBBBBBB?p=1",
        currentTime: 24,
        playbackRate: 2,
      }),
      0.2,
    );

    controller.maintainActiveSoftApply(video);

    assert.ok(
      Math.abs(video.playbackRate - 2) < 0.001,
      `expected restore to new session's rate 2, got ${video.playbackRate}`,
    );
  } finally {
    windowStub.restore();
  }
});

test("explicit user ratechange cancels a rate-only session without reverting the user rate", () => {
  const windowStub = installWindowStub();
  try {
    const runtimeState = createContentRuntimeState();
    const video = createVideo({ currentTime: 24, playbackRate: 1 });
    let now = 10_000;
    const controller = createSoftApplyController({
      runtimeState,
      normalizeUrl: (url) => url?.trim() ?? null,
      getVideoElement: () => video,
      debugLog: () => {},
      userGestureGraceMs: 300,
      programmaticApplyWindowMs: 700,
      getNow: () => now,
      armProgrammaticApplyWindow: () => {},
    });

    // Rate-only catch-up bumps the rate; restore snapshot is the base rate 1.
    controller.upsertActiveSoftApply(
      createPlayback({ currentTime: 25, playbackRate: 1 }),
      1,
      {
        armCooldownOnConverge: false,
        relativeDriftClose: { driftSeconds: 1, rateOffsetSeconds: 0.12 },
      },
    );
    video.playbackRate = 1.12;

    // The user then sets their own rate mid-window.
    video.playbackRate = 2;
    controller.cancelActiveSoftApply(video, "user-ratechange");
    assert.ok(
      Math.abs(video.playbackRate - 2) < 0.001,
      `expected user rate 2 to survive, got ${video.playbackRate}`,
    );

    // The session is gone, so a later deadline cannot revert the user's rate.
    now = 30_000;
    controller.maintainActiveSoftApply(video);
    assert.ok(Math.abs(video.playbackRate - 2) < 0.001);
  } finally {
    windowStub.restore();
  }
});

test("drift-closed honors the sticky cooldown of a soft-apply taken over by a rate-only nudge", () => {
  const windowStub = installWindowStub();
  try {
    const runtimeState = createContentRuntimeState();
    const video = createVideo({ currentTime: 24, playbackRate: 1 });
    let now = 10_000;
    const controller = createSoftApplyController({
      runtimeState,
      normalizeUrl: (url) => url?.trim() ?? null,
      getVideoElement: () => video,
      debugLog: () => {},
      userGestureGraceMs: 300,
      programmaticApplyWindowMs: 700,
      getNow: () => now,
      armProgrammaticApplyWindow: () => {},
    });

    // A real soft-apply runs first (arms cooldown on converge by default).
    controller.upsertActiveSoftApply(
      createPlayback({ currentTime: 25, playbackRate: 1 }),
      1,
    );
    // A small (<=0.6s) remote shift re-upserts the same url as a rate-only nudge
    // that on its own would not arm the cooldown.
    now = 10_200;
    controller.upsertActiveSoftApply(
      createPlayback({ currentTime: 25.1, playbackRate: 1 }),
      1,
      {
        armCooldownOnConverge: false,
        relativeDriftClose: { driftSeconds: 1, rateOffsetSeconds: 0.12 },
      },
    );

    // Once the relative-drift deadline elapses, the sticky cooldown must arm.
    now = 30_000;
    controller.maintainActiveSoftApply(video);
    assert.ok(
      runtimeState.softApplyCooldownUntil > now,
      `expected cooldown to be armed, got ${runtimeState.softApplyCooldownUntil}`,
    );
  } finally {
    windowStub.restore();
  }
});

test("isActiveRateOnlyCatchUp flags pure rate-only sessions but not real soft-apply", () => {
  const windowStub = installWindowStub();
  try {
    const runtimeState = createContentRuntimeState();
    const video = createVideo({ currentTime: 24, playbackRate: 1 });
    const controller = createSoftApplyController({
      runtimeState,
      normalizeUrl: (url) => url?.trim() ?? null,
      getVideoElement: () => video,
      debugLog: () => {},
      userGestureGraceMs: 300,
      programmaticApplyWindowMs: 700,
      getNow: () => 10_000,
      armProgrammaticApplyWindow: () => {},
    });

    const url = "https://www.bilibili.com/video/BV1xx411c7mD?p=1";

    // A pure rate-only catch-up is flagged for the matching url only.
    controller.upsertActiveSoftApply(
      createPlayback({ currentTime: 25, playbackRate: 1 }),
      1,
      {
        armCooldownOnConverge: false,
        relativeDriftClose: { driftSeconds: 1, rateOffsetSeconds: 0.12 },
      },
    );
    assert.equal(controller.isActiveRateOnlyCatchUp(url), true);
    assert.equal(controller.isActiveRateOnlyCatchUp("other"), false);
    assert.equal(controller.isActiveRateOnlyCatchUp(null), false);

    // A real soft-apply (writes currentTime, sticky cooldown) is NOT a pure
    // rate-only catch-up even after a rate-only nudge re-upserts the session.
    controller.upsertActiveSoftApply(
      createPlayback({ currentTime: 25, playbackRate: 1 }),
      1,
    );
    controller.upsertActiveSoftApply(
      createPlayback({ currentTime: 25.1, playbackRate: 1 }),
      1,
      {
        armCooldownOnConverge: false,
        relativeDriftClose: { driftSeconds: 1, rateOffsetSeconds: 0.12 },
      },
    );
    assert.equal(controller.isActiveRateOnlyCatchUp(url), false);
  } finally {
    windowStub.restore();
  }
});

test("relative-drift session settling via the timer still honors a sticky cooldown", () => {
  const windowStub = installWindowStub();
  try {
    const runtimeState = createContentRuntimeState();
    const video = createVideo({ currentTime: 24, playbackRate: 1 });
    let now = 10_000;
    const controller = createSoftApplyController({
      runtimeState,
      normalizeUrl: (url) => url?.trim() ?? null,
      getVideoElement: () => video,
      debugLog: () => {},
      userGestureGraceMs: 300,
      programmaticApplyWindowMs: 700,
      getNow: () => now,
      armProgrammaticApplyWindow: () => {},
    });

    // Real soft-apply first (sticky cooldown), then taken over by a rate-only
    // nudge on the same url.
    controller.upsertActiveSoftApply(
      createPlayback({ currentTime: 25, playbackRate: 1 }),
      1,
    );
    now = 10_200;
    controller.upsertActiveSoftApply(
      createPlayback({ currentTime: 25.1, playbackRate: 1 }),
      1,
      {
        armCooldownOnConverge: false,
        relativeDriftClose: { driftSeconds: 1, rateOffsetSeconds: 0.12 },
      },
    );

    // Settle through the scheduled timer (no maintain call), as happens when no
    // timeupdate fires right after the deadline.
    now = 30_000;
    windowStub.flushTimers();
    assert.ok(
      runtimeState.softApplyCooldownUntil > now,
      `expected cooldown armed via timer, got ${runtimeState.softApplyCooldownUntil}`,
    );
  } finally {
    windowStub.restore();
  }
});

test("a steadily advancing peer no longer cancels a catch-up as target-shifted", () => {
  const windowStub = installWindowStub();
  try {
    const runtimeState = createContentRuntimeState();
    let now = 20_000;
    const controller = createSoftApplyController({
      runtimeState,
      normalizeUrl: (url) => url ?? null,
      getVideoElement: () => null,
      debugLog: () => {},
      userGestureGraceMs: 300,
      programmaticApplyWindowMs: 700,
      getNow: () => now,
      armProgrammaticApplyWindow: () => {},
    });

    controller.upsertActiveSoftApply(
      createPlayback({ currentTime: 24.8 }),
      0.8,
      {
        armCooldownOnConverge: false,
        relativeDriftClose: { driftSeconds: 0.8, rateOffsetSeconds: 0.12 },
      },
    );

    // A routine heartbeat 3s later from a peer playing steadily at 1x. Against
    // the frozen snapshot this looks like a 3s jump and used to cancel the
    // session long before it could converge.
    now = 23_000;
    assert.equal(
      controller.shouldCancelActiveSoftApplyForPlayback(
        createPlayback({ currentTime: 27.8 }),
      ),
      null,
    );

    // A genuine unannounced jump still cancels: the peer is 2s past where
    // steady playback would have put it.
    assert.equal(
      controller.shouldCancelActiveSoftApplyForPlayback(
        createPlayback({ currentTime: 29.8 }),
      ),
      "target-shifted",
    );
  } finally {
    windowStub.restore();
  }
});

test("a peer's buffering does not abort an active catch-up, a real pause still does", () => {
  const windowStub = installWindowStub();
  try {
    const runtimeState = createContentRuntimeState();
    let now = 20_000;
    const controller = createSoftApplyController({
      runtimeState,
      normalizeUrl: (url) => url ?? null,
      getVideoElement: () => null,
      debugLog: () => {},
      userGestureGraceMs: 300,
      programmaticApplyWindowMs: 700,
      getNow: () => now,
      armProgrammaticApplyWindow: () => {},
    });

    controller.upsertActiveSoftApply(
      createPlayback({ currentTime: 24.8 }),
      0.8,
      {
        armCooldownOnConverge: false,
        relativeDriftClose: { driftSeconds: 0.8, rateOffsetSeconds: 0.12 },
      },
    );

    // A transient stall of the sender is not a change to where the room is.
    assert.equal(
      controller.shouldCancelActiveSoftApplyForPlayback(
        createPlayback({ currentTime: 24.8, playState: "buffering" }),
      ),
      null,
    );

    // Its frozen position falls further behind the extrapolated target the
    // longer it stalls; that must not read as an unannounced jump either.
    now = 23_000;
    assert.equal(
      controller.shouldCancelActiveSoftApplyForPlayback(
        createPlayback({ currentTime: 24.8, playState: "buffering" }),
      ),
      null,
    );

    // A real stop still ends the session.
    assert.equal(
      controller.shouldCancelActiveSoftApplyForPlayback(
        createPlayback({ currentTime: 24.8, playState: "paused" }),
      ),
      "play-state-changed",
    );
  } finally {
    windowStub.restore();
  }
});

test("hasActiveCorrectionSession covers real soft-apply, not just rate-only catch-ups", () => {
  const windowStub = installWindowStub();
  try {
    const runtimeState = createContentRuntimeState();
    const controller = createSoftApplyController({
      runtimeState,
      normalizeUrl: (url) => url ?? null,
      getVideoElement: () => null,
      debugLog: () => {},
      userGestureGraceMs: 300,
      programmaticApplyWindowMs: 700,
      getNow: () => 20_000,
      armProgrammaticApplyWindow: () => {},
    });
    const url = "https://www.bilibili.com/video/BV1xx411c7mD?p=1";

    // A real soft-apply: it writes currentTime AND elevates the rate, so
    // `isActiveRateOnlyCatchUp` deliberately excludes it — but its rate needs
    // the same protection from being written back to the room's base value.
    controller.upsertActiveSoftApply(
      createPlayback({ currentTime: 24.8 }),
      1.1,
    );

    assert.equal(controller.isActiveRateOnlyCatchUp(url), false);
    assert.equal(controller.hasActiveCorrectionSession(url), true);
    assert.equal(controller.hasActiveCorrectionSession("https://other"), false);
    assert.equal(controller.hasActiveCorrectionSession(null), false);
  } finally {
    windowStub.restore();
  }
});

test("the rate restore on cancel arms a ratechange-scoped window", () => {
  const windowStub = installWindowStub();
  try {
    const runtimeState = createContentRuntimeState();
    const video = createVideo({ currentTime: 24, playbackRate: 1 });
    const armed: Array<{ actorId?: string; scope?: string }> = [];
    const controller = createSoftApplyController({
      runtimeState,
      normalizeUrl: (url) => url?.trim() ?? null,
      getVideoElement: () => video,
      debugLog: () => {},
      userGestureGraceMs: 300,
      programmaticApplyWindowMs: 700,
      getNow: () => 10_000,
      armProgrammaticApplyWindow: (_signature, _reason, actorId, scope) => {
        armed.push({ actorId, scope });
      },
    });

    controller.upsertActiveSoftApply(
      createPlayback({ currentTime: 25.4 }),
      1.4,
    );
    // The reconcile (not the session) writes the elevated rate; mirror it so
    // the cancel below has a rate to restore, which is what arms the window.
    video.playbackRate = 1.25;

    // `onSeeking` calls this before recording the user's explicit seek, so the
    // window it opens must only claim the `ratechange` the restore produces.
    controller.cancelActiveSoftApply(video, "seek");

    assert.deepEqual(armed, [{ actorId: "system", scope: "ratechange" }]);
  } finally {
    windowStub.restore();
  }
});
