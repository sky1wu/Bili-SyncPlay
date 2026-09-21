import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  isBackgroundPopupStateMessage,
  type PopupToBackgroundMessage,
} from "../src/shared/messages";
import type { PersistedProfileState } from "../src/shared/storage";

const DEFAULT_URL = "wss://default.example/";
const CUSTOM_URL = "wss://custom.example/";
const profile: PersistedProfileState = {
  serverUrl: CUSTOM_URL,
  displayName: "Saved name",
  pageShareButtonEnabled: false,
};
const bundles = await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["src/background/index.ts", "src/popup/index.ts"],
  outdir: "unused",
  bundle: true,
  write: false,
  format: "iife",
  define: { __BILI_SYNCPLAY_DEFAULT_SERVER_URL__: JSON.stringify(DEFAULT_URL) },
});
const [backgroundCode, popupCode] = bundles.outputFiles.map(
  (file) => file.text,
);

function createEvent<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>();
  return {
    addListener: (listener: (...args: Args) => void) => listeners.add(listener),
    removeListener: (listener: (...args: Args) => void) =>
      listeners.delete(listener),
    emit: (...args: Args) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class ElementStub {
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  textContent = "";
  className = "";
  childNodes: ElementStub[] = [];
  classList = { toggle: () => {}, add: () => {}, remove: () => {} };
  private listeners = new Map<string, () => void>();

  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }
  click(): void {
    this.listeners.get("click")?.();
  }
  append(...nodes: ElementStub[]): void {
    this.childNodes.push(...nodes);
  }
  replaceChildren(...nodes: ElementStub[]): void {
    this.childNodes = nodes;
  }
}

function createHarness() {
  const storedProfile = deferred<Record<string, PersistedProfileState>>();
  const profileWrites: unknown[] = [];
  const socketUrls: string[] = [];
  const runtime = {
    onMessage: createEvent<[unknown, object, (response: unknown) => void]>(),
    onConnect: createEvent<[object]>(),
    getURL: () => "chrome-extension://test/",
  };
  const chrome = {
    runtime,
    storage: {
      local: {
        get: () => storedProfile.promise,
        set: async (value: unknown) => {
          profileWrites.push(structuredClone(value));
        },
      },
      session: { get: async () => ({}), set: async () => {} },
    },
    tabs: {
      onRemoved: createEvent<[number]>(),
      query: async () => [],
      sendMessage: async () => {},
    },
    alarms: { onAlarm: createEvent<[object]>(), create: () => {} },
  };
  class SocketStub {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = SocketStub.CONNECTING;
    constructor(url: string) {
      socketUrls.push(url);
    }
    addEventListener(): void {}
    send(): void {}
    close(): void {}
  }
  const globals = {
    URL,
    performance,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    self: { setTimeout, clearTimeout, setInterval, clearInterval },
  };
  runInContext(
    backgroundCode,
    createContext({
      ...globals,
      chrome,
      WebSocket: SocketStub,
      fetch: async () => ({
        ok: true,
        json: async () => ({ data: { websocketAllowed: true } }),
      }),
    }),
  );

  function request(message: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      runtime.onMessage.emit(message, {}, (response) =>
        resolve(structuredClone(response)),
      );
    });
  }

  function openPopup(queryReply?: Promise<unknown>) {
    const elements = new Map<string, ElementStub>([["app", new ElementStub()]]);
    const messages: unknown[] = [];
    let disconnected = false;
    const onDisconnect = createEvent<[]>();
    const onMessage = createEvent<[unknown]>();
    const port = {
      name: "popup-state",
      onDisconnect,
      onMessage,
      disconnect: () => {
        disconnected = true;
        onDisconnect.emit();
      },
      postMessage: (message: unknown) => {
        assert.equal(disconnected, false, "must not publish to a closed popup");
        const snapshot = structuredClone(message);
        messages.push(snapshot);
        queueMicrotask(() => onMessage.emit(snapshot));
      },
    };
    const document = {
      documentElement: { lang: "" },
      title: "",
      activeElement: null,
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: () => new ElementStub(),
      importNode: (node: ElementStub) => node,
    };
    class ParserStub {
      parseFromString(html: string) {
        for (const match of html.matchAll(/id="([^"]+)"/g)) {
          elements.set(match[1], new ElementStub());
        }
        return { body: { childNodes: [...elements.values()] } };
      }
    }
    runInContext(
      popupCode,
      createContext({
        ...globals,
        document,
        DOMParser: ParserStub,
        chrome: {
          runtime: {
            sendMessage: (message: PopupToBackgroundMessage) =>
              message.type === "popup:get-state" && queryReply
                ? queryReply
                : request(message),
            connect: () => {
              queueMicrotask(() => runtime.onConnect.emit(port));
              return port;
            },
          },
        },
      }),
    );
    return {
      messages,
      close: port.disconnect,
      mounted: () => elements.has("server-url"),
      element(id: string): ElementStub {
        const element = elements.get(id);
        assert.ok(element, `missing element ${id}`);
        return element;
      },
      snapshots: () => messages.filter(isBackgroundPopupStateMessage),
    };
  }

  return { storedProfile, profileWrites, socketUrls, request, openPopup };
}

