import { createAdminApi } from "./api.js";
import {
  AUTO_REFRESH_MS,
  clearAuth as clearAuthState,
  clearNotice as clearNoticeState,
  clearRefreshTimer as clearRefreshTimerState,
  DEMO_QUERY_KEY,
  DEMO_TOKEN,
  normalizePath,
  routeHref,
  routeMeta,
  setToken as setTokenState,
  showNotice as showNoticeState,
  state,
  withDemoQuery,
} from "./state.js";
import {
  renderDialog as renderDialogTemplate,
  renderLoginScreen as renderLoginTemplate,
  renderNavLink as renderNavLinkTemplate,
} from "./templates.js";

let dialogEventsBound = false;

const appRoot = document.querySelector("#app");
const api = createAdminApi({
  state,
  serializeQuery,
  clearAuth,
  navigate,
  mockRequest: mockApiRequest,
});

function clearRefreshTimer() {
  clearRefreshTimerState(state);
}

function clearAuth() {
  clearAuthState(state);
}

function showNotice(type, message) {
  showNoticeState(state, type, message);
}

function clearNotice() {
  clearNoticeState(state);
}

function setToken(token) {
  setTokenState(state, token);
}

async function bootstrap() {
  bindDialogEvents();
  state.currentRoute = normalizePath(location.pathname);

  if (state.demo) {
    state.token = "demo-token";
    state.me = { id: "admin-demo", username: "demo-admin", role: "admin" };
    await render();
    return;
  }

  if (state.token) {
    try {
      state.me = await api.getMe();
    } catch (error) {
      if (error.code !== "unauthorized") {
        showNotice("error", error.message || "管理员身份校验失败。");
      }
      clearAuth();
    }
  }

  if (!state.token && state.currentRoute !== "/login") {
    navigate("/login", true);
    return;
  }

  if (state.token && state.currentRoute === "/login") {
    navigate("/overview", true);
    return;
  }

  await render();
}

function canManage() {
  return (
    state.me && (state.me.role === "operator" || state.me.role === "admin")
  );
}

function navigate(path, replace = false) {
  state.currentRoute = path;
  const method = replace ? history.replaceState : history.pushState;
  method.call(history, null, "", withDemoQuery(routeHref(path)));
  render().catch(handleFatalRenderError);
}

function navigateToUrl(url, path, replace = false) {
  state.currentRoute = path;
  const method = replace ? history.replaceState : history.pushState;
  method.call(history, null, "", url);
  render().catch(handleFatalRenderError);
}

function formatDateTime(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  const raw = typeof value === "number" ? String(value) : date.toISOString();
  return `<span title="${escapeHtml(raw)}">${escapeHtml(date.toLocaleString())}</span>`;
}

function renderTimeBlock(value, hint = "") {
  if (value === null || value === undefined || value === "") {
    return renderEmptyValue();
  }

  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return renderEmptyValue();
  }

  return renderDataPair(
    formatDateTime(value),
    hint || escapeHtml(date.toLocaleDateString()),
  );
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((part, index) =>
      index === 0 ? String(part) : String(part).padStart(2, "0"),
    )
    .join(":");
}

function getPlaybackState(playback) {
  if (!playback) {
    return "paused";
  }

  if (typeof playback.playState === "string" && playback.playState) {
    return playback.playState;
  }

  return playback.paused ? "paused" : "playing";
}

function formatJson(value) {
  return escapeHtml(JSON.stringify(value, null, 2));
}

function renderEmptyValue(value = "—") {
  return `<span class="empty-value">${escapeHtml(value)}</span>`;
}

function renderResultBadge(value) {
  const normalized = String(value || "").toLowerCase();
  let tone = "neutral";
  if (
    normalized === "ok" ||
    normalized === "success" ||
    normalized === "ready" ||
    normalized === "healthy"
  ) {
    tone = "success";
  } else if (
    normalized === "rejected" ||
    normalized === "error" ||
    normalized === "failed" ||
    normalized === "closed"
  ) {
    tone = "danger";
  } else if (normalized) {
    tone = "warning";
  }

  return `<span class="status ${tone}">${escapeHtml(value || "—")}</span>`;
}

function classifyOrigin(value) {
  if (!value) {
    return { label: "", tone: "neutral" };
  }

  if (value.startsWith("chrome-extension://")) {
    return { label: "扩展", tone: "extension" };
  }

  if (value.startsWith("https://")) {
    return { label: "HTTPS", tone: "web" };
  }

  if (value.startsWith("http://")) {
    return { label: "HTTP", tone: "web" };
  }

  return { label: "其他", tone: "neutral" };
}

function renderCompactCode(value, copyLabel = "复制") {
  if (!value) {
    return renderEmptyValue();
  }

  return `
    <div class="compact-stack">
      <span class="code compact-code" title="${escapeHtml(value)}">${escapeHtml(value)}</span>
      <button class="button link" type="button" data-copy="${escapeHtml(value)}">${copyLabel}</button>
    </div>
  `;
}

function renderDataPair(primary, secondary) {
  return `
    <div class="data-pair">
      <div class="data-pair-primary">${primary}</div>
      ${secondary ? `<div class="data-pair-secondary">${secondary}</div>` : ""}
    </div>
  `;
}

function renderMiniStat(label, value, tone = "neutral") {
  return `
    <div class="mini-stat ${escapeHtml(tone)}">
      <span class="mini-stat-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function formatRelativeDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "—";
  }
  if (ms <= 0) {
    return "已到期";
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return "不足 1 分钟";
  }
  if (minutes < 60) {
    return `${minutes} 分钟后`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时后`;
  }
  return `${Math.floor(hours / 24)} 天后`;
}

function getRoomAttention(item) {
  const now = Date.now();
  if (item.isActive && !item.sharedVideo) {
    return {
      tone: "warning",
      label: "活跃但未共享视频",
      hint: "通常代表成员已进入房间，但还没人发起共享。",
    };
  }

  if (item.isActive && item.memberCount >= 4) {
    return {
      tone: "success",
      label: "多人活跃中",
      hint: `${item.memberCount} 人在线，适合优先关注同步状态。`,
    };
  }

  if (!item.isActive && item.expiresAt && item.expiresAt > now) {
    const remainingMs = item.expiresAt - now;
    if (remainingMs <= 10 * 60_000) {
      return {
        tone: "warning",
        label: "即将过期",
        hint: `${formatRelativeDuration(remainingMs)}，若要保留请尽快让成员重新进入。`,
      };
    }
  }

  if (!item.isActive && item.sharedVideo) {
    return {
      tone: "neutral",
      label: "空闲待回访",
      hint: "房间里保留了共享状态，成员重进后可继续协同。",
    };
  }

  return {
    tone: item.isActive ? "success" : "neutral",
    label: item.isActive ? "运行中" : "空闲中",
    hint: item.isActive ? "房间当前有在线成员。" : "当前没有在线成员。",
  };
}

function getRoomVideoSummary(item) {
  if (!item.sharedVideo) {
    return {
      primary: "未共享视频",
      secondary: item.isActive ? "可提醒房主发起共享" : "空闲房间可忽略",
    };
  }

  return {
    primary: item.sharedVideo.title || item.sharedVideo.videoId || "已共享视频",
    secondary: item.playback
      ? `${getPlaybackState(item.playback)} @ ${Number(item.playback.currentTime ?? 0).toFixed(1)}s`
      : "已共享，尚无播放同步状态",
  };
}

function getEventPresentation(eventName) {
  const presentationMap = {
    room_created: {
      label: "创建房间",
      category: "房间生命周期",
      tone: "success",
      summary: "有成员新建了房间。",
    },
    room_joined: {
      label: "加入房间",
      category: "房间生命周期",
      tone: "success",
      summary: "有成员进入房间。",
    },
    room_left: {
      label: "离开房间",
      category: "房间生命周期",
      tone: "neutral",
      summary: "有成员离开房间。",
    },
    room_restored: {
      label: "恢复房间",
      category: "房间生命周期",
      tone: "success",
      summary: "成员重新进入了一个已保存的房间。",
    },
    room_expired_deleted: {
      label: "过期清理",
      category: "房间生命周期",
      tone: "warning",
      summary: "空闲房间达到过期条件后被删除。",
    },
    room_event_bus_error: {
      label: "房间事件总线异常",
      category: "系统维护",
      tone: "danger",
      summary: "节点间房间广播出现异常。",
    },
    runtime_index_reaper_failed: {
      label: "运行时索引清理失败",
      category: "系统维护",
      tone: "danger",
      summary: "离线节点残留索引回收失败。",
    },
    ws_connection_rejected: {
      label: "连接被拒绝",
      category: "连接与安全",
      tone: "warning",
      summary: "有 WebSocket 连接在握手阶段被拒绝。",
    },
    ws_connection_closed: {
      label: "连接关闭",
      category: "连接与安全",
      tone: "neutral",
      summary: "一个 WebSocket 会话结束。",
    },
    auth_failed: {
      label: "鉴权失败",
      category: "连接与安全",
      tone: "danger",
      summary: "成员缺少权限、令牌无效或已被踢出。",
    },
    invalid_message: {
      label: "非法消息",
      category: "连接与安全",
      tone: "warning",
      summary: "客户端发送了协议不合法的消息。",
    },
    rate_limited: {
      label: "触发限流",
      category: "连接与安全",
      tone: "warning",
      summary: "某类操作过于频繁，被服务端限流。",
    },
    playback_update_applied: {
      label: "已应用播放同步",
      category: "播放协同",
      tone: "success",
      summary: "新的播放状态已被接受并广播。",
    },
    playback_update_ignored: {
      label: "忽略播放同步",
      category: "播放协同",
      tone: "neutral",
      summary: "收到的播放状态因时序或权限原因未被采用。",
    },
    admin_room_closed: {
      label: "管理员关闭房间",
      category: "后台治理",
      tone: "danger",
      summary: "管理员已关闭房间并断开成员。",
    },
    admin_room_expired: {
      label: "管理员提前过期房间",
      category: "后台治理",
      tone: "warning",
      summary: "管理员主动清理了空闲房间。",
    },
    admin_room_video_cleared: {
      label: "管理员清空共享视频",
      category: "后台治理",
      tone: "warning",
      summary: "管理员已重置当前共享视频和播放状态。",
    },
    admin_member_kicked: {
      label: "管理员踢出成员",
      category: "后台治理",
      tone: "danger",
      summary: "管理员主动移除了某个成员。",
    },
    admin_session_disconnected: {
      label: "管理员断开会话",
      category: "后台治理",
      tone: "warning",
      summary: "管理员强制断开了一个会话。",
    },
  };

  return (
    presentationMap[eventName] || {
      label: eventName,
      category: "其他事件",
      tone: "neutral",
      summary: "查看详情 JSON 获取完整上下文。",
    }
  );
}

