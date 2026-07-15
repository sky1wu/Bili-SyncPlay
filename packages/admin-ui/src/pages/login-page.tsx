import { Alert, Button, Card, Form, Input, Typography } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ApiError } from "../api/http.js";
import { useAuth } from "../auth/auth-context.js";
import { readAdminUiConfig } from "../config.js";

type LoginFormValues = {
  username: string;
  password: string;
};

// 服务端错误信封是英文文案，这里按错误码映射成友好的中文提示。
const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "用户名或密码错误。",
  too_many_login_attempts: "登录尝试过于频繁，请稍后再试。",
  admin_auth_unavailable: "管理端认证未配置或不可用。",
};

function resolveLoginErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError && LOGIN_ERROR_MESSAGES[cause.code]) {
    return LOGIN_ERROR_MESSAGES[cause.code];
  }
  return cause instanceof Error ? cause.message : "登录失败。";
}

function isDemoPreviewRequest(): boolean {
  return (
    readAdminUiConfig().demoEnabled &&
    new URLSearchParams(window.location.search).get("demo") === "1"
  );
}

export function LoginPage() {
  const { token, signIn } = useAuth();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  if (token) {
    return <Navigate to="/overview" replace />;
  }

  const handleFinish = async (values: LoginFormValues) => {
    setSubmitting(true);
    setError("");
    try {
      await signIn(values.username.trim(), values.password);
      navigate("/overview", { replace: true });
    } catch (cause) {
      setError(resolveLoginErrorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f5f5f5",
      }}
    >
      <Card style={{ width: 360 }}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          Bili-SyncPlay Admin
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          登录管理控制台
        </Typography.Paragraph>
        {isDemoPreviewRequest() ? (
          <Alert
            type="info"
            message="新控制台暂不支持演示模式"
            description={
              <>
                演示预览请使用旧面板 <a href="/admin?demo=1">/admin?demo=1</a>
                ，新控制台的演示支持将随页面迁移逐步补齐。
              </>
            }
            showIcon
            style={{ marginBottom: 16 }}
          />
        ) : null}
        {error ? (
          <Alert
            type="error"
            message={error}
            showIcon
            style={{ marginBottom: 16 }}
          />
        ) : null}
        <Form<LoginFormValues> onFinish={handleFinish} layout="vertical">
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: "请输入用户名" }]}
          >
            <Input
              prefix={<UserOutlined />}
              autoComplete="username"
              autoFocus
            />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: "请输入密码" }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              autoComplete="current-password"
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
