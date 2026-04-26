import assert from "node:assert/strict";
import test from "node:test";
import type { ProgrammaticPlaybackSignature } from "../src/content/runtime-state";
import {
  applyPendingPlaybackApplication,
  syncPlaybackPosition,
} from "../src/content/player-binding";

function createVideo(
  overrides: Partial<HTMLVideoElement> = {},
): HTMLVideoElement {
  return {
    paused: false,
    readyState: 4,
    duration: 120,
    currentTime: 12,
    defaultPlaybackRate: 1,
    playbackRate: 1,
    pause() {},
    play: async () => undefined,
    ...overrides,
  } as HTMLVideoElement;
}

test("rate-only adjustment nudges playback rate without rewriting current time for medium drift", () => {
  const video = createVideo({
    currentTime: 12,
    playbackRate: 1,
  });

  const applied = syncPlaybackPosition(video, 12.8, "playing", undefined, 1);

  assert.ok(Math.abs(video.currentTime - 12) < 0.001);
  assert.ok(Math.abs(video.playbackRate - 1.12) < 0.001);
  assert.equal(applied.mode, "rate-only");
  assert.equal(applied.targetTime, 12.8);
  assert.equal(applied.restorePlaybackRate, 1);
  assert.equal(applied.currentTime, 12);
  assert.equal(applied.playbackRate, 1.12);
  assert.equal(applied.reason, "playing-rate-adjust");
  assert.ok(Math.abs(applied.delta - 0.8) < 0.001);
  assert.equal(applied.didWriteCurrentTime, false);
  assert.equal(applied.didWritePlaybackRate, true);
});

test("rate-only adjustment slows playback without rewriting current time when local timeline is ahead", () => {
  const video = createVideo({
    currentTime: 12.8,
    playbackRate: 1,
  });

  const applied = syncPlaybackPosition(video, 12, "playing", undefined, 1);

  assert.ok(Math.abs(video.currentTime - 12.8) < 0.001);
  assert.ok(Math.abs(video.playbackRate - 0.88) < 0.001);
  assert.equal(applied.mode, "rate-only");
  assert.equal(applied.targetTime, 12);
  assert.equal(applied.restorePlaybackRate, 1);
  assert.equal(applied.currentTime, 12.8);
  assert.equal(applied.playbackRate, 0.88);
  assert.equal(applied.reason, "playing-rate-adjust");
  assert.ok(Math.abs(applied.delta - 0.8) < 0.001);
  assert.equal(applied.didWriteCurrentTime, false);
  assert.equal(applied.didWritePlaybackRate, true);
});

test("rate-only adjustment widens playback-rate correction at 2x", () => {
  const video = createVideo({
    currentTime: 12,
    playbackRate: 2,
  });

  const applied = syncPlaybackPosition(video, 13.1, "playing", undefined, 2);

  assert.equal(applied.mode, "rate-only");
  assert.ok(Math.abs(video.currentTime - 12) < 0.001);
  assert.ok(Math.abs(video.playbackRate - 2.198) < 0.001);
  assert.equal(applied.didWriteCurrentTime, false);
  assert.equal(applied.didWritePlaybackRate, true);
});

test("programmatic apply signature tracks the soft-applied position instead of the raw remote target", () => {
  const video = createVideo({
    currentTime: 12,
    playbackRate: 1,
  });
  const signatures: Array<{
    url: string;
    playState: "playing" | "paused" | "buffering";
    currentTime: number;
    playbackRate: number;
  }> = [];

  const applied = applyPendingPlaybackApplication({
    video,
    pendingPlaybackApplication: {
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      currentTime: 13.1,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 1,
      serverTime: 1,
      actorId: "remote-member",
      seq: 3,
    },
    clearPendingPlaybackApplication: () => {},
    markProgrammaticApply: (signature) => {
      signatures.push(signature);
    },
    debugLog: () => {},
  });

  assert.equal(applied.applied, true);
  assert.equal(applied.didChange, true);
  assert.equal(signatures.length, 1);
  assert.ok(Math.abs(signatures[0]!.currentTime - 12.4) < 0.001);
  assert.ok(Math.abs(signatures[0]!.playbackRate - 1.12) < 0.001);
});

test("soft apply uses a more conservative time step than the raw drift", () => {
  const video = createVideo({
    currentTime: 12,
    playbackRate: 1,
  });

  const applied = syncPlaybackPosition(video, 13.1, "playing", undefined, 1);

  assert.equal(applied.mode, "soft-apply");
  assert.ok(Math.abs(video.currentTime - 12.4) < 0.001);
  assert.ok(Math.abs(applied.targetTime - applied.currentTime - 0.7) < 0.001);
  assert.equal(applied.didWriteCurrentTime, true);
});

