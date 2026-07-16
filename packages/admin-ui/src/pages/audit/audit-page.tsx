import { ReloadOutlined } from "@ant-design/icons";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import dayjs from "dayjs";
import { useEffect, useState } from "react";
import type {
  AuditLogQuery,
  AuditLogRecord,
  AuditResult,
  AuditTargetType,
} from "../../api/types.js";
import { useAuth } from "../../auth/auth-context.js";
import { JsonModal } from "../../components/json-modal.js";
import { ResultBadge } from "../../components/result-badge.js";
import { formatDateTime, formatTime } from "../../lib/format.js";
import {
  readPositiveInt,
  readTimestamp,
  useUrlQueryState,
} from "../../lib/url-query.js";

const AUDIT_REFRESH_MS = 15_000;

const QUERY_DEFAULTS: Record<string, string> = {
  page: "1",
  pageSize: "20",
};

// 管理动作的中文标签；未收录的动作原样展示。
const ACTION_LABELS: Record<string, string> = {
  close_room: "关闭房间",
  expire_room: "提前过期",
  clear_room_video: "清空共享视频",
  kick_member: "踢出成员",
  disconnect_session: "断开会话",
};

const TARGET_TYPE_LABELS: Record<AuditTargetType, string> = {
  room: "房间",
  session: "会话",
  member: "成员",
  config: "配置",
  block: "封禁",
};

function queryFromSearchParams(params: URLSearchParams): AuditLogQuery {
  const targetType = params.get("targetType");
  const result = params.get("result");
  return {
    actor: params.get("actor") ?? undefined,
    action: params.get("action") ?? undefined,
    targetId: params.get("targetId") ?? undefined,
    targetType:
      targetType && targetType in TARGET_TYPE_LABELS
        ? (targetType as AuditTargetType)
        : undefined,
    result:
      result === "ok" || result === "rejected" || result === "error"
        ? result
        : undefined,
    from: readTimestamp(params, "from"),
    to: readTimestamp(params, "to"),
    page: readPositiveInt(params, "page", 1),
    pageSize: readPositiveInt(params, "pageSize", 20),
  };
}

function AuditFilter({
  query,
  onChange,
}: {
  query: AuditLogQuery;
  onChange: (
    patch: Record<string, string | number | boolean | undefined>,
  ) => void;
}) {
  const [drafts, setDrafts] = useState({
    actor: query.actor ?? "",
    action: query.action ?? "",
    targetId: query.targetId ?? "",
  });

  useEffect(() => {
    setDrafts({
      actor: query.actor ?? "",
      action: query.action ?? "",
      targetId: query.targetId ?? "",
    });
  }, [query.actor, query.action, query.targetId]);

  const submit = () => {
    onChange({
      actor: drafts.actor.trim(),
      action: drafts.action.trim(),
      targetId: drafts.targetId.trim(),
      page: 1,
    });
  };

  return (
    <Space wrap>
      {(
        [
          ["actor", "操作人"],
          ["action", "动作"],
          ["targetId", "目标 ID"],
        ] as const
      ).map(([key, label]) => (
        <Input
          key={key}
          allowClear
          placeholder={label}
          value={drafts[key]}
          onChange={(event) =>
            setDrafts((prev) => ({ ...prev, [key]: event.target.value }))
          }
          onPressEnter={submit}
          style={{ width: 160 }}
        />
      ))}
      <Select<AuditTargetType | "">
        value={query.targetType ?? ""}
        style={{ width: 140 }}
        onChange={(value) => onChange({ targetType: value, page: 1 })}
        options={[
          { value: "", label: "全部目标类型" },
          ...Object.entries(TARGET_TYPE_LABELS).map(([value, label]) => ({
            value,
            label,
          })),
        ]}
      />
      <Select<AuditResult | "">
        value={query.result ?? ""}
        style={{ width: 120 }}
        onChange={(value) => onChange({ result: value, page: 1 })}
        options={[
          { value: "", label: "全部结果" },
          { value: "ok", label: "成功" },
          { value: "rejected", label: "已拒绝" },
          { value: "error", label: "错误" },
        ]}
      />
      <DatePicker.RangePicker
        showTime
        value={[
          query.from ? dayjs(query.from) : null,
          query.to ? dayjs(query.to) : null,
        ]}
        onChange={(range) =>
          onChange({
            from: range?.[0]?.valueOf(),
            to: range?.[1]?.valueOf(),
            page: 1,
          })
        }
      />
      <Button type="primary" onClick={submit}>
        查询
      </Button>
    </Space>
  );
}

