import { ReloadOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Row,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import { useAuth } from "../../auth/auth-context.js";
import { formatDuration } from "../../lib/format.js";

// 配置摘要页面向"全局后台自身进程"，多节点部署时给出提示。
const GLOBAL_ADMIN_INSTANCE_PREFIX = "global-admin";

const RATE_LIMIT_LABELS: Record<string, string> = {
  roomCreatePerMinute: "建房 / 分钟",
  roomJoinPerMinute: "加入 / 分钟",
  videoSharePer10Seconds: "共享视频 / 10 秒",
  playbackUpdatePerSecond: "播放更新 / 秒",
  playbackUpdateBurst: "播放更新突发",
  syncRequestPer10Seconds: "同步请求 / 10 秒",
  syncPingPerSecond: "同步 ping / 秒",
  syncPingBurst: "同步 ping 突发",
  adminLoginFailuresPerIpPerMinute: "登录失败 / IP / 分钟",
  adminLoginFailuresPerUsernamePerMinute: "登录失败 / 用户名 / 分钟",
};

function BoolTag({ value }: { value: boolean }) {
  return value ? <Tag color="success">是</Tag> : <Tag>否</Tag>;
}

function OriginList({ values }: { values: string[] }) {
  if (values.length === 0) {
    return <Typography.Text type="secondary">（空）</Typography.Text>;
  }
  return (
    <Space direction="vertical" size={2}>
      {values.map((value) => (
        <Typography.Text code key={value}>
          {value}
        </Typography.Text>
      ))}
    </Space>
  );
}

export function ConfigPage() {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => api.getConfig(),
  });

  const refreshNow = () => {
    void queryClient.invalidateQueries({ queryKey: ["config"] });
  };

  if (configQuery.isPending) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (configQuery.isError) {
    return (
      <Alert
        type="error"
        showIcon
        message="配置摘要加载失败"
        description={
          configQuery.error instanceof Error
            ? configQuery.error.message
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

  const config = configQuery.data;
  const rateLimitRows = Object.entries(config.security.rateLimits).map(
    ([key, value]) => ({
      key,
      label: RATE_LIMIT_LABELS[key] ?? key,
      value,
    }),
  );

  return (
    <Space direction="vertical" size={16} style={{ display: "flex" }}>
      {config.instanceId.startsWith(GLOBAL_ADMIN_INSTANCE_PREFIX) ? (
        <Alert
          type="warning"
          showIcon
          message="当前展示的是全局后台进程自身加载到的配置摘要；如果房间节点独立部署，请以对应业务节点的运行配置为准。"
        />
      ) : null}

      <Space>
        <Button icon={<ReloadOutlined />} onClick={refreshNow}>
          刷新
        </Button>
      </Space>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="实例与持久化">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="实例 ID">
                <Typography.Text code>{config.instanceId}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="存储提供方">
                {config.persistence.provider}
              </Descriptions.Item>
              <Descriptions.Item label="空房间保留时长">
                {formatDuration(config.persistence.emptyRoomTtlMs)}
              </Descriptions.Item>
              <Descriptions.Item label="房间清理间隔">
                {formatDuration(config.persistence.roomCleanupIntervalMs)}
              </Descriptions.Item>
              <Descriptions.Item label="已配置 Redis">
                <BoolTag value={config.persistence.redisConfigured} />
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="管理后台">
            {config.admin.configured ? (
              <Descriptions column={1} size="small">
                <Descriptions.Item label="管理员用户名">
                  {config.admin.username}
                </Descriptions.Item>
                <Descriptions.Item label="角色">
                  <Tag color="blue">{config.admin.role}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="会话有效期">
                  {formatDuration(config.admin.sessionTtlMs)}
                </Descriptions.Item>
              </Descriptions>
            ) : (
              <Alert
                type="warning"
                showIcon
                message="管理端认证未配置（缺少 ADMIN_USERNAME / ADMIN_PASSWORD_HASH / ADMIN_SESSION_SECRET）。"
              />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="连接与安全">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="允许的来源">
                <OriginList values={config.security.allowedOrigins} />
              </Descriptions.Item>
              <Descriptions.Item label="开发模式允许缺失 Origin">
                <BoolTag value={config.security.allowMissingOriginInDev} />
              </Descriptions.Item>
              <Descriptions.Item label="允许任意 Firefox 扩展来源">
                <BoolTag
                  value={config.security.allowAnyFirefoxExtensionOrigin}
                />
              </Descriptions.Item>
              <Descriptions.Item label="可信代理地址">
                <OriginList values={config.security.trustedProxyAddresses} />
              </Descriptions.Item>
              <Descriptions.Item label="单 IP 最大连接数">
                {config.security.maxConnectionsPerIp}
              </Descriptions.Item>
              <Descriptions.Item label="连接尝试 / 分钟">
                {config.security.connectionAttemptsPerMinute}
              </Descriptions.Item>
              <Descriptions.Item label="单房间最大成员数">
                {config.security.maxMembersPerRoom}
              </Descriptions.Item>
              <Descriptions.Item label="最大消息字节数">
                {config.security.maxMessageBytes}
              </Descriptions.Item>
              <Descriptions.Item label="非法消息断开阈值">
                {config.security.invalidMessageCloseThreshold}
              </Descriptions.Item>
              <Descriptions.Item label="WS 心跳">
                <BoolTag value={config.security.wsHeartbeatEnabled} />
                {config.security.wsHeartbeatEnabled ? (
                  <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                    间隔 {formatDuration(config.security.wsHeartbeatIntervalMs)}
                  </Typography.Text>
                ) : null}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="限流阈值">
            <Table
              size="small"
              pagination={false}
              rowKey="key"
              dataSource={rateLimitRows}
              columns={[
                { title: "限流项", dataIndex: "label" },
                { title: "阈值", dataIndex: "value", width: 120 },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
