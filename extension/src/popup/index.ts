import { normalizeBilibiliUrl, type RoomMember } from "@bili-syncplay/protocol";
import type { BackgroundToPopupMessage } from "../shared/messages";
import { escapeHtml, parseInviteValue } from "./helpers";
import {
  createServerUrlDraftState,
  getRenderedServerUrlValue,
  syncServerUrlDraft,
  updateServerUrlDraft
} from "./server-url-draft";
import { applyIncomingPopupState, createPopupStateSyncState } from "./state-sync";

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
  sharedVideoOwner: HTMLElement;
  logs: HTMLElement;
  memberList: HTMLElement;
  copyLogsButton: HTMLButtonElement;
  serverUrlInput: HTMLInputElement;
  saveServerUrlButton: HTMLButtonElement;
  debugMemberStatus: HTMLElement;
  retryStatusValue: HTMLElement;
  retryStatusCount: HTMLElement;
  clockStatus: HTMLElement;
  createRoomButton: HTMLButtonElement;
  joinRoomButton: HTMLButtonElement;
  leaveRoomButton: HTMLButtonElement;
}

let refs: PopupRefs | null = null;
let copyRoomResetTimer: number | null = null;
let copyLogsResetTimer: number | null = null;
let roomActionPending = false;
let lastKnownPendingCreateRoom = false;
let lastKnownPendingJoinRoomCode: string | null = null;
let lastKnownRoomCode: string | null = null;
let lastRoomEnteredAt = 0;
let roomCodeDraft = "";
const serverUrlDraft = createServerUrlDraftState();
let localStatusMessage: string | null = null;
let popupPort: chrome.runtime.Port | null = null;
const popupStateSync = createPopupStateSyncState();

const LEAVE_GUARD_MS = 1500;

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
        <div class="video-subline">
          <div class="video-meta" id="shared-video-meta">点击可打开共享视频</div>
          <div class="video-owner" id="shared-video-owner" hidden>由 - 共享</div>
        </div>
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
              <span class="metric-value retry-status" id="retry-status">
                <span id="retry-status-value">-</span>
                <span class="retry-status-count" id="retry-status-count"></span>
              </span>
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
  connectPopupStatePort();
  const initialState = await queryState();
  if (applyState(initialState, "query")) {
    render();
  }
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
    sharedVideoOwner: getById("shared-video-owner"),
    logs: getById("debug-logs"),
    memberList: getById("member-list"),
    copyLogsButton: getById("copy-logs") as HTMLButtonElement,
    serverUrlInput: getById("server-url") as HTMLInputElement,
    saveServerUrlButton: getById("save-server-url") as HTMLButtonElement,
    debugMemberStatus: getById("member-status"),
    retryStatusValue: getById("retry-status-value"),
    retryStatusCount: getById("retry-status-count"),
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

function applyActionState(state: BackgroundToPopupMessage["payload"]): void {
  applyState(state, "port");
  render();
}

function connectPopupStatePort(): void {
  popupPort?.disconnect();
  popupPort = chrome.runtime.connect({ name: "popup-state" });
  popupPort.onMessage.addListener((message: BackgroundToPopupMessage) => {
    if (message.type !== "background:state") {
      return;
    }
    if (applyState(message.payload, "port")) {
      render();
    }
  });
  popupPort.onDisconnect.addListener(() => {
    popupPort = null;
  });
}

async function sendPopupLog(message: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "popup:debug-log", message });
  } catch {
    // Ignore popup debug logging failures.
  }
}

function applyRoomActionControlState(nodes: PopupRefs): void {
  const isRoomTransitioning =
    roomActionPending || lastKnownPendingCreateRoom || Boolean(lastKnownPendingJoinRoomCode);
  nodes.createRoomButton.disabled = isRoomTransitioning;
  nodes.joinRoomButton.disabled = isRoomTransitioning || !nodes.roomCodeInput.value.trim();
  nodes.leaveRoomButton.disabled = isRoomTransitioning;
  nodes.roomCodeInput.disabled = isRoomTransitioning || Boolean(lastKnownRoomCode);
}

