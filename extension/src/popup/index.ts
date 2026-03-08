import type { BackgroundToPopupMessage } from "../shared/messages";

const app = document.getElementById("app");

interface PopupRefs {
  serverStatus: HTMLElement;
  roomStatus: HTMLElement;
  membersStatus: HTMLElement;
  message: HTMLElement;
  roomPanelJoined: HTMLElement;
  roomPanelIdle: HTMLElement;
  roomCodeInput: HTMLInputElement;
  copyRoomButton: HTMLButtonElement;
  shareCurrentVideoButton: HTMLButtonElement;
  sharedVideoCard: HTMLButtonElement;
  sharedVideoTitle: HTMLElement;
  sharedVideoMeta: HTMLElement;
  logs: HTMLElement;
  memberList: HTMLElement;
  copyLogsButton: HTMLButtonElement;
  serverUrlInput: HTMLInputElement;
  saveServerUrlButton: HTMLButtonElement;
  debugMemberStatus: HTMLElement;
  retryStatus: HTMLElement;
  clockStatus: HTMLElement;
  createRoomButton: HTMLButtonElement;
  joinRoomButton: HTMLButtonElement;
  leaveRoomButton: HTMLButtonElement;
}

let refs: PopupRefs | null = null;
let renderTimer: number | null = null;
let copyRoomResetTimer: number | null = null;
let copyLogsResetTimer: number | null = null;

void init();

async function init(): Promise<void> {
  if (!app) {
    return;
  }

  app.innerHTML = `
    <div class="card">
      <div class="hero">
        <div class="hero-copy">
          <h1 class="title">哔哩同步放映</h1>
        </div>
        <div class="hero-badge">LIVE</div>
      </div>

      <div class="grid">
        <div class="metric">
          <span class="metric-label">连接状态</span>
          <span class="metric-value" id="server-status">-</span>
        </div>
        <div class="metric">
          <span class="metric-label">房间人数</span>
          <span class="metric-value" id="members-status">-</span>
        </div>
      </div>

      <div class="room-panel">
        <div class="metric room-code-metric" id="room-panel-joined">
          <div class="room-code-header">
            <div>
              <span class="metric-label">当前房间码</span>
              <span class="metric-value room-code-value" id="room-status">-</span>
            </div>
            <div class="room-code-actions">
              <button class="secondary compact-button copy-button" id="copy-room" type="button">
                <span class="button-icon-wrap" aria-hidden="true">
                  <svg class="button-icon button-icon-copy" viewBox="0 0 16 16">
                    <rect x="5" y="3" width="8" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"></rect>
                    <path d="M3.5 10.5V5.5C3.5 4.4 4.4 3.5 5.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
                  </svg>
                  <svg class="button-icon button-icon-check" viewBox="0 0 16 16">
                    <path d="M3.2 8.3L6.6 11.4L12.8 4.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                  </svg>
                </span>
                <span class="button-label">复制</span>
              </button>
              <button class="secondary compact-button danger-button" id="leave-room" type="button">退出</button>
            </div>
          </div>
        </div>

        <div class="metric room-entry-metric" id="room-panel-idle">
          <div class="room-entry-header">
            <button class="compact-button" id="create-room" type="button">创建</button>
            <input id="room-code" placeholder="输入房间码">
            <button class="secondary compact-button" id="join-room" type="button">加入</button>
          </div>
        </div>
      </div>

      <div class="status-banner" id="status-message" hidden></div>

      <div class="section-title shared-video-heading">当前共享视频</div>

      <button class="video-card video-card-button" id="shared-video-card" type="button">
        <div class="video-title" id="shared-video-title">暂无共享视频</div>
        <div class="video-meta" id="shared-video-meta">点击可打开共享视频</div>
      </button>

      <button class="secondary compact-button full-width-button" id="share-current-video" type="button">同步当前页视频</button>

      <div class="row">
        <div style="flex: 1;">
          <div class="section-title">房间成员</div>
          <div class="member-list" id="member-list"></div>
        </div>
      </div>
    </div>

    <div class="card">
      <details class="details">
        <summary>高级信息</summary>
        <div class="details-body">
          <div class="details-grid">
            <div class="metric" style="grid-column: span 2;">
              <span class="metric-label">服务端地址</span>
              <div class="settings-row">
                <input id="server-url" placeholder="ws://localhost:8787">
                <button class="secondary compact-button" id="save-server-url" type="button">保存</button>
              </div>
            </div>
            <div class="metric">
              <span class="metric-label">当前身份</span>
              <span class="metric-value" id="member-status">-</span>
            </div>
            <div class="metric">
              <span class="metric-label">重连倒计时</span>
              <span class="metric-value" id="retry-status">-</span>
            </div>
            <div class="metric" style="grid-column: span 2;">
              <span class="metric-label">时钟校准</span>
              <span class="metric-value" id="clock-status">-</span>
            </div>
          </div>
          <div class="logs-header">
            <div class="section-title">调试日志</div>
            <button class="secondary compact-button copy-button" id="copy-logs" type="button">
              <span class="button-icon-wrap" aria-hidden="true">
                <svg class="button-icon button-icon-copy" viewBox="0 0 16 16">
                  <rect x="5" y="3" width="8" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"></rect>
                  <path d="M3.5 10.5V5.5C3.5 4.4 4.4 3.5 5.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
                </svg>
                <svg class="button-icon button-icon-check" viewBox="0 0 16 16">
                  <path d="M3.2 8.3L6.6 11.4L12.8 4.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                </svg>
              </span>
              <span class="button-label">复制</span>
            </button>
          </div>
          <div class="log-box" id="debug-logs">
            <div class="muted">暂无日志</div>
          </div>
        </div>
      </details>
    </div>
  `;

  refs = collectRefs();
  bindActions(refs);
  await render();
  scheduleRefresh();
}