test("soft apply keeps a smaller time step but a wider rate offset at 2x", () => {
  const video = createVideo({
    currentTime: 12,
    playbackRate: 2,
  });

  const applied = syncPlaybackPosition(video, 13.7, "playing", undefined, 2);

  assert.equal(applied.mode, "soft-apply");
  assert.ok(video.currentTime > 12);
  assert.ok(video.currentTime < 12.4);
  assert.ok(Math.abs(video.playbackRate - 2.22) < 0.001);
  assert.equal(applied.didWriteCurrentTime, true);
  assert.equal(applied.didWritePlaybackRate, true);
});

test("explicit seek still uses hard seek for immediate alignment", () => {
  const video = createVideo({
    currentTime: 12,
    playbackRate: 1,
  });

  const applied = syncPlaybackPosition(
    video,
    25,
    "playing",
    "explicit-seek",
    1,
  );

  assert.equal(applied.mode, "hard-seek");
  assert.ok(Math.abs(video.currentTime - 25) < 0.001);
  assert.equal(applied.didWriteCurrentTime, true);
});

test("large playing drift still escalates to hard seek", () => {
  const video = createVideo({
    currentTime: 12,
    playbackRate: 1,
  });

  const applied = syncPlaybackPosition(video, 13.6, "playing", undefined, 1);

  assert.equal(applied.mode, "hard-seek");
  assert.ok(Math.abs(video.currentTime - 13.6) < 0.001);
  assert.equal(applied.didWriteCurrentTime, true);
});

test("ignore-window playback update does not arm programmatic apply when nothing actually changed", () => {
  const video = createVideo({
    paused: false,
    currentTime: 12,
    playbackRate: 1,
  });
  const signatures: ProgrammaticPlaybackSignature[] = [];

  const applied = applyPendingPlaybackApplication({
    video,
    pendingPlaybackApplication: {
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      currentTime: 12.28,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 1,
      serverTime: 1,
      actorId: "remote-member",
      seq: 4,
    },
    clearPendingPlaybackApplication: () => {},
    markProgrammaticApply: (signature) => {
      signatures.push(signature);
    },
    debugLog: () => {},
  });

  assert.equal(applied.applied, true);
  assert.equal(applied.didChange, false);
  assert.equal(applied.adjustment?.mode, "ignore");
  assert.equal(applied.adjustment?.reason, "within-threshold");
  assert.equal(applied.adjustment?.didWriteCurrentTime, false);
  assert.equal(applied.adjustment?.didWritePlaybackRate, false);
  assert.equal(signatures.length, 0);
});

test("ignore-window playback update still restores playbackRate when only the rate drifted", () => {
  const video = createVideo({
    paused: false,
    currentTime: 12,
    defaultPlaybackRate: 1.1,
    playbackRate: 1.1,
  });

  const applied = applyPendingPlaybackApplication({
    video,
    pendingPlaybackApplication: {
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      currentTime: 12.15,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 1,
      serverTime: 1,
      actorId: "remote-member",
      seq: 6,
    },
    clearPendingPlaybackApplication: () => {},
    debugLog: () => {},
  });

  assert.equal(applied.applied, true);
  assert.equal(applied.didChange, true);
  assert.equal(applied.adjustment?.mode, "ignore");
  assert.equal(applied.adjustment?.didWriteCurrentTime, false);
  assert.equal(applied.adjustment?.didWritePlaybackRate, true);
  assert.ok(Math.abs(video.playbackRate - 1) < 0.001);
  assert.ok(Math.abs(video.defaultPlaybackRate - 1) < 0.001);
});

test("buffering playback update does not force-pause an already playing video", () => {
  let pauseCalls = 0;
  const video = createVideo({
    paused: false,
    currentTime: 12,
    playbackRate: 1,
    pause() {
      pauseCalls += 1;
    },
  });
  const signatures: ProgrammaticPlaybackSignature[] = [];

  const applied = applyPendingPlaybackApplication({
    video,
    pendingPlaybackApplication: {
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      currentTime: 12,
      playState: "buffering",
      playbackRate: 1,
      updatedAt: 1,
      serverTime: 1,
      actorId: "remote-member",
      seq: 5,
    },
    clearPendingPlaybackApplication: () => {},
    markProgrammaticApply: (signature) => {
      signatures.push(signature);
    },
    debugLog: () => {},
  });

  assert.equal(applied.applied, true);
  assert.equal(applied.didChange, false);
  assert.equal(applied.adjustment?.mode, "ignore");
  assert.equal(pauseCalls, 0);
  assert.equal(signatures.length, 0);
});
