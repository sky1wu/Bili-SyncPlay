import { Modal, Table, Tag, Typography } from "antd";

export type BatchOutcome = {
  roomCode: string;
  ok: boolean;
  message?: string;
};

export type BatchResult = {
  title: string;
  outcomes: BatchOutcome[];
};

export function BatchResultModal({
  result,
  onClose,
}: {
  result: BatchResult | null;
  onClose: () => void;
}) {
  const failed = result?.outcomes.filter((outcome) => !outcome.ok) ?? [];
  const succeeded = (result?.outcomes.length ?? 0) - failed.length;

  return (
    <Modal
      open={result !== null}
      title={result?.title}
      footer={null}
      onCancel={onClose}
      width={560}
    >
      <Typography.Paragraph>
        成功 {succeeded} 个，失败 {failed.length} 个。
        {failed.length > 0 ? "失败的房间保持勾选，可修正后重试。" : ""}
      </Typography.Paragraph>
      {failed.length > 0 ? (
        <Table<BatchOutcome>
          size="small"
          rowKey="roomCode"
          pagination={false}
          dataSource={failed}
          columns={[
            {
              title: "房间",
              dataIndex: "roomCode",
              width: 120,
              render: (value: string) => (
                <Typography.Text code>{value}</Typography.Text>
              ),
            },
            {
              title: "失败原因",
              dataIndex: "message",
              render: (value: string | undefined) => (
                <>
                  <Tag color="error">失败</Tag>
                  {value ?? "未知错误"}
                </>
              ),
            },
          ]}
        />
      ) : null}
    </Modal>
  );
}
