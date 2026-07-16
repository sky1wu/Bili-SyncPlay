// 常见事件名的中文标签；未收录的事件原样展示事件名。
export const EVENT_LABELS: Record<string, string> = {
  room_created: "创建房间",
  room_joined: "加入房间",
  room_left: "离开房间",
  room_restored: "房间恢复",
  room_persisted: "房间持久化",
  room_expired_deleted: "过期清理",
  room_expiry_scheduled: "计划过期",
  video_shared: "共享视频",
  playback_update_applied: "播放状态更新",
  playback_update_ignored: "播放更新被忽略",
  playback_update_deduplicated: "播放更新去重",
  rate_limited: "触发限流",
  ws_connection_rejected: "连接被拒",
  auth_failed: "认证失败",
  invalid_message: "非法消息",
  protocol_version_missing: "协议版本缺失",
  protocol_version_rejected: "协议版本被拒",
  admin_room_closed: "管理端关闭房间",
  admin_room_expired: "管理端提前过期",
  admin_room_video_cleared: "管理端清空视频",
  admin_member_kicked: "管理端踢出成员",
  admin_session_disconnected: "管理端断开会话",
};

export function getEventLabel(event: string): string | null {
  return EVENT_LABELS[event] ?? null;
}
