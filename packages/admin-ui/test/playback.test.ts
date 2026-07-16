import type { PlaybackState } from "@bili-syncplay/protocol";
import { describe, expect, it } from "vitest";
import {
  PLAYBACK_STALE_AFTER_MS,
  formatPlaybackPosition,
  getPlaybackDisplayPosition,
  getPlaybackSyncedAt,
  getPlayStateLabel,
  isPlaybackStale,
} from "../src/lib/playback.js";

const NOW = 1_800_000_000_000;

function makePlayback(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
    currentTime: 100,
    playState: "playing",
    playbackRate: 1,
    updatedAt: NOW - 10_000,
    serverTime: NOW - 10_000,
    actorId: "member-1",
    seq: 1,
    ...overrides,
  };
}

describe("getPlaybackSyncedAt", () => {
  it("prefers serverTime, falls back to updatedAt then lastActiveAt", () => {
    expect(getPlaybackSyncedAt(makePlayback({ serverTime: 111 }))).toBe(111);
    expect(
      getPlaybackSyncedAt(
        makePlayback({
          serverTime: Number.NaN,
          updatedAt: 222,
        }),
      ),
    ).toBe(222);
    expect(
      getPlaybackSyncedAt(
        makePlayback({ serverTime: Number.NaN, updatedAt: Number.NaN }),
        333,
      ),
    ).toBe(333);
    expect(getPlaybackSyncedAt(null)).toBeNull();
  });
});

describe("isPlaybackStale", () => {
  it("becomes stale after the threshold", () => {
    const playback = makePlayback({ serverTime: NOW - 10_000 });
    expect(isPlaybackStale(playback, undefined, NOW)).toBe(false);
    expect(
      isPlaybackStale(
        playback,
        undefined,
        NOW - 10_000 + PLAYBACK_STALE_AFTER_MS + 1,
      ),
    ).toBe(true);
  });
});

describe("getPlaybackDisplayPosition", () => {
  it("extrapolates while playing and fresh, honoring playback rate", () => {
    const playback = makePlayback({
      currentTime: 100,
      playbackRate: 2,
      serverTime: NOW - 10_000,
    });
    expect(getPlaybackDisplayPosition(playback, undefined, NOW)).toBe(120);
  });

  it("returns the base position when paused or stale", () => {
    const paused = makePlayback({ playState: "paused", currentTime: 100 });
    expect(getPlaybackDisplayPosition(paused, undefined, NOW)).toBe(100);

    const stale = makePlayback({
      currentTime: 100,
      serverTime: NOW - PLAYBACK_STALE_AFTER_MS - 1_000,
    });
    expect(getPlaybackDisplayPosition(stale, undefined, NOW)).toBe(100);
  });

  it("returns null without playback state", () => {
    expect(getPlaybackDisplayPosition(null)).toBeNull();
  });
});

describe("formatPlaybackPosition / getPlayStateLabel", () => {
  it("formats positions", () => {
    expect(formatPlaybackPosition(65)).toBe("1:05");
    expect(formatPlaybackPosition(3_661)).toBe("1:01:01");
    expect(formatPlaybackPosition(null)).toBe("—");
  });

  it("labels play states", () => {
    expect(getPlayStateLabel(makePlayback())).toBe("播放中");
    expect(getPlayStateLabel(makePlayback({ playState: "paused" }))).toBe(
      "已暂停",
    );
    expect(getPlayStateLabel(null)).toBe("无播放状态");
  });
});