function setRoomActionPending(nextPending: boolean): void {
  roomActionPending = nextPending;
  if (refs) {
    applyRoomActionControlState(refs);
  }
}

function setLocalStatusMessage(message: string | null): void {
  localStatusMessage = message;
  if (popupStateSync.popupState) {
    render();
  }
}

function formatInviteDraft(roomCode: string | null, joinToken: string | null): string {
  if (!roomCode) {
    return "";
  }
  return joinToken ? `${roomCode}:${joinToken}` : roomCode;
}

function applyState(state: BackgroundToPopupMessage["payload"], source: "port" | "query" = "port"): boolean {
  if (!applyIncomingPopupState(popupStateSync, state, source)) {
    return false;
  }
  const previousRoomCode = lastKnownRoomCode;
  lastKnownPendingCreateRoom = state.pendingCreateRoom;
  lastKnownPendingJoinRoomCode = state.pendingJoinRoomCode;
  lastKnownRoomCode = state.roomCode;
  if (!previousRoomCode && state.roomCode) {
    lastRoomEnteredAt = Date.now();
  }
  return true;
}

function render(): void {
  if (!refs || !popupStateSync.popupState) {
    return;
  }

  const state = popupStateSync.popupState;
  const roomCodeFocused = document.activeElement === refs.roomCodeInput;
  const serverUrlFocused = document.activeElement === refs.serverUrlInput;

  refs.serverStatus.textContent = state.connected ? "已连接" : "未连接";
  refs.roomStatus.textContent = state.roomCode ?? "-";
  refs.membersStatus.textContent = `${state.roomState?.members.length ?? 0} 人在线`;
  refs.debugMemberStatus.textContent = state.memberId ?? "-";
  refs.retryStatusValue.textContent = state.retryInMs !== null ? `${Math.ceil(state.retryInMs / 1000)} 秒` : "-";
  refs.retryStatusCount.textContent = state.retryAttempt > 0
    ? `(${state.retryAttempt}/${state.retryAttemptMax})`
    : "";
  refs.clockStatus.textContent = `偏移 ${state.clockOffsetMs ?? "-"}ms / RTT ${state.rttMs ?? "-"}ms`;
  const visibleMessage = localStatusMessage ?? state.error;
  refs.message.textContent = visibleMessage ?? "";
  refs.message.hidden = !visibleMessage;

  if (!roomCodeFocused) {
    if (state.roomCode) {
      roomCodeDraft = formatInviteDraft(state.roomCode, state.joinToken);
      refs.roomCodeInput.value = roomCodeDraft;
    } else {
      refs.roomCodeInput.value = roomCodeDraft;
    }
  }
  refs.serverUrlInput.value = getRenderedServerUrlValue(serverUrlDraft, state.serverUrl, serverUrlFocused);

  refs.copyRoomButton.disabled = !state.roomCode;
  refs.roomPanelJoined.hidden = !state.roomCode;
  refs.roomPanelIdle.hidden = Boolean(state.roomCode);
  applyRoomActionControlState(refs);

  refs.sharedVideoTitle.textContent = state.roomState?.sharedVideo?.title ?? "暂无共享视频";
  refs.sharedVideoMeta.textContent = formatVideoMeta(state.roomState?.sharedVideo?.url ?? null);
  const ownerText = formatVideoOwner(
    state.roomState?.members ?? [],
    state.roomState?.sharedVideo?.sharedByMemberId ?? null
  );
  refs.sharedVideoOwner.textContent = ownerText;
  refs.sharedVideoOwner.hidden = !state.roomState?.sharedVideo?.url || !ownerText;
  refs.sharedVideoCard.disabled = !state.roomState?.sharedVideo?.url;

  renderMemberList(refs.memberList, state.roomState?.members ?? []);
  renderLogs(refs.logs, state.logs);

  if (state.pendingJoinRoomCode || roomActionPending) {
    void sendPopupLog(
      `Render room=${state.roomCode ?? "none"} connected=${state.connected} pendingJoin=${state.pendingJoinRoomCode ?? "none"} pendingAction=${roomActionPending}`
    );
  }
}

