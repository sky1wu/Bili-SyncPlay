import { ReloadOutlined } from "@ant-design/icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Row,
  Space,
  Spin,
  Statistic,
  Switch,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import { formatDuration, formatTime } from "../../lib/format.js";
import { useOverviewQuery, useReadyQuery } from "./overview-queries.js";
import { EventStatsTable } from "./event-stats-table.js";
import { NodesTable } from "./nodes-table.js";

export function OverviewPage() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const queryClient = useQueryClient();
  const overviewQuery = useOverviewQuery(autoRefresh);
  const readyQuery = useReadyQuery(autoRefresh);

  const refreshNow = () => {
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
    void queryClient.invalidateQueries({ queryKey: ["ready"] });
  };

  if (overviewQuery.isPending) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (overviewQuery.isError) {
    return (
      <Alert
        type="error"
        showIcon
        message="概览数据加载失败"
        description={
          overviewQuery.error instanceof Error
            ? overviewQuery.error.message
            : "请求失败。"
        }
        action={
          <Button size="small" onClick={refreshNow}>
            重试
          </Button>
        }
      />
    );
  }

  const overview = overviewQuery.data;
  const ready = readyQuery.data;
  const readyDegraded =
    readyQuery.isError || (ready && ready.status !== "ready");

  return (
    <Space direction="vertical" size={16} style={{ display: "flex" }}>
      {readyDegraded ? (
        <Alert
          type="warning"
          showIcon
          message={
            readyQuery.isError
              ? "readyz 检查失败，请检查服务与网络状态。"
              : `readyz 状态为 ${ready?.status}，请检查存储与 Redis 连通性。`
          }
        />
      ) : null}

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
          更新于 {formatTime(overviewQuery.dataUpdatedAt)}
        </Typography.Text>
      </Space>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="连接数"
              value={overview.runtime.connectionCount}
            />
            <Typography.Text type="secondary">WebSocket</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="在线房间"
              value={overview.runtime.activeRoomCount}
            />
            <Typography.Text type="secondary">
              总计 {overview.rooms.totalNonExpired} 非过期
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="在线成员"
              value={overview.runtime.activeMemberCount}
            />
            <Typography.Text type="secondary">
              空闲房间 {overview.rooms.idle}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="运行时长"
              value={formatDuration(overview.service.uptimeMs)}
            />
            <Typography.Text type="secondary">
              {overview.service.name} v{overview.service.version}
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <Card title="存储">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="提供方">
                {overview.storage.provider}
              </Descriptions.Item>
              <Descriptions.Item label="Redis">
                {overview.storage.redisConnected ? (
                  <Tag color="success">已连接</Tag>
                ) : (
                  <Tag color="warning">未连接</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="roomStore">
                {ready?.checks.roomStore ?? "—"}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} lg={16}>
          <Card title="事件统计">
            <EventStatsTable events={overview.events} />
          </Card>
        </Col>
      </Row>

      <Card
        title={`节点（在线 ${overview.nodes.online} · 陈旧 ${overview.nodes.stale} · 离线 ${overview.nodes.offline}）`}
      >
        <NodesTable nodes={overview.nodes.items} />
      </Card>
    </Space>
  );
}
