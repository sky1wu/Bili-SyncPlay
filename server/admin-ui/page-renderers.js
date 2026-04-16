import { escapeHtml } from "./templates.js";
import {
  formatDateTime,
  formatDuration,
  formatJson,
  formatRelativeDuration,
  getPlaybackState,
  getRoomOwnerSummary,
  getRoomVideoSummary,
  isGlobalAdminInstance,
  metricCard,
  renderAuditActionCell,
  renderAuditTargetCell,
  renderCompactCode,
  renderDataPair,
  renderEmptyValue,
  renderEventNameCell,
  renderOriginValue,
  renderResultBadge,
  renderStatus,
  renderTimeBlock,
  resolveConsoleContext,
  selectField,
  textField,
} from "./render-utils.js";

export function roomsQueryFromLocation(search) {
  const params = new URLSearchParams(search);
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

export function listQueryFromLocation(search, defaults = {}) {
  const params = new URLSearchParams(search);
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

export function roomActionButtons(
  roomCode,
  isActive = false,
  canManage = false,
) {
  const view = `<button class="button link" type="button" data-open-room="${escapeHtml(roomCode)}">查看详情</button>`;
  if (!canManage) {
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

export function memberActionButtons(roomCode, member, canManage = false) {
  if (!canManage) {
    return "—";
  }

  return `
    <div class="table-actions">
      <button class="button link" type="button" data-member-action="kick" data-room-code="${escapeHtml(roomCode)}" data-member-id="${escapeHtml(member.memberId)}">踢出成员</button>
      <button class="button link" type="button" data-member-action="disconnect" data-room-code="${escapeHtml(roomCode)}" data-session-id="${escapeHtml(member.sessionId)}">断开会话</button>
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

function renderLogPage(options) {
  return `
    <div class="section">
      <section class="panel panel-filter">
        <form id="${escapeHtml(options.formId)}" class="form-grid">
          ${options.filters}
          <div class="filter-footer full-width">
            <strong>共 ${escapeHtml(options.data.total)} 条</strong>
            <div class="actions">
              <button class="button primary" type="submit">查询</button>
              <button class="button ghost" type="button" data-reset-list="${escapeHtml(options.basePath)}">重置</button>
            </div>
          </div>
        </form>
      </section>
      <section class="table-card">
        <div class="toolbar table-toolbar">
          <div class="table-title">${escapeHtml(options.title)}</div>
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

export function createRoomActionConfig(
  action,
  { roomCode, api, navigate, rerender, currentRoute },
) {
  return {
    close: {
      title: `关闭房间 ${roomCode}`,
      description: "这会断开该房间全部在线成员，并删除房间数据。",
      confirmLabel: "确认关闭",
      successMessage: `房间 ${roomCode} 已关闭。`,
      onConfirm: (reason) => api.closeRoom(roomCode, reason),
      onSuccess: () => {
        if (currentRoute() === `/rooms/${roomCode}`) {
          navigate("/rooms", true);
          return;
        }
        rerender();
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
      description: "这会清空当前共享视频和播放状态，并向在线成员广播新状态。",
      confirmLabel: "确认清空",
      successMessage: `房间 ${roomCode} 的共享视频已清空。`,
      onConfirm: (reason) => api.clearRoomVideo(roomCode, reason),
    },
  }[action];
}

function bindPageButtons({
  document,
  location,
  history,
  state,
  rerender,
  basePath,
}) {
  document.querySelectorAll("[data-page-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const params = new URLSearchParams(location.search);
      params.set("page", button.getAttribute("data-page-target"));
      if (state.demo) {
        params.set("demo", "1");
      }
      history.replaceState(null, "", `/admin${basePath}?${params.toString()}`);
      rerender();
    });
  });
}

export function bindRoomActionButtons({
  document,
  api,
  confirmAction,
  navigate,
  rerender,
  currentRoute,
  onDone,
}) {
  document.querySelectorAll("[data-room-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const roomCode = button.getAttribute("data-room-code");
      const action = button.getAttribute("data-room-action");
      const config = createRoomActionConfig(action, {
        roomCode,
        api,
        navigate,
        rerender,
        currentRoute,
      });

      await confirmAction(config);
      if (typeof onDone === "function") {
        onDone();
      }
    });
  });
}

