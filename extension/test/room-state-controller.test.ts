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
  const hydrationRetries: Array<number | undefined> = [];
  let hydrationResets = 0;
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
    scheduleHydrationRetry: (delayMs) => {
      hydrationRetries.push(delayMs);
    },
    resetHydrationRetry: () => {
      hydrationResets += 1;
    },
  });
  return {
    controller,
    runtimeState,
    hydrationRetries,
    hydrationResetCount: () => hydrationResets,
  };
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

test("switching rooms clears the previous room's hydration backoff", () => {
  // Both hydration backoff streaks measure how long *this* room's wait has been
  // failing, and the retry timer belongs to it too. Carried into a new room they
  // either stretch the 150ms bootstrap retry below to the ceiling, or make the
  // single-timer guard refuse it outright — leaving the new room behind the
  // hydration gate with broadcasts suppressed and a pause held (#229).
  const harness = createController([]);

  harness.controller.handleSyncStatus({
    roomCode: "ROOM01",
    connected: true,
    memberId: "self",
    rttMs: 10,
  });
  assert.equal(
    harness.hydrationResetCount(),
    0,
    "the first room is not a switch",
  );
  assert.deepEqual(harness.hydrationRetries, [150]);

  harness.runtimeState.hasReceivedInitialRoomState = true;
  harness.controller.handleSyncStatus({
    roomCode: "ROOM02",
    connected: true,
    memberId: "self",
    rttMs: 10,
  });

  assert.equal(
    harness.hydrationResetCount(),
    1,
    "a room switch must clear the previous room's retry state",
  );
  assert.deepEqual(
    harness.hydrationRetries,
    [150, 150],
    "and the new room still gets its bootstrap retry",
  );
});

test("leaving a room clears the hydration backoff for the next one", () => {
  // `roomChanged` needs both codes non-null, but leaving then joining reports
  // `ROOM01 -> null -> ROOM02`: neither call satisfies it, so without a reset on
  // the clearing path the old room's timer and streaks survive into the new
  // room and its 150ms bootstrap retry is stretched or refused outright (#229).
  const harness = createController([]);

  harness.controller.handleSyncStatus({
    roomCode: "ROOM01",
    connected: true,
    memberId: "self",
    rttMs: 10,
  });
  assert.equal(harness.hydrationResetCount(), 0);

  harness.controller.handleSyncStatus({
    roomCode: null,
    connected: true,
    memberId: null,
    rttMs: null,
  });
  assert.equal(
    harness.hydrationResetCount(),
    1,
    "leaving must clear the retry state, since the later join will not",
  );

  harness.controller.handleSyncStatus({
    roomCode: "ROOM02",
    connected: true,
    memberId: "self",
    rttMs: 10,
  });
  assert.equal(
    harness.hydrationResetCount(),
    1,
    "the join itself is not a switch, so it adds no further reset",
  );
  assert.deepEqual(
    harness.hydrationRetries,
    [150, 150],
    "and the new room still gets its bootstrap retry",
  );
});

// The natural-end marker's validity window is wider than Bilibili's next-video
// countdown (`SHARED_VIDEO_NATURAL_END_WINDOW_MS`, #236), so what keeps a stale
// end from being read as the new room's autoplay is that leaving/switching wipes
// it — not that it expires quickly. These two guard that wipe at the real entry
// point; without them the room-scoped cleanup could stop clearing these fields
// and only an integration-level bug would reveal it.
function seedNaturalEndMarker(
  runtimeState: ReturnType<typeof createContentRuntimeState>,
): void {
  runtimeState.activeSharedUrl = sharedUrl;
  runtimeState.activeSharedByMemberId = "self";
  runtimeState.sharedVideoNaturalEndUrl = sharedUrl;
  runtimeState.sharedVideoNaturalEndAt = 9_000;
}

function assertNaturalEndMarkerCleared(
  runtimeState: ReturnType<typeof createContentRuntimeState>,
  context: string,
): void {
  assert.equal(
    runtimeState.sharedVideoNaturalEndUrl,
    null,
    `${context} must clear the natural-end URL`,
  );
  assert.equal(
    runtimeState.sharedVideoNaturalEndAt,
    0,
    `${context} must clear the natural-end timestamp`,
  );
}

test("switching rooms clears the shared video's natural-end marker", () => {
  const harness = createController([]);

  harness.controller.handleSyncStatus({
    roomCode: "ROOM01",
    connected: true,
    memberId: "self",
    rttMs: 10,
  });
  seedNaturalEndMarker(harness.runtimeState);
  harness.runtimeState.hasReceivedInitialRoomState = true;

  harness.controller.handleSyncStatus({
    roomCode: "ROOM02",
    connected: true,
    memberId: "self",
    rttMs: 10,
  });

  assertNaturalEndMarkerCleared(harness.runtimeState, "a room switch");
});

test("leaving a room clears the shared video's natural-end marker", () => {
  const harness = createController([]);

  harness.controller.handleSyncStatus({
    roomCode: "ROOM01",
    connected: true,
    memberId: "self",
    rttMs: 10,
  });
  seedNaturalEndMarker(harness.runtimeState);

  harness.controller.handleSyncStatus({
    roomCode: null,
    connected: true,
    memberId: null,
    rttMs: null,
  });

  assertNaturalEndMarkerCleared(harness.runtimeState, "leaving a room");
});