function renderEventNameCell(item) {
  const meta = getEventPresentation(item.event);
  return renderDataPair(
    `
      <div class="event-primary">
        <span class="event-name">${escapeHtml(meta.label)}</span>
        <span class="event-category ${escapeHtml(meta.tone)}">${escapeHtml(meta.category)}</span>
      </div>
    `,
    item.event === meta.label
      ? meta.summary
      : `${meta.summary} 原始事件名：${item.event}`,
  );
}

function summarizeVisibleEvents(items) {
  const counters = {
    governance: 0,
    security: 0,
    playback: 0,
    room: 0,
  };

  items.forEach((item) => {
    const category = getEventPresentation(item.event).category;
    if (category === "后台治理") {
      counters.governance += 1;
    } else if (category === "连接与安全") {
      counters.security += 1;
    } else if (category === "播放协同") {
      counters.playback += 1;
    } else if (category === "房间生命周期") {
      counters.room += 1;
    }
  });

  return counters;
}

function getAuditActionPresentation(action) {
  const actionMap = {
    close_room: {
      label: "关闭房间",
      category: "房间治理",
      tone: "danger",
      summary: "强制关闭房间并断开成员。",
    },
    expire_room: {
      label: "提前过期房间",
      category: "房间治理",
      tone: "warning",
      summary: "对空闲房间执行立即清理。",
    },
    clear_room_video: {
      label: "清空共享视频",
      category: "房间治理",
      tone: "warning",
      summary: "重置共享视频和播放状态。",
    },
    kick_member: {
      label: "踢出成员",
      category: "成员治理",
      tone: "danger",
      summary: "移除房间中的指定成员。",
    },
    disconnect_session: {
      label: "断开会话",
      category: "成员治理",
      tone: "warning",
      summary: "强制断开指定会话。",
    },
  };

  return (
    actionMap[action] || {
      label: action,
      category: "其他治理",
      tone: "neutral",
      summary: "查看请求内容了解完整上下文。",
    }
  );
}

function getAuditTargetTypeLabel(targetType) {
  const labelMap = {
    room: "房间",
    session: "会话",
    member: "成员",
    config: "配置",
    block: "封禁",
  };

  return labelMap[targetType] || targetType || "未知目标";
}

function renderAuditActionCell(item) {
  const meta = getAuditActionPresentation(item.action);
  return renderDataPair(
    `
      <div class="event-primary">
        <span class="event-name">${escapeHtml(meta.label)}</span>
        <span class="event-category ${escapeHtml(meta.tone)}">${escapeHtml(meta.category)}</span>
      </div>
    `,
    item.action === meta.label
      ? meta.summary
      : `${meta.summary} 原始动作名：${item.action}`,
  );
}

function renderAuditTargetCell(item) {
  const targetLabel = getAuditTargetTypeLabel(item.targetType);
  return renderDataPair(
    item.targetId
      ? `<span class="primary-code">${escapeHtml(item.targetId)}</span>`
      : renderEmptyValue(),
    `${targetLabel}${item.targetInstanceId ? ` · 目标实例 ${item.targetInstanceId}` : ""}${item.executorInstanceId ? ` · 执行实例 ${item.executorInstanceId}` : ""}`,
  );
}

function renderAuditRequestSummary(item) {
  const fragments = [];
  if (item.reason) {
    fragments.push(`原因：${item.reason}`);
  }
  if (item.commandStatus) {
    fragments.push(`命令状态：${item.commandStatus}`);
  }
  if (item.commandCode) {
    fragments.push(`命令代码：${item.commandCode}`);
  }
  if (item.commandRequestId) {
    fragments.push(`请求号：${item.commandRequestId}`);
  }
  return fragments.length > 0
    ? fragments.join(" · ")
    : "查看请求内容了解更多细节";
}

function summarizeAuditLogs(items) {
  const counters = {
    success: 0,
    rejected: 0,
    error: 0,
    roomGovernance: 0,
    memberGovernance: 0,
  };

  items.forEach((item) => {
    if (item.result === "ok") {
      counters.success += 1;
    } else if (item.result === "rejected") {
      counters.rejected += 1;
    } else if (item.result === "error") {
      counters.error += 1;
    }

    const category = getAuditActionPresentation(item.action).category;
    if (category === "房间治理") {
      counters.roomGovernance += 1;
    } else if (category === "成员治理") {
      counters.memberGovernance += 1;
    }
  });

  return counters;
}

function isGlobalAdminInstance(instanceId) {
  return typeof instanceId === "string" && instanceId.includes("global-admin");
}

function resolveConsoleContext(instanceId, serviceName = "") {
  if (
    serviceName === "bili-syncplay-global-admin" ||
    isGlobalAdminInstance(instanceId)
  ) {
    return {
      label: "全局后台",
      title: "全局控制面",
      description:
        "这里代表治理与观测入口本身；具体房间会显示它所属的业务实例。",
      pill: "集群视图",
    };
  }

  return {
    label: "实例",
    title: "实例上下文",
    description: "统一管理当前服务实例的运行状态与治理动作。",
    pill: `实例 ${instanceId || "—"}`,
  };
}

function renderOriginValue(value) {
  if (!value) {
    return renderEmptyValue();
  }

  const originMeta = classifyOrigin(value);
  return `
    <div class="origin-stack">
      <div class="origin-meta">
        <span class="origin-badge ${escapeHtml(originMeta.tone)}">${escapeHtml(originMeta.label)}</span>
      </div>
      <span class="code origin-value" title="${escapeHtml(value)}">${escapeHtml(value)}</span>
      <button class="button link" type="button" data-copy="${escapeHtml(value)}">复制</button>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function serializeQuery(query) {
  const params = new URLSearchParams();
  if (state.demo) {
    params.set(DEMO_QUERY_KEY, "1");
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    params.set(key, String(value));
  }

  const raw = params.toString();
  return raw ? `?${raw}` : "";
}

async function withAction(action, successMessage, onSuccess) {
  try {
    const result = await action();
    if (successMessage) {
      showNotice("success", successMessage);
    }
    if (typeof onSuccess === "function") {
      await onSuccess(result);
    } else {
      await render();
    }
    return result;
  } catch (error) {
    showNotice("error", error.message || "操作失败。");
    render().catch(handleFatalRenderError);
    return null;
  }
}

async function openReasonDialog(config) {
  return new Promise((resolve) => {
    state.dialog = {
      ...config,
      resolve,
    };
    render().catch(handleFatalRenderError);
  });
}

function syncDialogDom() {
  const dialogRoot = document.querySelector(".dialog-root");
  if (!dialogRoot) {
    return;
  }

  if (!state.dialog) {
    dialogRoot.hidden = true;
    dialogRoot.replaceChildren();
    return;
  }

  dialogRoot.outerHTML = renderDialog();
}

function closeDialog(result = null) {
  const resolver = state.dialog?.resolve;
  state.dialog = null;
  syncDialogDom();
  if (resolver) {
    resolver(result);
  }
  render().catch(handleFatalRenderError);
}

function bindDialogEvents() {
  if (dialogEventsBound) {
    return;
  }

  dialogEventsBound = true;

  document.addEventListener("click", (event) => {
    const closeButton = event.target.closest("[data-dialog-close]");
    if (!closeButton) {
      return;
    }

    event.preventDefault();
    closeDialog(null);
  });

  document.addEventListener("submit", (event) => {
    const form = event.target.closest("#confirm-dialog");
    if (!form) {
      return;
    }

    event.preventDefault();
    const reason = new FormData(form).get("reason")?.toString().trim() || "";
    closeDialog({ reason });
  });
}

async function confirmAction(config) {
  const result = await openReasonDialog(config);
  if (!result) {
    return;
  }
  await withAction(
    () => config.onConfirm(result.reason),
    config.successMessage,
    config.onSuccess,
  );
}

function handleFatalRenderError(error) {
  console.error(error);
  showNotice("error", "页面渲染失败。");
  appRoot.innerHTML = `<div class="login-shell"><div class="login-card"><h1>渲染失败</h1><p>${escapeHtml(error.message || "未知错误")}</p></div></div>`;
}

async function render() {
  clearRefreshTimer();

  if (!state.token || state.currentRoute === "/login") {
    renderLogin();
    bindLoginEvents();
    return;
  }

  const page = await loadPage();
  if (page.instanceId) {
    state.instanceId = page.instanceId;
  }
  if (!page.instanceId && !state.instanceId) {
    await ensureInstanceId();
  }
  const meta =
    page.meta || routeMeta[state.currentRoute] || routeMeta["/overview"];
  const instanceId =
    page.instanceId ||
    state.instanceId ||
    state.lastOverviewData?.instanceId ||
    "—";
  const consoleContext = resolveConsoleContext(
    instanceId,
    page.serviceName || state.lastOverviewData?.name,
  );
  document.title = `${meta.title} | Bili-SyncPlay Admin`;

  appRoot.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-eyebrow">管理控制台</span>
          <h1>Bili-SyncPlay</h1>
          <p>排障、治理和运行观察统一入口。</p>
        </div>
        <nav class="nav">
          ${renderNavLink("/overview", "概览")}
          ${renderNavLink("/rooms", "房间管理")}
          ${renderNavLink("/events", "运行事件")}
          ${renderNavLink("/audit-logs", "审计日志")}
          ${renderNavLink("/config", "配置摘要")}
        </nav>
        <div class="sidebar-meta-card">
          <div class="sidebar-meta-kicker">${escapeHtml(consoleContext.title)}</div>
          <div class="sidebar-meta">${escapeHtml(consoleContext.label)}</div>
          <strong>${escapeHtml(instanceId)}</strong>
          <div class="sidebar-meta">${escapeHtml(consoleContext.description)}</div>
        </div>
      </aside>
      <main class="main">
        <div class="main-inner">
        <section class="topbar-card">
          <div class="topbar">
            <div class="page-title">
              <div class="page-kicker">运营控制台</div>
              <h2>${escapeHtml(meta.title)}</h2>
              <p>${escapeHtml(meta.description)}</p>
            </div>
            <div class="userbar-card">
              <div class="userbar-meta">
                <div class="userbar-label">当前登录</div>
                <div class="userbar-name">${escapeHtml(state.me.username)}</div>
              </div>
              <div class="userbar">
                <span class="pill">${escapeHtml(state.me.role)}</span>
                <span class="pill">${escapeHtml(consoleContext.pill)}</span>
              </div>
              <button class="button ghost" data-action="logout">退出登录</button>
            </div>
          </div>
          <div class="topbar-subline">
            <div class="pill subtle">${escapeHtml(consoleContext.pill)}</div>
            <div class="topbar-note">桌面优先的后台工作台，面向排障、治理和运行观察。</div>
          </div>
        </section>
        ${state.notice ? `<div class="notice ${escapeHtml(state.notice.type)}">${escapeHtml(state.notice.message)}</div>` : ""}
        ${page.html}
        </div>
      </main>
    </div>
    ${renderDialog()}
  `;

  bindCommonEvents(page);
  if (typeof page.bind === "function") {
    page.bind();
  }
}