test("cold popup publishes restored settings before exposing Save or room actions", async () => {
  const harness = createHarness();
  const popup = harness.openPopup();
  await flush();
  assert.equal(popup.mounted(), false);
  assert.equal(popup.snapshots().length, 0);

  harness.storedProfile.resolve({ "bili-syncplay-profile": profile });
  await flush();
  assert.equal(popup.element("server-url").value, CUSTOM_URL);
  assert.equal(popup.element("page-share-button-enabled").checked, false);
  assert.ok(popup.snapshots().length > 0);
  assert.ok(
    popup.snapshots().every((state) => state.payload.serverUrl === CUSTOM_URL),
  );

  popup.element("save-server-url").click();
  await flush();
  assert.deepEqual(
    harness.profileWrites,
    [],
    "saving an unchanged address must not overwrite the profile",
  );
  popup.element("create-room").click();
  await flush();
  assert.deepEqual(harness.socketUrls, [CUSTOM_URL]);
});

test("popup state queries wait for storage even without a port", async () => {
  const harness = createHarness();
  let response: unknown;
  const query = harness.request({ type: "popup:get-state" }).then((value) => {
    response = value;
  });
  await flush();
  assert.equal(response, undefined);
  harness.storedProfile.resolve({ "bili-syncplay-profile": profile });
  await query;
  assert.ok(isBackgroundPopupStateMessage(response));
  assert.equal(response.payload.serverUrl, CUSTOM_URL);
  assert.equal(response.payload.pageShareButtonEnabled, false);
});

test("joining from a cold popup connects to the restored server", async () => {
  const harness = createHarness();
  const popup = harness.openPopup();
  await flush();
  harness.storedProfile.resolve({ "bili-syncplay-profile": profile });
  await flush();
  popup.element("room-code").value = "ROOM01:join-token-123456";
  popup.element("join-room").click();
  await flush();
  assert.deepEqual(harness.socketUrls, [CUSTOM_URL]);
});

test("a ready port can render before the query and a late query cannot replace newer settings", async () => {
  const harness = createHarness();
  const queryReply = deferred<unknown>();
  const popup = harness.openPopup(queryReply.promise);
  await flush();
  harness.storedProfile.resolve({ "bili-syncplay-profile": profile });
  await flush();
  assert.equal(popup.element("server-url").value, CUSTOM_URL);

  const olderState = await harness.request({ type: "popup:get-state" });
  await harness.request({
    type: "popup:set-server-url",
    serverUrl: "wss://next.example/",
  });
  await flush();
  queryReply.resolve(olderState);
  await flush();
  assert.equal(popup.element("server-url").value, "wss://next.example/");
});

test("content events and mutations remain rejected while storage is loading", async () => {
  const harness = createHarness();
  for (const message of [
    { type: "popup:create-room" },
    { type: "popup:set-server-url", serverUrl: DEFAULT_URL },
    { type: "content:get-page-share-button-settings" },
  ]) {
    assert.deepEqual(await harness.request(message), {
      ok: false,
      error: "Extension is still initializing.",
    });
  }
  harness.storedProfile.resolve({ "bili-syncplay-profile": profile });
  await flush();
  assert.deepEqual(harness.profileWrites, []);
  assert.deepEqual(harness.socketUrls, []);
});

test("closing a popup during bootstrap does not attach its disconnected port", async () => {
  const harness = createHarness();
  const popup = harness.openPopup();
  await flush();
  popup.close();
  harness.storedProfile.resolve({ "bili-syncplay-profile": profile });
  await flush();
  assert.equal(popup.messages.length, 0);

  const reopened = harness.openPopup();
  await flush();
  assert.equal(reopened.element("server-url").value, CUSTOM_URL);
});

test("bootstrap failure reaches both pending query and popup port", async () => {
  const harness = createHarness();
  const popup = harness.openPopup();
  const query = harness.request({ type: "popup:get-state" });
  await flush();
  harness.storedProfile.reject(new Error("storage unavailable"));
  const response = await query;
  await flush();
  assert.ok(isBackgroundPopupStateMessage(response));
  assert.match(response.payload.error ?? "", /initialization failed/);
  assert.match(
    popup.element("status-message").textContent,
    /initialization failed/,
  );
  assert.ok(
    popup
      .snapshots()
      .some((state) => state.payload.error === response.payload.error),
  );
});

test("a warm popup and later port updates use the current settings", async () => {
  const harness = createHarness();
  harness.storedProfile.resolve({ "bili-syncplay-profile": profile });
  await flush();
  const popup = harness.openPopup();
  await flush();
  assert.equal(popup.element("server-url").value, CUSTOM_URL);
  await harness.request({
    type: "popup:set-server-url",
    serverUrl: "wss://next.example/",
  });
  await flush();
  assert.equal(popup.element("server-url").value, "wss://next.example/");
});

test("a profile with no saved address uses the build default after storage resolves", async () => {
  const harness = createHarness();
  const popup = harness.openPopup();
  harness.storedProfile.resolve({});
  await flush();
  assert.equal(popup.element("server-url").value, DEFAULT_URL);
  assert.equal(popup.element("page-share-button-enabled").checked, true);
});
