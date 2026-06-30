import assert from "node:assert/strict";
import test from "node:test";
import {
  isGestureInsidePlayer,
  startUserGestureTracking,
} from "../src/content/gesture-tracker";

class FakeElement {
  constructor(
    private readonly matchedSelectors: Record<string, boolean> = {},
    readonly isContentEditable = false,
  ) {}
  closest(selector: string): FakeElement | null {
    return this.matchedSelectors[selector] ? this : null;
  }
}

const PLAYER_SELECTOR = ".bpx-player-container, #bilibili-player";
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function withElementStub(run: () => void): void {
  const originalElement = (globalThis as { Element?: unknown }).Element;
  (globalThis as { Element?: unknown }).Element = FakeElement;
  try {
    run();
  } finally {
    (globalThis as { Element?: unknown }).Element = originalElement;
  }
}

function fakeEvent(
  type: string,
  target: unknown,
  key?: string,
  repeat = false,
): Event {
  return { type, target, key, repeat } as unknown as Event;
}

test("isGestureInsidePlayer recognises pointer gestures inside the player only", () => {
  withElementStub(() => {
    const inPlayer = new FakeElement({ [PLAYER_SELECTOR]: true });
    const blank = new FakeElement({});
    assert.equal(
      isGestureInsidePlayer(fakeEvent("pointerdown", inPlayer)),
      true,
    );
    assert.equal(isGestureInsidePlayer(fakeEvent("click", blank)), false);
  });
});

test("isGestureInsidePlayer rejects gestures on editable fields even inside the player", () => {
  withElementStub(() => {
    const danmakuInput = new FakeElement({
      [PLAYER_SELECTOR]: true,
      [EDITABLE_SELECTOR]: true,
    });
    assert.equal(
      isGestureInsidePlayer(fakeEvent("click", danmakuInput)),
      false,
    );
  });
});

test("isGestureInsidePlayer rejects non-`false` contenteditable variants (e.g. plaintext-only)", () => {
  withElementStub(() => {
    // A rich danmaku/comment box using contenteditable="plaintext-only" matches
    // the broadened `[contenteditable]:not([contenteditable="false"])` selector.
    const plaintextOnlyBox = new FakeElement({
      [PLAYER_SELECTOR]: true,
      [EDITABLE_SELECTOR]: true,
    });
    assert.equal(
      isGestureInsidePlayer(fakeEvent("keydown", plaintextOnlyBox, " ")),
      false,
    );
  });
});

test("isGestureInsidePlayer rejects targets that inherit editability", () => {
  withElementStub(() => {
    // A node nested inside a contenteditable host: no selector match on itself,
    // but `isContentEditable` is true.
    const inheritedEditable = new FakeElement(
      { [PLAYER_SELECTOR]: true },
      true,
    );
    assert.equal(
      isGestureInsidePlayer(fakeEvent("keydown", inheritedEditable, "k")),
      false,
    );
  });
});

test("isGestureInsidePlayer treats only play-toggle keys as in-player intent", () => {
  withElementStub(() => {
    const body = new FakeElement({});
    assert.equal(isGestureInsidePlayer(fakeEvent("keydown", body, " ")), true);
    assert.equal(isGestureInsidePlayer(fakeEvent("keydown", body, "k")), true);
    assert.equal(
      isGestureInsidePlayer(fakeEvent("keydown", body, "Escape")),
      false,
    );
  });
});

test("isGestureInsidePlayer ignores auto-repeat keydowns from a held play key", () => {
  withElementStub(() => {
    const body = new FakeElement({});
    // First discrete press counts; the auto-repeat events while held do not, so a
    // single held press cannot keep refreshing the in-player gesture timestamp.
    assert.equal(
      isGestureInsidePlayer(fakeEvent("keydown", body, " ", false)),
      true,
    );
    assert.equal(
      isGestureInsidePlayer(fakeEvent("keydown", body, " ", true)),
      false,
    );
  });
});

test("isGestureInsidePlayer returns false for a non-element target", () => {
  withElementStub(() => {
    assert.equal(isGestureInsidePlayer(fakeEvent("keydown", null, " ")), false);
  });
});

test("startUserGestureTracking reports whether each gesture was inside the player", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const listeners: Array<{ type: string; handler: (event: Event) => void }> =
    [];
  Object.assign(globalThis, {
    document: {
      addEventListener(type: string, handler: (event: Event) => void) {
        listeners.push({ type, handler });
      },
    },
    window: {
      addEventListener(type: string, handler: (event: Event) => void) {
        listeners.push({ type, handler });
      },
    },
  });
  const reports: boolean[] = [];

  try {
    withElementStub(() => {
      startUserGestureTracking((insidePlayer) => {
        reports.push(insidePlayer);
      });
      const clickHandler = listeners.find(
        (entry) => entry.type === "click",
      )?.handler;
      assert.ok(clickHandler);
      clickHandler?.(
        fakeEvent("click", new FakeElement({ [PLAYER_SELECTOR]: true })),
      );
      clickHandler?.(fakeEvent("click", new FakeElement({})));
      const popstateHandler = listeners.find(
        (entry) => entry.type === "popstate",
      )?.handler;
      popstateHandler?.(fakeEvent("popstate", null));
    });

    // in-player click → true, blank click → false, popstate → false.
    assert.deepEqual(reports, [true, false, false]);
  } finally {
    Object.assign(globalThis, {
      document: originalDocument,
      window: originalWindow,
    });
  }
});

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
