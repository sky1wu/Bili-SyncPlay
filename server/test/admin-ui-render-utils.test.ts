import assert from "node:assert/strict";
import test from "node:test";
import {
  getPlaybackDisplayPosition,
  getRoomPlaybackSummary,
  getRoomStatusSummary,
} from "../admin-ui/render-utils.js";

const NOW = 1_700_000_000_000;

function roomWithPlayback(playback: Record<string, unknown>, extra = {}) {
  return {
    roomCode: "ROOM8A",
    isActive: true,
    memberCount: 1,
    sharedVideo: { title: "测试视频" },
    playback,
    lastActiveAt: NOW - 5_000,
    ...extra,
  };
}

test("playing playback within stale window extrapolates display position", () => {
  const room = roomWithPlayback({
    playState: "playing",
    currentTime: 100,
    playbackRate: 2,
    serverTime: NOW - 10_000,
  });

  assert.equal(getPlaybackDisplayPosition(room, NOW), 120);
  assert.equal(getRoomPlaybackSummary(room, NOW).secondary, "2:00 · x2.00");
});

test("paused and stale playback keep the last synced position", () => {
  const paused = roomWithPlayback({
    playState: "paused",
    currentTime: 100,
    playbackRate: 1,
    serverTime: NOW - 10_000,
  });
  const stalePlaying = roomWithPlayback({
    playState: "playing",
    currentTime: 100,
    playbackRate: 1,
    serverTime: NOW - 120_000,
  });

  assert.equal(getPlaybackDisplayPosition(paused, NOW), 100);
  assert.equal(getPlaybackDisplayPosition(stalePlaying, NOW), 100);
  assert.equal(getPlaybackDisplayPosition({ playback: null }, NOW), null);
});

test("stale paused playback stays neutral instead of warning", () => {
  const summary = getRoomPlaybackSummary(
    roomWithPlayback({
      playState: "paused",
      currentTime: 61,
      playbackRate: 1,
      serverTime: NOW - 20 * 60_000,
    }),
    NOW,
  );

  assert.equal(summary.tone, "neutral");
  assert.equal(summary.primary, "已暂停");
  assert.equal(summary.secondary, "1:01 · 暂停于 20 分钟前");
});

test("stale playing playback escalates to interrupted sync", () => {
  const summary = getRoomPlaybackSummary(
    roomWithPlayback({
      playState: "playing",
      currentTime: 61,
      playbackRate: 1,
      serverTime: NOW - 3 * 60 * 60 * 1000,
    }),
    NOW,
  );

  assert.equal(summary.tone, "danger");
  assert.equal(summary.primary, "同步中断");
  assert.equal(summary.secondary, "播放中停留在 1:01 · 上次同步 3 小时前");
});

test("stale buffering playback also escalates to interrupted sync", () => {
  const summary = getRoomPlaybackSummary(
    roomWithPlayback({
      playState: "buffering",
      currentTime: 61,
      playbackRate: 1,
      serverTime: NOW - 60_000,
    }),
    NOW,
  );

  assert.equal(summary.tone, "danger");
  assert.equal(summary.primary, "同步中断");
});

test("room status summary composes activity and playback state", () => {
  assert.deepEqual(
    getRoomStatusSummary({ isActive: false, playback: null }, NOW),
    { tone: "neutral", primary: "空闲", secondary: "" },
  );

  const unsynced = getRoomStatusSummary(
    { isActive: true, playback: null, sharedVideo: { title: "测试视频" } },
    NOW,
  );
  assert.equal(unsynced.primary, "活跃 · 未同步");
  assert.equal(unsynced.secondary, "等待播放状态");

  const playing = getRoomStatusSummary(
    roomWithPlayback({
      playState: "playing",
      currentTime: 10,
      playbackRate: 1,
      serverTime: NOW - 1_000,
    }),
    NOW,
  );
  assert.equal(playing.tone, "success");
  assert.equal(playing.primary, "活跃 · 播放中");

  const pausedStale = getRoomStatusSummary(
    roomWithPlayback({
      playState: "paused",
      currentTime: 10,
      playbackRate: 1,
      serverTime: NOW - 60_000,
    }),
    NOW,
  );
  assert.equal(pausedStale.tone, "neutral");
  assert.equal(pausedStale.primary, "活跃 · 已暂停");

  const interrupted = getRoomStatusSummary(
    roomWithPlayback({
      playState: "playing",
      currentTime: 10,
      playbackRate: 1,
      serverTime: NOW - 60_000,
    }),
    NOW,
  );
  assert.equal(interrupted.tone, "danger");
  assert.equal(interrupted.primary, "同步中断");
});
