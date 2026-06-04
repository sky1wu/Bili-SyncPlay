export const STORAGE_KEY = "bili-syncplay-admin-token";
export const AUTO_REFRESH_MS = 15000;
export const DEMO_QUERY_KEY = "demo";
export const DEMO_TOKEN = "demo-token";

export function normalizeAdminUiConfig(value) {
  if (!value || typeof value !== "object") {
    return { demoEnabled: false, apiBaseUrl: "" };
  }

  return {
    demoEnabled: value.demoEnabled === true,
    apiBaseUrl:
      typeof value.apiBaseUrl === "string"
        ? value.apiBaseUrl.replace(/\/+$/, "")
        : "",
  };
}

export const ADMIN_UI_CONFIG = normalizeAdminUiConfig(
  window.__ADMIN_UI_CONFIG__,
);

export const routeMeta = {
  "/overview": {
    title: "概览",
    description: "服务、存储、运行态与近期事件的快速视图。",
  },
  "/rooms": {
    title: "房间管理",
    description: "筛选房间、查看详情并执行治理动作。",
  },
  "/events": { title: "运行事件", description: "按条件检索近期运行事件。" },
  "/ip-blocks": {
    title: "小黑屋",
    description: "维护禁止连接的 IP 黑名单。",
  },
  "/audit-logs": {
    title: "审计日志",
    description: "查看管理员操作留痕和请求参数。",
  },
  "/config": {
    title: "配置摘要",
    description: "核对当前实例运行配置，不暴露敏感信息。",
  },
};

export const state = {
  demo:
    ADMIN_UI_CONFIG.demoEnabled &&
    new URLSearchParams(location.search).get(DEMO_QUERY_KEY) === "1",
  token: localStorage.getItem(STORAGE_KEY) || "",
  me: null,
  currentRoute: "/overview",
  notice: null,
  dialog: null,
  refreshHandle: null,
  lastOverviewData: null,
  instanceId: "",
  overviewAutoRefresh: true,
};

export function resolveApiPath(path) {
  const baseUrl = ADMIN_UI_CONFIG.apiBaseUrl || "";
  return `${baseUrl}${path}`;
}

export function normalizePath(pathname, token = state.token) {
  if (!pathname.startsWith("/admin")) {
    return "/login";
  }

  const path = pathname.slice("/admin".length) || "/overview";
  if (path === "/") {
    return token ? "/overview" : "/login";
  }
  return path;
}

export function routeHref(path) {
  return `/admin${path}`;
}

export function withDemoQuery(url, isDemo = state.demo) {
  if (!isDemo) {
    return url;
  }

  const resolved = new URL(url, location.origin);
  resolved.searchParams.set(DEMO_QUERY_KEY, "1");
  return `${resolved.pathname}${resolved.search}`;
}

export function clearRefreshTimer(targetState = state) {
  if (targetState.refreshHandle) {
    clearInterval(targetState.refreshHandle);
    targetState.refreshHandle = null;
  }
}

export function clearAuth(targetState = state) {
  targetState.token = "";
  targetState.me = null;
  localStorage.removeItem(STORAGE_KEY);
  clearRefreshTimer(targetState);
}

export function showNotice(targetState, type, message) {
  targetState.notice = { type, message };
}

export function clearNotice(targetState = state) {
  targetState.notice = null;
}

export function setToken(targetState, token) {
  targetState.token = token;
  localStorage.setItem(STORAGE_KEY, token);
}
