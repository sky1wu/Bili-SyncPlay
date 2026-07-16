import { Tag } from "antd";
import type { RoomSummary } from "../../api/types.js";

export function RoomStatusTag({
  room,
  currentTime = Date.now(),
}: {
  room: RoomSummary;
  currentTime?: number;
}) {
  if (room.isActive) {
    return <Tag color="success">活跃 · {room.memberCount} 人</Tag>;
  }
  if (room.expiresAt !== null && room.expiresAt <= currentTime) {
    return <Tag color="default">已过期</Tag>;
  }
  return <Tag color="warning">空闲</Tag>;
}