function collectRefs(): PopupRefs {
  return {
    serverStatus: getById("server-status"),
    roomStatus: getById("room-status"),
    membersStatus: getById("members-status"),
    message: getById("status-message"),
    roomPanelJoined: getById("room-panel-joined"),
    roomPanelIdle: getById("room-panel-idle"),
    roomCodeInput: getById("room-code") as HTMLInputElement,
    copyRoomButton: getById("copy-room") as HTMLButtonElement,
    shareCurrentVideoButton: getById("share-current-video") as HTMLButtonElement,
    sharedVideoCard: getById("shared-video-card") as HTMLButtonElement,
    sharedVideoTitle: getById("shared-video-title"),
    sharedVideoMeta: getById("shared-video-meta"),
    logs: getById("debug-logs"),
    memberList: getById("member-list"),
    copyLogsButton: getById("copy-logs") as HTMLButtonElement,
    serverUrlInput: getById("server-url") as HTMLInputElement,
    saveServerUrlButton: getById("save-server-url") as HTMLButtonElement,
    debugMemberStatus: getById("member-status"),
    retryStatus: getById("retry-status"),
    clockStatus: getById("clock-status"),
    createRoomButton: getById("create-room") as HTMLButtonElement,
    joinRoomButton: getById("join-room") as HTMLButtonElement,
    leaveRoomButton: getById("leave-room") as HTMLButtonElement
  };
}

function getById(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing popup element: ${id}`);
  }
  return node;
}

async function queryState(): Promise<BackgroundToPopupMessage["payload"]> {
  const response = (await chrome.runtime.sendMessage({ type: "popup:get-state" })) as BackgroundToPopupMessage;
  return response.payload;
}

async function render(): Promise<void> {
  if (!refs) {
    return;
  }

  const state = await queryState();
  const roomCodeFocused = document.activeElement === refs.roomCodeInput;
  const serverUrlFocused = document.activeElement === refs.serverUrlInput;

  refs.serverStatus.textContent = state.connected ? "已连接" : "未连接";
  refs.roomStatus.textContent = state.roomCode ?? "-";
  refs.membersStatus.textContent = `${state.roomState?.members.length ?? 0} 人在线`;
  refs.debugMemberStatus.textContent = state.memberId ?? "-";
  refs.retryStatus.textContent = state.retryInMs ? `${Math.ceil(state.retryInMs / 1000)} 秒` : "-";
  refs.clockStatus.textContent = `偏移 ${state.clockOffsetMs ?? "-"}ms / RTT ${state.rttMs ?? "-"}ms`;
  refs.message.textContent = state.error ?? "";
  refs.message.hidden = !state.error;

  if (!roomCodeFocused) {
    refs.roomCodeInput.value = state.roomCode ?? "";
  }
  if (!serverUrlFocused) {
    refs.serverUrlInput.value = state.serverUrl;
  }

  refs.copyRoomButton.disabled = !state.roomCode;
  refs.roomPanelJoined.hidden = !state.roomCode;
  refs.roomPanelIdle.hidden = Boolean(state.roomCode);

  refs.sharedVideoTitle.textContent = state.roomState?.sharedVideo?.title ?? "暂无共享视频";
  refs.sharedVideoMeta.textContent = formatVideoMeta(state.roomState?.sharedVideo?.url ?? null);
  refs.sharedVideoCard.disabled = !state.roomState?.sharedVideo?.url;

  renderMemberList(refs.memberList, state.roomState?.members ?? []);
  renderLogs(refs.logs, state.logs);
}

function formatVideoMeta(url: string | null): string {
  if (!url) {
    return "点击可打开共享视频";
  }
  const match = url.match(/\/video\/([^/?]+)/);
  return match ? match[1] : "打开共享视频";
}

function renderLogs(container: HTMLElement, logs: BackgroundToPopupMessage["payload"]["logs"]): void {
  if (logs.length === 0) {
    container.innerHTML = `<div class="muted">暂无日志</div>`;
    return;
  }

  container.innerHTML = logs
    .map((entry) => {
      const time = new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false });
      return `<div class="log-line">[${time}] [${entry.scope}] ${escapeHtml(entry.message)}</div>`;
    })
    .join("");
}

function renderMemberList(container: HTMLElement, members: string[]): void {
  if (members.length === 0) {
    container.innerHTML = `<span class="member-chip">暂无成员</span>`;
    return;
  }
  container.innerHTML = members.map((member) => `<span class="member-chip">${escapeHtml(member)}</span>`).join("");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

async function handleShareCurrentVideo(): Promise<void> {
  if (!refs) {
    return;
  }

  const state = await queryState();
  const activeVideo = await chrome.runtime.sendMessage({ type: "popup:get-active-video" });
  if (!activeVideo?.ok || !activeVideo.payload?.video) {
    await render();
    return;
  }

  const currentVideo = activeVideo.payload.video as { title: string; url: string };
  if (!state.roomCode) {
    const shouldCreateRoom = window.confirm("当前未加入房间。是否创建房间并同步当前页视频？");
    if (!shouldCreateRoom) {
      return;
    }
  } else if (
    state.roomState?.sharedVideo?.url &&
    normalizeUrl(state.roomState.sharedVideo.url) !== normalizeUrl(currentVideo.url)
  ) {
    const shouldReplace = window.confirm(
      `当前房间正在同步《${state.roomState.sharedVideo.title}》。\n是否替换为《${currentVideo.title}》？`
    );
    if (!shouldReplace) {
      return;
    }
  }

  await chrome.runtime.sendMessage({ type: "popup:share-current-video" });
  await render();
}

function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    const bvid = parsed.searchParams.get("bvid");
    const cid = parsed.searchParams.get("cid");
    if (bvid) {
      return cid ? `https://www.bilibili.com/video/${bvid}?cid=${cid}` : `https://www.bilibili.com/video/${bvid}`;
    }

    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.split("?")[0].replace(/\/+$/, "");
  }
}