function renderNavLink(path, label) {
  return renderNavLinkTemplate({
    active: state.currentRoute === path,
    href: withDemoQuery(routeHref(path)),
    label,
    path,
  });
}

async function ensureInstanceId() {
  try {
    const config = await api.getConfig();
    state.instanceId = config.instanceId || "";
  } catch {
    // ignore; the current page can still render without instance metadata
  }
}

function renderDialog() {
  return renderDialogTemplate(state.dialog, formatJson);
}

function bindCommonEvents(page) {
  document.querySelectorAll("[data-nav]").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.preventDefault();
      navigate(element.getAttribute("data-nav"));
    });
  });

  document
    .querySelector("[data-action='logout']")
    ?.addEventListener("click", async () => {
      try {
        await api.logout();
      } catch {
        // ignore
      }
      clearAuth();
      navigate("/login", true);
    });

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.getAttribute("data-copy"));
        showNotice("success", "已复制到剪贴板。");
      } catch {
        showNotice("error", "复制失败。");
      }
      render().catch(handleFatalRenderError);
    });
  });

  if (page.autoRefresh) {
    state.refreshHandle = setInterval(() => {
      render().catch(handleFatalRenderError);
    }, AUTO_REFRESH_MS);
  }

  if (state.notice?.type === "success") {
    setTimeout(() => {
      if (state.notice?.type === "success") {
        clearNotice();
        render().catch(handleFatalRenderError);
      }
    }, 2400);
  }
}

function renderLogin() {
  appRoot.innerHTML = renderLoginTemplate(state.notice);
}

function bindLoginEvents() {
  document
    .querySelector("#login-form")
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const username = formData.get("username")?.toString().trim() || "";
      const password = formData.get("password")?.toString() || "";

      try {
        clearNotice();
        const result = await api.login({ username, password });
        setToken(result.token);
        state.me = await api.getMe();
        navigate("/overview", true);
      } catch (error) {
        showNotice("error", error.message || "登录失败。");
        renderLogin();
        bindLoginEvents();
      }
    });
}

async function loadPage() {
  switch (state.currentRoute) {
    case "/overview":
      return renderOverviewPage();
    case "/rooms":
      return renderRoomsPage();
    case "/events":
      return renderEventsPage();
    case "/audit-logs":
      return renderAuditLogsPage();
    case "/config":
      return renderConfigPage();
    default:
      if (state.currentRoute.startsWith("/rooms/")) {
        return renderRoomDetailPage(state.currentRoute.slice("/rooms/".length));
      }
      navigate("/overview", true);
      return renderOverviewPage();
  }
}

async function renderOverviewPage() {
  const [health, ready, overview] = await Promise.all([
    api.getHealth(),
    api.getReady(),
    api.getOverview(),
  ]);
  state.lastOverviewData = overview.service;
  const readyWarning = ready.status !== "ready";
  const overviewHighlights = [
    [
      isGlobalAdminInstance(overview.service.instanceId) ? "全局后台" : "实例",
      overview.service.instanceId,
    ],
    ["存储", overview.storage.provider],
    ["Redis", overview.storage.redisConnected ? "已连接" : "未连接"],
    [
      "房间",
      `${overview.runtime.activeRoomCount} 活跃 / ${overview.rooms.totalNonExpired} 非过期`,
    ],
  ];

  return {
    autoRefresh: state.overviewAutoRefresh,
    instanceId: overview.service.instanceId,
    serviceName: overview.service.name,
    html: `
      ${readyWarning ? `<div class="warning-banner">readyz 当前状态为 ${escapeHtml(ready.status)}，请优先检查房间存储与 Redis 连通性。</div>` : ""}
      <div class="section">
        <div class="toolbar toolbar-elevated">
          <div class="actions">
            <div class="pill">自动刷新 ${state.overviewAutoRefresh ? "开启" : "关闭"}</div>
            <button class="button ghost" data-toggle-overview-refresh>${state.overviewAutoRefresh ? "关闭自动刷新" : "开启自动刷新"}</button>
          </div>
          <button class="button" data-refresh-overview>立即刷新</button>
        </div>
        <section class="panel overview-strip">
          ${overviewHighlights
            .map(
              ([label, value]) => `
            <div class="overview-strip-item">
              <span class="overview-strip-label">${escapeHtml(label)}</span>
              <strong>${escapeHtml(value)}</strong>
            </div>
          `,
            )
            .join("")}
        </section>
        <div class="grid cards-4">
          ${metricCard("服务", escapeHtml(overview.service.name), `版本 ${escapeHtml(overview.service.version)}`)}
          ${metricCard(isGlobalAdminInstance(overview.service.instanceId) ? "全局后台节点" : "实例", escapeHtml(overview.service.instanceId), `启动于 ${new Date(overview.service.startedAt).toLocaleString()}`)}
          ${metricCard("健康检查", escapeHtml(health.status), `readyz ${escapeHtml(ready.status)}`)}
          ${metricCard("运行时长", escapeHtml(formatDuration(overview.service.uptimeMs)), "持续运行时长")}
        </div>
        <div class="grid cards-4">
          ${metricCard("连接数", overview.runtime.connectionCount, "当前 WebSocket 连接")}
          ${metricCard("在线房间", overview.runtime.activeRoomCount, overview.rooms.orphanRuntimeCount > 0 ? `已忽略 ${overview.rooms.orphanRuntimeCount} 个失配运行时索引` : "活跃房间")}
          ${metricCard("在线成员", overview.runtime.activeMemberCount, "当前在线成员")}
          ${metricCard("非过期房间", overview.rooms.totalNonExpired, `空闲 ${overview.rooms.idle}`)}
        </div>
        <div class="detail-grid">
          <section class="panel">
            <div class="section-header">
              <h3>存储状态</h3>
            </div>
            <dl class="kv">
              <dt>存储提供方</dt><dd>${escapeHtml(overview.storage.provider)}</dd>
              <dt>Redis</dt><dd>${renderStatus(overview.storage.redisConnected ? "success" : "warning", overview.storage.redisConnected ? "已连接" : "未连接")}</dd>
              <dt>readyz.roomStore</dt><dd>${escapeHtml(ready.checks.roomStore)}</dd>
              <dt>readyz.redis</dt><dd>${escapeHtml(ready.checks.redis)}</dd>
            </dl>
          </section>
          <section class="panel">
            <div class="section-header">
              <h3>事件统计</h3>
            </div>
            <dl class="kv">
              <dt>最近一分钟</dt><dd>room_created ${overview.events.lastMinute.room_created} / room_joined ${overview.events.lastMinute.room_joined} / rate_limited ${overview.events.lastMinute.rate_limited}</dd>
              <dt>最近一分钟</dt><dd>ws_connection_rejected ${overview.events.lastMinute.ws_connection_rejected} / error ${overview.events.lastMinute.error}</dd>
              <dt>累计</dt><dd>room_created ${overview.events.totals.room_created} / room_joined ${overview.events.totals.room_joined}</dd>
              <dt>累计</dt><dd>ws_connection_rejected ${overview.events.totals.ws_connection_rejected} / rate_limited ${overview.events.totals.rate_limited}</dd>
            </dl>
          </section>
        </div>
      </div>
    `,
    bind() {
      document
        .querySelector("[data-refresh-overview]")
        ?.addEventListener("click", () =>
          render().catch(handleFatalRenderError),
        );
      document
        .querySelector("[data-toggle-overview-refresh]")
        ?.addEventListener("click", () => {
          state.overviewAutoRefresh = !state.overviewAutoRefresh;
          render().catch(handleFatalRenderError);
        });
    },
  };
}

function metricCard(label, value, meta) {
  return `
    <section class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}</div>
      <div class="metric-meta">${meta}</div>
    </section>
  `;
}

function renderStatus(kind, text) {
  return `<span class="status ${escapeHtml(kind)}">${escapeHtml(text)}</span>`;
}

