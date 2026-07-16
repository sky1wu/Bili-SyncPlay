import { Alert, Input, Modal, Typography } from "antd";
import { useState } from "react";

export type PendingGovernanceAction = {
  title: string;
  description?: string;
  danger?: boolean;
  execute: (reason: string) => Promise<void>;
};

export function ReasonModal({
  pending,
  onClose,
}: {
  pending: PendingGovernanceAction | null;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const close = () => {
    setReason("");
    setError("");
    setSubmitting(false);
    onClose();
  };

  const confirm = async () => {
    if (!pending) {
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await pending.execute(reason.trim());
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={pending !== null}
      title={pending?.title}
      okText="确认执行"
      okButtonProps={{ danger: pending?.danger, loading: submitting }}
      cancelText="取消"
      onOk={confirm}
      onCancel={close}
      destroyOnHidden
    >
      {pending?.description ? (
        <Typography.Paragraph type="secondary">
          {pending.description}
        </Typography.Paragraph>
      ) : null}
      {error ? (
        <Alert
          type="error"
          message={error}
          showIcon
          style={{ marginBottom: 12 }}
        />
      ) : null}
      <Input.TextArea
        rows={2}
        placeholder="操作原因（可选，写入审计日志）"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={200}
      />
    </Modal>
  );
}
