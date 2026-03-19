export interface PopupUiState {
  roomActionPending: boolean;
  lastKnownPendingCreateRoom: boolean;
  lastKnownPendingJoinRoomCode: string | null;
  lastKnownRoomCode: string | null;
  lastRoomEnteredAt: number;
  roomCodeDraft: string;
  localStatusMessage: string | null;
  copyRoomSuccess: boolean;
  copyLogsSuccess: boolean;
  popupPort: chrome.runtime.Port | null;
}

export interface PopupUiStateStore {
  getState(): PopupUiState;
  patch(nextState: Partial<PopupUiState>): PopupUiState;
  reset(): PopupUiState;
}

export function createPopupUiState(): PopupUiState {
  return {
    roomActionPending: false,
    lastKnownPendingCreateRoom: false,
    lastKnownPendingJoinRoomCode: null,
    lastKnownRoomCode: null,
    lastRoomEnteredAt: 0,
    roomCodeDraft: "",
    localStatusMessage: null,
    copyRoomSuccess: false,
    copyLogsSuccess: false,
    popupPort: null,
  };
}

export function createPopupUiStateStore(): PopupUiStateStore {
  const state = createPopupUiState();

  return {
    getState() {
      return state;
    },
    patch(nextState) {
      Object.assign(state, nextState);
      return state;
    },
    reset() {
      Object.assign(state, createPopupUiState());
      return state;
    },
  };
}
