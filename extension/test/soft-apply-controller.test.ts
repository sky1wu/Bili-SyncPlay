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
