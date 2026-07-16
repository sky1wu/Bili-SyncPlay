import type { PlaybackState } from "@bili-syncplay/protocol";

// 超过该时长没有播放状态同步就视为陈旧，停止外推。
export const PLAYBACK_STALE_AFTER_MS = 30_000;

export function getPlaybackSyncedAt(
  playback: PlaybackState | null,
  lastActiveAt?: number,
): number | null {
  if (!playback) {
    return null;
  }
  if (Number.isFinite(playback.serverTime)) {
    return playback.serverTime;
  }
  if (Number.isFinite(playback.updatedAt)) {
    return playback.updatedAt;
  }
  return typeof lastActiveAt === "number" && Number.isFinite(lastActiveAt)
    ? lastActiveAt
    : null;
}

export function isPlaybackStale(
  playback: PlaybackState | null,
  lastActiveAt?: number,
  currentTime = Date.now(),
): boolean {
  const syncedAt = getPlaybackSyncedAt(playback, lastActiveAt);
  return syncedAt !== null && currentTime - syncedAt > PLAYBACK_STALE_AFTER_MS;
}

/**
 * 播放中且状态未陈旧时，按最近一次同步的位置 + 经过时间 × 倍速外推当前
 * 位置；其余情况返回同步时的原始位置。
 */
export function getPlaybackDisplayPosition(
  playback: PlaybackState | null,
  lastActiveAt?: number,
  currentTime = Date.now(),
): number | null {
  if (!playback) {
    return null;
  }
  const basePosition = Number(playback.currentTime);
  if (!Number.isFinite(basePosition)) {
    return null;
  }
  const syncedAt = getPlaybackSyncedAt(playback, lastActiveAt);
  if (
    playback.playState !== "playing" ||
    syncedAt === null ||
    isPlaybackStale(playback, lastActiveAt, currentTime)
  ) {
    return basePosition;
  }
  const rate = Number(playback.playbackRate || 1);
  const elapsedSeconds = Math.max(0, (currentTime - syncedAt) / 1000);
  return basePosition + elapsedSeconds * rate;
}

const PLAY_STATE_LABELS: Record<string, string> = {
  playing: "播放中",
  paused: "已暂停",
  buffering: "缓冲中",
};

export function getPlayStateLabel(playback: PlaybackState | null): string {
  if (!playback) {
    return "无播放状态";
  }
  return PLAY_STATE_LABELS[playback.playState] ?? playback.playState;
}

export function formatPlaybackPosition(
  seconds: number | null | undefined,
): string {
  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return "—";
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}
