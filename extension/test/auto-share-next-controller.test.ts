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
          targetNormalizedUrl: "https://www.bilibili.com/video/BV1NextVideo",
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
        targetNormalizedUrl: "https://www.bilibili.com/video/BV1NextVideo",
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

test("auto-share next controller retry does not cancel a newer navigation's pending request", async () => {
  const windowHarness = installWindowStub();
  let currentUrl = "https://www.bilibili.com/video/BV1FirstVideo";
  const sentMessages: unknown[] = [];
  let resolveFirst: ((value: { ok: boolean }) => void) | null = null;
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    retryDelayMs: 300,
    maxAttempts: 4,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      if (sentMessages.length === 1) {
        return await new Promise<{ ok: boolean }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { ok: true };
    },
    debugLog: () => {},
  });

  try {
    // First navigation settles and starts an in-flight (awaiting) request.
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1FirstVideo",
    });
    windowHarness.runTimers();
    await Promise.resolve();
    assert.equal(sentMessages.length, 1);

    // A newer navigation arrives while the first request is still awaiting and
    // arms its own settle timer.
    currentUrl = "https://www.bilibili.com/video/BV1SecondVideo";
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1SecondVideo",
    });
    assert.equal(windowHarness.timers.size, 1);

    // The first (now stale) request fails. Its retry must not cancel the newer
    // navigation's pending timer.
    resolveFirst?.({ ok: false });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(windowHarness.timers.size, 1);

    // The surviving timer belongs to the second video and shares it.
    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sentMessages.length, 2);
    assert.deepEqual(sentMessages[1], {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
        targetNormalizedUrl: "https://www.bilibili.com/video/BV1SecondVideo",
      },
    });
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller supersedes an in-flight request when a new navigation returns to the same target", async () => {
  const windowHarness = installWindowStub();
  let currentUrl = "https://www.bilibili.com/video/BV1FirstVideo";
  const sentMessages: unknown[] = [];
  let resolveFirst: ((value: { ok: boolean }) => void) | null = null;
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    retryDelayMs: 300,
    maxAttempts: 4,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      if (sentMessages.length === 1) {
        return await new Promise<{ ok: boolean }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { ok: true };
    },
    debugLog: () => {},
  });

  try {
    // Sharer autoplays A→B; B's request settles and starts an in-flight send.
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1FirstVideo",
    });
    windowHarness.runTimers();
    await Promise.resolve();
    assert.equal(sentMessages.length, 1);

    // The page autoplays on to C and then back to B while B's request is still
    // awaiting. The return-to-B navigation must NOT be dropped as a duplicate —
    // it supersedes the stale in-flight request with a fresh round.
    currentUrl = "https://www.bilibili.com/video/BV1SecondVideo";
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1SecondVideo",
    });
    currentUrl = "https://www.bilibili.com/video/BV1FirstVideo";
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1FirstVideo",
    });

    // The original B request resolves but is now stale and abandons itself.
    resolveFirst?.({ ok: false });
    await Promise.resolve();
    await Promise.resolve();

    // The freshest round (back to B) is the only pending timer and shares B.
    assert.equal(windowHarness.timers.size, 1);
    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(sentMessages.length, 2);
    assert.deepEqual(sentMessages[1], {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
        targetNormalizedUrl: "https://www.bilibili.com/video/BV1FirstVideo",
      },
    });
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller re-sends the same target after a superseded request bails and the page moves on", async () => {
  const windowHarness = installWindowStub();
  let currentUrl = "https://www.bilibili.com/video/BV1FirstVideo";
  const sentMessages: unknown[] = [];
  let resolveFirst: ((value: { ok: boolean }) => void) | null = null;
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    retryDelayMs: 300,
    maxAttempts: 4,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      if (sentMessages.length === 1) {
        return await new Promise<{ ok: boolean }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { ok: true };
    },
    debugLog: () => {},
  });

  try {
    // First navigation to B settles and starts an in-flight request.
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1FirstVideo",
    });
    windowHarness.runTimers();
    await Promise.resolve();
    assert.equal(sentMessages.length, 1);

    // A newer navigation to C supersedes it (bumps the generation) and arms its
    // own settle timer.
    currentUrl = "https://www.bilibili.com/video/BV1SecondVideo";
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1SecondVideo",
    });

    // The stale B request resolves and abandons itself because its generation is
    // stale, leaving no trace that could suppress a future request for B.
    resolveFirst?.({ ok: true });
    await Promise.resolve();
    await Promise.resolve();

    // The page moves on again before the C request runs, so the superseding
    // request bails early without sending.
    currentUrl = "https://www.bilibili.com/video/BV1ThirdVideo";
    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sentMessages.length, 1);

    // The room later returns to B and the sharer autoplays back into it. This
    // legitimate navigation must still schedule and send a fresh request.
    currentUrl = "https://www.bilibili.com/video/BV1FirstVideo";
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1FirstVideo",
    });
    assert.equal(windowHarness.timers.size, 1);
    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(sentMessages.length, 2);
    assert.deepEqual(sentMessages[1], {
      type: "content:auto-share-next-video",
      payload: {
        previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
        targetNormalizedUrl: "https://www.bilibili.com/video/BV1FirstVideo",
      },
    });
  } finally {
    controller.destroy();
    windowHarness.restore();
  }
});

test("auto-share next controller re-shares the same target after the previous request settled", async () => {
  const windowHarness = installWindowStub();
  const currentUrl = "https://www.bilibili.com/video/BV1NextVideo";
  const sentMessages: unknown[] = [];
  const controller = createAutoShareNextController({
    settleDelayMs: 900,
    getCurrentPageUrl: () => currentUrl,
    normalizeVideoPageUrl: normalizeTestVideoPageUrl,
    runtimeSendMessage: async (message) => {
      sentMessages.push(message);
      return { ok: true };
    },
    debugLog: () => {},
  });

  try {
    // The room is on A and the sharer autoplays A→B. The share completes.
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });
    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sentMessages.length, 1);

    // Later the room returns to A and the sharer autoplays A→B again. The
    // settled dedup marker must not suppress this legitimate fresh request.
    controller.scheduleForNavigation({
      previousSharedUrl: "https://www.bilibili.com/video/BV1OldVideo",
      nextNormalizedPageUrl: "https://www.bilibili.com/video/BV1NextVideo",
    });
    assert.equal(windowHarness.timers.size, 1);
    windowHarness.runTimers();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(sentMessages.length, 2);
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
