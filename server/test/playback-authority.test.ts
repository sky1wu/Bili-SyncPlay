import assert from "node:assert/strict";
import test from "node:test";
import { decidePlaybackAcceptance } from "../src/playback-authority.js";

test("playback authority ignores non-explicit follow-up play during another actor's authority window", () => {
  const decision = decidePlaybackAcceptance({
    currentPlayback: {
      currentTime: 42,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 100,
      serverTime: 0,
      actorId: "owner",
    },
    authority: {
      actorId: "owner",
      kind: "play",
      until: 200,
      baselineCurrentTime: 42,
      baselineUpdatedAt: 100,
      baselinePlaybackRate: 1,
    },
    incomingPlayback: {
      currentTime: 42.3,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 110,
      serverTime: 0,
      actorId: "guest",
    },
    currentTime: 150,
  });

  assert.deepEqual(decision, {
    decision: "ignore-as-follow",
    reason: "authority-window-follow",
  });
});

test("playback authority ignores stale-like playing updates that regress behind current playback", () => {
  const decision = decidePlaybackAcceptance({
    currentPlayback: {
      currentTime: 20,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 100,
      serverTime: 0,
      actorId: "owner",
    },
    authority: null,
    incomingPlayback: {
      currentTime: 19,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 110,
      serverTime: 0,
      actorId: "guest",
    },
    currentTime: 150,
  });

  assert.deepEqual(decision, {
    decision: "ignore-stale-like",
    reason: "timeline-regression",
  });
});

test("playback authority accepts explicit control even inside another actor's authority window", () => {
  const decision = decidePlaybackAcceptance({
    currentPlayback: {
      currentTime: 42,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 100,
      serverTime: 0,
      actorId: "owner",
    },
    authority: {
      actorId: "owner",
      kind: "seek",
      until: 200,
      baselineCurrentTime: 42,
      baselineUpdatedAt: 100,
      baselinePlaybackRate: 1,
    },
    incomingPlayback: {
      currentTime: 43,
      playState: "paused",
      playbackRate: 1,
      updatedAt: 110,
      serverTime: 0,
      actorId: "guest",
      syncIntent: "explicit-seek",
    },
    currentTime: 150,
  });

  assert.deepEqual(decision, {
    decision: "accept",
    reason: "default",
  });
});
