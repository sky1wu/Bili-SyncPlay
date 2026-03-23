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
