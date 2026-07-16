import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import type {
  RoomDetailMember,
  RoomSummary,
  RuntimeEventRecord,
} from "../../api/types.js";
import { formatDateTime } from "../../lib/format.js";
import { PlaybackCell } from "./playback-cell.js";
import { RoomStatusTag } from "./room-status-tag.js";
import { useRoomDetailQuery } from "./rooms-queries.js";
import type { PendingGovernanceAction } from "./reason-modal.js";
import type { RoomGovernanceHandlers } from "./rooms-table.js";

export type MemberGovernanceHandlers = {
  kickMember: (
    room: RoomSummary,
    member: RoomDetailMember,
  ) => PendingGovernanceAction;
  disconnectSession: (
    room: RoomSummary,
    member: RoomDetailMember,
  ) => PendingGovernanceAction;
};

export function RoomDetailDrawer({
  roomCode,
  autoRefresh,
  manageable,
  onClose,
  onAction,
  governance,
  memberGovernance,
}: {
  roomCode: string | null;
  autoRefresh: boolean;
  manageable: boolean;
  onClose: () => void;
  onAction: (pending: PendingGovernanceAction) => void;
  governance: RoomGovernanceHandlers;
  memberGovernance: MemberGovernanceHandlers;
}) {
  const detailQuery = useRoomDetailQuery(roomCode, autoRefresh);
  const detail = detailQuery.data;

  return (
    <Drawer
      open={roomCode !== null}
      onClose={onClose}
      width={720}
      title={`房间 ${roomCode ?? ""}`}
    >
      {detailQuery.isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spin />
        </div>
      ) : detailQuery.isError ? (
        <Alert
          type="error"
          showIcon
          message="房间详情加载失败"
          description={
            detailQuery.error instanceof Error
              ? detailQuery.error.message
              : "请求失败。"
          }
        />
      ) : detail ? (
        <Space direction="vertical" size={16} style={{ display: "flex" }}>
          {manageable ? (
            <Space wrap>
              <Button
                danger
                size="small"
                onClick={() => onAction(governance.closeRoom(detail.room))}
              >
                关闭房间
              </Button>
              <Button
                size="small"
                disabled={detail.room.isActive}
                title={
                  detail.room.isActive
                    ? "房间仍有在线成员，仅空闲房间可提前过期"
                    : undefined
                }
                onClick={() => onAction(governance.expireRoom(detail.room))}
              >
                提前过期
              </Button>
              <Button
                size="small"
                onClick={() => onAction(governance.clearRoomVideo(detail.room))}
              >
                清空共享视频
              </Button>
            </Space>
          ) : null}

          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="状态">
              <RoomStatusTag room={detail.room} />
            </Descriptions.Item>
            <Descriptions.Item label="房主">
              {detail.room.ownerDisplayName ?? "—"}
            </Descriptions.Item>
            <Descriptions.Item label="创建时间">
              {formatDateTime(detail.room.createdAt)}
            </Descriptions.Item>
            <Descriptions.Item label="最近活跃">
              {formatDateTime(detail.room.lastActiveAt)}
            </Descriptions.Item>
            <Descriptions.Item label="过期时间">
              {detail.room.expiresAt === null
                ? "不过期"
                : formatDateTime(detail.room.expiresAt)}
            </Descriptions.Item>
            <Descriptions.Item label="所在节点">
              {detail.room.instanceIds.length > 0
                ? detail.room.instanceIds.join(", ")
                : (detail.instanceId ?? "—")}
            </Descriptions.Item>
            <Descriptions.Item label="共享视频" span={2}>
              {detail.room.sharedVideo ? (
                <Typography.Link
                  href={detail.room.sharedVideo.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {detail.room.sharedVideo.title || detail.room.sharedVideo.url}
                </Typography.Link>
              ) : (
                "未共享视频"
              )}
            </Descriptions.Item>
            <Descriptions.Item label="播放状态" span={2}>
              <PlaybackCell room={detail.room} />
            </Descriptions.Item>
          </Descriptions>

          <Typography.Title level={5} style={{ margin: 0 }}>
            在线成员（{detail.members.length}）
          </Typography.Title>
          <Table<RoomDetailMember>
            size="small"
            rowKey="sessionId"
            pagination={false}
            dataSource={detail.members}
            locale={{ emptyText: "当前没有在线成员。" }}
            columns={[
              {
                title: "成员",
                dataIndex: "displayName",
                render: (displayName: string, member) => (
                  <>
                    <Typography.Text strong>{displayName}</Typography.Text>
                    {member.memberId === detail.room.ownerMemberId ? (
                      <Tag color="blue" style={{ marginLeft: 8 }}>
                        房主
                      </Tag>
                    ) : null}
                    <br />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {member.memberId}
                    </Typography.Text>
                  </>
                ),
              },
              {
                title: "加入时间",
                dataIndex: "joinedAt",
                render: (value: number) => formatDateTime(value),
              },
              {
                title: "来源",
                dataIndex: "remoteAddress",
                render: (_value, member) => (
                  <>
                    {member.remoteAddress ?? "—"}
                    <br />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {member.origin ?? "—"}
                    </Typography.Text>
                  </>
                ),
              },
              ...(manageable
                ? [
                    {
                      title: "操作",
                      key: "actions",
                      render: (_value: unknown, member: RoomDetailMember) => (
                        <Space>
                          <Button
                            size="small"
                            danger
                            onClick={() =>
                              onAction(
                                memberGovernance.kickMember(
                                  detail.room,
                                  member,
                                ),
                              )
                            }
                          >
                            踢出
                          </Button>
                          <Button
                            size="small"
                            onClick={() =>
                              onAction(
                                memberGovernance.disconnectSession(
                                  detail.room,
                                  member,
                                ),
                              )
                            }
                          >
                            断开会话
                          </Button>
                        </Space>
                      ),
                    },
                  ]
                : []),
            ]}
          />

          <Typography.Title level={5} style={{ margin: 0 }}>
            最近事件（{detail.recentEvents.length}）
          </Typography.Title>
          <Table<RuntimeEventRecord>
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={detail.recentEvents}
            locale={{ emptyText: "暂无事件。" }}
            columns={[
              {
                title: "时间",
                dataIndex: "timestamp",
                width: 170,
                render: (value: string) => formatDateTime(Date.parse(value)),
              },
              { title: "事件", dataIndex: "event" },
              {
                title: "结果",
                dataIndex: "result",
                render: (value: string | null) =>
                  value ? <Tag>{value}</Tag> : "—",
              },
            ]}
          />
        </Space>
      ) : null}
    </Drawer>
  );
}
