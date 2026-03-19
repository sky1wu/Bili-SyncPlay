import type { BackgroundToPopupMessage } from "../shared/messages";
import { bindPopupActions } from "./popup-actions";
import {
  connectPopupStatePort as createPopupStatePort,
  queryPopupState,
} from "./popup-port";
import {
  applyRoomActionControlState as applyRoomActionControlStateToRefs,
  renderPopup,
} from "./popup-render";
import { createPopupUiStateStore } from "./popup-store";
import { renderPopupTemplate } from "./popup-template";
import { collectPopupRefs, type PopupRefs } from "./popup-view";
import { createServerUrlDraftState } from "./server-url-draft";
import {
  applyIncomingPopupState,
  createPopupStateSyncState,
} from "./state-sync";
import { getDocumentLanguage, t } from "../shared/i18n";

const app = document.getElementById("app");

let refs: PopupRefs | null = null;
const serverUrlDraft = createServerUrlDraftState();
const popupUiStateStore = createPopupUiStateStore();
const popupStateSync = createPopupStateSyncState();

const LEAVE_GUARD_MS = 1500;

void init();

async function init(): Promise<void> {
  if (!app) {
    return;
  }

  document.documentElement.lang = getDocumentLanguage();
  document.title = t("popupTitle");
  app.innerHTML = renderPopupTemplate();

  refs = collectPopupRefs();
  bindPopupActions({
    refs,
    leaveGuardMs: LEAVE_GUARD_MS,
    uiStateStore: popupUiStateStore,
    serverUrlDraft,
    queryState,
    applyActionState,
    render,
    sendPopupLog,
    applyRoomActionControlState,
    getPopupState: () => popupStateSync.popupState,
  });
  connectPort();
  const initialState = await queryState();
  if (applyState(initialState, "query")) {
    render();
  }
}

async function queryState(): Promise<BackgroundToPopupMessage["payload"]> {
  return queryPopupState();
}

function applyActionState(state: BackgroundToPopupMessage["payload"]): void {
  applyState(state, "port");
  render();
}

function connectPort(): void {
  popupUiStateStore.getState().popupPort?.disconnect();
  const popupPort = createPopupStatePort({
    onState: (state) => {
      if (applyState(state, "port")) {
        render();
      }
    },
    onDisconnect: () => {
      popupUiStateStore.patch({ popupPort: null });
    },
  });
  popupUiStateStore.patch({ popupPort });
}

async function sendPopupLog(message: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "popup:debug-log", message });
  } catch {
    // Ignore popup debug logging failures.
  }
}

function applyRoomActionControlState(nodes: PopupRefs): void {
  const uiState = popupUiStateStore.getState();
  applyRoomActionControlStateToRefs({
    refs: nodes,
    roomActionPending: uiState.roomActionPending,
    lastKnownPendingCreateRoom: uiState.lastKnownPendingCreateRoom,
    lastKnownPendingJoinRoomCode: uiState.lastKnownPendingJoinRoomCode,
    lastKnownRoomCode: uiState.lastKnownRoomCode,
  });
}

function applyState(
  state: BackgroundToPopupMessage["payload"],
  source: "port" | "query" = "port",
): boolean {
  if (!applyIncomingPopupState(popupStateSync, state, source)) {
    return false;
  }
  const previousRoomCode = popupUiStateStore.getState().lastKnownRoomCode;
  popupUiStateStore.patch({
    lastKnownPendingCreateRoom: state.pendingCreateRoom,
    lastKnownPendingJoinRoomCode: state.pendingJoinRoomCode,
    lastKnownRoomCode: state.roomCode,
  });
  if (!previousRoomCode && state.roomCode) {
    popupUiStateStore.patch({ lastRoomEnteredAt: Date.now() });
  }
  return true;
}

function render(): void {
  if (!refs || !popupStateSync.popupState) {
    return;
  }
  const uiState = popupUiStateStore.getState();
  renderPopup({
    refs,
    state: popupStateSync.popupState,
    serverUrlDraft,
    roomCodeDraft: uiState.roomCodeDraft,
    setRoomCodeDraft: (value) => {
      popupUiStateStore.patch({ roomCodeDraft: value });
    },
    localStatusMessage: uiState.localStatusMessage,
    roomActionPending: uiState.roomActionPending,
    lastKnownPendingCreateRoom: uiState.lastKnownPendingCreateRoom,
    lastKnownPendingJoinRoomCode: uiState.lastKnownPendingJoinRoomCode,
    lastKnownRoomCode: uiState.lastKnownRoomCode,
    copyRoomSuccess: uiState.copyRoomSuccess,
    copyLogsSuccess: uiState.copyLogsSuccess,
    sendPopupLog,
  });
}
