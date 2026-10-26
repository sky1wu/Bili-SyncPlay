import { NotificationOutlined, ReloadOutlined } from "@ant-design/icons";
import { ANNOUNCEMENT_MESSAGE_MAX_LENGTH } from "@bili-syncplay/protocol";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  Radio,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { useState } from "react";
import type {
  AdminAnnouncement,
  AnnouncementLevel,
  AnnouncementResult,
} from "../../api/types.js";
import { useAuth } from "../../auth/auth-context.js";
import { formatDateTime, formatDuration } from "../../lib/format.js";
import { canManage } from "../../lib/roles.js";
import { useNow } from "../../lib/use-now.js";
import { ReasonModal } from "../rooms/reason-modal.js";
import type { PendingGovernanceAction } from "../rooms/reason-modal.js";

const ANNOUNCEMENT_QUERY_KEY = ["announcement"];

// 与节点轮询间隔一致：公告的发布/撤回本来就要这么久才到客户端。
export const ANNOUNCEMENT_REFRESH_MS = 15_000;

// 与服务端 ANNOUNCEMENT_MAX_LIFETIME_MS 一致；这里只做提前提示，以服务端校验为准。
export const ANNOUNCEMENT_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const LEVEL_LABELS: Record<AnnouncementLevel, string> = {
  info: "通知",
  warning: "警告",
};

const LEVEL_COLORS: Record<AnnouncementLevel, string> = {
  info: "blue",
  warning: "orange",
};

/**
 * 把写操作确认后的结果写进缓存。先取消在途的查询：它在写之前发出、答复的是写之前
 * 的状态，晚于这里返回就会把刚确认的结果覆盖回去，直到下一次轮询。
 */
async function showConfirmedAnnouncement(
  queryClient: QueryClient,
  announcement: AdminAnnouncement | null,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey: ANNOUNCEMENT_QUERY_KEY });
  queryClient.setQueryData<AnnouncementResult>(ANNOUNCEMENT_QUERY_KEY, {
    announcement,
  });
}

type PublishFormValues = {
  level: AnnouncementLevel;
  message: string;
  scheduledAt?: Dayjs | null;
  expiresAt?: Dayjs | null;
};

function CurrentAnnouncement({
  announcement,
  now,
}: {
  announcement: AdminAnnouncement;
  now: number;
}) {
  const remainingMs = announcement.expiresAt - now;
  return (
    <Descriptions column={1} size="small">
      <Descriptions.Item label="等级">
        <Tag color={LEVEL_COLORS[announcement.level]}>
          {LEVEL_LABELS[announcement.level]}
        </Tag>
      </Descriptions.Item>
      <Descriptions.Item label="内容">
        <Typography.Paragraph style={{ whiteSpace: "pre-wrap", margin: 0 }}>
          {announcement.message}
        </Typography.Paragraph>
      </Descriptions.Item>
      {announcement.scheduledAt !== null ? (
        <Descriptions.Item label="计划时间">
          {formatDateTime(announcement.scheduledAt)}
        </Descriptions.Item>
      ) : null}
      <Descriptions.Item label="发布时间">
        {formatDateTime(announcement.publishedAt)}
      </Descriptions.Item>
      <Descriptions.Item label="到期时间">
        {formatDateTime(announcement.expiresAt)}
        <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
          {remainingMs > 0 ? `剩余 ${formatDuration(remainingMs)}` : "已到期"}
        </Typography.Text>
      </Descriptions.Item>
      <Descriptions.Item label="ID">
        <Typography.Text code>{announcement.id}</Typography.Text>
      </Descriptions.Item>
    </Descriptions>
  );
}