async function renderRoomsPage() {
  const query = roomsQueryFromLocation();
  const data = await api.listRooms(query);
  const activeCount = data.items.filter((item) => item.isActive).length;
  const idleCount = data.items.length - activeCount;
  const noVideoCount = data.items.filter((item) => !item.sharedVideo).length;
  const expiringSoonCount = data.items.filter((item) => {
    if (!item.expiresAt) {
      return false;
    }
    const remainingMs = item.expiresAt - Date.now();
    return remainingMs > 0 && remainingMs <= 10 * 60_000;
  }).length;
  const hasFilters = Boolean(
    query.keyword ||
    query.status !== "all" ||
    query.includeExpired ||
    query.sortBy !== "lastActiveAt" ||
    query.sortOrder !== "desc",
  );

  return {
    instanceId: state.lastOverviewData?.instanceId,
    html: `
      <div class="section">
        <section class="panel panel-filter">
          <div class="panel-intro">
            <div class="panel-intro-kicker">房间筛选</div>
            <div class="panel-intro-text">按房间状态、排序方式和过期范围快速收敛目标房间，再进入详情页执行治理动作。</div>
          </div>
          <form id="rooms-filter" class="form-grid">
            ${textField("keyword", "房间号关键字", query.keyword)}
            ${selectField("status", "状态", query.status, [
              ["all", "all"],
              ["active", "active"],
              ["idle", "idle"],
            ])}
            ${selectField("sortBy", "排序字段", query.sortBy, [
              ["lastActiveAt", "lastActiveAt"],
              ["createdAt", "createdAt"],
            ])}
            ${selectField("sortOrder", "排序方向", query.sortOrder, [
              ["desc", "desc"],
              ["asc", "asc"],
            ])}
            ${textField("pageSize", "每页条数", String(query.pageSize), "number")}
            <div class="field inline align-end">
              <input id="includeExpired" name="includeExpired" type="checkbox" ${query.includeExpired ? "checked" : ""} />
              <label for="includeExpired">包含已过期房间</label>
            </div>
            <div class="filter-footer full-width">
              <div class="filter-summary">
                <span class="filter-summary-label">当前视图</span>
                <strong>${hasFilters ? "已应用筛选" : "默认排序"}</strong>
                <span>共 ${data.pagination.total} 个结果</span>
              </div>
              <div class="actions">
                <button class="button primary" type="submit">查询</button>
                <button class="button ghost" type="button" data-reset-rooms>重置</button>
              </div>
            </div>
          </form>
        </section>
        <section class="panel panel-summary">
          <div class="section-header">
            <h3>当前页速览</h3>
            <span class="muted">先看哪些房间值得优先处理</span>
          </div>
          <div class="mini-stat-grid">
            ${renderMiniStat("活跃房间", activeCount, "success")}
            ${renderMiniStat("空闲房间", idleCount, "neutral")}
            ${renderMiniStat("未共享视频", noVideoCount, noVideoCount > 0 ? "warning" : "neutral")}
            ${renderMiniStat("10 分钟内过期", expiringSoonCount, expiringSoonCount > 0 ? "warning" : "neutral")}
          </div>
        </section>
        <section class="table-card">
          <div class="toolbar table-toolbar">
            <div>
              <div class="table-title">房间列表</div>
              <div class="muted">把房间健康度、视频状态和下一步建议放在一行里，方便直接处理。</div>
            </div>
            <div class="table-toolbar-actions">
              <div class="pill subtle">每页 ${query.pageSize}</div>
              <button class="button" data-refresh-rooms>刷新</button>
            </div>
          </div>
          ${
            data.items.length === 0
              ? `<div class="empty-state">当前筛选条件下没有房间。</div>`
              : `
            <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>房间号</th>
                  <th>当前状态</th>
                  <th>成员</th>
                  <th>视频与同步</th>
                  <th>时间线</th>
                  <th>建议关注</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${data.items
                  .map((item) => {
                    const attention = getRoomAttention(item);
                    const videoSummary = getRoomVideoSummary(item);
                    return `
                  <tr>
                    <td>${renderDataPair(`<a href="${withDemoQuery(routeHref(`/rooms/${item.roomCode}`))}" data-room-link="${escapeHtml(item.roomCode)}" class="primary-cell-link"><strong>${escapeHtml(item.roomCode)}</strong></a>`, item.sharedVideo?.videoId ? `<span class="primary-code">${escapeHtml(item.sharedVideo.videoId)}</span>` : "")}</td>
                    <td>${renderDataPair(
                      renderStatus(
                        item.isActive ? "success" : "neutral",
                        item.isActive ? "有人在线" : "当前空闲",
                      ),
                      item.instanceId
                        ? `实例 ${escapeHtml(item.instanceId)}`
                        : "实例信息未知",
                    )}</td>
                    <td>${renderDataPair(`<strong>${item.memberCount}</strong>`, item.memberCount > 0 ? `${item.memberCount} 个在线成员` : "暂无在线成员")}</td>
                    <td>${renderDataPair(escapeHtml(videoSummary.primary), escapeHtml(videoSummary.secondary))}</td>
                    <td>${renderDataPair(
                      `${formatDateTime(item.lastActiveAt)}`,
                      `创建于 ${new Date(item.createdAt).toLocaleString()}${item.expiresAt ? ` · ${formatRelativeDuration(item.expiresAt - Date.now())}` : ""}`,
                    )}</td>
                    <td>${renderDataPair(renderStatus(attention.tone, attention.label), escapeHtml(attention.hint))}</td>
                    <td>${roomActionButtons(item.roomCode, item.isActive)}</td>
                  </tr>
                `;
                  })
                  .join("")}
              </tbody>
            </table>
            </div>
            ${renderPagination(query.page, query.pageSize, data.pagination.total, "rooms")}
          `
          }
        </section>
      </div>
    `,
    bind() {
      bindRoomsListEvents(query);
    },
  };
}

function roomsQueryFromLocation() {
  const params = new URLSearchParams(location.search);
  return {
    keyword: params.get("keyword") || "",
    status: params.get("status") || "all",
    includeExpired: params.get("includeExpired") === "true",
    sortBy: params.get("sortBy") || "lastActiveAt",
    sortOrder: params.get("sortOrder") || "desc",
    page: Number(params.get("page") || "1"),
    pageSize: Number(params.get("pageSize") || "20"),
  };
}

function roomActionButtons(roomCode, isActive = false) {
  const view = `<button class="button link" type="button" data-open-room="${escapeHtml(roomCode)}">查看详情</button>`;
  if (!canManage()) {
    return `<div class="table-actions">${view}</div>`;
  }

  const expireDisabled = isActive ? "disabled" : "";
  const expireHint = isActive
    ? `title="房间仍有在线成员，仅空闲房间可提前过期"`
    : "";

  return `
    <div class="table-actions">
      ${view}
      <button class="button link" type="button" data-room-action="close" data-room-code="${escapeHtml(roomCode)}">关闭房间</button>
      <button class="button link" type="button" data-room-action="expire" data-room-code="${escapeHtml(roomCode)}" ${expireDisabled} ${expireHint}>提前过期</button>
      <button class="button link" type="button" data-room-action="clear-video" data-room-code="${escapeHtml(roomCode)}">清空共享视频</button>
    </div>
  `;
}

function renderPagination(page, pageSize, total, scope) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return `
    <div class="pagination">
      <div>第 ${page} / ${totalPages} 页，共 ${total} 条</div>
      <div class="actions">
        <button class="button" type="button" data-page-scope="${scope}" data-page-target="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button>
        <button class="button" type="button" data-page-scope="${scope}" data-page-target="${page + 1}" ${page >= totalPages ? "disabled" : ""}>下一页</button>
      </div>
    </div>
  `;
}

function bindRoomsListEvents(query) {
  document
    .querySelector("#rooms-filter")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const nextQuery = {
        keyword: formData.get("keyword")?.toString().trim() || "",
        status: formData.get("status")?.toString() || "all",
        includeExpired: formData.get("includeExpired") === "on",
        sortBy: formData.get("sortBy")?.toString() || "lastActiveAt",
        sortOrder: formData.get("sortOrder")?.toString() || "desc",
        page: 1,
        pageSize: Number(formData.get("pageSize") || query.pageSize || 20),
      };
      history.replaceState(
        null,
        "",
        `${routeHref("/rooms")}${serializeQuery(nextQuery)}`,
      );
      render().catch(handleFatalRenderError);
    });

  document
    .querySelector("[data-reset-rooms]")
    ?.addEventListener("click", () => {
      history.replaceState(null, "", withDemoQuery(routeHref("/rooms")));
      render().catch(handleFatalRenderError);
    });

  document
    .querySelector("[data-refresh-rooms]")
    ?.addEventListener("click", () => render().catch(handleFatalRenderError));

  document
    .querySelectorAll("[data-open-room],[data-room-link]")
    .forEach((element) => {
      element.addEventListener("click", (event) => {
        event.preventDefault();
        navigate(
          `/rooms/${element.getAttribute("data-open-room") || element.getAttribute("data-room-link")}`,
        );
      });
    });

  bindPageButtons("/rooms");
  bindRoomActionButtons(() => render().catch(handleFatalRenderError));
}

function bindPageButtons(basePath) {
  document.querySelectorAll("[data-page-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const params = new URLSearchParams(location.search);
      params.set("page", button.getAttribute("data-page-target"));
      if (state.demo) {
        params.set(DEMO_QUERY_KEY, "1");
      }
      history.replaceState(null, "", `/admin${basePath}?${params.toString()}`);
      render().catch(handleFatalRenderError);
    });
  });
}

