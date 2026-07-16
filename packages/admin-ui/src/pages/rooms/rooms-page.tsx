import { ReloadOutlined } from "@ant-design/icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Space,
  Switch,
  Typography,
} from "antd";
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
import { BatchResultModal } from "./batch-result-modal.js";
import type { BatchOutcome, BatchResult } from "./batch-result-modal.js";
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
  const [selectedRoomCodes, setSelectedRoomCodes] = useState<string[]>([]);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);

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

  const runBatch = async (
    roomCodes: string[],
    title: string,
    action: (roomCode: string, reason: string) => Promise<unknown>,
    reason: string,
  ) => {
    const outcomes: BatchOutcome[] = [];
    // 顺序执行避免瞬时打爆管理接口；管理场景下批量规模有限。
    for (const roomCode of roomCodes) {
      try {
        await action(roomCode, reason);
        outcomes.push({ roomCode, ok: true });
      } catch (cause) {
        outcomes.push({
          roomCode,
          ok: false,
          message: cause instanceof Error ? cause.message : "请求失败。",
        });
      }
    }
    // 失败的房间保持勾选，便于修正后重试。
    setSelectedRoomCodes(
      outcomes
        .filter((outcome) => !outcome.ok)
        .map((outcome) => outcome.roomCode),
    );
    setBatchResult({ title, outcomes });
    await queryClient.invalidateQueries({ queryKey: ["rooms"] });
    await queryClient.invalidateQueries({ queryKey: ["room"] });
  };

  const batchGovernance = {
    closeRooms: (roomCodes: string[]): PendingGovernanceAction => ({
      title: `批量关闭 ${roomCodes.length} 个房间`,
      description: "关闭后房间立即解散，所有在线成员会被断开。",
      danger: true,
      execute: (reason) =>
        runBatch(
          roomCodes,
          "批量关闭结果",
          (roomCode, batchReason) => api.closeRoom(roomCode, batchReason),
          reason,
        ),
    }),
    expireRooms: (roomCodes: string[]): PendingGovernanceAction => ({
      title: `批量提前过期 ${roomCodes.length} 个房间`,
      description: "仅空闲房间可提前过期；仍有在线成员的房间会失败并列出。",
      execute: (reason) =>
        runBatch(
          roomCodes,
          "批量提前过期结果",
          (roomCode, batchReason) => api.expireRoom(roomCode, batchReason),
          reason,
        ),
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
          {manageable && selectedRoomCodes.length > 0 ? (
            <Space wrap>
              <Typography.Text strong>
                已选 {selectedRoomCodes.length} 个房间
              </Typography.Text>
              <Button
                danger
                size="small"
                onClick={() =>
                  setPendingAction(
                    batchGovernance.closeRooms(selectedRoomCodes),
                  )
                }
              >
                批量关闭
              </Button>
              <Button
                size="small"
                onClick={() =>
                  setPendingAction(
                    batchGovernance.expireRooms(selectedRoomCodes),
                  )
                }
              >
                批量过期
              </Button>
              <Button
                size="small"
                type="text"
                onClick={() => setSelectedRoomCodes([])}
              >
                取消选择
              </Button>
            </Space>
          ) : null}
        </Space>
      </Card>

      {roomsQuery.isError ? (
        <Alert
          type="error"
          showIcon
          message="房间列表加载失败"
          description={
            roomsQuery.error instanceof Error
              ? roomsQuery.error.message
              : "请求失败。"
          }
          action={
            <Button size="small" onClick={refreshNow}>
              重试
            </Button>
          }
        />
      ) : (
        <RoomsTable
          data={roomsQuery.data}
          loading={roomsQuery.isPending}
          query={query}
          manageable={manageable}
          selectedRoomCodes={selectedRoomCodes}
          onSelectionChange={setSelectedRoomCodes}
          onQueryChange={updateQuery}
          onOpenRoom={openRoom}
          onAction={setPendingAction}
          governance={governance}
        />
      )}

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

      <BatchResultModal
        result={batchResult}
        onClose={() => setBatchResult(null)}
      />
    </Space>
  );
}
