import assert from "node:assert/strict";
import test from "node:test";
import { startUserGestureTracking } from "../src/content/gesture-tracker";

interface RegisteredListener {
  type: string;
  handler: (event: Event) => void;
}

function installEventTargetStubs() {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const documentListeners: RegisteredListener[] = [];
  const windowListeners: RegisteredListener[] = [];

  Object.assign(globalThis, {
    document: {
      addEventListener(type: string, handler: (event: Event) => void) {
        documentListeners.push({ type, handler });
      },
    },
    window: {
      addEventListener(type: string, handler: (event: Event) => void) {
        windowListeners.push({ type, handler });
      },
    },
  });

  return {
    documentListeners,
    windowListeners,
    restore() {
      Object.assign(globalThis, {
        document: originalDocument,
        window: originalWindow,
      });
    },
  };
}

test("startUserGestureTracking treats browser history popstate as a user gesture", () => {
  const stubs = installEventTargetStubs();
  let gestures = 0;

  try {
    startUserGestureTracking(() => {
      gestures += 1;
    });

    const popstateListener = stubs.windowListeners.find(
      (listener) => listener.type === "popstate",
    );
    assert.ok(
      popstateListener,
      "expected a popstate listener on window for back/forward navigation",
    );

    // popstate is only registered on window, never on document.
    assert.equal(
      stubs.documentListeners.some((listener) => listener.type === "popstate"),
      false,
    );

    popstateListener?.handler(new Event("popstate"));
    assert.equal(gestures, 1);
  } finally {
    stubs.restore();
  }
});
