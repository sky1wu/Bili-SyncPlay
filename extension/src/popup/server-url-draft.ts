export interface ServerUrlDraftState {
  value: string;
  dirty: boolean;
}

export function createServerUrlDraftState(): ServerUrlDraftState {
  return {
    value: "",
    dirty: false
  };
}

export function syncServerUrlDraft(state: ServerUrlDraftState, serverUrl: string): void {
  state.value = serverUrl;
  state.dirty = false;
}

export function updateServerUrlDraft(
  state: ServerUrlDraftState,
  value: string,
  persistedServerUrl: string
): void {
  state.value = value;
  state.dirty = value !== persistedServerUrl;
}

export function getRenderedServerUrlValue(
  state: ServerUrlDraftState,
  persistedServerUrl: string,
  focused: boolean
): string {
  if (!focused && !state.dirty) {
    syncServerUrlDraft(state, persistedServerUrl);
  }
  return state.value;
}
