import assert from "node:assert/strict";
import test from "node:test";

import { bindPopupActions } from "../src/popup/popup-actions";
import { createPopupUiStateStore } from "../src/popup/popup-store";
import {
  createServerUrlDraftState,
  updateServerUrlDraft,
} from "../src/popup/server-url-draft";
import type { PopupRefs } from "../src/popup/popup-view";
import type { BackgroundPopupState } from "../src/shared/messages";
import { setLocaleForTests } from "../src/shared/i18n";

const REF_KEYS = [
  "serverStatus",
  "roomStatus",
  "membersStatus",
  "message",
  "roomPanelJoined",
  "roomPanelIdle",
  "roomCodeInput",
  "copyRoomButton",
  "shareCurrentVideoButton",
  "sharedVideoCard",
  "sharedVideoTitle",
  "sharedVideoMeta",
  "sharedVideoOwner",
  "logs",
  "memberList",
  "copyLogsButton",
  "serverUrlInput",
  "saveServerUrlButton",
  "debugMemberStatus",
  "retryStatusValue",
  "retryStatusCount",
  "clockStatus",
  "createRoomButton",
  "joinRoomButton",
  "leaveRoomButton",
] as const;

function createFakeRef(): EventTarget & Record<string, unknown> {
  const target = new EventTarget();
  const element = target as EventTarget & Record<string, unknown>;
  element.value = "";
  element.disabled = false;
  element.textContent = "";
  element.hidden = false;
  element.innerHTML = "";
  element.classList = {
    toggle: () => {},
    contains: () => false,
    add: () => {},
    remove: () => {},
  };
  return element;
}

function createRefs(): PopupRefs {
  const refs = Object.create(null) as Record<string, unknown>;
  for (const key of REF_KEYS) {
    refs[key] = createFakeRef();
  }
  return refs as unknown as PopupRefs;
}

function createState(
  overrides: Partial<BackgroundPopupState> = {},
): BackgroundPopupState {
  return {
    connected: true,
    serverUrl: "ws://current.example/",
    error: null,
    roomCode: null,
    joinToken: null,
    memberId: null,
    displayName: null,
    roomState: null,
    pendingCreateRoom: false,
    pendingJoinRoomCode: null,
    retryInMs: null,
    retryAttempt: 0,
    retryAttemptMax: 5,
    clockOffsetMs: null,
    rttMs: null,
    logs: [],
    ...overrides,
  };
}

function wrapStateMessage(state: BackgroundPopupState): {
  type: "background:state";
  payload: BackgroundPopupState;
} {
  return { type: "background:state", payload: state };
}

function installChromeRuntimeStub(
  handler: (message: unknown) => BackgroundPopupState,
): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      async sendMessage(message: unknown): Promise<unknown> {
        return wrapStateMessage(handler(message));
      },
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

type BindArgs = Parameters<typeof bindPopupActions>[0];

function buildBindings(overrides: Partial<BindArgs> = {}): BindArgs {
  const refs = overrides.refs ?? createRefs();
  const uiStateStore = overrides.uiStateStore ?? createPopupUiStateStore();
  const serverUrlDraft =
    overrides.serverUrlDraft ?? createServerUrlDraftState();
  return {
    refs,
    leaveGuardMs: 0,
    uiStateStore,
    serverUrlDraft,
    queryState: async () => createState(),
    applyActionState: () => {},
    render: () => {},
    sendPopupLog: async () => {},
    applyRoomActionControlState: () => {},
    getPopupState: () => null,
    ...overrides,
  };
}

