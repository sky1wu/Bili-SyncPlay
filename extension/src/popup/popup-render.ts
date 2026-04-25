import type { RoomMember } from "@bili-syncplay/protocol";
import type { BackgroundPopupState } from "../shared/messages";
import { getUiLanguage, t } from "../shared/i18n";
import { escapeHtml } from "./helpers";
import {
  getRenderedServerUrlValue,
  type ServerUrlDraftState,
} from "./server-url-draft";
import type { PopupRefs } from "./popup-view";

let lastPendingRenderLogKey: string | null = null;

export function resetPopupRenderDebugStateForTests(): void {
  lastPendingRenderLogKey = null;
}

export function formatInviteDraft(
  roomCode: string | null,
  joinToken: string | null,
): string {
  if (!roomCode) {
    return "";
  }
  return joinToken ? `${roomCode}:${joinToken}` : roomCode;
}

export function applyRoomActionControlState(args: {
  refs: PopupRefs;
  roomActionPending: boolean;
  lastKnownPendingCreateRoom: boolean;
  lastKnownPendingJoinRoomCode: string | null;
  lastKnownRoomCode: string | null;
}): void {
  const isRoomTransitioning =
    args.roomActionPending ||
    args.lastKnownPendingCreateRoom ||
    Boolean(args.lastKnownPendingJoinRoomCode);
  args.refs.createRoomButton.disabled = isRoomTransitioning;
  args.refs.joinRoomButton.disabled =
    isRoomTransitioning || !args.refs.roomCodeInput.value.trim();
  args.refs.leaveRoomButton.disabled = isRoomTransitioning;
  args.refs.roomCodeInput.disabled =
    isRoomTransitioning || Boolean(args.lastKnownRoomCode);
}

export function renderPopup(args: {
  refs: PopupRefs;
  state: BackgroundPopupState;
  serverUrlDraft: ServerUrlDraftState;
  roomCodeDraft: string;
  setRoomCodeDraft: (value: string) => void;
  localStatusMessage: string | null;
  roomActionPending: boolean;
  lastKnownPendingCreateRoom: boolean;
  lastKnownPendingJoinRoomCode: string | null;
  lastKnownRoomCode: string | null;
  copyRoomSuccess: boolean;
  copyLogsSuccess: boolean;
  sendPopupLog: (message: string) => Promise<void>;
}): void {
  const roomCodeFocused = document.activeElement === args.refs.roomCodeInput;
  const serverUrlFocused = document.activeElement === args.refs.serverUrlInput;

  args.refs.serverStatus.textContent = args.state.connected
    ? t("statusConnected")
    : t("statusDisconnected");
  args.refs.serverStatus.classList.toggle("is-connected", args.state.connected);
  args.refs.serverStatus.classList.toggle(
    "is-disconnected",
    !args.state.connected,
  );
  args.refs.roomStatus.textContent = args.state.roomCode ?? "-";
  args.refs.membersStatus.textContent = t("membersCount", {
    count: args.state.roomState?.members.length ?? 0,
  });
  args.refs.debugMemberStatus.textContent =
    args.state.displayName ?? args.state.memberId ?? "-";
  args.refs.retryStatusValue.textContent =
    args.state.retryInMs !== null
      ? t("retrySeconds", { seconds: Math.ceil(args.state.retryInMs / 1000) })
      : "-";
  args.refs.retryStatusCount.textContent =
    args.state.retryAttempt > 0
      ? `(${args.state.retryAttempt}/${args.state.retryAttemptMax})`
      : "";
  args.refs.clockStatus.innerHTML = `
    <span class="clock-metric">
      <span class="clock-metric-label">${escapeHtml(t("metricClockOffset"))}</span>
      <span class="clock-metric-value">${escapeHtml(formatClockMetricValue(args.state.clockOffsetMs))}</span>
    </span>
    <span class="clock-metric">
      <span class="clock-metric-label">${escapeHtml(t("metricClockRtt"))}</span>
      <span class="clock-metric-value">${escapeHtml(formatClockMetricValue(args.state.rttMs))}</span>
    </span>
  `;
  const visibleMessage = args.localStatusMessage ?? args.state.error;
  args.refs.message.textContent = visibleMessage ?? "";
  args.refs.message.hidden = !visibleMessage;

  if (!roomCodeFocused) {
    if (args.state.roomCode) {
      const nextRoomCodeDraft = formatInviteDraft(
        args.state.roomCode,
        args.state.joinToken,
      );
      args.setRoomCodeDraft(nextRoomCodeDraft);
      args.refs.roomCodeInput.value = nextRoomCodeDraft;
    } else {
      args.refs.roomCodeInput.value = args.roomCodeDraft;
    }
  }
  args.refs.serverUrlInput.value = getRenderedServerUrlValue(
    args.serverUrlDraft,
    args.state.serverUrl,
    serverUrlFocused,
  );

  args.refs.copyRoomButton.disabled = !args.state.roomCode;
  args.refs.copyRoomButton.classList.toggle(
    "success-button",
    args.copyRoomSuccess,
  );
  args.refs.copyLogsButton.classList.toggle(
    "success-button",
    args.copyLogsSuccess,
  );
  args.refs.roomPanelJoined.hidden = !args.state.roomCode;
  args.refs.roomPanelIdle.hidden = Boolean(args.state.roomCode);
  applyRoomActionControlState({
    refs: args.refs,
    roomActionPending: args.roomActionPending,
    lastKnownPendingCreateRoom: args.lastKnownPendingCreateRoom,
    lastKnownPendingJoinRoomCode: args.lastKnownPendingJoinRoomCode,
    lastKnownRoomCode: args.lastKnownRoomCode,
  });

  args.refs.sharedVideoTitle.textContent =
    args.state.roomState?.sharedVideo?.title ?? t("stateNoSharedVideo");
  args.refs.sharedVideoMeta.textContent = formatVideoMeta(
    args.state.roomState?.sharedVideo?.url ?? null,
  );
  const ownerText = formatVideoOwner(
    args.state.roomState?.members ?? [],
    args.state.roomState?.sharedVideo?.sharedByMemberId ?? null,
    args.state.roomState?.sharedVideo?.sharedByDisplayName ?? null,
  );
  args.refs.sharedVideoOwner.textContent = ownerText;
  args.refs.sharedVideoOwner.hidden =
    !args.state.roomState?.sharedVideo?.url || !ownerText;
  args.refs.sharedVideoCard.disabled = !args.state.roomState?.sharedVideo?.url;
  args.refs.sharedVideoCard.classList.toggle(
    "is-empty",
    !args.state.roomState?.sharedVideo?.url,
  );

  renderMemberList(
    args.refs.memberList,
    args.state.roomState?.members ?? [],
    args.state.memberId,
  );
  renderLogs(args.refs.logs, args.state.logs);

  if (args.state.pendingJoinRoomCode || args.roomActionPending) {
    const logKey = [
      args.state.roomCode ?? "none",
      String(args.state.connected),
      args.state.pendingJoinRoomCode ?? "none",
      String(args.roomActionPending),
      args.lastKnownPendingJoinRoomCode ?? "none",
      args.lastKnownRoomCode ?? "none",
    ].join("|");
    if (logKey === lastPendingRenderLogKey) {
      return;
    }
    lastPendingRenderLogKey = logKey;
    void args.sendPopupLog(
      `Render room=${args.state.roomCode ?? "none"} connected=${args.state.connected} backgroundPendingJoin=${args.state.pendingJoinRoomCode ?? "none"} uiPendingAction=${args.roomActionPending} lastKnownPendingJoin=${args.lastKnownPendingJoinRoomCode ?? "none"} lastKnownRoom=${args.lastKnownRoomCode ?? "none"}`,
    );
    return;
  }

  lastPendingRenderLogKey = null;
}