function PublishForm({ replacing }: { replacing: boolean }) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const { message, modal } = AntdApp.useApp();
  const [form] = Form.useForm<PublishFormValues>();
  const [error, setError] = useState("");

  const publish = useMutation({
    mutationFn: (values: PublishFormValues) =>
      api.publishAnnouncement({
        level: values.level,
        message: values.message.trim(),
        scheduledAt: values.scheduledAt?.valueOf(),
        expiresAt: values.expiresAt?.valueOf() ?? 0,
      }),
    onSuccess: async (result) => {
      await showConfirmedAnnouncement(queryClient, result.announcement);
      form.resetFields();
      setError("");
      void message.success("公告已发布，各节点约 15 秒内推送。");
    },
    onError: (cause) => {
      setError(cause instanceof Error ? cause.message : "发布失败。");
    },
  });

  // 每次发布都先确认：公告会推给所有在线用户，而表单里任意输入框按回车
  // （包括确认日期的那一下）都会提交表单。
  const submit = (values: PublishFormValues) => {
    setError("");
    modal.confirm({
      title: replacing ? "替换当前公告？" : "发布公告？",
      content: (
        <>
          <Typography.Paragraph style={{ whiteSpace: "pre-wrap" }}>
            {values.message.trim()}
          </Typography.Paragraph>
          <Typography.Text type="secondary">
            {replacing
              ? "新公告发布后，当前公告会立即失效。"
              : "发布后各节点约 15 秒内推送给房间内的扩展用户。"}
          </Typography.Text>
        </>
      ),
      okText: replacing ? "发布并替换" : "确认发布",
      cancelText: "取消",
      onOk: () => publish.mutateAsync(values).catch(() => undefined),
    });
  };

  return (
    <Form<PublishFormValues>
      form={form}
      layout="vertical"
      initialValues={{ level: "info" }}
      onFinish={submit}
      disabled={publish.isPending}
    >
      {error ? (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Form.Item name="level" label="等级" required>
        <Radio.Group
          options={[
            { value: "info", label: LEVEL_LABELS.info },
            {
              value: "warning",
              label: `${LEVEL_LABELS.warning}（页面内提示）`,
            },
          ]}
        />
      </Form.Item>
      <Form.Item
        name="message"
        label="内容"
        rules={[
          {
            validator: (_, value: string | undefined) =>
              value?.trim()
                ? Promise.resolve()
                : Promise.reject(new Error("请填写公告内容")),
          },
        ]}
      >
        <Input.TextArea
          rows={3}
          maxLength={ANNOUNCEMENT_MESSAGE_MAX_LENGTH}
          showCount
          placeholder="例如：今晚 04:30 服务器维护，预计中断 5 分钟。"
        />
      </Form.Item>
      <Form.Item
        name="scheduledAt"
        label="计划时间（可选）"
        extra="仅随公告展示，例如维护开始时间；不影响公告何时生效。"
      >
        <DatePicker showTime style={{ width: 240 }} />
      </Form.Item>
      <Form.Item
        name="expiresAt"
        label="到期时间"
        extra="到期后公告自动失效，最长 30 天。"
        rules={[
          {
            validator: (_, value: Dayjs | null | undefined) => {
              if (!value) {
                return Promise.reject(new Error("请选择到期时间"));
              }
              const remainingMs = value.valueOf() - Date.now();
              if (remainingMs <= 0) {
                return Promise.reject(new Error("到期时间必须晚于现在"));
              }
              if (remainingMs > ANNOUNCEMENT_MAX_LIFETIME_MS) {
                return Promise.reject(new Error("到期时间不能超过 30 天"));
              }
              return Promise.resolve();
            },
          },
        ]}
      >
        <DatePicker
          showTime
          style={{ width: 240 }}
          disabledDate={(date) =>
            date.isBefore(dayjs(), "day") ||
            date.isAfter(dayjs().add(ANNOUNCEMENT_MAX_LIFETIME_MS, "ms"), "day")
          }
        />
      </Form.Item>
      <Button
        type="primary"
        htmlType="submit"
        icon={<NotificationOutlined />}
        loading={publish.isPending}
      >
        {replacing ? "发布并替换当前公告" : "发布公告"}
      </Button>
    </Form>
  );
}

export function AnnouncementPage() {
  const { api, me } = useAuth();
  const queryClient = useQueryClient();
  const manageable = canManage(me);
  const [pending, setPending] = useState<PendingGovernanceAction | null>(null);
  const { message } = AntdApp.useApp();
  const announcementQuery = useQuery({
    queryKey: ANNOUNCEMENT_QUERY_KEY,
    queryFn: () => api.getAnnouncement(),
    refetchInterval: ANNOUNCEMENT_REFRESH_MS,
  });
  const announcement = announcementQuery.data?.announcement ?? null;
  const now = useNow(1_000, announcement !== null);

  const refreshNow = () => {
    void queryClient.invalidateQueries({ queryKey: ANNOUNCEMENT_QUERY_KEY });
  };

  const requestWithdraw = () => {
    setPending({
      title: "撤回当前公告",
      description: "撤回后各节点约 15 秒内从扩展端移除这条公告。",
      danger: true,
      execute: async (reason) => {
        await api.withdrawAnnouncement(reason);
        await showConfirmedAnnouncement(queryClient, null);
        void message.success("公告已撤回。");
      },
    });
  };

  let current;
  if (announcementQuery.isPending) {
    current = (
      <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
        <Spin />
      </div>
    );
  } else if (announcementQuery.isError) {
    current = (
      <Alert
        type="error"
        showIcon
        message="公告加载失败"
        description={
          announcementQuery.error instanceof Error
            ? announcementQuery.error.message
            : "请求失败。"
        }
        action={
          <Button size="small" onClick={refreshNow}>
            重试
          </Button>
        }
      />
    );
  } else if (announcement === null) {
    current = <Empty description="当前没有公告" />;
  } else {
    current = <CurrentAnnouncement announcement={announcement} now={now} />;
  }

  return (
    <Space direction="vertical" size={16} style={{ display: "flex" }}>
      <Alert
        type="info"
        showIcon
        message="同一时间只有一条公告。发布后各节点约 15 秒内推送给房间内的扩展用户，仅支持公告的扩展版本会显示。"
      />
      <Card
        title="当前公告"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={refreshNow}>
              刷新
            </Button>
            {manageable && announcement !== null ? (
              <Button danger onClick={requestWithdraw}>
                撤回
              </Button>
            ) : null}
          </Space>
        }
      >
        {current}
      </Card>
      {manageable ? (
        <Card title="发布公告">
          <PublishForm replacing={announcement !== null} />
        </Card>
      ) : null}
      <ReasonModal pending={pending} onClose={() => setPending(null)} />
    </Space>
  );
}
