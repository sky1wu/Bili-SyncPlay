import assert from "node:assert/strict";
import test from "node:test";
import { createMessageController } from "../src/background/message-controller";
import type { RoomState } from "@bili-syncplay/protocol";

function createControllerHarness(
  overrides: {
    connectionState?: { connected: boolean; lastError: string | null };
    roomSessionState?: {
      roomCode: string | null;
      memberToken: string | null;
      memberId: string | null;
      displayName: string | null;
      roomState: RoomState | null;
    };
    settingsState?: {
      pageShareButtonEnabled: boolean;
    };
    isActiveSharedTab?: boolean;
    isRememberedSharedSourceTab?: boolean;
    reclaimSharedSourceTabIfUnclaimed?: boolean;
    tabVideoPayloadResult?: {
      ok: boolean;
      payload: {
        video: {
          videoId: string;
          url: string;
          title: string;
        };
        playback: null;
      } | null;
      tabId: number | null;
      error?: string;
    };
    queueOrSendSharedVideoResult?: { ok: true } | { ok: false; error: string };
  } = {},
) {
  const calls = {
    createRoom: 0,
    joinRoom: [] as Array<{ roomCode: string; joinToken: string }>,
    waitForJoinAttemptResult: 0,
    leaveRoom: 0,
    popupLogs: [] as string[],
    contentLogs: [] as string[],
    connect: 0,
    sendToServer: [] as unknown[],
    persistState: 0,
    persistProfileState: 0,
    notifyPageShareButtonSettings: 0,
    notifyAll: 0,
    queueOrSendSharedVideo: [] as Array<{
      payload: unknown;
      tabId: number | null;
    }>,
    getVideoPayloadFromTab: [] as Array<
      Pick<chrome.tabs.Tab, "id" | "url"> | null | undefined
    >,
    openSharedVideoFromPopup: 0,
    updateServerUrl: [] as string[],
  };
  const connectionState = overrides.connectionState ?? {
    connected: true,
    lastError: null,
  };
  const roomSessionState = overrides.roomSessionState ?? {
    roomCode: "ROOM01",
    memberToken: "member-token-1",
    memberId: "member-1",
    displayName: "Alice",
    roomState: {
      roomCode: "ROOM01",
      sharedVideo: null,
      playback: null,
      members: [],
    },
  };
  const popupState = { ok: true, roomCode: roomSessionState.roomCode };
  const settingsState = overrides.settingsState ?? {
    pageShareButtonEnabled: true,
  };

  const controller = createMessageController({
    connectionState,
    roomSessionState,
    settingsState,
    diagnosticsController: {
      log(scope, message) {
        if (scope === "popup") {
          calls.popupLogs.push(message);
          return;
        }
        calls.contentLogs.push(message);
      },
      maybeLogPopupStateRequest() {},
      formatContentSource() {
        return "tab:123";
      },
    },
    popupStateController: {
      popupState() {
        return popupState;
      },
    },
    roomSessionController: {
      async requestCreateRoom() {
        calls.createRoom += 1;
      },
      async requestJoinRoom(roomCode, joinToken) {
        calls.joinRoom.push({ roomCode, joinToken });
      },
      async waitForJoinAttemptResult() {
        calls.waitForJoinAttemptResult += 1;
        return { ok: true };
      },
      async requestLeaveRoom() {
        calls.leaveRoom += 1;
      },
    },
    shareController: {
      async getActiveVideoPayload() {
        return {
          ok: true,
          payload: {
            video: {
              videoId: "BV1xx411c7mD",
              url: "https://www.bilibili.com/video/BV1xx411c7mD",
              title: "Video",
            },
            playback: null,
          },
          tabId: 123,
        };
      },
      async getVideoPayloadFromTab(tab) {
        calls.getVideoPayloadFromTab.push(tab);
        if (overrides.tabVideoPayloadResult) {
          return overrides.tabVideoPayloadResult;
        }
        return {
          ok: true,
          payload: {
            video: {
              videoId: "BV199W9zEEcH",
              url: "https://www.bilibili.com/video/BV199W9zEEcH",
              title: "New Video",
            },
            playback: null,
          },
          tabId: tab?.id ?? null,
        };
      },
      async queueOrSendSharedVideo(payload, tabId) {
        calls.queueOrSendSharedVideo.push({ payload, tabId });
        return overrides.queueOrSendSharedVideoResult ?? { ok: true };
      },
    },
    tabController: {
      async openSharedVideoFromPopup() {
        calls.openSharedVideoFromPopup += 1;
      },
      isActiveSharedTab() {
        return overrides.isActiveSharedTab ?? true;
      },
      isRememberedSharedSourceTab() {
        return overrides.isRememberedSharedSourceTab ?? false;
      },
      reclaimSharedSourceTabIfUnclaimed() {
        return overrides.reclaimSharedSourceTabIfUnclaimed ?? false;
      },
    },
    clockController: {
      compensateRoomState(state) {
        return {
          ...state,
          playback: state.playback
            ? { ...state.playback, position: state.playback.position + 1 }
            : null,
        };
      },
    },
    socketController: {
      async connect() {
        calls.connect += 1;
      },
    },
    sendToServer(message) {
      calls.sendToServer.push(message);
    },
    async updateServerUrl(serverUrl) {
      calls.updateServerUrl.push(serverUrl);
    },
    async persistState() {
      calls.persistState += 1;
    },
    async persistProfileState() {
      calls.persistProfileState += 1;
    },
    async notifyPageShareButtonSettings() {
      calls.notifyPageShareButtonSettings += 1;
    },
    notifyAll() {
      calls.notifyAll += 1;
    },
  });

  return {
    controller,
    calls,
    connectionState,
    roomSessionState,
    popupState,
    settingsState,
  };
}