function bindActions(nodes: PopupRefs): void {
  nodes.createRoomButton.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "popup:create-room" });
    await render();
  });

  nodes.joinRoomButton.addEventListener("click", async () => {
    const roomCode = nodes.roomCodeInput.value.trim();
    if (!roomCode) {
      return;
    }
    await chrome.runtime.sendMessage({ type: "popup:join-room", roomCode });
    await render();
  });

  nodes.leaveRoomButton.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "popup:leave-room" });
    await render();
  });

  nodes.copyRoomButton.addEventListener("click", async () => {
    const roomCode = nodes.roomStatus.textContent?.trim();
    if (!roomCode || roomCode === "-") {
      return;
    }

    await navigator.clipboard.writeText(roomCode);
    nodes.copyRoomButton.classList.add("success-button");
    if (copyRoomResetTimer !== null) {
      window.clearTimeout(copyRoomResetTimer);
    }
    copyRoomResetTimer = window.setTimeout(() => {
      copyRoomResetTimer = null;
      nodes.copyRoomButton.classList.remove("success-button");
    }, 1400);
  });

  nodes.copyLogsButton.addEventListener("click", async () => {
    const state = await queryState();
    const text = state.logs
      .slice()
      .reverse()
      .map((entry) => {
        const time = new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false });
        return `[${time}] [${entry.scope}] ${entry.message}`;
      })
      .join("\n");

    await navigator.clipboard.writeText(text || "暂无日志");
    nodes.copyLogsButton.classList.add("success-button");
    if (copyLogsResetTimer !== null) {
      window.clearTimeout(copyLogsResetTimer);
    }
    copyLogsResetTimer = window.setTimeout(() => {
      copyLogsResetTimer = null;
      nodes.copyLogsButton.classList.remove("success-button");
    }, 1400);
  });

  nodes.shareCurrentVideoButton.addEventListener("click", () => {
    void handleShareCurrentVideo();
  });

  nodes.sharedVideoCard.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "popup:open-shared-video" });
    window.close();
  });

  nodes.roomCodeInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }
    const roomCode = nodes.roomCodeInput.value.trim();
    if (!roomCode) {
      return;
    }
    await chrome.runtime.sendMessage({ type: "popup:join-room", roomCode });
    await render();
  });

  const saveServerUrl = async () => {
    const response = (await chrome.runtime.sendMessage({
      type: "popup:set-server-url",
      serverUrl: nodes.serverUrlInput.value.trim()
    })) as BackgroundToPopupMessage;
    nodes.serverUrlInput.value = response.payload.serverUrl;
    await render();
  };

  nodes.saveServerUrlButton.addEventListener("click", () => {
    void saveServerUrl();
  });

  nodes.serverUrlInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    await saveServerUrl();
  });
}

function scheduleRefresh(): void {
  stopRefresh();
  renderTimer = window.setInterval(() => {
    void render();
  }, 1500);
}

function stopRefresh(): void {
  if (renderTimer !== null) {
    window.clearInterval(renderTimer);
    renderTimer = null;
  }
}
