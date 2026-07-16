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
  Checkbox,
  DatePicker,
  Input,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import dayjs from "dayjs";
import { useEffect, useState } from "react";
import type { EventListQuery, RuntimeEventRecord } from "../../api/types.js";
import { useAuth } from "../../auth/auth-context.js";
import { JsonModal } from "../../components/json-modal.js";
import { ResultBadge } from "../../components/result-badge.js";
import { formatDateTime, formatTime } from "../../lib/format.js";
import {
  readPositiveInt,
  readTimestamp,
  useUrlQueryState,
} from "../../lib/url-query.js";
import { getEventLabel } from "./event-labels.js";

const EVENTS_REFRESH_MS = 15_000;

const QUERY_DEFAULTS: Record<string, string> = {
  page: "1",
  pageSize: "20",
  includeSystem: "false",
};

function queryFromSearchParams(params: URLSearchParams): EventListQuery {
  return {
    event: params.get("event") ?? undefined,
    roomCode: params.get("roomCode") ?? undefined,
    sessionId: params.get("sessionId") ?? undefined,
    remoteAddress: params.get("remoteAddress") ?? undefined,
    origin: params.get("origin") ?? undefined,
    result: params.get("result") ?? undefined,
    includeSystem: params.get("includeSystem") === "true",
    from: readTimestamp(params, "from"),
    to: readTimestamp(params, "to"),
    page: readPositiveInt(params, "page", 1),
    pageSize: readPositiveInt(params, "pageSize", 20),
  };
}

type TextFilterKey =
  "event" | "roomCode" | "sessionId" | "remoteAddress" | "origin" | "result";

const TEXT_FILTERS: Array<{ key: TextFilterKey; label: string }> = [
  { key: "event", label: "事件名" },
  { key: "roomCode", label: "房间号" },
  { key: "sessionId", label: "会话 ID" },
  { key: "remoteAddress", label: "远端地址" },
  { key: "origin", label: "来源" },
  { key: "result", label: "结果" },
];

function EventsFilter({
  query,
  onChange,
}: {
  query: EventListQuery;
  onChange: (
    patch: Record<string, string | number | boolean | undefined>,
  ) => void;
}) {
  const [drafts, setDrafts] = useState<Record<TextFilterKey, string>>({
    event: query.event ?? "",
    roomCode: query.roomCode ?? "",
    sessionId: query.sessionId ?? "",
    remoteAddress: query.remoteAddress ?? "",
    origin: query.origin ?? "",
    result: query.result ?? "",
  });

  // URL 是状态源：前进/后退等路由变化要回写输入框。
  useEffect(() => {
    setDrafts({
      event: query.event ?? "",
      roomCode: query.roomCode ?? "",
      sessionId: query.sessionId ?? "",
      remoteAddress: query.remoteAddress ?? "",
      origin: query.origin ?? "",
      result: query.result ?? "",
    });
  }, [
    query.event,
    query.roomCode,
    query.sessionId,
    query.remoteAddress,
    query.origin,
    query.result,
  ]);

  const submit = () => {
    onChange({
      ...Object.fromEntries(
        Object.entries(drafts).map(([key, value]) => [key, value.trim()]),
      ),
      page: 1,
    });
  };

  return (
    <Space direction="vertical" size={12} style={{ display: "flex" }}>
      <Space wrap>
        {TEXT_FILTERS.map(({ key, label }) => (
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
      </Space>
      <Space wrap>
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
        <Checkbox
          checked={query.includeSystem ?? false}
          onChange={(event) =>
            onChange({ includeSystem: event.target.checked, page: 1 })
          }
        >
          含系统事件
        </Checkbox>
        <Button type="primary" onClick={submit}>
          查询
        </Button>
      </Space>
    </Space>
  );
}

export function EventsPage() {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const { searchParams, updateQuery } = useUrlQueryState(QUERY_DEFAULTS);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [detailsValue, setDetailsValue] = useState<unknown>(null);

  const query = queryFromSearchParams(searchParams);
  const eventsQuery = useQuery({
    queryKey: ["events", query],
    queryFn: () => api.listEvents(query),
    refetchInterval: autoRefresh ? EVENTS_REFRESH_MS : false,
    placeholderData: keepPreviousData,
  });

  const refreshNow = () => {
    void queryClient.invalidateQueries({ queryKey: ["events"] });
  };

  return (
    <Space direction="vertical" size={16} style={{ display: "flex" }}>
      <Card>
        <Space direction="vertical" size={12} style={{ display: "flex" }}>
          <EventsFilter query={query} onChange={updateQuery} />
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
              更新于 {formatTime(eventsQuery.dataUpdatedAt)}
            </Typography.Text>
          </Space>
        </Space>
      </Card>

      {eventsQuery.isError ? (
        <Alert
          type="error"
          showIcon
          message="运行事件加载失败"
          description={
            eventsQuery.error instanceof Error
              ? eventsQuery.error.message
              : "请求失败。"
          }
          action={
            <Button size="small" onClick={refreshNow}>
              重试
            </Button>
          }
        />
      ) : (
        <Table<RuntimeEventRecord>
          size="middle"
          rowKey="id"
          loading={eventsQuery.isPending}
          dataSource={eventsQuery.data?.items ?? []}
          locale={{ emptyText: "没有匹配的事件。" }}
          onChange={(pagination) =>
            updateQuery({
              page: pagination.current ?? 1,
              pageSize: pagination.pageSize ?? 20,
            })
          }
          pagination={{
            current: query.page ?? 1,
            pageSize: query.pageSize ?? 20,
            total: eventsQuery.data?.total ?? 0,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条事件`,
          }}
          columns={[
            {
              title: "时间",
              dataIndex: "timestamp",
              width: 180,
              render: (value: string) => formatDateTime(Date.parse(value)),
            },
            {
              title: "事件",
              dataIndex: "event",
              render: (event: string) => {
                const label = getEventLabel(event);
                return (
                  <>
                    <Tag>{event}</Tag>
                    {label ? (
                      <Typography.Text type="secondary">
                        {label}
                      </Typography.Text>
                    ) : null}
                  </>
                );
              },
            },
            {
              title: "房间",
              dataIndex: "roomCode",
              render: (value: string | null) => value ?? "—",
            },
            {
              title: "来源",
              dataIndex: "remoteAddress",
              render: (_value, item) => (
                <>
                  {item.remoteAddress ?? "—"}
                  <br />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {item.origin ?? "—"}
                  </Typography.Text>
                </>
              ),
            },
            {
              title: "结果",
              dataIndex: "result",
              render: (value: string | null) => <ResultBadge result={value} />,
            },
            {
              title: "详情",
              key: "details",
              render: (_value, item) =>
                Object.keys(item.details ?? {}).length > 0 ? (
                  <Button
                    size="small"
                    type="link"
                    onClick={() => setDetailsValue(item.details)}
                  >
                    JSON
                  </Button>
                ) : (
                  "—"
                ),
            },
          ]}
        />
      )}

      <JsonModal
        title="事件详情"
        value={detailsValue}
        onClose={() => setDetailsValue(null)}
      />
    </Space>
  );
}
