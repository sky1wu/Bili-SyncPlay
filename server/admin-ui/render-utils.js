import { escapeHtml } from "./templates.js";

export function formatDateTime(value) {
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

export function renderTimeBlock(value, hint = "") {
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

export function formatDuration(ms) {
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

export function getPlaybackState(playback) {
  if (!playback) {
    return "paused";
  }

  if (typeof playback.playState === "string" && playback.playState) {
    return playback.playState;
  }

  return playback.paused ? "paused" : "playing";
}

export function formatJson(value) {
  return escapeHtml(JSON.stringify(value, null, 2));
}

export function renderEmptyValue(value = "—") {
  return `<span class="empty-value">${escapeHtml(value)}</span>`;
}

export function renderResultBadge(value) {
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

export function classifyOrigin(value) {
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

export function renderCompactCode(value, copyLabel = "复制") {
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

export function renderDataPair(primary, secondary) {
  return `
    <div class="data-pair">
      <div class="data-pair-primary">${primary}</div>
      ${secondary ? `<div class="data-pair-secondary">${secondary}</div>` : ""}
    </div>
  `;
}

export function formatRelativeDuration(ms) {
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

export function getRoomVideoSummary(item) {
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

export function getEventPresentation(eventName) {
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

export function renderEventNameCell(item) {
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

export function getAuditActionPresentation(action) {
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

export function getAuditTargetTypeLabel(targetType) {
  const labelMap = {
    room: "房间",
    session: "会话",
    member: "成员",
    config: "配置",
    block: "封禁",
  };

  return labelMap[targetType] || targetType || "未知目标";
}

export function renderAuditActionCell(item) {
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

export function renderAuditTargetCell(item) {
  const targetLabel = getAuditTargetTypeLabel(item.targetType);
  return renderDataPair(
    item.targetId
      ? `<span class="primary-code">${escapeHtml(item.targetId)}</span>`
      : renderEmptyValue(),
    `${targetLabel}${item.targetInstanceId ? ` · 目标实例 ${item.targetInstanceId}` : ""}${item.executorInstanceId ? ` · 执行实例 ${item.executorInstanceId}` : ""}`,
  );
}

export function isGlobalAdminInstance(instanceId) {
  return typeof instanceId === "string" && instanceId.includes("global-admin");
}

export function resolveConsoleContext(instanceId, serviceName = "") {
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

export function renderOriginValue(value) {
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

export function serializeQueryParams(query, options = {}) {
  const { isDemo = false, demoQueryKey = "demo" } = options;
  const params = new URLSearchParams();
  if (isDemo) {
    params.set(demoQueryKey, "1");
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

export function metricCard(label, value, meta) {
  return `
    <section class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}</div>
      <div class="metric-meta">${meta}</div>
    </section>
  `;
}

export function renderStatus(kind, text) {
  return `<span class="status ${escapeHtml(kind)}">${escapeHtml(text)}</span>`;
}

export function getRoomOwnerSummary(item) {
  const primary = item.ownerDisplayName || item.ownerMemberId || "—";
  const secondary =
    item.ownerDisplayName && item.ownerMemberId
      ? `memberId ${item.ownerMemberId}`
      : "";
  return { primary, secondary };
}

export function textField(name, label, value, type = "text") {
  return `
    <div class="field">
      <label for="${escapeHtml(name)}">${escapeHtml(label)}</label>
      <input id="${escapeHtml(name)}" name="${escapeHtml(name)}" type="${escapeHtml(type)}" value="${escapeHtml(value || "")}" />
    </div>
  `;
}

export function selectField(name, label, value, options) {
  return `
    <div class="field">
      <label for="${escapeHtml(name)}">${escapeHtml(label)}</label>
      <select id="${escapeHtml(name)}" name="${escapeHtml(name)}">
        ${options
          .map(
            ([optionValue, optionLabel]) =>
              `<option value="${escapeHtml(optionValue)}" ${value === optionValue ? "selected" : ""}>${escapeHtml(optionLabel)}</option>`,
          )
          .join("")}
      </select>
    </div>
  `;
}

export function paginate(items, page, pageSize) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Number(pageSize) || 20);
  const start = (safePage - 1) * safePageSize;
  return {
    items: items.slice(start, start + safePageSize),
    total: items.length,
    pagination: { total: items.length, page: safePage, pageSize: safePageSize },
  };
}

export function includesText(value, search) {
  return String(value || "")
    .toLowerCase()
    .includes(String(search || "").toLowerCase());
}
