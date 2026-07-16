import { Checkbox, Input, Segmented, Space } from "antd";
import { useEffect, useState } from "react";
import type { RoomListQuery, RoomStatusFilter } from "../../api/types.js";

export function RoomsFilter({
  query,
  onChange,
}: {
  query: RoomListQuery;
  onChange: (patch: Partial<RoomListQuery>) => void;
}) {
  // URL 是筛选状态的唯一来源；输入框保留本地草稿以便输入，
  // 但路由带来的 keyword 变化（前进/后退、外部链接）必须回写。
  const [keywordDraft, setKeywordDraft] = useState(query.keyword ?? "");
  useEffect(() => {
    setKeywordDraft(query.keyword ?? "");
  }, [query.keyword]);

  return (
    <Space wrap>
      <Input.Search
        allowClear
        placeholder="房间号 / 成员 / 视频标题 / URL，空格分隔多关键字"
        value={keywordDraft}
        onChange={(event) => setKeywordDraft(event.target.value)}
        onSearch={(keyword) => onChange({ keyword: keyword.trim(), page: 1 })}
        style={{ width: 360 }}
      />
      <Segmented<RoomStatusFilter>
        value={query.status ?? "all"}
        onChange={(status) => onChange({ status, page: 1 })}
        options={[
          { label: "全部", value: "all" },
          { label: "活跃", value: "active" },
          { label: "空闲", value: "idle" },
        ]}
      />
      <Checkbox
        checked={query.includeExpired ?? false}
        onChange={(event) =>
          onChange({ includeExpired: event.target.checked, page: 1 })
        }
      >
        包含已过期
      </Checkbox>
    </Space>
  );
}
