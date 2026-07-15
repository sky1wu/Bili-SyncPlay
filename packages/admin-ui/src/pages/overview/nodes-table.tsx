import { Table, Tag, Typography } from "antd";
import type { NodeHealth, OverviewNode } from "../../api/types.js";
import { formatDateTime } from "../../lib/format.js";

const HEALTH_PRESENTATION: Record<
  NodeHealth,
  { color: string; label: string }
> = {
  ok: { color: "success", label: "在线" },
  stale: { color: "warning", label: "陈旧" },
  offline: { color: "default", label: "离线" },
};

export function NodesTable({ nodes }: { nodes: OverviewNode[] }) {
  return (
    <Table<OverviewNode>
      size="small"
      pagination={false}
      rowKey="instanceId"
      dataSource={nodes}
      locale={{ emptyText: "当前没有在线节点心跳或会话。" }}
      columns={[
        {
          title: "节点",
          dataIndex: "instanceId",
          render: (instanceId: string, node) => (
            <>
              <Typography.Text strong>{instanceId}</Typography.Text>
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {node.version || "unknown"}
              </Typography.Text>
            </>
          ),
        },
        {
          title: "状态",
          dataIndex: "health",
          render: (health: NodeHealth) => {
            const presentation = HEALTH_PRESENTATION[health];
            return <Tag color={presentation.color}>{presentation.label}</Tag>;
          },
        },
        { title: "连接", dataIndex: "connectionCount" },
        { title: "房间", dataIndex: "currentRoomCount" },
        { title: "用户", dataIndex: "currentMemberCount" },
        {
          title: "最近心跳",
          dataIndex: "lastHeartbeatAt",
          render: (value: number) => formatDateTime(value),
        },
      ]}
    />
  );
}