function bindRoomActionButtons(onDone) {
  document.querySelectorAll("[data-room-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const roomCode = button.getAttribute("data-room-code");
      const action = button.getAttribute("data-room-action");
      const config = {
        close: {
          title: `关闭房间 ${roomCode}`,
          description: "这会断开该房间全部在线成员，并删除房间数据。",
          confirmLabel: "确认关闭",
          successMessage: `房间 ${roomCode} 已关闭。`,
          onConfirm: (reason) => api.closeRoom(roomCode, reason),
          onSuccess: () => {
            if (state.currentRoute === `/rooms/${roomCode}`) {
              navigate("/rooms", true);
              return;
            }
            render().catch(handleFatalRenderError);
          },
        },
        expire: {
          title: `提前过期房间 ${roomCode}`,
          description:
            "仅空闲房间可提前过期并立即清理；仍有在线成员时请改用关闭房间。",
          confirmLabel: "确认过期",
          successMessage: `房间 ${roomCode} 已提前过期并清理。`,
          onConfirm: (reason) => api.expireRoom(roomCode, reason),
        },
        "clear-video": {
          title: `清空房间 ${roomCode} 的共享视频`,
          description:
            "这会清空当前共享视频和播放状态，并向在线成员广播新状态。",
          confirmLabel: "确认清空",
          successMessage: `房间 ${roomCode} 的共享视频已清空。`,
          onConfirm: (reason) => api.clearRoomVideo(roomCode, reason),
        },
      }[action];

      await confirmAction(config);
      if (typeof onDone === "function") {
        onDone();
      }
    });
  });
}

async function renderRoomDetailPage(roomCode) {
  try {
    const detail = await api.getRoomDetail(roomCode);
    return {
      meta: {
        title: `房间 ${detail.room.roomCode}`,
        description: "查看房间摘要、共享视频、在线成员与最近事件。",
      },
      instanceId: detail.instanceId,
      html: `
        <div class="section">
          <section class="panel room-summary-strip">
            <div class="room-summary-chip">
              <span class="room-summary-label">房间号</span>
              <strong>${escapeHtml(detail.room.roomCode)}</strong>
            </div>
            <div class="room-summary-chip">
              <span class="room-summary-label">状态</span>
              ${renderStatus(detail.room.isActive ? "success" : "neutral", detail.room.isActive ? "active" : "idle")}
            </div>
            <div class="room-summary-chip">
              <span class="room-summary-label">在线成员</span>
              <strong>${escapeHtml(detail.room.memberCount)}</strong>
            </div>
            <div class="room-summary-chip">
              <span class="room-summary-label">实例</span>
              <strong>${escapeHtml(detail.room.instanceId || "—")}</strong>
            </div>
          </section>
          <div class="toolbar">
            <div class="actions">
              <button class="button ghost" data-nav-back>返回房间列表</button>
              <button class="button" data-refresh-detail>刷新</button>
            </div>
            ${
              canManage()
                ? `
              <div class="actions">
                <button class="button danger" data-room-action="close" data-room-code="${escapeHtml(roomCode)}">关闭房间</button>
                <button class="button" data-room-action="expire" data-room-code="${escapeHtml(roomCode)}" ${detail.room.isActive ? 'disabled title="房间仍有在线成员，仅空闲房间可提前过期"' : ""}>提前过期</button>
                <button class="button" data-room-action="clear-video" data-room-code="${escapeHtml(roomCode)}">清空共享视频</button>
              </div>
            `
                : ""
            }
          </div>
          <div class="detail-grid">
            <section class="panel">
              <div class="section-header"><h3>房间摘要</h3></div>
              <dl class="kv">
                <dt>房间号</dt><dd><strong>${escapeHtml(detail.room.roomCode)}</strong></dd>
                <dt>实例</dt><dd>${escapeHtml(detail.room.instanceId || "—")}</dd>
                <dt>在线状态</dt><dd>${renderStatus(detail.room.isActive ? "success" : "neutral", detail.room.isActive ? "active" : "idle")}</dd>
                <dt>成员数</dt><dd>${detail.room.memberCount}</dd>
                <dt>创建时间</dt><dd>${formatDateTime(detail.room.createdAt)}</dd>
                <dt>最近活跃</dt><dd>${formatDateTime(detail.room.lastActiveAt)}</dd>
                <dt>过期时间</dt><dd>${formatDateTime(detail.room.expiresAt)}</dd>
              </dl>
            </section>
            <section class="panel">
              <div class="section-header"><h3>共享视频与播放状态</h3></div>
              <div class="media-summary">
                <div class="media-summary-title">${escapeHtml(detail.room.sharedVideo?.title || "未共享视频")}</div>
                <div class="media-summary-meta">
                  ${detail.room.sharedVideo?.videoId ? `<span class="pill subtle">ID ${escapeHtml(detail.room.sharedVideo.videoId)}</span>` : renderEmptyValue("无视频 ID")}
                  ${detail.room.playback ? renderResultBadge(getPlaybackState(detail.room.playback)) : renderEmptyValue("未同步")}
                </div>
              </div>
              <dl class="kv">
                <dt>标题</dt><dd>${escapeHtml(detail.room.sharedVideo?.title || "未共享")}</dd>
                <dt>视频 ID</dt><dd>${detail.room.sharedVideo?.videoId ? `<span class="code">${escapeHtml(detail.room.sharedVideo.videoId)}</span>` : renderEmptyValue()}</dd>
                <dt>URL</dt><dd>${detail.room.sharedVideo?.url ? `<a href="${escapeHtml(detail.room.sharedVideo.url)}" target="_blank" rel="noreferrer">${escapeHtml(detail.room.sharedVideo.url)}</a>` : renderEmptyValue()}</dd>
                <dt>播放状态</dt><dd>${detail.room.playback ? renderResultBadge(getPlaybackState(detail.room.playback)) : renderEmptyValue("未同步")}</dd>
                <dt>当前时间</dt><dd>${detail.room.playback ? `${Number(detail.room.playback.currentTime || 0).toFixed(1)}s` : renderEmptyValue()}</dd>
                <dt>播放速度</dt><dd>${detail.room.playback ? `x${Number(detail.room.playback.playbackRate || 1).toFixed(2)}` : renderEmptyValue()}</dd>
              </dl>
            </section>
          </div>
          <section class="table-card">
            <div class="toolbar table-toolbar">
              <div>
                <div class="table-title">在线成员</div>
                <div class="muted">支持复制会话和成员标识。</div>
              </div>
              <div class="pill subtle">在线 ${detail.members.length}</div>
            </div>
            ${
              detail.members.length === 0
                ? `<div class="empty-state">当前没有在线成员。</div>`
                : `
              <div class="table-scroll">
              <table class="detail-table members-table">
                <thead>
                  <tr>
                    <th>显示名</th>
                    <th>memberId</th>
                    <th>sessionId</th>
                    <th>加入时间</th>
                    <th>远端地址</th>
                    <th>Origin</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${detail.members
                    .map(
                      (member) => `
                    <tr>
                      <td>${renderDataPair(`<strong>${escapeHtml(member.displayName)}</strong>`, member.memberId ? `memberId ${escapeHtml(member.memberId)}` : "")}</td>
                      <td><div class="copy-stack"><span class="code">${escapeHtml(member.memberId)}</span><button class="button link" type="button" data-copy="${escapeHtml(member.memberId)}">复制</button></div></td>
                      <td><div class="copy-stack"><span class="code">${escapeHtml(member.sessionId)}</span><button class="button link" type="button" data-copy="${escapeHtml(member.sessionId)}">复制</button></div></td>
                      <td>${renderTimeBlock(member.joinedAt, "加入")}</td>
                      <td>${member.remoteAddress ? `<div class="copy-stack"><span class="code">${escapeHtml(member.remoteAddress)}</span><button class="button link" type="button" data-copy="${escapeHtml(member.remoteAddress)}">复制</button></div>` : renderEmptyValue()}</td>
                      <td>${renderOriginValue(member.origin)}</td>
                      <td>${memberActionButtons(roomCode, member)}</td>
                    </tr>
                  `,
                    )
                    .join("")}
                </tbody>
              </table>
              </div>
            `
            }
          </section>
          <section class="table-card">
            <div class="toolbar table-toolbar">
              <div>
                <div class="table-title">最近事件</div>
                <div class="muted">默认展示最近 20 条，服务重启后事件存储会丢失。</div>
              </div>
              <button class="button ghost" data-jump-events="${escapeHtml(roomCode)}">带筛选跳转到事件页</button>
            </div>
            ${
              detail.recentEvents.length === 0
                ? `<div class="empty-state">暂无近期事件。</div>`
                : `
              <div class="table-scroll">
              <table class="detail-table room-events-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>事件名</th>
                    <th>会话</th>
                    <th>结果</th>
                    <th>详情</th>
                  </tr>
                </thead>
                <tbody>
                  ${detail.recentEvents
                    .map(
                      (event) => `
                    <tr>
                      <td>${renderTimeBlock(event.timestamp, "事件")}</td>
                      <td>${renderEventNameCell(event)}</td>
                      <td>${event.sessionId ? `<span class="code">${escapeHtml(event.sessionId)}</span>` : renderEmptyValue()}</td>
                      <td>${event.result ? renderResultBadge(event.result) : renderEmptyValue()}</td>
                      <td><button class="button link" type="button" data-view-json='${escapeHtml(JSON.stringify(event.details))}'>查看 JSON</button></td>
                    </tr>
                  `,
                    )
                    .join("")}
                </tbody>
              </table>
              </div>
            `
            }
          </section>
        </div>
      `,
      bind() {
        document
          .querySelector("[data-nav-back]")
          ?.addEventListener("click", () => navigate("/rooms"));
        document
          .querySelector("[data-refresh-detail]")
          ?.addEventListener("click", () =>
            render().catch(handleFatalRenderError),
          );
        document
          .querySelector("[data-jump-events]")
          ?.addEventListener("click", (event) => {
            const targetRoomCode =
              event.currentTarget.getAttribute("data-jump-events");
            navigateToUrl(
              withDemoQuery(
                `/admin/events?${new URLSearchParams({ roomCode: targetRoomCode }).toString()}`,
              ),
              "/events",
              true,
            );
          });
        bindRoomActionButtons(() => render().catch(handleFatalRenderError));
        bindMemberActionButtons(roomCode);
        bindJsonButtons();
      },
    };
  } catch (error) {
    if (error.code === "room_not_found") {
      return {
        html: `
          <div class="empty-state">
            <h3>房间不存在</h3>
            <p class="muted">房间 ${escapeHtml(roomCode)} 可能已被删除或已过期。</p>
            <div class="actions centered">
              <button class="button" data-nav-back>返回房间列表</button>
            </div>
          </div>
        `,
        bind() {
          document
            .querySelector("[data-nav-back]")
            ?.addEventListener("click", () => navigate("/rooms"));
        },
      };
    }
    throw error;
  }
}