test("message controller waits for popup join completion only when already connected", async () => {
  const connectedHarness = createControllerHarness();
  let connectedResponse: unknown;
  await connectedHarness.controller.handleRuntimeMessage(
    {
      type: "popup:join-room",
      roomCode: "ROOM99",
      joinToken: "join-token-99",
    },
    {},
    (response) => {
      connectedResponse = response;
    },
  );

  assert.deepEqual(connectedHarness.calls.joinRoom, [
    { roomCode: "ROOM99", joinToken: "join-token-99" },
  ]);
  assert.equal(connectedHarness.calls.waitForJoinAttemptResult, 1);
  assert.deepEqual(connectedResponse, connectedHarness.popupState);

  const disconnectedHarness = createControllerHarness({
    connectionState: { connected: false, lastError: null },
  });
  let disconnectedResponse: unknown;
  await disconnectedHarness.controller.handleRuntimeMessage(
    {
      type: "popup:join-room",
      roomCode: "ROOM42",
      joinToken: "join-token-42",
    },
    {},
    (response) => {
      disconnectedResponse = response;
    },
  );

  assert.deepEqual(disconnectedHarness.calls.joinRoom, [
    { roomCode: "ROOM42", joinToken: "join-token-42" },
  ]);
  assert.equal(disconnectedHarness.calls.waitForJoinAttemptResult, 0);
  assert.deepEqual(disconnectedResponse, disconnectedHarness.popupState);
});

test("message controller reconnects on popup:get-state when room context exists but socket is offline", async () => {
  const harness = createControllerHarness({
    connectionState: { connected: false, lastError: null },
  });
  let response: unknown;

  await harness.controller.handleRuntimeMessage(
    { type: "popup:get-state" },
    {},
    (nextResponse) => {
      response = nextResponse;
    },
  );

  assert.equal(harness.calls.connect, 1);
  assert.deepEqual(response, harness.popupState);
});

test("message controller updates the page share button setting from popup", async () => {
  const harness = createControllerHarness();
  let response: unknown;

  await harness.controller.handleRuntimeMessage(
    { type: "popup:set-page-share-button-enabled", enabled: false },
    {},
    (nextResponse) => {
      response = nextResponse;
    },
  );

  assert.equal(harness.settingsState.pageShareButtonEnabled, false);
  assert.equal(harness.calls.persistProfileState, 1);
  assert.equal(harness.calls.notifyAll, 1);
  assert.equal(harness.calls.notifyPageShareButtonSettings, 1);
  assert.deepEqual(response, harness.popupState);
});

test("message controller returns the page share button setting to content", async () => {
  const harness = createControllerHarness({
    settingsState: { pageShareButtonEnabled: false },
  });
  let response: unknown;

  await harness.controller.handleRuntimeMessage(
    { type: "content:get-page-share-button-settings" },
    {},
    (nextResponse) => {
      response = nextResponse;
    },
  );

  assert.deepEqual(response, { ok: true, enabled: false });
});

