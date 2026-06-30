import assert from "node:assert/strict";
import test from "node:test";
import { startNavigationSignalListener } from "../src/content/navigation-signal";

function installWindowStub() {
  const originalWindow = globalThis.window;
  const listeners: Array<(event: MessageEvent) => void> = [];
  const windowStub = {
    addEventListener(type: string, handler: (event: MessageEvent) => void) {
      if (type === "message") {
        listeners.push(handler);
      }
    },
    removeEventListener(type: string, handler: (event: MessageEvent) => void) {
      if (type === "message") {
        const index = listeners.indexOf(handler);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      }
    },
  };
  Object.assign(globalThis, { window: windowStub });

  return {
    windowStub,
    dispatch(event: Partial<MessageEvent>) {
      for (const handler of [...listeners]) {
        handler(event as MessageEvent);
      }
    },
    listenerCount: () => listeners.length,
    restore() {
      Object.assign(globalThis, { window: originalWindow });
    },
  };
}

test("startNavigationSignalListener fires only for matching same-window messages", () => {
  const harness = installWindowStub();
  let calls = 0;
  try {
    startNavigationSignalListener(() => {
      calls += 1;
    });

    // Wrong type — ignored.
    harness.dispatch({
      source: harness.windowStub as unknown as Window,
      data: { type: "bili-syncplay:festival-video" },
    });
    // Foreign source — ignored.
    harness.dispatch({
      source: {} as Window,
      data: { type: "bili-syncplay:navigation" },
    });
    // Matching signal — fires.
    harness.dispatch({
      source: harness.windowStub as unknown as Window,
      data: { type: "bili-syncplay:navigation" },
    });

    assert.equal(calls, 1);
  } finally {
    harness.restore();
  }
});

test("startNavigationSignalListener unsubscribe removes the listener", () => {
  const harness = installWindowStub();
  let calls = 0;
  try {
    const unsubscribe = startNavigationSignalListener(() => {
      calls += 1;
    });
    assert.equal(harness.listenerCount(), 1);

    unsubscribe();
    assert.equal(harness.listenerCount(), 0);

    harness.dispatch({
      source: harness.windowStub as unknown as Window,
      data: { type: "bili-syncplay:navigation" },
    });
    assert.equal(calls, 0);
  } finally {
    harness.restore();
  }
});