function memberActionButtons(roomCode, member) {
  if (!canManage()) {
    return "—";
  }

  return `
    <div class="table-actions">
      <button class="button link" type="button" data-member-action="kick" data-room-code="${escapeHtml(roomCode)}" data-member-id="${escapeHtml(member.memberId)}">踢出成员</button>
      <button class="button link" type="button" data-member-action="disconnect" data-room-code="${escapeHtml(roomCode)}" data-session-id="${escapeHtml(member.sessionId)}">断开会话</button>
    </div>
  `;
}

function bindMemberActionButtons(roomCode) {
  document.querySelectorAll("[data-member-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.getAttribute("data-member-action");
      if (action === "kick") {
        const memberId = button.getAttribute("data-member-id");
        await confirmAction({
          title: `踢出成员 ${memberId}`,
          description: "这会断开该成员当前连接。",
          confirmLabel: "确认踢出",
          successMessage: `成员 ${memberId} 已被踢出。`,
          onConfirm: (reason) => api.kickMember(roomCode, memberId, reason),
        });
      } else {
        const sessionId = button.getAttribute("data-session-id");
        await confirmAction({
          title: `断开会话 ${sessionId}`,
          description: "这会强制断开指定会话。",
          confirmLabel: "确认断开",
          successMessage: `会话 ${sessionId} 已断开。`,
          onConfirm: (reason) => api.disconnectSession(sessionId, reason),
        });
      }
      render().catch(handleFatalRenderError);
    });
  });
}

async function renderEventsPage() {
  const query = listQueryFromLocation({ pageSize: "20" });
  const data = await api.listEvents(query);
  const summary = summarizeVisibleEvents(data.items);

  return {
    html: renderLogPage({
      title: "运行事件列表",
      muted:
        "默认隐藏系统噪音事件，更适合直接排查用户问题；需要时可勾选显示系统事件。",
      filterKicker: "事件筛选",
      filterIntro:
        "按事件名、房间号、会话、来源和时间范围筛选近期运行事件。优先看后台治理、连接与安全、播放协同三类。",
      summaryCards: `
        ${renderMiniStat("房间生命周期", summary.room, summary.room > 0 ? "success" : "neutral")}
        ${renderMiniStat("连接与安全", summary.security, summary.security > 0 ? "warning" : "neutral")}
        ${renderMiniStat("播放协同", summary.playback, summary.playback > 0 ? "success" : "neutral")}
        ${renderMiniStat("后台治理", summary.governance, summary.governance > 0 ? "warning" : "neutral")}
      `,
      tableClass: "events-table",
      filters: `
        ${textField("event", "事件名", query.event)}
        ${textField("roomCode", "房间号", query.roomCode)}
        ${textField("sessionId", "会话 ID", query.sessionId)}
        ${textField("remoteAddress", "远端地址", query.remoteAddress)}
        ${textField("origin", "来源 Origin", query.origin)}
        ${textField("result", "结果", query.result)}
        ${textField("from", "开始时间戳(ms)", query.from, "number")}
        ${textField("to", "结束时间戳(ms)", query.to, "number")}
        ${textField("pageSize", "每页条数", query.pageSize, "number")}
        <div class="field inline align-end">
          <input id="includeSystem" name="includeSystem" type="checkbox" ${query.includeSystem ? "checked" : ""} />
          <label for="includeSystem">显示系统事件</label>
        </div>
      `,
      rows: data.items
        .map(
          (item) => `
        <tr>
          <td>${renderTimeBlock(item.timestamp, "事件")}</td>
          <td>${renderEventNameCell(item)}</td>
          <td>${item.roomCode ? `<span class="primary-code">${escapeHtml(item.roomCode)}</span>` : renderEmptyValue()}</td>
          <td>${renderCompactCode(item.sessionId)}</td>
          <td>${renderCompactCode(item.remoteAddress)}</td>
          <td>${renderOriginValue(item.origin)}</td>
          <td>${item.result ? renderResultBadge(item.result) : renderEmptyValue()}</td>
          <td><button class="button link" type="button" data-view-json='${escapeHtml(JSON.stringify(item.details))}'>查看 JSON</button></td>
        </tr>
      `,
        )
        .join(""),
      headers:
        "<th>时间</th><th>事件名</th><th>房间号</th><th>会话 ID</th><th>远端地址</th><th>来源 Origin</th><th>结果</th><th>详情</th>",
      data,
      query,
      basePath: "/events",
      formId: "events-filter",
    }),
    bind() {
      bindListFilter("/events", "events-filter");
      bindPageButtons("/events");
      bindJsonButtons();
    },
  };
}

async function renderAuditLogsPage() {
  const query = listQueryFromLocation({ pageSize: "20" });
  const data = await api.listAuditLogs(query);
  const summary = summarizeAuditLogs(data.items);

  return {
    html: renderLogPage({
      title: "审计日志",
      muted: "适合回答“谁做的、对谁做的、执行到哪一步、是否真的生效了”。",
      filterKicker: "审计筛选",
      filterIntro:
        "按操作人、动作、目标和结果定位后台治理动作的留痕记录。优先看失败、拒绝和跨节点执行记录。",
      summaryCards: `
        ${renderMiniStat("成功执行", summary.success, summary.success > 0 ? "success" : "neutral")}
        ${renderMiniStat("被拒绝", summary.rejected, summary.rejected > 0 ? "warning" : "neutral")}
        ${renderMiniStat("执行出错", summary.error, summary.error > 0 ? "danger" : "neutral")}
        ${renderMiniStat("成员治理", summary.memberGovernance, summary.memberGovernance > 0 ? "warning" : "neutral")}
      `,
      tableClass: "audit-table",
      filters: `
        ${textField("actor", "操作人", query.actor)}
        ${textField("action", "动作", query.action)}
        ${textField("targetType", "目标类型", query.targetType)}
        ${textField("targetId", "目标 ID", query.targetId)}
        ${textField("result", "结果", query.result)}
        ${textField("from", "开始时间戳(ms)", query.from, "number")}
        ${textField("to", "结束时间戳(ms)", query.to, "number")}
        ${textField("pageSize", "每页条数", query.pageSize, "number")}
      `,
      rows: data.items
        .map(
          (item) => `
        <tr>
          <td>${renderTimeBlock(item.timestamp, "审计")}</td>
          <td>${renderDataPair(`<strong>${escapeHtml(item.actor.username)}</strong>`, `账号 ${escapeHtml(item.actor.adminId)}`)}</td>
          <td>${renderResultBadge(item.actor.role)}</td>
          <td>${renderAuditActionCell(item)}</td>
          <td>${renderAuditTargetCell(item)}</td>
          <td>${renderResultBadge(item.result)}</td>
          <td>${renderDataPair(item.reason ? escapeHtml(item.reason) : renderEmptyValue("未填写"), escapeHtml(renderAuditRequestSummary(item)))}</td>
          <td>${item.instanceId ? renderDataPair(`<span class="primary-code">${escapeHtml(item.instanceId)}</span>`, item.executorInstanceId && item.executorInstanceId !== item.instanceId ? `执行节点 ${escapeHtml(item.executorInstanceId)}` : "由当前控制节点记录") : renderEmptyValue()}</td>
          <td><button class="button link" type="button" data-view-json='${escapeHtml(JSON.stringify(item.request))}'>查看请求</button></td>
        </tr>
      `,
        )
        .join(""),
      headers:
        "<th>时间</th><th>操作人</th><th>角色</th><th>治理动作</th><th>目标</th><th>结果</th><th>执行说明</th><th>记录节点</th><th>请求</th>",
      data,
      query,
      basePath: "/audit-logs",
      formId: "audit-filter",
    }),
    bind() {
      bindListFilter("/audit-logs", "audit-filter");
      bindPageButtons("/audit-logs");
      bindJsonButtons();
    },
  };
}

function renderLogPage(options) {
  return `
    <div class="section">
      <section class="panel panel-filter">
        <div class="panel-intro">
          <div class="panel-intro-kicker">${escapeHtml(options.filterKicker || "筛选条件")}</div>
          <div class="panel-intro-text">${escapeHtml(options.filterIntro || "按筛选条件快速定位目标数据。")}</div>
        </div>
        <form id="${escapeHtml(options.formId)}" class="form-grid">
          ${options.filters}
          <div class="filter-footer full-width">
            <div class="filter-summary">
              <span class="filter-summary-label">筛选结果</span>
              <strong>共 ${escapeHtml(options.data.total)} 条</strong>
              <span>默认按时间倒序展示</span>
            </div>
            <div class="actions">
              <button class="button primary" type="submit">查询</button>
              <button class="button ghost" type="button" data-reset-list="${escapeHtml(options.basePath)}">重置</button>
            </div>
          </div>
        </form>
      </section>
      ${
        options.summaryCards
          ? `
        <section class="panel panel-summary">
          <div class="section-header">
            <h3>当前页速览</h3>
            <span class="muted">${escapeHtml(options.muted || "便于快速判断眼前这一页主要在发生什么。")}</span>
          </div>
          <div class="mini-stat-grid">
            ${options.summaryCards}
          </div>
        </section>
      `
          : ""
      }
      <section class="table-card">
        <div class="toolbar table-toolbar">
          <div>
            <div class="table-title">${escapeHtml(options.title)}</div>
            <div class="muted">${escapeHtml(options.muted)}</div>
          </div>
          <div class="table-toolbar-actions">
            <div class="pill subtle">总数 ${escapeHtml(options.data.total)}</div>
            <div class="pill">每页 ${escapeHtml(options.query.pageSize || 20)}</div>
          </div>
        </div>
        ${
          options.data.items.length === 0
            ? `<div class="empty-state">没有匹配结果。</div>`
            : `
          <div class="table-scroll">
          <table class="logs-table ${escapeHtml(options.tableClass || "")}">
            <thead><tr>${options.headers}</tr></thead>
            <tbody>${options.rows}</tbody>
          </table>
          </div>
          ${renderPagination(Number(options.query.page || 1), Number(options.query.pageSize || 20), options.data.total, "logs")}
        `
        }
      </section>
    </div>
  `;
}

