import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRoomActionControlState,
  renderPopup,
  resetPopupRenderDebugStateForTests,
} from "../src/popup/popup-render";
import type { PopupRefs } from "../src/popup/popup-view";
import { setLocaleForTests } from "../src/shared/i18n";

class FakeClassList {
  private readonly classes = new Set<string>();

  toggle(name: string, force?: boolean): void {
    if (force === false) {
      this.classes.delete(name);
      return;
    }
    if (force === true || !this.classes.has(name)) {
      this.classes.add(name);
      return;
    }
    this.classes.delete(name);
  }

  contains(name: string): boolean {
    return this.classes.has(name);
  }
}

function createElement() {
  return {
    textContent: "",
    hidden: false,
    disabled: false,
    value: "",
    innerHTML: "",
    classList: new FakeClassList(),
  };
}

function createPopupRefs(): PopupRefs {
  return {
    serverStatus: createElement() as unknown as HTMLElement,
    roomStatus: createElement() as unknown as HTMLElement,
    membersStatus: createElement() as unknown as HTMLElement,
    message: createElement() as unknown as HTMLElement,
    roomPanelJoined: createElement() as unknown as HTMLElement,
    roomPanelIdle: createElement() as unknown as HTMLElement,
    roomCodeInput: createElement() as unknown as HTMLInputElement,
    copyRoomButton: createElement() as unknown as HTMLButtonElement,
    shareCurrentVideoButton: createElement() as unknown as HTMLButtonElement,
    sharedVideoCard: createElement() as unknown as HTMLButtonElement,
    sharedVideoTitle: createElement() as unknown as HTMLElement,
    sharedVideoMeta: createElement() as unknown as HTMLElement,
    sharedVideoOwner: createElement() as unknown as HTMLElement,
    logs: createElement() as unknown as HTMLElement,
    memberList: createElement() as unknown as HTMLElement,
    copyLogsButton: createElement() as unknown as HTMLButtonElement,
    serverUrlInput: createElement() as unknown as HTMLInputElement,
    saveServerUrlButton: createElement() as unknown as HTMLButtonElement,
    debugMemberStatus: createElement() as unknown as HTMLElement,
    retryStatusValue: createElement() as unknown as HTMLElement,
    retryStatusCount: createElement() as unknown as HTMLElement,
    clockStatus: createElement() as unknown as HTMLElement,
    createRoomButton: createElement() as unknown as HTMLButtonElement,
    joinRoomButton: createElement() as unknown as HTMLButtonElement,
    leaveRoomButton: createElement() as unknown as HTMLButtonElement,
  };
}

test("applyRoomActionControlState disables room actions during room transitions", () => {
  resetPopupRenderDebugStateForTests();
  const refs = createPopupRefs();
  refs.roomCodeInput.value = "ROOM01:token-1";

  applyRoomActionControlState({
    refs,
    roomActionPending: true,
    lastKnownPendingCreateRoom: false,
    lastKnownPendingJoinRoomCode: null,
    lastKnownRoomCode: null,
  });

  assert.equal(refs.createRoomButton.disabled, true);
  assert.equal(refs.joinRoomButton.disabled, true);
  assert.equal(refs.leaveRoomButton.disabled, true);
  assert.equal(refs.roomCodeInput.disabled, true);
});

test("renderPopup updates popup metrics, owner hint, logs, and draft values", async () => {
  resetPopupRenderDebugStateForTests();
  setLocaleForTests("en-US");
  const originalDocument = globalThis.document;
  const refs = createPopupRefs();
  const roomCodeInput = refs.roomCodeInput as unknown as {
    value: string;
  };
  const serverUrlInput = refs.serverUrlInput as unknown as {
    value: string;
  };
  const draftValues: string[] = [];

  Object.assign(globalThis, {
    document: {
      activeElement: null,
    },
  });

  try {
    renderPopup({
      refs,
      state: {
        connected: true,
        serverUrl: "ws://localhost:8787",
        error: null,
        roomCode: "ROOM01",
        joinToken: "join-token-1",
        memberId: "member-1",
        displayName: "Alice",
        roomState: {
          roomCode: "ROOM01",
          sharedVideo: {
            videoId: "BV1xx411c7mD",
            url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
            title: "Shared Video",
            sharedByMemberId: "member-2",
          },
          playback: null,
          members: [
            { id: "member-1", name: "Alice" },
            { id: "member-2", name: "Bob" },
          ],
        },
        pendingCreateRoom: false,
        pendingJoinRoomCode: null,
        retryInMs: 2_000,
        retryAttempt: 1,
        retryAttemptMax: 5,
        clockOffsetMs: 25,
        rttMs: 60,
        logs: [
          {
            at: 1_710_000_000_000,
            scope: "background",
            message: "Connected",
          },
        ],
      },
      serverUrlDraft: { value: "", dirty: false },
      roomCodeDraft: "",
      setRoomCodeDraft: (value) => {
        draftValues.push(value);
      },
      localStatusMessage: "Ready",
      roomActionPending: false,
      lastKnownPendingCreateRoom: false,
      lastKnownPendingJoinRoomCode: null,
      lastKnownRoomCode: "ROOM01",
      copyRoomSuccess: true,
      copyLogsSuccess: true,
      sendPopupLog: async () => {},
    });

    assert.equal(refs.serverStatus.textContent, "Connected");
    assert.equal(refs.serverStatus.classList.contains("is-connected"), true);
    assert.equal(refs.roomStatus.textContent, "ROOM01");
    assert.equal(refs.membersStatus.textContent, "2 members");
    assert.equal(refs.message.textContent, "Ready");
    assert.equal(roomCodeInput.value, "ROOM01:join-token-1");
    assert.equal(serverUrlInput.value, "ws://localhost:8787");
    assert.deepEqual(draftValues, ["ROOM01:join-token-1"]);
    assert.equal(refs.copyRoomButton.disabled, false);
    assert.equal(
      refs.copyRoomButton.classList.contains("success-button"),
      true,
    );
    assert.equal(
      refs.copyLogsButton.classList.contains("success-button"),
      true,
    );
    assert.equal(refs.sharedVideoTitle.textContent, "Shared Video");
    assert.equal(refs.sharedVideoMeta.textContent, "BV1xx411c7mD");
    assert.equal(refs.sharedVideoOwner.textContent, "Shared by Bob");
    assert.equal(refs.sharedVideoOwner.hidden, false);
    assert.equal(refs.logs.innerHTML.includes("Connected"), true);
    assert.equal(refs.memberList.innerHTML.includes("Bob"), true);
    assert.equal(refs.memberList.innerHTML.includes("Me (Alice)"), true);
  } finally {
    setLocaleForTests(null);
    Object.assign(globalThis, { document: originalDocument });
  }
});