test("message controller updates the page share button setting from content", async () => {
  const harness = createControllerHarness();
  let response: unknown;

  await harness.controller.handleRuntimeMessage(
    { type: "content:set-page-share-button-enabled", enabled: false },
    {},
    (nextResponse) => {
      response = nextResponse;
    },
  );

  assert.equal(harness.settingsState.pageShareButtonEnabled, false);
  assert.equal(harness.calls.persistProfileState, 1);
  assert.equal(harness.calls.notifyAll, 1);
  assert.equal(harness.calls.notifyPageShareButtonSettings, 1);
  assert.deepEqual(response, { ok: true, enabled: false });
});

test("message controller returns share context for content page actions", async () => {
  const sharedVideo = {
    videoId: "BV199W9zEEcH",
    url: "https://www.bilibili.com/video/BV199W9zEEcH",
    title: "Shared Video",
    sharedByMemberId: "member-88",
    sharedByDisplayName: "Alice",
  };
  const harness = createControllerHarness({
    roomSessionState: {
      roomCode: "ROOM88",
      memberToken: "member-token-88",
      memberId: "member-88",
      displayName: "Alice",
      roomState: {
        roomCode: "ROOM88",
        sharedVideo,
        playback: null,
        members: [
          { id: "member-88", name: "Alice" },
          { id: "member-99", name: "Bob" },
        ],
      },
    },
  });
  let response: unknown;

  await harness.controller.handleRuntimeMessage(
    { type: "content:get-share-context" },
    { tab: { id: 456 } },
    (nextResponse) => {
      response = nextResponse;
    },
  );

  assert.deepEqual(response, {
    ok: true,
    roomCode: "ROOM88",
    memberCount: 2,
    sharedVideo: {
      videoId: "BV199W9zEEcH",
      url: "https://www.bilibili.com/video/BV199W9zEEcH",
      title: "Shared Video",
    },
  });
});

test("message controller shares content page video by reading the sender tab", async () => {
  const harness = createControllerHarness();
  let response: unknown;
  const senderTab = {
    id: 456,
    url: "https://www.bilibili.com/video/BV199W9zEEcH",
  };

  await harness.controller.handleRuntimeMessage(
    {
      type: "content:share-current-video",
    },
    { tab: senderTab },
    (nextResponse) => {
      response = nextResponse;
    },
  );

  assert.deepEqual(harness.calls.getVideoPayloadFromTab, [senderTab]);
  assert.deepEqual(harness.calls.queueOrSendSharedVideo, [
    {
      payload: {
        video: {
          videoId: "BV199W9zEEcH",
          url: "https://www.bilibili.com/video/BV199W9zEEcH",
          title: "New Video",
        },
        playback: null,
      },
      tabId: 456,
    },
  ]);
  assert.equal(harness.calls.persistState, 1);
  assert.equal(harness.calls.notifyAll, 1);
  assert.deepEqual(response, { ok: true });
});

test("message controller reports content page share read failures", async () => {
  const harness = createControllerHarness({
    tabVideoPayloadResult: {
      ok: false,
      payload: null,
      tabId: 456,
      error: "无法读取当前视频。",
    },
  });
  let response: unknown;

  await harness.controller.handleRuntimeMessage(
    {
      type: "content:share-current-video",
    },
    {
      tab: {
        id: 456,
        url: "https://www.bilibili.com/video/BV199W9zEEcH",
      },
    },
    (nextResponse) => {
      response = nextResponse;
    },
  );

  assert.deepEqual(harness.calls.queueOrSendSharedVideo, []);
  assert.equal(harness.connectionState.lastError, "无法读取当前视频。");
  assert.equal(harness.calls.persistState, 0);
  assert.equal(harness.calls.notifyAll, 1);
  assert.deepEqual(response, {
    ok: false,
    error: "无法读取当前视频。",
  });
});