test("saveServerUrl surfaces a notice when the backend silently normalizes the URL", async () => {
  setLocaleForTests("zh-CN");
  try {
    const refs = createRefs();
    const uiStateStore = createPopupUiStateStore();
    const serverUrlDraft = createServerUrlDraftState();
    updateServerUrlDraft(serverUrlDraft, "   ", "ws://current.example/");

    installChromeRuntimeStub((message) => {
      const typed = message as { type?: string };
      if (typed.type === "popup:set-server-url") {
        return createState({ serverUrl: "ws://default.example/" });
      }
      return createState();
    });

    bindPopupActions(buildBindings({ refs, uiStateStore, serverUrlDraft }));

    (refs.saveServerUrlButton as unknown as EventTarget).dispatchEvent(
      new Event("click"),
    );
    await flushMicrotasks();

    const message = uiStateStore.getState().localStatusMessage ?? "";
    assert.match(message, /ws:\/\/default\.example\//);
    assert.match(message, /调整/);
  } finally {
    setLocaleForTests(null);
  }
});

test("saveServerUrl surfaces a notice when only surrounding whitespace was trimmed", async () => {
  setLocaleForTests("zh-CN");
  try {
    const refs = createRefs();
    const uiStateStore = createPopupUiStateStore();
    const serverUrlDraft = createServerUrlDraftState();
    updateServerUrlDraft(
      serverUrlDraft,
      "  ws://trimmed.example/  ",
      "ws://current.example/",
    );

    const requests: unknown[] = [];
    installChromeRuntimeStub((message) => {
      const typed = message as { type?: string; serverUrl?: string };
      if (typed.type === "popup:set-server-url") {
        requests.push(typed.serverUrl);
        return createState({ serverUrl: "ws://trimmed.example/" });
      }
      return createState();
    });

    bindPopupActions(buildBindings({ refs, uiStateStore, serverUrlDraft }));

    (refs.saveServerUrlButton as unknown as EventTarget).dispatchEvent(
      new Event("click"),
    );
    await flushMicrotasks();

    assert.deepEqual(requests, ["ws://trimmed.example/"]);
    const message = uiStateStore.getState().localStatusMessage ?? "";
    assert.match(message, /ws:\/\/trimmed\.example\//);
    assert.match(message, /调整/);
  } finally {
    setLocaleForTests(null);
  }
});

test("saveServerUrl leaves localStatusMessage untouched when the backend reports an error", async () => {
  setLocaleForTests("zh-CN");
  try {
    const refs = createRefs();
    const uiStateStore = createPopupUiStateStore();
    const serverUrlDraft = createServerUrlDraftState();
    updateServerUrlDraft(
      serverUrlDraft,
      "http://oops",
      "ws://current.example/",
    );

    installChromeRuntimeStub((message) => {
      const typed = message as { type?: string };
      if (typed.type === "popup:set-server-url") {
        return createState({
          serverUrl: "ws://current.example/",
          error: "服务端地址必须以 ws:// 或 wss:// 开头。",
        });
      }
      return createState();
    });

    bindPopupActions(buildBindings({ refs, uiStateStore, serverUrlDraft }));

    (refs.saveServerUrlButton as unknown as EventTarget).dispatchEvent(
      new Event("click"),
    );
    await flushMicrotasks();

    assert.equal(uiStateStore.getState().localStatusMessage, null);
  } finally {
    setLocaleForTests(null);
  }
});

test("saveServerUrl clears a previous localStatusMessage on a successful save", async () => {
  setLocaleForTests("zh-CN");
  try {
    const refs = createRefs();
    const uiStateStore = createPopupUiStateStore();
    const serverUrlDraft = createServerUrlDraftState();
    updateServerUrlDraft(
      serverUrlDraft,
      "ws://next.example/",
      "ws://current.example/",
    );
    uiStateStore.patch({ localStatusMessage: "leftover" });

    installChromeRuntimeStub((message) => {
      const typed = message as { type?: string };
      if (typed.type === "popup:set-server-url") {
        return createState({ serverUrl: "ws://next.example/" });
      }
      return createState();
    });

    bindPopupActions(buildBindings({ refs, uiStateStore, serverUrlDraft }));

    (refs.saveServerUrlButton as unknown as EventTarget).dispatchEvent(
      new Event("click"),
    );
    await flushMicrotasks();

    assert.equal(uiStateStore.getState().localStatusMessage, null);
  } finally {
    setLocaleForTests(null);
  }
});
