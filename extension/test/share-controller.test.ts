import assert from "node:assert/strict";
import test from "node:test";
import {
  createShareController,
  shouldIncludePlaybackInSharePayload,
} from "../src/content/share-controller";
import { createContentRuntimeState } from "../src/content/runtime-state";

function installDomStub(args: {
  href: string;
  pathname: string;
  title: string;
  video?: HTMLVideoElement | null;
}): { restore: () => void } {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  Object.assign(globalThis, {
    window: {
      location: {
        href: args.href,
        pathname: args.pathname,
      },
      setTimeout,
    },
    document: {
      title: args.title,
      querySelector(selector: string) {
        if (selector === "video") {
          return args.video ?? null;
        }
        return null;
      },
    },
  });

  return {
    restore() {
      Object.assign(globalThis, {
        window: originalWindow,
        document: originalDocument,
      });
    },
  };
}

test("includes playback snapshot when not switching the room shared video", () => {
  assert.equal(
    shouldIncludePlaybackInSharePayload({
      activeRoomCode: "ROOM01",
      activeSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
      nextSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
    }),
    true,
  );
});

test("includes playback snapshot when switching to a different shared video in-room", () => {
  assert.equal(
    shouldIncludePlaybackInSharePayload({
      activeRoomCode: "ROOM01",
      activeSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
      nextSharedUrl: "https://www.bilibili.com/video/BV199W9zEEcH",
    }),
    true,
  );
});

test("keeps playback snapshot outside of a room", () => {
  assert.equal(
    shouldIncludePlaybackInSharePayload({
      activeRoomCode: null,
      activeSharedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
      nextSharedUrl: "https://www.bilibili.com/video/BV199W9zEEcH",
    }),
    true,
  );
});

test("share controller keeps playback snapshot while switching to another shared video in-room", () => {
  const dom = installDomStub({
    href: "https://www.bilibili.com/video/BV199W9zEEcH",
    pathname: "/video/BV199W9zEEcH",
    title: "New Video_哔哩哔哩",
    video: {
      currentTime: 95.03,
      playbackRate: 1.08,
      paused: false,
      readyState: 4,
    } as HTMLVideoElement,
  });

  const runtimeState = createContentRuntimeState();
  runtimeState.activeRoomCode = "ROOM01";
  runtimeState.activeSharedUrl = "https://www.bilibili.com/video/BV1xx411c7mD";
  runtimeState.intendedPlayState = "playing";

  const debugLogs: string[] = [];
  const controller = createShareController({
    runtimeState,
    festivalSnapshotTtlMs: 1_200,
    nextSeq: () => 7,
    getFestivalSnapshot: () => null,
    refreshFestivalBridge: async () => null,
    debugLog: (message) => {
      debugLogs.push(message);
    },
  });

  try {
    const payload = controller.getCurrentSharePayload();

    assert.ok(payload);
    assert.equal(
      payload?.video.url,
      "https://www.bilibili.com/video/BV199W9zEEcH",
    );
    assert.equal(payload?.playback?.currentTime, 95.03);
    assert.equal(payload?.playback?.playbackRate, 1.08);
    assert.equal(payload?.playback?.playState, "playing");
    assert.equal(debugLogs.length, 0);
  } finally {
    dom.restore();
  }
});
