import assert from "node:assert/strict";
import test from "node:test";
import { createMicrophonePermissionController } from "../src/background/microphone-permission-controller";

function installChromeWindowsStub(): {
  created: unknown[];
  removedListeners: Array<(windowId: number) => void>;
  restore: () => void;
} {
  const previousChrome = (globalThis as unknown as { chrome?: unknown }).chrome;
  const created: unknown[] = [];
  const removedListeners: Array<(windowId: number) => void> = [];

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      getURL(path: string) {
        return `chrome-extension://test/${path}`;
      },
    },
    windows: {
      onRemoved: {
        addListener(listener: (windowId: number) => void) {
          removedListeners.push(listener);
        },
      },
      async create(options: unknown) {
        created.push(options);
        return { id: 101 };
      },
    },
  };

  return {
    created,
    removedListeners,
    restore() {
      (globalThis as unknown as { chrome?: unknown }).chrome = previousChrome;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("microphone permission controller opens a visible permission window and resolves grant", async () => {
  const chromeStub = installChromeWindowsStub();
  const logs: string[] = [];
  try {
    const controller = createMicrophonePermissionController({
      log: (message) => logs.push(message),
      timeoutMs: 1000,
    });
    const permissionPromise = controller.ensurePermission();

    await flushMicrotasks();

    assert.equal(chromeStub.created.length, 1);
    assert.equal(
      controller.handlePermissionResult({
        type: "voice-permission:result",
        requestId: new URL(
          (chromeStub.created[0] as { url: string }).url,
        ).searchParams.get("requestId")!,
        granted: true,
      }),
      true,
    );
    assert.deepEqual(await permissionPromise, { granted: true });
    assert.match(logs.join("\n"), /Microphone permission granted/);
  } finally {
    chromeStub.restore();
  }
});

test("microphone permission controller resolves denial when the permission window closes", async () => {
  const chromeStub = installChromeWindowsStub();
  try {
    const controller = createMicrophonePermissionController({
      log: () => undefined,
      timeoutMs: 1000,
    });
    const permissionPromise = controller.ensurePermission();

    await flushMicrotasks();
    chromeStub.removedListeners[0]?.(101);

    assert.deepEqual(await permissionPromise, {
      granted: false,
      error: "Microphone permission window was closed.",
    });
  } finally {
    chromeStub.restore();
  }
});