test("message controller reports content page share send failures", async () => {
  const harness = createControllerHarness({
    queueOrSendSharedVideoResult: {
      ok: false,
      error: "成员令牌缺失，请重新加入房间。",
    },
  });
  let response: unknown;

  await harness.controller.handleRuntimeMessage(
    {
      type: "content:share-current-video",
    },
    {
      tab: {
        id: 456,
        url: "https://www.bilibili.com/video/BV199W9zEEcH",
      },
    },
    (nextResponse) => {
      response = nextResponse;
    },
  );

  assert.equal(
    harness.connectionState.lastError,
    "成员令牌缺失，请重新加入房间。",
  );
  assert.equal(harness.calls.queueOrSendSharedVideo.length, 1);
  assert.equal(harness.calls.persistState, 0);
  assert.equal(harness.calls.notifyAll, 1);
  assert.deepEqual(response, {
    ok: false,
    error: "成员令牌缺失，请重新加入房间。",
  });
});

test("message controller auto-shares the next video from the original sharer's source tab", async () => {
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
    title: "Old Video",
    sharedByMemberId: "member-1",
  };
  const harness = createControllerHarness({
    isRememberedSharedSourceTab: true,
    roomSessionState: {
      roomCode: "ROOM01",
      memberToken: "member-token-1",
      memberId: "member-1",
      displayName: "Alice",
      roomState: {
        roomCode: "ROOM01",
        sharedVideo,
        playback: null,
        members: [{ id: "member-1", name: "Alice" }],
      },
    },
  });
  let response: unknown;
  const senderTab = {
    id: 456,
    url: "https://www.bilibili.com/video/BV199W9zEEcH",
  };

  await harness.controller.handleRuntimeMessage(
    {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
        targetNormalizedUrl: "https://www.bilibili.com/video/BV199W9zEEcH",
      },
    },
    { tab: senderTab },
    (nextResponse) => {
      response = nextResponse;
    },
  );

  assert.deepEqual(harness.calls.getVideoPayloadFromTab, [senderTab]);
  assert.deepEqual(harness.calls.queueOrSendSharedVideo, [
    {
      payload: {
        video: {
          videoId: "BV199W9zEEcH",
          url: "https://www.bilibili.com/video/BV199W9zEEcH",
          title: "New Video",
        },
        playback: null,
      },
      tabId: 456,
    },
  ]);
  assert.equal(harness.calls.persistState, 1);
  assert.equal(harness.calls.notifyAll, 1);
  assert.deepEqual(response, { ok: true });
});

test("message controller re-claims the shared source tab after a worker restart lost the binding", async () => {
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
    title: "Old Video",
    sharedByMemberId: "member-1",
  };
  const harness = createControllerHarness({
    // The MV3 worker restarted: the source-tab binding is lost so the sender is
    // not yet remembered, but it can be re-claimed since the sender is the
    // sharer and the room is still on the scheduled video.
    isRememberedSharedSourceTab: false,
    reclaimSharedSourceTabIfUnclaimed: true,
    roomSessionState: {
      roomCode: "ROOM01",
      memberToken: "member-token-1",
      memberId: "member-1",
      displayName: "Alice",
      roomState: {
        roomCode: "ROOM01",
        sharedVideo,
        playback: null,
        members: [{ id: "member-1", name: "Alice" }],
      },
    },
  });
  let response: unknown;
  const senderTab = {
    id: 456,
    url: "https://www.bilibili.com/video/BV199W9zEEcH",
  };

  await harness.controller.handleRuntimeMessage(
    {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
        targetNormalizedUrl: "https://www.bilibili.com/video/BV199W9zEEcH",
      },
    },
    { tab: senderTab },
    (nextResponse) => {
      response = nextResponse;
    },
  );

  // The re-claimed source tab is allowed to advance the room.
  assert.deepEqual(harness.calls.getVideoPayloadFromTab, [senderTab]);
  assert.equal(harness.calls.queueOrSendSharedVideo.length, 1);
  assert.deepEqual(response, { ok: true });
});

