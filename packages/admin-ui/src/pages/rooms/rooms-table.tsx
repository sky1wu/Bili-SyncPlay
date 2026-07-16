import { DownOutlined } from "@ant-design/icons";
import { Button, Dropdown, Space, Table, Typography } from "antd";
import type { TablePaginationConfig } from "antd";
import type { SorterResult } from "antd/es/table/interface";
import type {
  RoomListQuery,
  RoomListResult,
  RoomSortBy,
  RoomSummary,
} from "../../api/types.js";
import { formatDateTime } from "../../lib/format.js";
import { PlaybackCell } from "./playback-cell.js";
import { RoomStatusTag } from "./room-status-tag.js";
import type { PendingGovernanceAction } from "./reason-modal.js";

export type RoomGovernanceHandlers = {
  closeRoom: (room: RoomSummary) => PendingGovernanceAction;
  expireRoom: (room: RoomSummary) => PendingGovernanceAction;
  clearRoomVideo: (room: RoomSummary) => PendingGovernanceAction;
};

export function RoomsTable({
  data,
  loading,
  query,
  manageable,
  onQueryChange,
  onOpenRoom,
  onAction,
  governance,
}: {
  data: RoomListResult | undefined;
  loading: boolean;
  query: RoomListQuery;
  manageable: boolean;
  onQueryChange: (patch: Partial<RoomListQuery>) => void;
  onOpenRoom: (roomCode: string) => void;
  onAction: (pending: PendingGovernanceAction) => void;
  governance: RoomGovernanceHandlers;
}) {
  const handleTableChange = (
    pagination: TablePaginationConfig,
    _filters: unknown,
    sorter: SorterResult<RoomSummary> | SorterResult<RoomSummary>[],
  ) => {
    const activeSorter = Array.isArray(sorter) ? sorter[0] : sorter;
    const sortBy: RoomSortBy =
      activeSorter?.field === "createdAt" && activeSorter.order
        ? "createdAt"
        : "lastActiveAt";
    onQueryChange({
      page: pagination.current ?? 1,
      pageSize: pagination.pageSize ?? 20,
      sortBy,
      sortOrder: activeSorter?.order === "ascend" ? "asc" : "desc",
    });
  };

  return (
    <Table<RoomSummary>
      size="middle"
      rowKey="roomCode"
      loading={loading}
      dataSource={data?.items ?? []}
      locale={{ emptyText: "没有符合条件的房间。" }}
      onChange={handleTableChange}
      pagination={{
        current: query.page ?? 1,
        pageSize: query.pageSize ?? 20,
        total: data?.pagination.total ?? 0,
        showSizeChanger: true,
        showTotal: (total) => `共 ${total} 个房间`,
      }}
      columns={[
        {
          title: "房间",
          dataIndex: "roomCode",
          render: (roomCode: string, room) => (
            <>
              <Typography.Link onClick={() => onOpenRoom(roomCode)}>
                <strong>{roomCode}</strong>
              </Typography.Link>
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {room.ownerDisplayName ?? "无房主"}
              </Typography.Text>
            </>
          ),
        },
        {
          title: "状态",
          dataIndex: "isActive",
          render: (_value, room) => <RoomStatusTag room={room} />,
        },
        {
          title: "共享视频",
          dataIndex: "sharedVideo",
          render: (_value, room) =>
            room.sharedVideo ? (
              <Typography.Link
                href={room.sharedVideo.url}
                target="_blank"
                rel="noreferrer"
                ellipsis
                style={{ maxWidth: 260, display: "inline-block" }}
              >
                {room.sharedVideo.title || room.sharedVideo.url}
              </Typography.Link>
            ) : (
              <Typography.Text type="secondary">未共享视频</Typography.Text>
            ),
        },
        {
          title: "播放进度",
          dataIndex: "playback",
          render: (_value, room) => <PlaybackCell room={room} />,
        },
        {
          title: "最近活跃",
          dataIndex: "lastActiveAt",
          sorter: true,
          defaultSortOrder: query.sortBy === "lastActiveAt" ? undefined : null,
          render: (value: number) => formatDateTime(value),
        },
        {
          title: "创建时间",
          dataIndex: "createdAt",
          sorter: true,
          render: (value: number) => formatDateTime(value),
        },
        {
          title: "操作",
          key: "actions",
          render: (_value, room) => (
            <Space>
              <Button size="small" onClick={() => onOpenRoom(room.roomCode)}>
                详情
              </Button>
              {manageable ? (
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: [
                      { key: "close", label: "关闭房间", danger: true },
                      {
                        key: "expire",
                        label: "提前过期",
                        disabled: room.isActive,
                      },
                      { key: "clear-video", label: "清空共享视频" },
                    ],
                    onClick: ({ key }) => {
                      if (key === "close") {
                        onAction(governance.closeRoom(room));
                      } else if (key === "expire") {
                        onAction(governance.expireRoom(room));
                      } else if (key === "clear-video") {
                        onAction(governance.clearRoomVideo(room));
                      }
                    },
                  }}
                >
                  <Button size="small">
                    治理 <DownOutlined />
                  </Button>
                </Dropdown>
              ) : null}
            </Space>
          ),
        },
      ]}
    />
  );
}
