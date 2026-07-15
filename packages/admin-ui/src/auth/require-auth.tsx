import { Button, Result, Spin } from "antd";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./auth-context.js";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { token, initializing, meError, retryLoadMe } = useAuth();
  const location = useLocation();

  if (initializing) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Spin size="large" />
      </div>
    );
  }

  if (!token) {
    // 保留查询串（如 ?demo=1），登录页依赖它展示演示模式提示。
    return (
      <Navigate to={{ pathname: "/login", search: location.search }} replace />
    );
  }

  if (meError) {
    return (
      <Result
        status="error"
        title="管理员身份校验失败"
        subTitle={meError}
        extra={
          <Button type="primary" onClick={retryLoadMe}>
            重试
          </Button>
        }
      />
    );
  }

  return children;
}
