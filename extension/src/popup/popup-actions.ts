import type { BackgroundPopupState } from "../shared/messages";
import { getUiLanguage, t } from "../shared/i18n";
import { areSharedVideoUrlsEqual } from "../shared/url";
import { parseInviteValue } from "./helpers";
import { formatInviteDraft } from "./popup-render";
import { sendPopupAction } from "./popup-port";
import type { PopupUiStateStore } from "./popup-store";
import {
  syncServerUrlDraft,
  updateServerUrlDraft,
  type ServerUrlDraftState,
} from "./server-url-draft";
import type { PopupRefs } from "./popup-view";

export function bindPopupActions(args: {
  refs: PopupRefs;
  leaveGuardMs: number;
  uiStateStore: PopupUiStateStore;
  serverUrlDraft: ServerUrlDraftState;
  queryState: () => Promise<BackgroundPopupState>;
  applyActionState: (state: BackgroundPopupState) => void;
  render: () => void;
  sendPopupLog: (message: string) => Promise<void>;
  applyRoomActionControlState: (refs: PopupRefs) => void;
  getPopupState: () => BackgroundPopupState | null;
}): void {
  const { refs } = args;

  refs.joinRoomButton.addEventListener("pointerdown", () => {
    const uiState = args.uiStateStore.getState();
    void args.sendPopupLog(
      `Join button pointerdown disabled=${refs.joinRoomButton.disabled} pending=${uiState.roomActionPending} inputDisabled=${refs.roomCodeInput.disabled}`,
    );
  });

  refs.leaveRoomButton.addEventListener("pointerdown", () => {
    const uiState = args.uiStateStore.getState();
    void args.sendPopupLog(
      `Leave button pointerdown disabled=${refs.leaveRoomButton.disabled} pending=${uiState.roomActionPending} room=${uiState.lastKnownRoomCode ?? "none"}`,
    );
  });

  refs.createRoomButton.addEventListener("click", async () => {
    if (args.uiStateStore.getState().roomActionPending) {
      void args.sendPopupLog(
        "Create room click ignored because room action is pending",
      );
      return;
    }
    void args.sendPopupLog("Create room button clicked");
    patchUiState({ localStatusMessage: null, roomActionPending: true });
    try {
      const state = await sendPopupAction({ type: "popup:create-room" });
      args.applyActionState(state);
      void args.sendPopupLog("Create room message resolved");
      patchUiState({ roomActionPending: false });
    } finally {
      if (args.uiStateStore.getState().roomActionPending) {
        patchUiState({ roomActionPending: false });
      }
    }
  });

  refs.joinRoomButton.addEventListener("click", async () => {
    await joinRoom({
      inviteText: refs.roomCodeInput.value.trim(),
      reasonLabel: "Join button clicked",
      resolvedLabel: "Join message resolved",
      invalidLabel: "Join click ignored because invite string is invalid",
      pendingLabel: "Join click ignored because room action is pending",
    });
  });

  refs.leaveRoomButton.addEventListener("click", async () => {
    const uiState = args.uiStateStore.getState();
    if (uiState.roomActionPending) {
      void args.sendPopupLog(
        "Leave click ignored because room action is pending",
      );
      return;
    }
    if (Date.now() - uiState.lastRoomEnteredAt < args.leaveGuardMs) {
      void args.sendPopupLog(
        `Leave click ignored by recent-join guard ${Date.now() - uiState.lastRoomEnteredAt}ms`,
      );
      return;
    }
    void args.sendPopupLog("Leave room button clicked");
    patchUiState({
      localStatusMessage: null,
      roomCodeDraft: formatInviteDraft(
        uiState.lastKnownRoomCode,
        args.getPopupState()?.joinToken ?? null,
      ),
      roomActionPending: true,
    });
    try {
      const state = await sendPopupAction({ type: "popup:leave-room" });
      args.applyActionState(state);
      void args.sendPopupLog("Leave room message resolved");
      patchUiState({ roomActionPending: false });
    } finally {
      if (args.uiStateStore.getState().roomActionPending) {
        patchUiState({ roomActionPending: false });
      }
    }
  });

  refs.copyRoomButton.addEventListener("click", async () => {
    const roomCode = refs.roomStatus.textContent?.trim();
    const state = await args.queryState();
    if (!roomCode || roomCode === "-" || !state.joinToken) {
      return;
    }

    await navigator.clipboard.writeText(`${roomCode}:${state.joinToken}`);
    toggleCopySuccess("copyRoomSuccess");
  });

  refs.copyLogsButton.addEventListener("click", async () => {
    const state = await args.queryState();
    const text = state.logs
      .slice()
      .reverse()
      .map((entry) => {
        const time = new Date(entry.at).toLocaleTimeString(getUiLanguage(), {
          hour12: false,
        });
        return `[${time}] [${entry.scope}] ${entry.message}`;
      })
      .join("\n");

    await navigator.clipboard.writeText(text || t("stateNoLogs"));
    toggleCopySuccess("copyLogsSuccess");
  });

  refs.shareCurrentVideoButton.addEventListener("click", () => {
    void handleShareCurrentVideo();
  });

  refs.sharedVideoCard.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "popup:open-shared-video" });
    window.close();
  });

  refs.roomCodeInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }
    await joinRoom({
      inviteText: refs.roomCodeInput.value.trim(),
      reasonLabel: "Join by Enter",
      resolvedLabel: "Join by Enter resolved",
      invalidLabel: "Join by Enter ignored because invite string is invalid",
      pendingLabel: "Join by Enter ignored because room action is pending",
      event,
    });
  });

  refs.roomCodeInput.addEventListener("input", () => {
    args.applyRoomActionControlState(refs);
    const inviteText = refs.roomCodeInput.value.trim();
    const invite = parseInviteValue(inviteText);
    patchUiState({
      roomCodeDraft: invite
        ? `${invite.roomCode}:${invite.joinToken}`
        : inviteText,
    });
    if (args.uiStateStore.getState().localStatusMessage) {
      patchUiState({ localStatusMessage: null });
    }
    if (invite) {
      void args.sendPopupLog(`Invite input changed room=${invite.roomCode}`);
    }
  });

  const saveServerUrl = async () => {
    patchUiState({ localStatusMessage: null });
    const requestedServerUrl = args.serverUrlDraft.value.trim();
    const state = await sendPopupAction({
      type: "popup:set-server-url",
      serverUrl: requestedServerUrl,
    });
    args.applyActionState(state);
    syncServerUrlDraft(args.serverUrlDraft, state.serverUrl);
    refs.serverUrlInput.value = state.serverUrl;
    args.render();
  };

  refs.saveServerUrlButton.addEventListener("click", () => {
    void saveServerUrl();
  });

  refs.serverUrlInput.addEventListener("input", () => {
    updateServerUrlDraft(
      args.serverUrlDraft,
      refs.serverUrlInput.value,
      args.getPopupState()?.serverUrl ?? "",
    );
    if (args.uiStateStore.getState().localStatusMessage) {
      patchUiState({ localStatusMessage: null });
    }
  });

  refs.serverUrlInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    await saveServerUrl();
  });

  async function handleShareCurrentVideo(): Promise<void> {
    const state = args.getPopupState() ?? (await args.queryState());
    const activeVideo = await chrome.runtime.sendMessage({
      type: "popup:get-active-video",
    });
    if (!activeVideo?.ok || !activeVideo.payload?.video) {
      if (args.getPopupState()) {
        args.render();
      }
      return;
    }

    const currentVideo = activeVideo.payload.video as {
      title: string;
      url: string;
    };
    if (!state.roomCode) {
      const shouldCreateRoom = window.confirm(
        t("confirmCreateRoomBeforeShare"),
      );
      if (!shouldCreateRoom) {
        return;
      }
    } else if (
      state.roomState?.sharedVideo?.url &&
      !areSharedVideoUrlsEqual(
        state.roomState.sharedVideo.url,
        currentVideo.url,
      )
    ) {
      const shouldReplace = window.confirm(
        t("confirmReplaceSharedVideo", {
          currentTitle: state.roomState.sharedVideo.title,
          nextTitle: currentVideo.title,
        }),
      );
      if (!shouldReplace) {
        return;
      }
    }

    await chrome.runtime.sendMessage({ type: "popup:share-current-video" });
    if (args.getPopupState()) {
      args.render();
    }
  }

  async function joinRoom(args2: {
    inviteText: string;
    reasonLabel: string;
    resolvedLabel: string;
    invalidLabel: string;
    pendingLabel: string;
    event?: KeyboardEvent;
  }): Promise<void> {
    if (args2.event) {
      if (args2.event.key !== "Enter") {
        return;
      }
      if (args.uiStateStore.getState().roomActionPending) {
        void args.sendPopupLog(args2.pendingLabel);
        return;
      }
    } else if (args.uiStateStore.getState().roomActionPending) {
      void args.sendPopupLog(args2.pendingLabel);
      return;
    }

    const invite = parseInviteValue(args2.inviteText);
    if (!invite) {
      patchUiState({ localStatusMessage: t("errorInvalidInviteFormat") });
      void args.sendPopupLog(args2.invalidLabel);
      return;
    }
    patchUiState({
      localStatusMessage: null,
      roomCodeDraft: `${invite.roomCode}:${invite.joinToken}`,
    });
    void args.sendPopupLog(`${args2.reasonLabel} room=${invite.roomCode}`);
    patchUiState({ roomActionPending: true });
    try {
      const state = await sendPopupAction({
        type: "popup:join-room",
        roomCode: invite.roomCode,
        joinToken: invite.joinToken,
      });
      args.applyActionState(state);
      void args.sendPopupLog(`${args2.resolvedLabel} room=${invite.roomCode}`);
      patchUiState({ roomActionPending: false });
    } finally {
      if (args.uiStateStore.getState().roomActionPending) {
        patchUiState({ roomActionPending: false });
      }
    }
  }

  function patchUiState(
    nextState: Partial<ReturnType<PopupUiStateStore["getState"]>>,
  ): void {
    args.uiStateStore.patch(nextState);
    args.render();
  }

  function toggleCopySuccess(
    field: "copyRoomSuccess" | "copyLogsSuccess",
  ): void {
    const previousTimer = copyResetTimers.get(field);
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
    }
    patchUiState({ [field]: true });
    const timer = window.setTimeout(() => {
      copyResetTimers.delete(field);
      patchUiState({ [field]: false });
    }, 1400);
    copyResetTimers.set(field, timer);
  }
}

const copyResetTimers = new Map<
  "copyRoomSuccess" | "copyLogsSuccess",
  number
>();
