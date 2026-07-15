import { Card, Result } from "antd";

export function PlaceholderPage({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Card>
      <Result
        status="info"
        title={`${title} · 建设中`}
        subTitle={`${description}（该页面将在后续迭代中迁移到新控制台。）`}
      />
    </Card>
  );
}