test("message controller skips auto-share next video from non-sharers", async () => {
  const harness = createControllerHarness({
    isRememberedSharedSourceTab: true,
    roomSessionState: {
      roomCode: "ROOM01",
      memberToken: "member-token-1",
      memberId: "member-1",
      displayName: "Alice",
      roomState: {
        roomCode: "ROOM01",
        sharedVideo: {
          videoId: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "Old Video",
          sharedByMemberId: "member-2",
        },
        playback: null,
        members: [
          { id: "member-1", name: "Alice" },
          { id: "member-2", name: "Bob" },
        ],
      },
    },
  });
  let response: unknown;

  await harness.controller.handleRuntimeMessage(
    {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
        targetNormalizedUrl: "https://www.bilibili.com/video/BV199W9zEEcH",
      },
    },
    {
      tab: {
        id: 456,
        url: "https://www.bilibili.com/video/BV199W9zEEcH",
      },
    },
    (nextResponse) => {
      response = nextResponse;
    },
  );

  assert.deepEqual(harness.calls.getVideoPayloadFromTab, []);
  assert.deepEqual(harness.calls.queueOrSendSharedVideo, []);
  assert.equal(harness.calls.persistState, 0);
  assert.deepEqual(response, { ok: true });
});

test("message controller skips auto-share next video from other tabs", async () => {
  const harness = createControllerHarness({
    isRememberedSharedSourceTab: false,
    roomSessionState: {
      roomCode: "ROOM01",
      memberToken: "member-token-1",
      memberId: "member-1",
      displayName: "Alice",
      roomState: {
        roomCode: "ROOM01",
        sharedVideo: {
          videoId: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "Old Video",
          sharedByMemberId: "member-1",
        },
        playback: null,
        members: [{ id: "member-1", name: "Alice" }],
      },
    },
  });
  let response: unknown;

  await harness.controller.handleRuntimeMessage(
    {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
        targetNormalizedUrl: "https://www.bilibili.com/video/BV199W9zEEcH",
      },
    },
    {
      tab: {
        id: 789,
        url: "https://www.bilibili.com/video/BV199W9zEEcH",
      },
    },
    (nextResponse) => {
      response = nextResponse;
    },
  );

  assert.deepEqual(harness.calls.getVideoPayloadFromTab, []);
  assert.deepEqual(harness.calls.queueOrSendSharedVideo, []);
  assert.equal(harness.calls.persistState, 0);
  assert.deepEqual(response, { ok: true });
});

test("message controller reports a retryable failure when the page bridge still resolves the previous shared video", async () => {
  const senderTab = {
    id: 456,
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
  };
  const harness = createControllerHarness({
    isRememberedSharedSourceTab: true,
    tabVideoPayloadResult: {
      ok: true,
      payload: {
        video: {
          videoId: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "Old Video",
        },
        playback: null,
      },
      tabId: senderTab.id,
    },
    roomSessionState: {
      roomCode: "ROOM01",
      memberToken: "member-token-1",
      memberId: "member-1",
      displayName: "Alice",
      roomState: {
        roomCode: "ROOM01",
        sharedVideo: {
          videoId: "BV1xx411c7mD",
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "Old Video",
          sharedByMemberId: "member-1",
        },
        playback: null,
        members: [{ id: "member-1", name: "Alice" }],
      },
    },
  });
  let response: unknown;

  await harness.controller.handleRuntimeMessage(
    {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
        targetNormalizedUrl: "https://www.bilibili.com/video/BV199W9zEEcH",
      },
    },
    { tab: senderTab },
    (nextResponse) => {
      response = nextResponse;
    },
  );

  // The page bridge still resolves the previous shared video mid-SPA, so
  // sharing it would be a no-op while the sharer has advanced. The room must
  // learn this is retryable rather than treating the stale resolution as done.
  assert.deepEqual(harness.calls.getVideoPayloadFromTab, [senderTab]);
  assert.deepEqual(harness.calls.queueOrSendSharedVideo, []);
  assert.equal(harness.calls.persistState, 0);
  assert.deepEqual(response, { ok: false });
});

test("message controller defers auto-share next video with a retryable failure while the sharer is offline", async () => {
  const sharedVideo = {
    videoId: "BV1xx411c7mD",
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
    title: "Old Video",
    sharedByMemberId: "member-1",
  };
  const harness = createControllerHarness({
    connectionState: { connected: false, lastError: null },
    isRememberedSharedSourceTab: true,
    roomSessionState: {
      roomCode: "ROOM01",
      memberToken: "member-token-1",
      memberId: "member-1",
      displayName: "Alice",
      roomState: {
        roomCode: "ROOM01",
        sharedVideo,
        playback: null,
        members: [{ id: "member-1", name: "Alice" }],
      },
    },
  });
  const senderTab = {
    id: 456,
    url: "https://www.bilibili.com/video/BV199W9zEEcH",
  };
  let response: unknown;

  await harness.controller.handleRuntimeMessage(
    {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
        targetNormalizedUrl: "https://www.bilibili.com/video/BV199W9zEEcH",
      },
    },
    { tab: senderTab },
    (nextResponse) => {
      response = nextResponse;
    },
  );

  // While offline the local room state may be stale, so the share must NOT be
  // queued (queuing would let it overwrite the room on reconnect). It is
  // deferred with a retryable failure flagged `deferred` so the content
  // controller keeps retrying after reconnect without burning its short
  // page-bridge attempt budget.
  assert.deepEqual(harness.calls.getVideoPayloadFromTab, []);
  assert.equal(harness.calls.queueOrSendSharedVideo.length, 0);
  assert.deepEqual(response, { ok: false, deferred: true });
});

