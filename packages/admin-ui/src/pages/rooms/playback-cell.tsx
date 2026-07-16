import { Tag, Typography } from "antd";
import type { RoomSummary } from "../../api/types.js";
import {
  formatPlaybackPosition,
  getPlaybackDisplayPosition,
  getPlayStateLabel,
  isPlaybackStale,
} from "../../lib/playback.js";
import { useNow } from "../../lib/use-now.js";

const STATE_COLORS: Record<string, string> = {
  playing: "processing",
  paused: "default",
  buffering: "warning",
};

export function PlaybackCell({ room }: { room: RoomSummary }) {
  const playing = room.playback?.playState === "playing";
  // 只有播放中且状态未陈旧才需要每秒外推重绘。
  const ticking = playing && !isPlaybackStale(room.playback, room.lastActiveAt);
  const now = useNow(1_000, ticking);

  if (!room.playback) {
    return <Typography.Text type="secondary">—</Typography.Text>;
  }

  const position = getPlaybackDisplayPosition(
    room.playback,
    room.lastActiveAt,
    now,
  );
  const stale = isPlaybackStale(room.playback, room.lastActiveAt, now);
  const rate = room.playback.playbackRate;

  return (
    <span>
      <Tag color={STATE_COLORS[room.playback.playState] ?? "default"}>
        {getPlayStateLabel(room.playback)}
      </Tag>
      <Typography.Text>{formatPlaybackPosition(position)}</Typography.Text>
      {rate !== 1 ? (
        <Typography.Text type="secondary"> · {rate}x</Typography.Text>
      ) : null}
      {stale ? (
        <Typography.Text type="warning"> · 同步已陈旧</Typography.Text>
      ) : null}
    </span>
  );
}
