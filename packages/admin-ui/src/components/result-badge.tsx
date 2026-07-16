import { Tag } from "antd";

const RESULT_PRESENTATION: Record<string, { color: string; label: string }> = {
  ok: { color: "success", label: "成功" },
  rejected: { color: "warning", label: "已拒绝" },
  error: { color: "error", label: "错误" },
};

export function ResultBadge({ result }: { result: string | null }) {
  if (!result) {
    return <span>—</span>;
  }
  const presentation = RESULT_PRESENTATION[result];
  if (!presentation) {
    return <Tag>{result}</Tag>;
  }
  return <Tag color={presentation.color}>{presentation.label}</Tag>;
}
