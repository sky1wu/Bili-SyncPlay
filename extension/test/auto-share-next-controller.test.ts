import assert from "node:assert/strict";
import test from "node:test";
import { createAutoShareNextController } from "../src/content/auto-share-next-controller";

function normalizeTestVideoPageUrl(url: string): string | null {
  return url.match(/https:\/\/www\.bilibili\.com\/video\/[^/?]+/)?.[0] ?? null;
}

function installWindowStub() {
  const originalWindow = globalThis.window;
  const timers = new Map<number, () => void>();
  let nextTimer = 1;

  Object.assign(globalThis, {
    window: {
      setTimeout(callback: () => void) {
        const timer = nextTimer;
        nextTimer += 1;
        timers.set(timer, callback);
        return timer;
      },
      clearTimeout(timer: number) {
        timers.delete(timer);
      },
    },
  });

  return {
    timers,
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) {
        callback();
      }
    },
    restore() {
      Object.assign(globalThis, { window: originalWindow });
    },
  };
}

test("auto-share next controller sends a request after the navigation settles", async () => {
  const windowHarness = installWindowStub();
  let currentUrl = "https://www.bilibili.com/video/BV1NextVideo";
  const sentMessages: unknown[] = [];
  const debugLogs: string[] = [];
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
    debugLog: (message) => {
      debugLogs.push(message);
    },
  });

  try {
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });

    assert.equal(windowHarness.timers.size, 1);
    windowHarness.runTimers();
    await Promise.resolve();

    assert.deepEqual(sentMessages, [{ type: "content:auto-share-next-video" }]);
    assert.deepEqual(debugLogs, []);
  } finally {
    currentUrl = "";
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller skips a settled request when the page moved again", async () => {
  const windowHarness = installWindowStub();
  let currentUrl = "https://www.bilibili.com/video/BV1NextVideo";
  const sentMessages: unknown[] = [];
  const debugLogs: string[] = [];
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
    debugLog: (message) => {
      debugLogs.push(message);
    },
  });

  try {
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });
    currentUrl = "https://www.bilibili.com/video/BV1OtherVideo";
    windowHarness.runTimers();
    await Promise.resolve();

    assert.deepEqual(sentMessages, []);
    assert.equal(debugLogs.length, 1);
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller deduplicates repeated requests for the same target", () => {
  const windowHarness = installWindowStub();
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    getCurrentPageUrl: () => "https://www.bilibili.com/video/BV1NextVideo",
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async () => ({ ok: true }),
    debugLog: () => {},
  });

  try {
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });

    assert.equal(windowHarness.timers.size, 1);
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});