test("message controller skips auto-share next video when the room moved past the scheduled shared video", async () => {
  const harness = createControllerHarness({
    isRememberedSharedSourceTab: true,
    roomSessionState: {
      roomCode: "ROOM01",
      memberToken: "member-token-1",
      memberId: "member-1",
      displayName: "Alice",
      roomState: {
        roomCode: "ROOM01",
        sharedVideo: {
          videoId: "BV1Newer",
          url: "https://www.bilibili.com/video/BV1Newer",
          title: "Newer Video",
          sharedByMemberId: "member-1",
        },
        playback: null,
        members: [{ id: "member-1", name: "Alice" }],
      },
    },
  });
  const senderTab = {
    id: 456,
    url: "https://www.bilibili.com/video/BV199W9zEEcH",
  };
  let response: unknown;

  await harness.controller.handleRuntimeMessage(
    {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
        targetNormalizedUrl: "https://www.bilibili.com/video/BV199W9zEEcH",
      },
    },
    { tab: senderTab },
    (nextResponse) => {
      response = nextResponse;
    },
  );

  assert.deepEqual(harness.calls.getVideoPayloadFromTab, []);
  assert.deepEqual(harness.calls.queueOrSendSharedVideo, []);
  assert.equal(harness.calls.persistState, 0);
  assert.deepEqual(response, { ok: true });
});

test("message controller persists content:report-user and forwards profile update for active room members", async () => {
  const harness = createControllerHarness();
  let response: unknown;

  await harness.controller.handleRuntimeMessage(
    {
      type: "content:report-user",
      payload: { displayName: "Bob" },
    },
    {},
    (nextResponse) => {
      response = nextResponse;
    },
  );

  assert.equal(harness.roomSessionState.displayName, "Bob");
  assert.equal(harness.calls.persistProfileState, 1);
  assert.equal(harness.calls.persistState, 0);
  assert.deepEqual(harness.calls.sendToServer, [
    {
      type: "profile:update",
      payload: {
        memberToken: "member-token-1",
        displayName: "Bob",
      },
    },
  ]);
  assert.deepEqual(response, { ok: true });
});

test("message controller forwards content playback updates only for the active shared tab", async () => {
  const activeHarness = createControllerHarness();
  await activeHarness.controller.handleRuntimeMessage(
    {
      type: "content:playback-update",
      payload: {
        url: "https://www.bilibili.com/video/BV1xx411c7mD",
        currentTime: 12,
        paused: false,
        playbackRate: 1,
        timestamp: 123,
        actorId: "remote-actor",
      },
    },
    { tab: { id: 123 } },
    () => undefined,
  );

  assert.deepEqual(activeHarness.calls.sendToServer, [
    {
      type: "playback:update",
      payload: {
        memberToken: "member-token-1",
        playback: {
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          currentTime: 12,
          paused: false,
          playbackRate: 1,
          timestamp: 123,
          actorId: "member-1",
          serverTime: 0,
        },
      },
    },
  ]);

  const inactiveHarness = createControllerHarness({
    isActiveSharedTab: false,
  });
  await inactiveHarness.controller.handleRuntimeMessage(
    {
      type: "content:playback-update",
      payload: {
        url: "https://www.bilibili.com/video/BV1xx411c7mD",
        currentTime: 12,
        paused: false,
        playbackRate: 1,
        timestamp: 123,
        actorId: "remote-actor",
      },
    },
    { tab: { id: 123 } },
    () => undefined,
  );

  assert.deepEqual(inactiveHarness.calls.sendToServer, []);
});
