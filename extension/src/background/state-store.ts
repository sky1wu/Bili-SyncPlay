import {
  createBackgroundRuntimeState,
  type BackgroundRuntimeState,
} from "./runtime-state";

type BackgroundRuntimeStatePatch = Partial<{
  [K in keyof BackgroundRuntimeState]: Partial<BackgroundRuntimeState[K]>;
}>;

export interface BackgroundStateStore {
  getState(): BackgroundRuntimeState;
  patch(patch: BackgroundRuntimeStatePatch): BackgroundRuntimeState;
  replace(nextState: BackgroundRuntimeState): BackgroundRuntimeState;
  reset(): BackgroundRuntimeState;
}

export function createBackgroundStateStore(): BackgroundStateStore {
  const state = createBackgroundRuntimeState();

  return {
    getState() {
      return state;
    },
    patch(patch) {
      if (patch.connection) {
        Object.assign(state.connection, patch.connection);
      }
      if (patch.room) {
        Object.assign(state.room, patch.room);
      }
      if (patch.share) {
        Object.assign(state.share, patch.share);
      }
      if (patch.clock) {
        Object.assign(state.clock, patch.clock);
      }
      if (patch.diagnostics) {
        Object.assign(state.diagnostics, patch.diagnostics);
      }
      return state;
    },
    replace(nextState) {
      Object.assign(state.connection, nextState.connection);
      Object.assign(state.room, nextState.room);
      Object.assign(state.share, nextState.share);
      Object.assign(state.clock, nextState.clock);
      Object.assign(state.diagnostics, nextState.diagnostics);
      return state;
    },
    reset() {
      const resetState = createBackgroundRuntimeState();
      Object.assign(state.connection, resetState.connection);
      Object.assign(state.room, resetState.room);
      Object.assign(state.share, resetState.share);
      Object.assign(state.clock, resetState.clock);
      Object.assign(state.diagnostics, resetState.diagnostics);
      return state;
    },
  };
}