function formatVideoMeta(url: string | null): string {
  if (!url) {
    return "点击可打开共享视频";
  }
  const match = url.match(/\/video\/([^/?]+)/);
  return match ? match[1] : "打开共享视频";
}

function formatVideoOwner(members: RoomMember[], actorId: string | null): string {
  if (!actorId) {
    return "";
  }
  const owner = members.find((member) => member.id === actorId)?.name;
  return owner ? `由 ${owner} 共享` : "";
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

function renderMemberList(container: HTMLElement, members: RoomMember[]): void {
  if (members.length === 0) {
    container.innerHTML = `<span class="member-chip">暂无成员</span>`;
    return;
  }

  container.innerHTML = members.map((member) => `<span class="member-chip">${escapeHtml(member.name)}</span>`).join("");
}

async function handleShareCurrentVideo(): Promise<void> {
  if (!refs) {
    return;
  }

  const state = popupStateSync.popupState ?? await queryState();
  const activeVideo = await chrome.runtime.sendMessage({ type: "popup:get-active-video" });
  if (!activeVideo?.ok || !activeVideo.payload?.video) {
    if (popupStateSync.popupState) {
      render();
    }
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
  if (popupStateSync.popupState) {
    render();
  }
}

function normalizeUrl(url: string | null | undefined): string | null {
  return normalizeBilibiliUrl(url);
}

function bindActions(nodes: PopupRefs): void {
  nodes.joinRoomButton.addEventListener("pointerdown", () => {
    void sendPopupLog(
      `Join button pointerdown disabled=${nodes.joinRoomButton.disabled} pending=${roomActionPending} inputDisabled=${nodes.roomCodeInput.disabled}`
    );
  });

  nodes.leaveRoomButton.addEventListener("pointerdown", () => {
    void sendPopupLog(
      `Leave button pointerdown disabled=${nodes.leaveRoomButton.disabled} pending=${roomActionPending} room=${lastKnownRoomCode ?? "none"}`
    );
  });

  nodes.createRoomButton.addEventListener("click", async () => {
    if (roomActionPending) {
      void sendPopupLog("Create room click ignored because room action is pending");
      return;
    }
    void sendPopupLog("Create room button clicked");
    setLocalStatusMessage(null);
    setRoomActionPending(true);
    try {
      const response = (await chrome.runtime.sendMessage({ type: "popup:create-room" })) as BackgroundToPopupMessage;
      applyActionState(response.payload);
      void sendPopupLog("Create room message resolved");
      setRoomActionPending(false);
    } finally {
      if (roomActionPending) {
        setRoomActionPending(false);
      }
    }
  });

  nodes.joinRoomButton.addEventListener("click", async () => {
    if (roomActionPending) {
      void sendPopupLog("Join click ignored because room action is pending");
      return;
    }
    const inviteText = nodes.roomCodeInput.value.trim();
    const invite = parseInviteValue(inviteText);
    if (!invite) {
      setLocalStatusMessage("邀请格式无效，请输入“房间码:加入码”。");
      void sendPopupLog("Join click ignored because invite string is invalid");
      return;
    }
    setLocalStatusMessage(null);
    roomCodeDraft = `${invite.roomCode}:${invite.joinToken}`;
    void sendPopupLog(`Join button clicked room=${invite.roomCode}`);
    setRoomActionPending(true);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "popup:join-room",
        roomCode: invite.roomCode,
        joinToken: invite.joinToken
      })) as BackgroundToPopupMessage;
      applyActionState(response.payload);
      void sendPopupLog(`Join message resolved room=${invite.roomCode}`);
      setRoomActionPending(false);
    } finally {
      if (roomActionPending) {
        setRoomActionPending(false);
      }
    }
  });

  nodes.leaveRoomButton.addEventListener("click", async () => {
    if (roomActionPending) {
      void sendPopupLog("Leave click ignored because room action is pending");
      return;
    }
    if (Date.now() - lastRoomEnteredAt < LEAVE_GUARD_MS) {
      void sendPopupLog(`Leave click ignored by recent-join guard ${Date.now() - lastRoomEnteredAt}ms`);
      return;
    }
    void sendPopupLog("Leave room button clicked");
    setLocalStatusMessage(null);
    roomCodeDraft = formatInviteDraft(lastKnownRoomCode, popupStateSync.popupState?.joinToken ?? null);
    setRoomActionPending(true);
    try {
      const response = (await chrome.runtime.sendMessage({ type: "popup:leave-room" })) as BackgroundToPopupMessage;
      applyActionState(response.payload);
      void sendPopupLog("Leave room message resolved");
      setRoomActionPending(false);
    } finally {
      if (roomActionPending) {
        setRoomActionPending(false);
      }
    }
  });

  nodes.copyRoomButton.addEventListener("click", async () => {
    const roomCode = nodes.roomStatus.textContent?.trim();
    const state = await queryState();
    if (!roomCode || roomCode === "-" || !state.joinToken) {
      return;
    }

    await navigator.clipboard.writeText(`${roomCode}:${state.joinToken}`);
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
    if (event.key !== "Enter" || roomActionPending) {
      if (event.key === "Enter" && roomActionPending) {
        void sendPopupLog("Join by Enter ignored because room action is pending");
      }
      return;
    }
    const inviteText = nodes.roomCodeInput.value.trim();
    const invite = parseInviteValue(inviteText);
    if (!invite) {
      setLocalStatusMessage("邀请格式无效，请输入“房间码:加入码”。");
      void sendPopupLog("Join by Enter ignored because invite string is invalid");
      return;
    }
    setLocalStatusMessage(null);
    roomCodeDraft = `${invite.roomCode}:${invite.joinToken}`;
    void sendPopupLog(`Join by Enter room=${invite.roomCode}`);
    setRoomActionPending(true);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "popup:join-room",
        roomCode: invite.roomCode,
        joinToken: invite.joinToken
      })) as BackgroundToPopupMessage;
      applyActionState(response.payload);
      void sendPopupLog(`Join by Enter resolved room=${invite.roomCode}`);
      setRoomActionPending(false);
    } finally {
      if (roomActionPending) {
        setRoomActionPending(false);
      }
    }
  });

  nodes.roomCodeInput.addEventListener("input", () => {
    applyRoomActionControlState(nodes);
    const inviteText = nodes.roomCodeInput.value.trim();
    const invite = parseInviteValue(inviteText);
    roomCodeDraft = invite ? `${invite.roomCode}:${invite.joinToken}` : inviteText;
    if (localStatusMessage) {
      setLocalStatusMessage(null);
    }
    if (invite) {
      void sendPopupLog(`Invite input changed room=${invite.roomCode}`);
    }
  });

  const saveServerUrl = async () => {
    setLocalStatusMessage(null);
    const requestedServerUrl = serverUrlDraft.value.trim();
    const response = (await chrome.runtime.sendMessage({
      type: "popup:set-server-url",
      serverUrl: requestedServerUrl
    })) as BackgroundToPopupMessage;
    applyState(response.payload);
    syncServerUrlDraft(serverUrlDraft, response.payload.serverUrl);
    nodes.serverUrlInput.value = response.payload.serverUrl;
    render();
  };

  nodes.saveServerUrlButton.addEventListener("click", () => {
    void saveServerUrl();
  });

  nodes.serverUrlInput.addEventListener("input", () => {
    updateServerUrlDraft(serverUrlDraft, nodes.serverUrlInput.value, popupStateSync.popupState?.serverUrl ?? "");
    if (localStatusMessage) {
      setLocalStatusMessage(null);
    }
  });

  nodes.serverUrlInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    await saveServerUrl();
  });
}
