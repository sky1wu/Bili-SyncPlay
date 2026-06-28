import assert from "node:assert/strict";
import test from "node:test";
import type { RoomState } from "@bili-syncplay/protocol";
import type { SharedVideoToastPayload } from "../src/shared/messages";
import { createRoomStateController } from "../src/content/room-state-controller";
import { createContentRuntimeState } from "../src/content/runtime-state";
import { createToastCoordinatorState } from "../src/content/toast";
import { setLocaleForTests } from "../src/shared/i18n";

function createController(shownToasts: string[]) {
  const runtimeState = createContentRuntimeState();
  runtimeState.localMemberId = "self";
  const controller = createRoomStateController({
    runtimeState,
    toastState: createToastCoordinatorState(),
    toastPresenter: {
      resetMountTarget: () => {},
      show: (message) => shownToasts.push(message),
    },
    getSharedVideo: () => null,
    normalizeUrl: (url) => url ?? null,
    debugLog: () => {},
    resetPlaybackSyncState: () => {},
    scheduleHydrationRetry: () => {},
  });
  return { controller, runtimeState };
}

const sharedUrl = "https://www.bilibili.com/video/BV1?p=2";

function createState(): RoomState {
  return {
    roomCode: "ROOM01",
    sharedVideo: { videoId: "BV1:p2", url: sharedUrl, title: "第 2 集" },
    playback: null,
    members: [{ id: "self", name: "Me" }],
  };
}

function createToast(): SharedVideoToastPayload {
  return {
    key: "toast-1",
    actorId: "self",
    title: "第 2 集",
    videoUrl: sharedUrl,
  };
}

test("room state controller shows an auto-continue toast for the local sharer's pending auto-share", () => {
  setLocaleForTests("zh-CN");
  const shownToasts: string[] = [];
  const { controller, runtimeState } = createController(shownToasts);
  // The sharer autoplayed to the next episode and is auto-sharing it.
  runtimeState.pendingAutoShareTargetUrl = sharedUrl;

  controller.maybeShowSharedVideoToast(createToast(), createState());

  assert.deepEqual(shownToasts, ["已自动连播并共享下一个视频：第 2 集"]);
  setLocaleForTests(null);
});

test("room state controller stays silent for the local sharer's manual share", () => {
  setLocaleForTests("zh-CN");
  const shownToasts: string[] = [];
  const { controller, runtimeState } = createController(shownToasts);
  // No pending auto-share: this is a manual self-share.
  runtimeState.pendingAutoShareTargetUrl = null;

  controller.maybeShowSharedVideoToast(createToast(), createState());

  assert.deepEqual(shownToasts, []);
  setLocaleForTests(null);
});
