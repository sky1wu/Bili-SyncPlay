import { ReloadOutlined } from "@ant-design/icons";
import { useQueryClient } from "@tanstack/react-query";
import { App as AntdApp, Button, Card, Space, Switch, Typography } from "antd";
import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type {
  RoomDetailMember,
  RoomListQuery,
  RoomSummary,
} from "../../api/types.js";
import { useAuth } from "../../auth/auth-context.js";
import { formatTime } from "../../lib/format.js";
import { canManage } from "../../lib/roles.js";
import { ReasonModal } from "./reason-modal.js";
import type { PendingGovernanceAction } from "./reason-modal.js";
import { RoomDetailDrawer } from "./room-detail-drawer.js";
import { RoomsFilter } from "./rooms-filter.js";
import { useRoomsQuery } from "./rooms-queries.js";
import { RoomsTable } from "./rooms-table.js";

export function queryFromSearchParams(params: URLSearchParams): RoomListQuery {
  const status = params.get("status");
  const sortBy = params.get("sortBy");
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));
  return {
    status:
      status === "active" || status === "idle" || status === "all"
        ? status
        : "all",
    keyword: params.get("keyword") ?? undefined,
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 20,
    sortBy: sortBy === "createdAt" ? "createdAt" : "lastActiveAt",
    sortOrder: params.get("sortOrder") === "asc" ? "asc" : "desc",
    includeExpired: params.get("includeExpired") === "true",
  };
}

const QUERY_DEFAULTS: Record<string, string> = {
  status: "all",
  keyword: "",
  page: "1",
  pageSize: "20",
  sortBy: "lastActiveAt",
  sortOrder: "desc",
  includeExpired: "false",
};

export function RoomsPage() {
  const { api, me } = useAuth();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { roomCode: roomCodeParam } = useParams();
  const roomCode = roomCodeParam ?? null;
  const [searchParams, setSearchParams] = useSearchParams();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [pendingAction, setPendingAction] =
    useState<PendingGovernanceAction | null>(null);

  const query = queryFromSearchParams(searchParams);
  const roomsQuery = useRoomsQuery(query, autoRefresh);
  const manageable = canManage(me);

  const updateQuery = (patch: Partial<RoomListQuery>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      const serialized = value === undefined ? "" : String(value);
      // 默认值不落 URL，保持地址干净可分享。
      if (serialized === "" || serialized === QUERY_DEFAULTS[key]) {
        next.delete(key);
      } else {
        next.set(key, serialized);
      }
    }
    setSearchParams(next, { replace: true });
  };

  const openRoom = (code: string) => {
    navigate({
      pathname: `/rooms/${encodeURIComponent(code)}`,
      search: searchParams.toString(),
    });
  };

  const closeDrawer = () => {
    navigate({ pathname: "/rooms", search: searchParams.toString() });
  };

  const refreshNow = () => {
    void queryClient.invalidateQueries({ queryKey: ["rooms"] });
    void queryClient.invalidateQueries({ queryKey: ["room"] });
  };

  const afterAction = async (successMessage: string) => {
    message.success(successMessage);
    await queryClient.invalidateQueries({ queryKey: ["rooms"] });
    await queryClient.invalidateQueries({ queryKey: ["room"] });
  };

  const governance = {
    closeRoom: (room: RoomSummary): PendingGovernanceAction => ({
      title: `关闭房间 ${room.roomCode}`,
      description: "关闭后房间立即解散，所有在线成员会被断开。",
      danger: true,
      execute: async (reason) => {
        await api.closeRoom(room.roomCode, reason);
        await afterAction(`房间 ${room.roomCode} 已关闭。`);
      },
    }),
    expireRoom: (room: RoomSummary): PendingGovernanceAction => ({
      title: `提前过期房间 ${room.roomCode}`,
      description: "空闲房间将立即标记为过期，等待清理。",
      execute: async (reason) => {
        await api.expireRoom(room.roomCode, reason);
        await afterAction(`房间 ${room.roomCode} 已提前过期。`);
      },
    }),
    clearRoomVideo: (room: RoomSummary): PendingGovernanceAction => ({
      title: `清空房间 ${room.roomCode} 的共享视频`,
      description: "成员将回到未共享状态，不影响成员在线。",
      execute: async (reason) => {
        await api.clearRoomVideo(room.roomCode, reason);
        await afterAction(`房间 ${room.roomCode} 的共享视频已清空。`);
      },
    }),
  };

  const memberGovernance = {
    kickMember: (
      room: RoomSummary,
      member: RoomDetailMember,
    ): PendingGovernanceAction => ({
      title: `踢出成员 ${member.displayName}`,
      description: `成员将被移出房间 ${room.roomCode} 并断开连接。`,
      danger: true,
      execute: async (reason) => {
        await api.kickMember(room.roomCode, member.memberId, reason);
        await afterAction(`成员 ${member.displayName} 已被踢出。`);
      },
    }),
    disconnectSession: (
      room: RoomSummary,
      member: RoomDetailMember,
    ): PendingGovernanceAction => ({
      title: `断开会话 ${member.displayName}`,
      description: "仅断开当前 WebSocket 连接，成员可重连回房间。",
      execute: async (reason) => {
        await api.disconnectSession(member.sessionId, reason);
        await afterAction(`已断开 ${member.displayName} 的会话。`);
      },
    }),
  };

  return (
    <Space direction="vertical" size={16} style={{ display: "flex" }}>
      <Card>
        <Space direction="vertical" size={12} style={{ display: "flex" }}>
          <RoomsFilter query={query} onChange={updateQuery} />
          <Space wrap>
            <Switch
              checked={autoRefresh}
              onChange={setAutoRefresh}
              checkedChildren="自动刷新"
              unCheckedChildren="自动刷新已关"
            />
            <Button icon={<ReloadOutlined />} onClick={refreshNow}>
              刷新
            </Button>
            <Typography.Text type="secondary">
              更新于 {formatTime(roomsQuery.dataUpdatedAt)}
            </Typography.Text>
          </Space>
        </Space>
      </Card>

      <RoomsTable
        data={roomsQuery.data}
        loading={roomsQuery.isPending}
        query={query}
        manageable={manageable}
        onQueryChange={updateQuery}
        onOpenRoom={openRoom}
        onAction={setPendingAction}
        governance={governance}
      />

      <RoomDetailDrawer
        roomCode={roomCode}
        autoRefresh={autoRefresh}
        manageable={manageable}
        onClose={closeDrawer}
        onAction={setPendingAction}
        governance={governance}
        memberGovernance={memberGovernance}
      />

      <ReasonModal
        pending={pendingAction}
        onClose={() => setPendingAction(null)}
      />
    </Space>
  );
}