function listQueryFromLocation(defaults = {}) {
  const params = new URLSearchParams(location.search);
  return {
    event: params.get("event") || "",
    roomCode: params.get("roomCode") || "",
    sessionId: params.get("sessionId") || "",
    remoteAddress: params.get("remoteAddress") || "",
    origin: params.get("origin") || "",
    result: params.get("result") || "",
    actor: params.get("actor") || "",
    action: params.get("action") || "",
    targetType: params.get("targetType") || "",
    targetId: params.get("targetId") || "",
    from: params.get("from") || "",
    to: params.get("to") || "",
    includeSystem: params.get("includeSystem") === "true",
    page: Number(params.get("page") || "1"),
    pageSize: params.get("pageSize") || defaults.pageSize || "20",
  };
}

function bindListFilter(basePath, formId) {
  document.querySelector(`#${formId}`)?.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const query = Object.fromEntries(formData.entries());
    query.page = "1";
    history.replaceState(
      null,
      "",
      `${routeHref(basePath)}${serializeQuery(query)}`,
    );
    render().catch(handleFatalRenderError);
  });

  document.querySelector("[data-reset-list]")?.addEventListener("click", () => {
    history.replaceState(null, "", withDemoQuery(routeHref(basePath)));
    render().catch(handleFatalRenderError);
  });
}

function bindJsonButtons() {
  document.querySelectorAll("[data-view-json]").forEach((button) => {
    button.addEventListener("click", async () => {
      const payload = JSON.parse(button.getAttribute("data-view-json"));
      await openReasonDialog({
        title: "原始 JSON",
        description: "以下内容仅供查看，可复制进行排查。",
        mode: "json-preview",
        payload,
      });
    });
  });
}

async function renderConfigPage() {
  const config = await api.getConfig();
  const consoleContext = resolveConsoleContext(config.instanceId);
  const isGlobalAdminConfig = isGlobalAdminInstance(config.instanceId);
  return {
    instanceId: config.instanceId,
    html: `
      <div class="section">
        ${
          isGlobalAdminConfig
            ? `<div class="warning-banner">当前页面展示的是全局后台进程自身加载到的配置摘要；如果房间节点独立部署，请以对应业务节点的运行配置为准。</div>`
            : ""
        }
        <div class="detail-grid">
          <section class="panel config-panel">
            <div class="section-header"><h3>实例与持久化</h3></div>
            <dl class="kv config-kv">
              <dt>${escapeHtml(consoleContext.label)} ID</dt><dd>${escapeHtml(config.instanceId)}</dd>
              <dt>存储提供方</dt><dd>${escapeHtml(config.persistence.provider)}</dd>
              <dt>空房间保留时长</dt><dd>${escapeHtml(config.persistence.emptyRoomTtlMs)} ms</dd>
              <dt>房间清理间隔</dt><dd>${escapeHtml(config.persistence.roomCleanupIntervalMs)} ms</dd>
              <dt>已配置 Redis</dt><dd>${renderStatus(config.persistence.redisConfigured ? "success" : "neutral", config.persistence.redisConfigured ? "是" : "否")}</dd>
            </dl>
          </section>
          <section class="panel config-panel">
            <div class="section-header"><h3>管理后台配置</h3></div>
            <dl class="kv config-kv">
              <dt>已启用后台</dt><dd>${renderStatus(config.admin.configured ? "success" : "warning", config.admin.configured ? "是" : "否")}</dd>
              <dt>用户名</dt><dd>${config.admin.username ? escapeHtml(config.admin.username) : renderEmptyValue()}</dd>
              <dt>角色</dt><dd>${config.admin.role ? escapeHtml(config.admin.role) : renderEmptyValue()}</dd>
              <dt>会话有效期</dt><dd>${config.admin.sessionTtlMs ? `${escapeHtml(config.admin.sessionTtlMs)} ms` : renderEmptyValue()}</dd>
            </dl>
          </section>
        </div>
        <section class="panel config-panel">
          <div class="section-header"><h3>安全配置</h3></div>
          <dl class="kv config-kv">
            <dt>允许的 Origin</dt>
            <dd>
              ${
                (config.security.allowedOrigins ?? []).length
                  ? `<div class="config-origin-list">${(
                      config.security.allowedOrigins ?? []
                    )
                      .map(
                        (item) =>
                          `<span class="config-origin code">${escapeHtml(item)}</span>`,
                      )
                      .join("")}</div>`
                  : renderEmptyValue("未设置")
              }
            </dd>
            <dt>开发环境允许缺省 Origin</dt><dd>${renderStatus(config.security.allowMissingOriginInDev ? "warning" : "neutral", config.security.allowMissingOriginInDev ? "是" : "否")}</dd>
            <dt>受信代理地址</dt><dd>${
              (config.security.trustedProxyAddresses ?? []).length > 0
                ? `<div class="config-origin-list">${(
                    config.security.trustedProxyAddresses ?? []
                  )
                    .map(
                      (item) =>
                        `<span class="config-origin code">${escapeHtml(item)}</span>`,
                    )
                    .join("")}</div>`
                : renderEmptyValue("未设置")
            }</dd>
            <dt>单 IP 最大连接数</dt><dd>${config.security.maxConnectionsPerIp}</dd>
            <dt>每分钟连接尝试上限</dt><dd>${config.security.connectionAttemptsPerMinute}</dd>
            <dt>单房间最大成员数</dt><dd>${config.security.maxMembersPerRoom}</dd>
            <dt>最大消息字节数</dt><dd>${config.security.maxMessageBytes}</dd>
            <dt>非法消息断开阈值</dt><dd>${config.security.invalidMessageCloseThreshold}</dd>
          </dl>
          <div class="config-rate-limits">
            <div class="config-rate-limits-title">限流配置</div>
            <pre class="pre">${formatJson(config.security.rateLimits)}</pre>
          </div>
        </section>
      </div>
    `,
  };
}

function textField(name, label, value, type = "text") {
  return `
    <div class="field">
      <label for="${escapeHtml(name)}">${escapeHtml(label)}</label>
      <input id="${escapeHtml(name)}" name="${escapeHtml(name)}" type="${escapeHtml(type)}" value="${escapeHtml(value || "")}" />
    </div>
  `;
}

function selectField(name, label, value, options) {
  return `
    <div class="field">
      <label for="${escapeHtml(name)}">${escapeHtml(label)}</label>
      <select id="${escapeHtml(name)}" name="${escapeHtml(name)}">
        ${options.map(([optionValue, optionLabel]) => `<option value="${escapeHtml(optionValue)}" ${value === optionValue ? "selected" : ""}>${escapeHtml(optionLabel)}</option>`).join("")}
      </select>
    </div>
  `;
}

function demoAdminSession() {
  return { id: "admin-demo", username: "demo-admin", role: "admin" };
}

