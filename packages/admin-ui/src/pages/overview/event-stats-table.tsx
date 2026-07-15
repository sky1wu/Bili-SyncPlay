import { Table, Typography } from "antd";
import type { AdminOverview, OverviewEventCounts } from "../../api/types.js";

type EventStatsRow = OverviewEventCounts & {
  key: string;
  window: string;
};

const WINDOW_LABELS: Array<[keyof AdminOverview["events"], string]> = [
  ["lastMinute", "最近一分钟"],
  ["lastHour", "最近一小时"],
  ["lastDay", "最近一天"],
  ["totals", "累计"],
];

function renderAttentionCount(value: number) {
  if (value > 0) {
    return <Typography.Text type="warning">{value}</Typography.Text>;
  }
  return value;
}

export function EventStatsTable({
  events,
}: {
  events: AdminOverview["events"];
}) {
  const rows: EventStatsRow[] = WINDOW_LABELS.map(([key, label]) => ({
    key,
    window: label,
    ...events[key],
  }));

  return (
    <Table<EventStatsRow>
      size="small"
      pagination={false}
      dataSource={rows}
      columns={[
        { title: "时间窗口", dataIndex: "window" },
        { title: "创建房间", dataIndex: "room_created" },
        { title: "加入房间", dataIndex: "room_joined" },
        {
          title: "限流",
          dataIndex: "rate_limited",
          render: renderAttentionCount,
        },
        {
          title: "连接拒绝",
          dataIndex: "ws_connection_rejected",
          render: renderAttentionCount,
        },
      ]}
    />
  );
}