function formatVideoMeta(url: string | null): string {
  if (!url) {
    return t("actionOpenSharedVideoHint");
  }
  const match = url.match(/\/video\/([^/?]+)/);
  return match ? match[1] : t("actionOpenSharedVideo");
}

function formatClockMetricValue(value: number | null): string {
  return value === null ? "-" : `${value}ms`;
}

function formatVideoOwner(
  members: RoomMember[],
  actorId: string | null,
  fallbackDisplayName: string | null,
): string {
  const liveName = actorId
    ? members.find((member) => member.id === actorId)?.name
    : undefined;
  const owner = liveName ?? fallbackDisplayName?.trim();
  return owner ? t("ownerSharedBy", { owner }) : "";
}

function renderLogs(
  container: HTMLElement,
  logs: BackgroundPopupState["logs"],
): void {
  if (logs.length === 0) {
    container.innerHTML = `<div class="muted">${escapeHtml(t("stateNoLogs"))}</div>`;
    return;
  }

  container.innerHTML = logs
    .map((entry) => {
      const time = new Date(entry.at).toLocaleTimeString(getUiLanguage(), {
        hour12: false,
      });
      return `<div class="log-line">[${time}] [${entry.scope}] ${escapeHtml(entry.message)}</div>`;
    })
    .join("");
}

function renderMemberList(
  container: HTMLElement,
  members: RoomMember[],
  currentMemberId: string | null,
): void {
  if (members.length === 0) {
    container.innerHTML = `<span class="member-chip">${escapeHtml(t("stateNoMembers"))}</span>`;
    return;
  }

  container.innerHTML = members
    .map((member) => {
      const isCurrentMember = currentMemberId === member.id;
      const label = isCurrentMember
        ? t("memberSelf", { name: member.name })
        : member.name;
      return `<span class="member-chip${isCurrentMember ? " member-chip-active" : ""}">${escapeHtml(label)}</span>`;
    })
    .join("");
}