export function AuditLogsPage() {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const { searchParams, updateQuery } = useUrlQueryState(QUERY_DEFAULTS);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [requestValue, setRequestValue] = useState<unknown>(null);

  const query = queryFromSearchParams(searchParams);
  const auditQuery = useQuery({
    queryKey: ["audit-logs", query],
    queryFn: () => api.listAuditLogs(query),
    refetchInterval: autoRefresh ? AUDIT_REFRESH_MS : false,
    placeholderData: keepPreviousData,
  });

  const refreshNow = () => {
    void queryClient.invalidateQueries({ queryKey: ["audit-logs"] });
  };

  return (
    <Space direction="vertical" size={16} style={{ display: "flex" }}>
      <Card>
        <Space direction="vertical" size={12} style={{ display: "flex" }}>
          <AuditFilter query={query} onChange={updateQuery} />
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
              更新于 {formatTime(auditQuery.dataUpdatedAt)}
            </Typography.Text>
          </Space>
        </Space>
      </Card>

      {auditQuery.isError ? (
        <Alert
          type="error"
          showIcon
          message="审计日志加载失败"
          description={
            auditQuery.error instanceof Error
              ? auditQuery.error.message
              : "请求失败。"
          }
          action={
            <Button size="small" onClick={refreshNow}>
              重试
            </Button>
          }
        />
      ) : (
        <Table<AuditLogRecord>
          size="middle"
          rowKey="id"
          loading={auditQuery.isPending}
          dataSource={auditQuery.data?.items ?? []}
          locale={{ emptyText: "没有匹配的审计记录。" }}
          onChange={(pagination) =>
            updateQuery({
              page: pagination.current ?? 1,
              pageSize: pagination.pageSize ?? 20,
            })
          }
          pagination={{
            current: query.page ?? 1,
            pageSize: query.pageSize ?? 20,
            total: auditQuery.data?.total ?? 0,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条记录`,
          }}
          columns={[
            {
              title: "时间",
              dataIndex: "timestamp",
              width: 180,
              render: (value: string) => formatDateTime(Date.parse(value)),
            },
            {
              title: "操作人",
              dataIndex: "actor",
              render: (_value, item) => (
                <>
                  <Typography.Text strong>
                    {item.actor.username}
                  </Typography.Text>
                  <br />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {item.actor.role}
                  </Typography.Text>
                </>
              ),
            },
            {
              title: "动作",
              dataIndex: "action",
              render: (action: string) => (
                <>
                  <Tag>{action}</Tag>
                  {ACTION_LABELS[action] ? (
                    <Typography.Text type="secondary">
                      {ACTION_LABELS[action]}
                    </Typography.Text>
                  ) : null}
                </>
              ),
            },
            {
              title: "目标",
              dataIndex: "targetId",
              render: (_value, item) => (
                <>
                  <Tag color="blue">
                    {TARGET_TYPE_LABELS[item.targetType] ?? item.targetType}
                  </Tag>
                  <Typography.Text code>{item.targetId}</Typography.Text>
                </>
              ),
            },
            {
              title: "结果",
              dataIndex: "result",
              render: (value: AuditResult) => <ResultBadge result={value} />,
            },
            {
              title: "原因",
              dataIndex: "reason",
              render: (_value, item) => {
                // 成功动作的 reason 被服务端记录在 request.reason 里，
                // 顶层 reason 字段仅部分路径写入，这里做回退取值。
                const reason =
                  item.reason ??
                  (typeof item.request.reason === "string"
                    ? item.request.reason
                    : undefined);
                return reason ? (
                  reason
                ) : (
                  <Typography.Text type="secondary">未填写</Typography.Text>
                );
              },
            },
            {
              title: "请求",
              key: "request",
              render: (_value, item) => (
                <Button
                  size="small"
                  type="link"
                  onClick={() => setRequestValue(item.request)}
                >
                  JSON
                </Button>
              ),
            },
          ]}
        />
      )}

      <JsonModal
        title="审计请求参数"
        value={requestValue}
        onClose={() => setRequestValue(null)}
      />
    </Space>
  );
}
