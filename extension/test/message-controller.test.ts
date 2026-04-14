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
    isActiveSharedTab?: boolean;
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
    notifyAll: 0,
    queueOrSendSharedVideo: [] as Array<{
      payload: unknown;
      tabId: number | null;
    }>,
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

  const controller = createMessageController({
    connectionState,
    roomSessionState,
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
      async queueOrSendSharedVideo(payload, tabId) {
        calls.queueOrSendSharedVideo.push({ payload, tabId });
      },
    },
    tabController: {
      async openSharedVideoFromPopup() {
        calls.openSharedVideoFromPopup += 1;
      },
      isActiveSharedTab() {
        return overrides.isActiveSharedTab ?? true;
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
    notifyAll() {
      calls.notifyAll += 1;
    },
  });

  return { controller, calls, connectionState, roomSessionState, popupState };
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
