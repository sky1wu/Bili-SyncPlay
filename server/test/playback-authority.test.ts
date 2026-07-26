import assert from "node:assert/strict";
import test from "node:test";
import { decidePlaybackAcceptance } from "../src/playback-authority.js";

test("playback authority ignores non-explicit follow-up play during another actor's authority window", () => {
  const decision = decidePlaybackAcceptance({
    currentPlayback: {
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      currentTime: 42,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 100,
      serverTime: 0,
      actorId: "owner",
      seq: 1,
    },
    authority: {
      actorId: "owner",
      kind: "play",
      until: 200,
      source: "playback:update",
    },
    incomingPlayback: {
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      currentTime: 42.3,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 110,
      serverTime: 0,
      actorId: "guest",
      seq: 2,
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
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      currentTime: 20,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 100,
      serverTime: 0,
      actorId: "owner",
      seq: 1,
    },
    authority: null,
    incomingPlayback: {
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      currentTime: 19,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 110,
      serverTime: 0,
      actorId: "guest",
      seq: 2,
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
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      currentTime: 42,
      playState: "playing",
      playbackRate: 1,
      updatedAt: 100,
      serverTime: 0,
      actorId: "owner",
      seq: 1,
    },
    authority: {
      actorId: "owner",
      kind: "seek",
      until: 200,
      source: "playback:update",
    },
    incomingPlayback: {
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      currentTime: 43,
      playState: "paused",
      playbackRate: 1,
      updatedAt: 110,
      serverTime: 0,
      actorId: "guest",
      syncIntent: "explicit-seek",
      seq: 2,
    },
    currentTime: 150,
  });

  assert.deepEqual(decision, {
    decision: "accept",
    reason: "default",
  });
});