function bindRoomsListEvents(options, query) {
  const {
    document,
    history,
    routeHref,
    withDemoQuery,
    serializeQuery,
    rerender,
    navigate,
    api,
    confirmAction,
    currentRoute,
  } = options;

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
      rerender();
    });

  document
    .querySelector("[data-reset-rooms]")
    ?.addEventListener("click", () => {
      history.replaceState(null, "", withDemoQuery(routeHref("/rooms")));
      rerender();
    });

  document
    .querySelector("[data-refresh-rooms]")
    ?.addEventListener("click", () => rerender());

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

  bindPageButtons({ ...options, basePath: "/rooms" });
  bindRoomActionButtons({
    document,
    api,
    confirmAction,
    navigate,
    rerender,
    currentRoute,
    onDone: rerender,
  });
}

function bindListFilter(options, basePath, formId) {
  const {
    document,
    history,
    routeHref,
    withDemoQuery,
    serializeQuery,
    rerender,
  } = options;

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
    rerender();
  });

  document.querySelector("[data-reset-list]")?.addEventListener("click", () => {
    history.replaceState(null, "", withDemoQuery(routeHref(basePath)));
    rerender();
  });
}

function bindJsonButtons({ document, openReasonDialog }) {
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

function bindMemberActionButtons({
  document,
  roomCode,
  api,
  confirmAction,
  rerender,
}) {
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
      rerender();
    });
  });
}

