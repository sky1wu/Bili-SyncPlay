import {
  DashboardOutlined,
  FileSearchOutlined,
  SettingOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { Button, Layout, Menu, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/auth-context.js";
import { NAV_ITEMS, findNavItem } from "./nav-items.js";

const NAV_ICONS: Record<string, ReactNode> = {
  "/overview": <DashboardOutlined />,
  "/rooms": <TeamOutlined />,
  "/events": <ThunderboltOutlined />,
  "/audit-logs": <FileSearchOutlined />,
  "/config": <SettingOutlined />,
};

export function AppLayout() {
  const { me, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const activeItem = findNavItem(location.pathname);

  const handleLogout = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Sider breakpoint="lg" collapsedWidth={0}>
        <div style={{ padding: "16px 24px" }}>
          <Typography.Text
            style={{ color: "rgba(255, 255, 255, 0.65)", fontSize: 12 }}
          >
            Admin
          </Typography.Text>
          <Typography.Title
            level={4}
            style={{ color: "#fff", margin: "4px 0 0" }}
          >
            Bili-SyncPlay
          </Typography.Title>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={activeItem ? [activeItem.path] : []}
          items={NAV_ITEMS.map((item) => ({
            key: item.path,
            icon: NAV_ICONS[item.path],
            label: item.label,
          }))}
          onClick={({ key }) => navigate(key)}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{
            background: "#fff",
            padding: "0 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Typography.Title level={4} style={{ margin: 0 }}>
            {activeItem?.label ?? "概览"}
          </Typography.Title>
          <Space>
            <Typography.Text strong>{me?.username}</Typography.Text>
            {me ? <Tag color="blue">{me.role}</Tag> : null}
            <Button onClick={handleLogout}>退出</Button>
          </Space>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>
          {activeItem ? (
            <Typography.Paragraph type="secondary">
              {activeItem.description}
            </Typography.Paragraph>
          ) : null}
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
