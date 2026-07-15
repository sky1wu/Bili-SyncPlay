export type NavItem = {
  path: string;
  label: string;
  description: string;
};

export const NAV_ITEMS: NavItem[] = [
  {
    path: "/overview",
    label: "概览",
    description: "服务、存储、运行态与近期事件的快速视图。",
  },
  {
    path: "/rooms",
    label: "房间管理",
    description: "筛选房间、查看详情并执行治理动作。",
  },
  {
    path: "/events",
    label: "运行事件",
    description: "按条件检索近期运行事件。",
  },
  {
    path: "/audit-logs",
    label: "审计日志",
    description: "查看管理员操作留痕和请求参数。",
  },
  {
    path: "/config",
    label: "配置摘要",
    description: "核对当前实例运行配置，不暴露敏感信息。",
  },
];

export function findNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find(
    (item) => pathname === item.path || pathname.startsWith(`${item.path}/`),
  );
}
