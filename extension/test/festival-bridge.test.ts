import assert from "node:assert/strict";
import test from "node:test";
import { createFestivalBridgeController } from "../src/content/festival-bridge";

interface PageBridgeDetail {
  epId?: string | number;
  bvid?: string;
  cid?: string | number;
  title?: string;
}

function installBridgeDomStub(details: Array<PageBridgeDetail | null>): {
  restore: () => void;
} {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  let listener: EventListener | null = null;
  const pendingTimeouts = new Map<number, boolean>();
  let timeoutSeq = 0;

  const windowStub = {
    setTimeout(callback: () => void) {
      const id = (timeoutSeq += 1);
      pendingTimeouts.set(id, true);
      queueMicrotask(() => {
        if (pendingTimeouts.get(id)) {
          callback();
        }
      });
      return id;
    },
    clearTimeout(id: number) {
      pendingTimeouts.set(id, false);
    },
    addEventListener(_type: string, nextListener: EventListener) {
      listener = nextListener;
    },
    removeEventListener(_type: string, nextListener: EventListener) {
      if (listener === nextListener) {
        listener = null;
      }
    },
    postMessage(message: { requestId?: string }) {
      const detail = details.shift();
      if (!detail || !listener) {
        return;
      }
      listener({
        source: windowStub,
        data: {
          type: "bili-syncplay:festival-video",
          requestId: message.requestId,
          detail,
        },
      } as MessageEvent);
    },
  };

  Object.assign(globalThis, {
    window: windowStub,
    document: {
      createElement() {
        return { dataset: {} };
      },
      head: {
        appendChild() {
          return undefined;
        },
      },
      documentElement: {
        appendChild() {
          return undefined;
        },
      },
    },
    chrome: {
      runtime: {
        getURL(path: string) {
          return path;
        },
      },
    },
  });

  return {
    restore() {
      Object.assign(globalThis, {
        window: originalWindow,
        document: originalDocument,
        chrome: originalChrome,
      });
    },
  };
}

test("festival bridge does not reuse cached bangumi snapshot on festival page", async () => {
  const dom = installBridgeDomStub([
    {
      epId: 508404,
      cid: 987654,
      title: "第46话",
    },
    null,
  ]);
  const controller = createFestivalBridgeController();

  try {
    const bangumiSnapshot = await controller.refreshSnapshot({
      pathname: "/bangumi/play/ss357",
      pageUrl: "https://www.bilibili.com/bangumi/play/ss357",
      maxAgeMs: 0,
    });
    assert.equal(bangumiSnapshot?.videoId, "ep508404");

    const festivalSnapshot = await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
      maxAgeMs: 60_000,
    });

    assert.equal(festivalSnapshot, null);
  } finally {
    dom.restore();
  }
});

test("festival bridge reuses cached festival snapshot for the same festival page", async () => {
  const dom = installBridgeDomStub([
    {
      bvid: "BVfestival",
      cid: 123,
      title: "Festival Episode",
    },
  ]);
  const controller = createFestivalBridgeController();

  try {
    const firstSnapshot = await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
      maxAgeMs: 0,
    });
    const cachedSnapshot = await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
      maxAgeMs: 60_000,
    });

    assert.deepEqual(cachedSnapshot, {
      videoId: firstSnapshot?.videoId,
      url: firstSnapshot?.url,
      title: firstSnapshot?.title,
    });
  } finally {
    dom.restore();
  }
});

test("festival bridge reuses cached festival snapshot across trailing slash path variants", async () => {
  const dom = installBridgeDomStub([
    {
      bvid: "BVfestival",
      cid: 123,
      title: "Festival Episode",
    },
  ]);
  const controller = createFestivalBridgeController();

  try {
    const firstSnapshot = await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
      maxAgeMs: 0,
    });
    const cachedSnapshot = await controller.refreshSnapshot({
      pathname: "/festival/demo/",
      pageUrl: "https://www.bilibili.com/festival/demo/",
      maxAgeMs: 60_000,
    });

    assert.deepEqual(cachedSnapshot, {
      videoId: firstSnapshot?.videoId,
      url: firstSnapshot?.url,
      title: firstSnapshot?.title,
    });
  } finally {
    dom.restore();
  }
});

test("festival bridge does not fall back to another festival page snapshot", async () => {
  const dom = installBridgeDomStub([
    {
      bvid: "BVfestival",
      cid: 123,
      title: "Festival Episode",
    },
    null,
  ]);
  const controller = createFestivalBridgeController();

  try {
    const firstSnapshot = await controller.refreshSnapshot({
      pathname: "/festival/demo",
      pageUrl: "https://www.bilibili.com/festival/demo",
      maxAgeMs: 0,
    });
    assert.equal(firstSnapshot?.videoId, "BVfestival:123");

    const nextSnapshot = await controller.refreshSnapshot({
      pathname: "/festival/other",
      pageUrl: "https://www.bilibili.com/festival/other",
      maxAgeMs: 0,
    });

    assert.equal(nextSnapshot, null);
  } finally {
    dom.restore();
  }
});
