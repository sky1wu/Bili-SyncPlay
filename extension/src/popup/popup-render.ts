import type { RoomMember } from "@bili-syncplay/protocol";
import type { BackgroundPopupState } from "../shared/messages";
import { getUiLanguage, t } from "../shared/i18n";
import type {
  VoiceConnectionStatus,
  VoiceRuntimeState,
} from "../shared/voice-state";
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
  renderClockStatus(
    args.refs.clockStatus,
    args.state.clockOffsetMs,
    args.state.rttMs,
  );
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

  renderVoiceState(args.refs, args.state.voice, Boolean(args.state.roomCode));
  renderMemberList(
    args.refs.memberList,
    args.state.roomState?.members ?? [],
    args.state.memberId,
    args.state.voice,
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

function buildClockMetric(label: string, value: string): HTMLSpanElement {
  const wrap = document.createElement("span");
  wrap.className = "clock-metric";
  const labelEl = document.createElement("span");
  labelEl.className = "clock-metric-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.className = "clock-metric-value";
  valueEl.textContent = value;
  wrap.append(labelEl, valueEl);
  return wrap;
}

function renderClockStatus(
  container: HTMLElement,
  clockOffsetMs: number | null,
  rttMs: number | null,
): void {
  container.replaceChildren(
    buildClockMetric(
      t("metricClockOffset"),
      formatClockMetricValue(clockOffsetMs),
    ),
    buildClockMetric(t("metricClockRtt"), formatClockMetricValue(rttMs)),
  );
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
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = t("stateNoLogs");
    container.replaceChildren(empty);
    return;
  }

  container.replaceChildren(
    ...logs.map((entry) => {
      const time = new Date(entry.at).toLocaleTimeString(getUiLanguage(), {
        hour12: false,
      });
      const line = document.createElement("div");
      line.className = "log-line";
      line.textContent = `[${time}] [${entry.scope}] ${entry.message}`;
      return line;
    }),
  );
}

function renderMemberList(
  container: HTMLElement,
  members: RoomMember[],
  currentMemberId: string | null,
  voiceState: VoiceRuntimeState,
): void {
  if (members.length === 0) {
    const chip = document.createElement("span");
    chip.className = "member-chip";
    chip.textContent = t("stateNoMembers");
    container.replaceChildren(chip);
    return;
  }

  container.replaceChildren(
    ...members.map((member) => {
      const isCurrentMember = currentMemberId === member.id;
      const chip = document.createElement("span");
      chip.className = isCurrentMember
        ? "member-chip member-chip-active"
        : "member-chip";
      const name = document.createElement("span");
      name.className = "member-name";
      name.textContent = isCurrentMember
        ? t("memberSelf", { name: member.name })
        : member.name;
      chip.append(name, createVoiceIndicator(voiceState, member.id));
      return chip;
    }),
  );
}

function renderVoiceState(
  refs: PopupRefs,
  voiceState: VoiceRuntimeState,
  hasRoom: boolean,
): void {
  refs.voiceStatus.textContent = formatVoiceStatus(voiceState.status);
  refs.voiceMicState.textContent = voiceState.muted
    ? t("voiceMicMuted")
    : t("voiceMicUnmuted");
  const canRetryVoice = hasRoom && isVoiceRetryStatus(voiceState.status);
  refs.voiceMicLabel.textContent = canRetryVoice
    ? t("voiceActionRetry")
    : voiceState.muted
      ? t("voiceActionUnmute")
      : t("voiceActionMute");
  refs.voiceMicButton.disabled =
    !hasRoom || (voiceState.status !== "connected" && !canRetryVoice);
  refs.voiceMicButton.setAttribute(
    "aria-pressed",
    String(voiceState.status === "connected" && !voiceState.muted),
  );
  refs.voiceMicButton.classList.toggle("is-live", !voiceState.muted);
  refs.voiceMicButton.classList.toggle("is-retry", canRetryVoice);
  refs.voiceDot.classList.toggle(
    "is-connected",
    voiceState.status === "connected",
  );
  refs.voiceDot.classList.toggle("is-live", !voiceState.muted);
  refs.voiceDot.classList.toggle(
    "is-unavailable",
    voiceState.status === "unavailable" || voiceState.status === "failed",
  );
  refs.voiceError.textContent = voiceState.error ?? "";
  refs.voiceError.hidden = !voiceState.error;
}

function isVoiceRetryStatus(status: VoiceConnectionStatus): boolean {
  return status === "failed" || status === "unavailable";
}

function formatVoiceStatus(status: VoiceConnectionStatus): string {
  switch (status) {
    case "requesting":
      return t("voiceStatusRequesting");
    case "connecting":
      return t("voiceStatusConnecting");
    case "connected":
      return t("voiceStatusConnected");
    case "unavailable":
      return t("voiceStatusUnavailable");
    case "failed":
      return t("voiceStatusFailed");
    case "idle":
    default:
      return t("voiceStatusIdle");
  }
}

function createVoiceIndicator(
  voiceState: VoiceRuntimeState,
  memberId: string,
): HTMLSpanElement {
  const indicator = document.createElement("span");
  const participant = voiceState.participants[memberId];
  indicator.className = "member-voice-indicator";
  if (!participant?.connected) {
    indicator.classList.toggle("is-offline", true);
    return indicator;
  }
  indicator.classList.toggle("is-muted", participant.muted);
  indicator.classList.toggle("is-speaking", participant.speaking);
  indicator.title = participant.speaking
    ? t("voiceMemberSpeaking")
    : participant.muted
      ? t("voiceMemberMuted")
      : t("voiceMicUnmuted");
  return indicator;
}
