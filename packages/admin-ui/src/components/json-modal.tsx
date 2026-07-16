import { Modal, Typography } from "antd";

export function JsonModal({
  title,
  value,
  onClose,
}: {
  title: string;
  value: unknown;
  onClose: () => void;
}) {
  return (
    <Modal
      open={value !== null}
      title={title}
      footer={null}
      onCancel={onClose}
      width={640}
    >
      <Typography.Paragraph>
        <pre style={{ maxHeight: 480, overflow: "auto", margin: 0 }}>
          {JSON.stringify(value, null, 2)}
        </pre>
      </Typography.Paragraph>
    </Modal>
  );
}