export function createPageLoaders(options) {
  const {
    document,
    location,
    history,
    state,
    api,
    routeHref,
    withDemoQuery,
    serializeQuery,
    navigate,
    navigateToUrl,
    rerender,
    canManage,
    confirmAction,
    openReasonDialog,
  } = options;

  return {
    async renderOverviewPage() {
      const [ready, overview] = await Promise.all([
        api.getReady(),
        api.getOverview(),
      ]);
      state.lastOverviewData = overview.service;
      const readyWarning = ready.status !== "ready";

      return {
        autoRefresh: state.overviewAutoRefresh,
        instanceId: overview.service.instanceId,
        serviceName: overview.service.name,
        html: `
          ${readyWarning ? `<div class="warning-banner">readyz 状态为 ${escapeHtml(ready.status)}，请检查存储与 Redis 连通性。</div>` : ""}
          <div class="section">
            <div class="toolbar toolbar-elevated">
              <div class="actions">
                <div class="pill">${state.overviewAutoRefresh ? "自动刷新中" : "自动刷新已关"}</div>
                <button class="button ghost" data-toggle-overview-refresh>${state.overviewAutoRefresh ? "关闭" : "开启"}</button>
              </div>
              <button class="button" data-refresh-overview>刷新</button>
            </div>
            <div class="grid cards-4">
              ${metricCard("连接数", overview.runtime.connectionCount, "WebSocket")}
              ${metricCard("在线房间", overview.runtime.activeRoomCount, `总计 ${overview.rooms.totalNonExpired} 非过期`)}
              ${metricCard("在线成员", overview.runtime.activeMemberCount, `空闲房间 ${overview.rooms.idle}`)}
              ${metricCard("运行时长", escapeHtml(formatDuration(overview.service.uptimeMs)), `${escapeHtml(overview.service.name)} v${escapeHtml(overview.service.version)}`)}
            </div>
            <div class="detail-grid">
              <section class="panel">
                <div class="section-header"><h3>存储</h3></div>
                <dl class="kv">
                  <dt>提供方</dt><dd>${escapeHtml(overview.storage.provider)}</dd>
                  <dt>Redis</dt><dd>${renderStatus(overview.storage.redisConnected ? "success" : "warning", overview.storage.redisConnected ? "已连接" : "未连接")}</dd>
                  <dt>roomStore</dt><dd>${escapeHtml(ready.checks.roomStore)}</dd>
                </dl>
              </section>
              <section class="panel">
                <div class="section-header"><h3>事件统计</h3></div>
                <dl class="kv">
                  <dt>最近一分钟</dt><dd>创建 ${overview.events.lastMinute.room_created} · 加入 ${overview.events.lastMinute.room_joined} · 限流 ${overview.events.lastMinute.rate_limited} · 拒绝 ${overview.events.lastMinute.ws_connection_rejected}</dd>
                  <dt>累计</dt><dd>创建 ${overview.events.totals.room_created} · 加入 ${overview.events.totals.room_joined} · 限流 ${overview.events.totals.rate_limited} · 拒绝 ${overview.events.totals.ws_connection_rejected}</dd>
                </dl>
              </section>
            </div>
          </div>
        `,
        bind() {
          document
            .querySelector("[data-refresh-overview]")
            ?.addEventListener("click", () => rerender());
          document
            .querySelector("[data-toggle-overview-refresh]")
            ?.addEventListener("click", () => {
              state.overviewAutoRefresh = !state.overviewAutoRefresh;
              rerender();
            });
        },
      };
    },

    async renderRoomsPage() {
      const query = roomsQueryFromLocation(location.search);
      const data = await api.listRooms(query);
      return {
        instanceId: state.lastOverviewData?.instanceId,
        html: `
          <div class="section">
            <section class="panel panel-filter">
              <form id="rooms-filter" class="form-grid">
                ${textField("keyword", "关键字", query.keyword)}
                ${selectField("status", "状态", query.status, [
                  ["all", "全部"],
                  ["active", "活跃"],
                  ["idle", "空闲"],
                ])}
                ${selectField("sortBy", "排序", query.sortBy, [
                  ["lastActiveAt", "最近活跃"],
                  ["createdAt", "创建时间"],
                ])}
                ${selectField("sortOrder", "方向", query.sortOrder, [
                  ["desc", "降序"],
                  ["asc", "升序"],
                ])}
                <div class="field inline align-end">
                  <input id="includeExpired" name="includeExpired" type="checkbox" ${query.includeExpired ? "checked" : ""} />
                  <label for="includeExpired">含已过期</label>
                </div>
                <div class="filter-footer full-width">
                  <div class="filter-summary">
                    <strong>共 ${data.pagination.total} 个房间</strong>
                  </div>
                  <div class="actions">
                    <button class="button primary" type="submit">查询</button>
                    <button class="button ghost" type="button" data-reset-rooms>重置</button>
                  </div>
                </div>
              </form>
            </section>
            <section class="table-card">
              <div class="toolbar table-toolbar">
                <div class="table-title">房间列表</div>
                <div class="table-toolbar-actions">
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
                      <th>状态</th>
                      <th>创建者</th>
                      <th>成员</th>
                      <th>视频</th>
                      <th>时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${data.items
                      .map((item) => {
                        const videoSummary = getRoomVideoSummary(item);
                        const ownerSummary = getRoomOwnerSummary(item);
                        return `
                      <tr>
                        <td><a href="${withDemoQuery(routeHref(`/rooms/${item.roomCode}`))}" data-room-link="${escapeHtml(item.roomCode)}" class="primary-cell-link"><strong>${escapeHtml(item.roomCode)}</strong></a></td>
                        <td>${renderStatus(item.isActive ? "success" : "neutral", item.isActive ? "活跃" : "空闲")}</td>
                        <td>${renderDataPair(escapeHtml(ownerSummary.primary), escapeHtml(ownerSummary.secondary))}</td>
                        <td><strong>${item.memberCount}</strong></td>
                        <td>${renderDataPair(escapeHtml(videoSummary.primary), escapeHtml(videoSummary.secondary))}</td>
                        <td>${renderDataPair(
                          `${formatDateTime(item.lastActiveAt)}`,
                          item.expiresAt
                            ? formatRelativeDuration(
                                item.expiresAt - Date.now(),
                              )
                            : "",
                        )}</td>
                        <td>${roomActionButtons(item.roomCode, item.isActive, canManage())}</td>
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
          bindRoomsListEvents(
            {
              document,
              location,
              history,
              state,
              routeHref,
              withDemoQuery,
              serializeQuery,
              rerender,
              navigate,
              api,
              confirmAction,
              currentRoute: () => state.currentRoute,
            },
            query,
          );
        },
      };
    },

    async renderRoomDetailPage(roomCode) {
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
                  <div class="table-title">在线成员 (${detail.members.length})</div>
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
                          <td>${memberActionButtons(roomCode, member, canManage())}</td>
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
                  <div class="table-title">最近事件</div>
                  <button class="button ghost" data-jump-events="${escapeHtml(roomCode)}">查看全部事件</button>
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
              ?.addEventListener("click", () => rerender());
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
            bindRoomActionButtons({
              document,
              api,
              confirmAction,
              navigate,
              rerender,
              currentRoute: () => state.currentRoute,
            });
            bindMemberActionButtons({
              document,
              roomCode,
              api,
              confirmAction,
              rerender,
            });
            bindJsonButtons({ document, openReasonDialog });
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
    },

    async renderEventsPage() {
      const query = listQueryFromLocation(location.search, { pageSize: "20" });
      const data = await api.listEvents(query);
      return {
        html: renderLogPage({
          title: "运行事件",
          tableClass: "events-table",
          filters: `
            ${textField("event", "事件名", query.event)}
            ${textField("roomCode", "房间号", query.roomCode)}
            ${textField("sessionId", "会话 ID", query.sessionId)}
            ${textField("remoteAddress", "远端地址", query.remoteAddress)}
            ${textField("origin", "来源", query.origin)}
            ${textField("result", "结果", query.result)}
            <div class="field inline align-end">
              <input id="includeSystem" name="includeSystem" type="checkbox" ${query.includeSystem ? "checked" : ""} />
              <label for="includeSystem">含系统事件</label>
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
              <td>${renderOriginValue(item.origin)}</td>
              <td>${item.result ? renderResultBadge(item.result) : renderEmptyValue()}</td>
              <td><button class="button link" type="button" data-view-json='${escapeHtml(JSON.stringify(item.details))}'>JSON</button></td>
            </tr>
          `,
            )
            .join(""),
          headers:
            "<th>时间</th><th>事件</th><th>房间号</th><th>会话</th><th>来源</th><th>结果</th><th>详情</th>",
          data,
          query,
          basePath: "/events",
          formId: "events-filter",
        }),
        bind() {
          bindListFilter(options, "/events", "events-filter");
          bindPageButtons({ ...options, basePath: "/events" });
          bindJsonButtons({ document, openReasonDialog });
        },
      };
    },

    async renderAuditLogsPage() {
      const query = listQueryFromLocation(location.search, { pageSize: "20" });
      const data = await api.listAuditLogs(query);
      return {
        html: renderLogPage({
          title: "审计日志",
          tableClass: "audit-table",
          filters: `
            ${textField("actor", "操作人", query.actor)}
            ${textField("action", "动作", query.action)}
            ${textField("targetType", "目标类型", query.targetType)}
            ${textField("targetId", "目标 ID", query.targetId)}
            ${textField("result", "结果", query.result)}
          `,
          rows: data.items
            .map(
              (item) => `
            <tr>
              <td>${renderTimeBlock(item.timestamp, "审计")}</td>
              <td>${renderDataPair(`<strong>${escapeHtml(item.actor.username)}</strong>`, escapeHtml(item.actor.role))}</td>
              <td>${renderAuditActionCell(item)}</td>
              <td>${renderAuditTargetCell(item)}</td>
              <td>${renderResultBadge(item.result)}</td>
              <td>${item.reason ? escapeHtml(item.reason) : renderEmptyValue("未填写")}</td>
              <td><button class="button link" type="button" data-view-json='${escapeHtml(JSON.stringify(item.request))}'>JSON</button></td>
            </tr>
          `,
            )
            .join(""),
          headers:
            "<th>时间</th><th>操作人</th><th>动作</th><th>目标</th><th>结果</th><th>原因</th><th>请求</th>",
          data,
          query,
          basePath: "/audit-logs",
          formId: "audit-filter",
        }),
        bind() {
          bindListFilter(options, "/audit-logs", "audit-filter");
          bindPageButtons({ ...options, basePath: "/audit-logs" });
          bindJsonButtons({ document, openReasonDialog });
        },
      };
    },

    async renderConfigPage() {
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
    },
  };
}
