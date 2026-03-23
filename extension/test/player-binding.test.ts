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
    playbackRate: 1,
    pause() {},
    play: async () => undefined,
    ...overrides,
  } as HTMLVideoElement;
}

test("soft apply nudges current time and playback rate toward the remote target", () => {
  const video = createVideo({
    currentTime: 12,
    playbackRate: 1,
  });

  const applied = syncPlaybackPosition(video, 12.8, "playing", undefined, 1);

  assert.ok(Math.abs(video.currentTime - 12.48) < 0.001);
  assert.ok(Math.abs(video.playbackRate - 1.12) < 0.001);
  assert.equal(applied.mode, "soft-apply");
  assert.equal(applied.targetTime, 12.8);
  assert.equal(applied.restorePlaybackRate, 1);
  assert.equal(applied.currentTime, 12.48);
  assert.equal(applied.playbackRate, 1.12);
  assert.equal(applied.reason, "playing-drift");
  assert.ok(Math.abs(applied.delta - 0.8) < 0.001);
  assert.equal(applied.didWriteCurrentTime, true);
  assert.equal(applied.didWritePlaybackRate, true);
});

test("soft apply slows down when local playback is ahead of the room timeline", () => {
  const video = createVideo({
    currentTime: 12.8,
    playbackRate: 1,
  });

  const applied = syncPlaybackPosition(video, 12, "playing", undefined, 1);

  assert.ok(Math.abs(video.currentTime - 12.32) < 0.001);
  assert.ok(Math.abs(video.playbackRate - 0.88) < 0.001);
  assert.equal(applied.mode, "soft-apply");
  assert.equal(applied.targetTime, 12);
  assert.equal(applied.restorePlaybackRate, 1);
  assert.equal(applied.currentTime, 12.32);
  assert.equal(applied.playbackRate, 0.88);
  assert.equal(applied.reason, "playing-drift");
  assert.ok(Math.abs(applied.delta - 0.8) < 0.001);
  assert.equal(applied.didWriteCurrentTime, true);
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
      currentTime: 12.8,
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
  assert.ok(Math.abs(signatures[0]!.currentTime - 12.48) < 0.001);
  assert.ok(Math.abs(signatures[0]!.playbackRate - 1.12) < 0.001);
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