test("renderPopup debug log distinguishes background pending state from local UI pending state", async () => {
  resetPopupRenderDebugStateForTests();
  setLocaleForTests("en-US");
  const originalDocument = globalThis.document;
  const refs = createPopupRefs();
  const popupLogs: string[] = [];

  Object.assign(globalThis, {
    document: {
      activeElement: null,
    },
  });

  try {
    renderPopup({
      refs,
      state: {
        connected: false,
        serverUrl: "ws://localhost:8787",
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
      },
      serverUrlDraft: { value: "", dirty: false },
      roomCodeDraft: "ROOM01:join-token-1",
      setRoomCodeDraft: () => {},
      localStatusMessage: null,
      roomActionPending: true,
      lastKnownPendingCreateRoom: false,
      lastKnownPendingJoinRoomCode: "ROOM01",
      lastKnownRoomCode: null,
      copyRoomSuccess: false,
      copyLogsSuccess: false,
      sendPopupLog: async (message) => {
        popupLogs.push(message);
      },
    });

    assert.deepEqual(popupLogs, [
      "Render room=none connected=false backgroundPendingJoin=none uiPendingAction=true lastKnownPendingJoin=ROOM01 lastKnownRoom=none",
    ]);
  } finally {
    setLocaleForTests(null);
    Object.assign(globalThis, { document: originalDocument });
  }
});

test("renderPopup only logs once for repeated identical pending renders", async () => {
  resetPopupRenderDebugStateForTests();
  setLocaleForTests("en-US");
  const originalDocument = globalThis.document;
  const refs = createPopupRefs();
  const popupLogs: string[] = [];

  Object.assign(globalThis, {
    document: {
      activeElement: null,
    },
  });

  const renderArgs = {
    refs,
    state: {
      connected: false,
      serverUrl: "ws://localhost:8787",
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
    },
    serverUrlDraft: { value: "", dirty: false },
    roomCodeDraft: "",
    setRoomCodeDraft: () => {},
    localStatusMessage: null,
    roomActionPending: true,
    lastKnownPendingCreateRoom: false,
    lastKnownPendingJoinRoomCode: null,
    lastKnownRoomCode: null,
    copyRoomSuccess: false,
    copyLogsSuccess: false,
    sendPopupLog: async (message: string) => {
      popupLogs.push(message);
    },
  } as const;

  try {
    renderPopup(renderArgs);
    renderPopup(renderArgs);

    assert.deepEqual(popupLogs, [
      "Render room=none connected=false backgroundPendingJoin=none uiPendingAction=true lastKnownPendingJoin=none lastKnownRoom=none",
    ]);
  } finally {
    setLocaleForTests(null);
    Object.assign(globalThis, { document: originalDocument });
  }
});

test("renderPopup falls back to sharedByDisplayName when the sharer is no longer in members", async () => {
  resetPopupRenderDebugStateForTests();
  setLocaleForTests("en-US");
  const originalDocument = globalThis.document;
  const refs = createPopupRefs();

  Object.assign(globalThis, {
    document: {
      activeElement: null,
    },
  });

  try {
    renderPopup({
      refs,
      state: {
        connected: true,
        serverUrl: "ws://localhost:8787",
        error: null,
        roomCode: "ROOM01",
        joinToken: "join-token-1",
        memberId: "member-1",
        displayName: "Alice",
        roomState: {
          roomCode: "ROOM01",
          sharedVideo: {
            videoId: "BV1xx411c7mD",
            url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
            title: "Shared Video",
            sharedByMemberId: "stale-member-99",
            sharedByDisplayName: "Bob",
          },
          playback: null,
          members: [{ id: "member-1", name: "Alice" }],
        },
        pendingCreateRoom: false,
        pendingJoinRoomCode: null,
        retryInMs: null,
        retryAttempt: 0,
        retryAttemptMax: 5,
        clockOffsetMs: null,
        rttMs: null,
        logs: [],
      },
      serverUrlDraft: { value: "", dirty: false },
      roomCodeDraft: "",
      setRoomCodeDraft: () => {},
      localStatusMessage: null,
      roomActionPending: false,
      lastKnownPendingCreateRoom: false,
      lastKnownPendingJoinRoomCode: null,
      lastKnownRoomCode: "ROOM01",
      copyRoomSuccess: false,
      copyLogsSuccess: false,
      sendPopupLog: async () => {},
    });

    assert.equal(refs.sharedVideoOwner.textContent, "Shared by Bob");
    assert.equal(refs.sharedVideoOwner.hidden, false);
  } finally {
    setLocaleForTests(null);
    Object.assign(globalThis, { document: originalDocument });
  }
});
