import assert from "node:assert/strict";
import test from "node:test";
import { createContentRuntimeState } from "../src/content/runtime-state";
import { createPlaybackBindingController } from "../src/content/playback-binding-controller";

type ListenerMap = Map<string, EventListener>;

function installDomStub() {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const listeners: ListenerMap = new Map();

  const video = {
    paused: false,
    addEventListener(type: string, listener: EventListener) {
      listeners.set(type, listener);
    },
  } as unknown as HTMLVideoElement;

  Object.assign(globalThis, {
    document: {
      querySelector(selector: string) {
        return selector === "video" ? video : null;
      },
    },
    window: {
      setTimeout() {
        return 1;
      },
      setInterval() {
        return 1;
      },
    },
  });

  return {
    video,
    listeners,
    restore() {
      Object.assign(globalThis, {
        document: originalDocument,
        window: originalWindow,
      });
    },
  };
}

test("playback binding controller forwards ratechange event source", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 1_000;
  const events: string[] = [];

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_100,
  });

  try {
    controller.attachPlaybackListeners();
    const listener = dom.listeners.get("ratechange");
    assert.notEqual(listener, undefined);

    listener!(new Event("ratechange"));

    await Promise.resolve();

    assert.deepEqual(events, ["ratechange"]);
    assert.deepEqual(runtimeState.lastExplicitUserAction, {
      kind: "ratechange",
      at: 1_100,
    });
  } finally {
    dom.restore();
  }
});

test("playback binding controller cancels active soft apply on pause and seek", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 1_000;
  const reasons: string[] = [];

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: (_video, reason) => {
      reasons.push(reason);
    },
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_100,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("pause")?.(new Event("pause"));
    dom.listeners.get("seeking")?.(new Event("seeking"));
    dom.listeners.get("seeked")?.(new Event("seeked"));

    assert.deepEqual(reasons, ["pause", "seek", "seek"]);
  } finally {
    dom.restore();
  }
});

test("playback binding controller does not cancel active soft apply for programmatic pause and seek events", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 0;
  const reasons: string[] = [];

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: (_video, reason) => {
      reasons.push(reason);
    },
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 2_500,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("pause")?.(new Event("pause"));
    dom.listeners.get("seeking")?.(new Event("seeking"));
    dom.listeners.get("seeked")?.(new Event("seeked"));

    assert.deepEqual(reasons, []);
  } finally {
    dom.restore();
  }
});

test("playback binding controller preserves explicit seek intent across immediate playing follow-up", () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 1_000;
  let now = 1_100;

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => null,
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async () => {},
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => now,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("seeking")?.(new Event("seeking"));
    now = 1_150;
    dom.listeners.get("playing")?.(new Event("playing"));

    assert.deepEqual(runtimeState.lastExplicitUserAction, {
      kind: "seek",
      at: 1_100,
    });
  } finally {
    dom.restore();
  }
});

test("playback binding controller does not mark programmatic ratechange as explicit user action", async () => {
  const dom = installDomStub();
  const runtimeState = createContentRuntimeState();
  runtimeState.lastUserGestureAt = 1_000;
  runtimeState.programmaticApplyUntil = 1_800;
  runtimeState.programmaticApplySignature = {
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
    playState: "playing",
    currentTime: 12.4,
    playbackRate: 1.11,
  };
  dom.video.playbackRate = 1.11;
  const events: string[] = [];

  const controller = createPlaybackBindingController({
    runtimeState,
    videoBindIntervalMs: 250,
    userGestureGraceMs: 1_200,
    initialRoomStatePauseHoldMs: 3_000,
    getSharedVideo: () => ({
      videoId: "BV1xx411c7mD:p1",
      url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
      title: "Video",
    }),
    hasRecentRemoteStopIntent: () => false,
    normalizeUrl: (url) => url ?? null,
    getLastBroadcastAt: () => 0,
    broadcastPlayback: async (_video, eventSource) => {
      events.push(eventSource ?? "manual");
    },
    cancelActiveSoftApply: () => {},
    maintainActiveSoftApply: () => {},
    applyPendingPlaybackApplication: () => {},
    activatePauseHold: () => {},
    debugLog: () => {},
    getNow: () => 1_100,
  });

  try {
    controller.attachPlaybackListeners();
    dom.listeners.get("ratechange")?.(new Event("ratechange"));

    await Promise.resolve();

    assert.deepEqual(events, ["ratechange"]);
    assert.equal(runtimeState.lastExplicitUserAction, null);
  } finally {
    dom.restore();
  }
});