function createDemoData() {
  const now = Date.now();
  const rooms = [
    {
      roomCode: "ROOM8A",
      instanceId: "instance-1",
      isActive: true,
      memberCount: 4,
      sharedVideo: {
        title: "【番剧】第 12 话同步播放",
        videoId: "BV1demo8A",
        url: "https://www.bilibili.com/video/BV1demo8A",
      },
      playback: { paused: false, currentTime: 428.4, playbackRate: 1 },
      createdAt: now - 1000 * 60 * 86,
      lastActiveAt: now - 1000 * 18,
      expiresAt: now + 1000 * 60 * 42,
    },
    {
      roomCode: "ROOM2B",
      instanceId: "instance-1",
      isActive: true,
      memberCount: 2,
      sharedVideo: {
        title: "音乐现场回放",
        videoId: "BV1demo2B",
        url: "https://www.bilibili.com/video/BV1demo2B",
      },
      playback: { paused: true, currentTime: 95.2, playbackRate: 1.25 },
      createdAt: now - 1000 * 60 * 210,
      lastActiveAt: now - 1000 * 60 * 3,
      expiresAt: now + 1000 * 60 * 18,
    },
    {
      roomCode: "ARCH9C",
      instanceId: "instance-2",
      isActive: false,
      memberCount: 0,
      sharedVideo: null,
      playback: null,
      createdAt: now - 1000 * 60 * 60 * 8,
      lastActiveAt: now - 1000 * 60 * 52,
      expiresAt: now - 1000 * 60 * 10,
    },
  ];

  const roomMembers = {
    ROOM8A: [
      {
        displayName: "Alice",
        memberId: "member-alice",
        sessionId: "sess-alice-01",
        joinedAt: now - 1000 * 60 * 28,
        remoteAddress: "203.0.113.10",
        origin: "chrome-extension://demo-extension",
      },
      {
        displayName: "Bob",
        memberId: "member-bob",
        sessionId: "sess-bob-02",
        joinedAt: now - 1000 * 60 * 18,
        remoteAddress: "198.51.100.42",
        origin: "https://www.bilibili.com",
      },
      {
        displayName: "Carol",
        memberId: "member-carol",
        sessionId: "sess-carol-03",
        joinedAt: now - 1000 * 60 * 11,
        remoteAddress: "198.51.100.77",
        origin: "http://localhost:5173",
      },
      {
        displayName: "Dave",
        memberId: "member-dave",
        sessionId: "sess-dave-04",
        joinedAt: now - 1000 * 60 * 4,
        remoteAddress: null,
        origin: "",
      },
    ],
    ROOM2B: [
      {
        displayName: "Echo",
        memberId: "member-echo",
        sessionId: "sess-echo-01",
        joinedAt: now - 1000 * 60 * 14,
        remoteAddress: "192.0.2.15",
        origin: "https://www.bilibili.com",
      },
      {
        displayName: "Foxtrot",
        memberId: "member-foxtrot",
        sessionId: "sess-foxtrot-02",
        joinedAt: now - 1000 * 60 * 6,
        remoteAddress: "192.0.2.18",
        origin: "chrome-extension://demo-extension",
      },
    ],
    ARCH9C: [],
  };

  const events = [
    {
      timestamp: now - 1000 * 15,
      event: "playback_synced",
      roomCode: "ROOM8A",
      sessionId: "sess-alice-01",
      remoteAddress: "203.0.113.10",
      origin: "chrome-extension://demo-extension",
      result: "ok",
      details: { currentTime: 428.4, playbackRate: 1 },
    },
    {
      timestamp: now - 1000 * 42,
      event: "room_joined",
      roomCode: "ROOM8A",
      sessionId: "sess-dave-04",
      remoteAddress: null,
      origin: "",
      result: "ok",
      details: { memberId: "member-dave" },
    },
    {
      timestamp: now - 1000 * 60 * 3,
      event: "room_joined",
      roomCode: "ROOM2B",
      sessionId: "sess-foxtrot-02",
      remoteAddress: "192.0.2.18",
      origin: "chrome-extension://demo-extension",
      result: "ok",
      details: { memberId: "member-foxtrot" },
    },
    {
      timestamp: now - 1000 * 60 * 7,
      event: "room_idle",
      roomCode: "ARCH9C",
      sessionId: "",
      remoteAddress: null,
      origin: "",
      result: "idle",
      details: { memberCount: 0 },
    },
    {
      timestamp: now - 1000 * 60 * 12,
      event: "admin_room_video_cleared",
      roomCode: "ROOM2B",
      sessionId: "",
      remoteAddress: null,
      origin: "",
      result: "success",
      details: { actor: "demo-admin" },
    },
  ];

  const auditLogs = [
    {
      timestamp: now - 1000 * 60 * 5,
      actor: { username: "demo-admin", role: "admin" },
      action: "clear_video",
      targetType: "room",
      targetId: "ROOM2B",
      result: "success",
      reason: "同步下一首视频前清空当前状态",
      instanceId: "instance-1",
      request: { reason: "同步下一首视频前清空当前状态" },
    },
    {
      timestamp: now - 1000 * 60 * 16,
      actor: { username: "demo-admin", role: "admin" },
      action: "kick_member",
      targetType: "member",
      targetId: "member-carol",
      result: "success",
      reason: "播放源异常，要求重连",
      instanceId: "instance-1",
      request: { roomCode: "ROOM8A", memberId: "member-carol" },
    },
    {
      timestamp: now - 1000 * 60 * 34,
      actor: { username: "demo-admin", role: "admin" },
      action: "disconnect_session",
      targetType: "session",
      targetId: "sess-echo-01",
      result: "success",
      reason: "演示用断开",
      instanceId: "instance-1",
      request: { sessionId: "sess-echo-01" },
    },
  ];

  return { now, rooms, roomMembers, events, auditLogs };
}

const demoData = createDemoData();

function paginate(items, page, pageSize) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Number(pageSize) || 20);
  const start = (safePage - 1) * safePageSize;
  return {
    items: items.slice(start, start + safePageSize),
    total: items.length,
    pagination: { total: items.length, page: safePage, pageSize: safePageSize },
  };
}

function includesText(value, search) {
  return String(value || "")
    .toLowerCase()
    .includes(String(search || "").toLowerCase());
}

async function mockApiRequest(path, _options = {}) {
  const url = new URL(path, location.origin);
  const pathname = url.pathname;
  const params = url.searchParams;

  if (pathname === "/api/admin/auth/login") {
    return {
      token: DEMO_TOKEN,
      expiresAt: demoData.now + 12 * 60 * 60 * 1000,
      admin: demoAdminSession(),
    };
  }
  if (pathname === "/api/admin/auth/logout") {
    return { ok: true };
  }
  if (pathname === "/api/admin/me") {
    return demoAdminSession();
  }
  if (pathname === "/healthz") {
    return { status: "healthy" };
  }
  if (pathname === "/readyz") {
    return { status: "ready", checks: { roomStore: "ok", redis: "ok" } };
  }
  if (pathname === "/api/admin/overview") {
    return {
      service: {
        name: "bili-syncplay-server",
        version: "0.7.0-demo",
        instanceId: "instance-1",
        startedAt: demoData.now - 1000 * 60 * 60 * 4,
        uptimeMs: 1000 * 60 * 60 * 4 + 1000 * 60 * 22,
      },
      storage: { provider: "redis", redisConnected: true },
      runtime: { connectionCount: 6, activeRoomCount: 2, activeMemberCount: 6 },
      rooms: { totalNonExpired: 2, idle: 1 },
      events: {
        lastMinute: {
          room_created: 1,
          room_joined: 2,
          rate_limited: 0,
          ws_connection_rejected: 0,
          error: 0,
        },
        totals: {
          room_created: 18,
          room_joined: 143,
          ws_connection_rejected: 4,
          rate_limited: 9,
        },
      },
    };
  }
  if (pathname === "/api/admin/rooms") {
    let items = demoData.rooms.slice();
    const keyword = params.get("keyword") || "";
    const status = params.get("status") || "all";
    const includeExpired = params.get("includeExpired") === "true";
    const sortBy = params.get("sortBy") || "lastActiveAt";
    const sortOrder = params.get("sortOrder") || "desc";
    const page = params.get("page") || "1";
    const pageSize = params.get("pageSize") || "20";

    if (keyword) {
      items = items.filter(
        (item) =>
          includesText(item.roomCode, keyword) ||
          includesText(item.sharedVideo?.title, keyword),
      );
    }
    if (status === "active") {
      items = items.filter((item) => item.isActive);
    } else if (status === "idle") {
      items = items.filter((item) => !item.isActive);
    }
    if (!includeExpired) {
      items = items.filter((item) => item.expiresAt > demoData.now);
    }
    items.sort((a, b) => {
      const delta = Number(a[sortBy] || 0) - Number(b[sortBy] || 0);
      return sortOrder === "asc" ? delta : -delta;
    });
    const paged = paginate(items, page, pageSize);
    return { items: paged.items, pagination: paged.pagination };
  }
  if (
    pathname.startsWith("/api/admin/rooms/") &&
    !pathname.endsWith("/close") &&
    !pathname.endsWith("/expire") &&
    !pathname.endsWith("/clear-video")
  ) {
    const roomCode = decodeURIComponent(pathname.split("/")[4] || "");
    const room = demoData.rooms.find((item) => item.roomCode === roomCode);
    if (!room) {
      throw { code: "room_not_found", message: "房间不存在。" };
    }
    return {
      instanceId: room.instanceId,
      room,
      members: demoData.roomMembers[roomCode] || [],
      recentEvents: demoData.events
        .filter((event) => event.roomCode === roomCode)
        .slice(0, 20),
    };
  }
  if (pathname === "/api/admin/events") {
    let items = demoData.events.slice();
    const filters = [
      "event",
      "roomCode",
      "sessionId",
      "remoteAddress",
      "origin",
      "result",
    ];
    for (const key of filters) {
      const value = params.get(key);
      if (value) {
        items = items.filter((item) => includesText(item[key], value));
      }
    }
    items.sort((a, b) => b.timestamp - a.timestamp);
    const paged = paginate(
      items,
      params.get("page") || "1",
      params.get("pageSize") || "20",
    );
    return { items: paged.items, total: paged.total };
  }
  if (pathname === "/api/admin/audit-logs") {
    let items = demoData.auditLogs.slice();
    const actor = params.get("actor");
    const action = params.get("action");
    const targetType = params.get("targetType");
    const targetId = params.get("targetId");
    const result = params.get("result");
    if (actor)
      items = items.filter((item) => includesText(item.actor.username, actor));
    if (action)
      items = items.filter((item) => includesText(item.action, action));
    if (targetType)
      items = items.filter((item) => includesText(item.targetType, targetType));
    if (targetId)
      items = items.filter((item) => includesText(item.targetId, targetId));
    if (result)
      items = items.filter((item) => includesText(item.result, result));
    items.sort((a, b) => b.timestamp - a.timestamp);
    const paged = paginate(
      items,
      params.get("page") || "1",
      params.get("pageSize") || "20",
    );
    return { items: paged.items, total: paged.total };
  }
  if (pathname === "/api/admin/config") {
    return {
      instanceId: "instance-1",
      persistence: {
        provider: "redis",
        emptyRoomTtlMs: 1800000,
        roomCleanupIntervalMs: 60000,
        redisConfigured: true,
      },
      admin: {
        configured: true,
        username: "demo-admin",
        role: "admin",
        sessionTtlMs: 43200000,
      },
      security: {
        allowedOrigins: [
          "https://www.bilibili.com",
          "chrome-extension://demo-extension",
        ],
        allowMissingOriginInDev: false,
        trustedProxyAddresses: ["127.0.0.1", "10.0.0.10"],
        maxConnectionsPerIp: 24,
        connectionAttemptsPerMinute: 120,
        maxMembersPerRoom: 16,
        maxMessageBytes: 8192,
        invalidMessageCloseThreshold: 3,
        rateLimits: {
          perIp: { windowMs: 60000, max: 120 },
          perRoom: { windowMs: 10000, max: 30 },
        },
      },
    };
  }
  if (
    pathname.includes("/close") ||
    pathname.includes("/expire") ||
    pathname.includes("/clear-video") ||
    pathname.includes("/kick") ||
    pathname.includes("/disconnect")
  ) {
    return { ok: true };
  }

  throw { code: "request_failed", message: `未实现的 demo 接口：${pathname}` };
}

window.addEventListener("popstate", () => {
  state.currentRoute = normalizePath(location.pathname);
  render().catch(handleFatalRenderError);
});

bootstrap().catch((error) => {
  console.error(error);
  showNotice("error", "管理控制面板初始化失败。");
  render().catch(handleFatalRenderError);
});
