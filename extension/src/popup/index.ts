import type { BackgroundPopupState } from "../shared/messages";
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
  getNextPopupRoomTrackingState,
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
  // 用 DOMParser 解析静态模板再 adopt 进文档，替代 innerHTML 赋值：
  // 模板不含任何用户输入，DOMParser 不执行脚本，且 addons-linter 不会
  // 对其告警（innerHTML 的官方安全替代）。
  const parsedTemplate = new DOMParser().parseFromString(
    renderPopupTemplate(),
    "text/html",
  );
  app.replaceChildren(
    ...Array.from(parsedTemplate.body.childNodes, (node) =>
      document.importNode(node, true),
    ),
  );

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

async function queryState(): Promise<BackgroundPopupState> {
  return queryPopupState();
}

function applyActionState(state: BackgroundPopupState): void {
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
  state: BackgroundPopupState,
  source: "port" | "query" = "port",
): boolean {
  if (!applyIncomingPopupState(popupStateSync, state, source)) {
    return false;
  }
  popupUiStateStore.patch(
    getNextPopupRoomTrackingState(popupUiStateStore.getState(), state),
  );
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
