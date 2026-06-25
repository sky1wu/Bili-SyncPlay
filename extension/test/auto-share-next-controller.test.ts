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

    assert.deepEqual(sentMessages, [
      {
        type: "content:auto-share-next-video",
        payload: {
          previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
        },
      },
    ]);
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

test("auto-share next controller retries when the background reports the page is not ready", async () => {
  const windowHarness = installWindowStub();
  const sentMessages: unknown[] = [];
  const responses = [{ ok: false }, { ok: true }];
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    retryDelayMs: 300,
    maxAttempts: 4,
    getCurrentPageUrl: () => "https://www.bilibili.com/video/BV1NextVideo",
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      return responses.shift() ?? { ok: true };
    },
    debugLog: () => {},
  });

  try {
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });

    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();
    // A retry timer should have been armed after the first failure.
    assert.equal(windowHarness.timers.size, 1);

    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(sentMessages.length, 2);
    assert.deepEqual(sentMessages[1], {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      },
    });
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller stops retrying after the maximum attempts", async () => {
  const windowHarness = installWindowStub();
  const sentMessages: unknown[] = [];
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    retryDelayMs: 300,
    maxAttempts: 3,
    getCurrentPageUrl: () => "https://www.bilibili.com/video/BV1NextVideo",
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      return { ok: false };
    },
    debugLog: () => {},
  });

  try {
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });

    for (let i = 0; i < 6; i += 1) {
      windowHarness.runTimers();
      await Promise.resolve();
      await Promise.resolve();
    }

    assert.equal(sentMessages.length, 3);
    assert.equal(windowHarness.timers.size, 0);
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
