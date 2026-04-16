import assert from "node:assert/strict";
import test from "node:test";

type Listener = (event?: unknown) => unknown;

class FakeElement {
  innerHTML = "";
  hidden = false;

  replaceChildren() {}
}

function createDocumentStub() {
  const appRoot = new FakeElement();
  const listeners = new Map<string, Listener[]>();

  return {
    appRoot,
    document: {
      title: "",
      querySelector(selector: string) {
        if (selector === "#app") {
          return appRoot;
        }
        return null;
      },
      querySelectorAll() {
        return [];
      },
      addEventListener(type: string, handler: Listener) {
        const queue = listeners.get(type) ?? [];
        queue.push(handler);
        listeners.set(type, queue);
      },
    },
  };
}

async function loadAdminAppModule() {
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  const originalLocalStorage = globalThis.localStorage;

  Object.assign(globalThis, {
    window: { __ADMIN_UI_CONFIG__: {}, addEventListener() {} },
    location: {
      pathname: "/admin/login",
      search: "",
      origin: "http://localhost",
    },
    localStorage: {
      getItem() {
        return "";
      },
      setItem() {},
      removeItem() {},
    },
  });

  try {
    return await import("../admin-ui/app-runtime.js");
  } finally {
    Object.assign(globalThis, {
      window: originalWindow,
      location: originalLocation,
      localStorage: originalLocalStorage,
    });
  }
}

test("bootstrap redirects unauthenticated admin routes to login", async () => {
  const { createAdminApp } = await loadAdminAppModule();
  const { document, appRoot } = createDocumentStub();
  const navigation: string[] = [];
  const state = {
    demo: false,
    token: "",
    me: null,
    currentRoute: "/overview",
    notice: null,
    dialog: null,
    refreshHandle: null,
    lastOverviewData: null,
    instanceId: "",
    overviewAutoRefresh: true,
  };

  const app = createAdminApp({
    document,
    location: {
      pathname: "/admin/rooms",
      search: "",
      origin: "http://localhost",
    },
    history: {
      pushState() {},
      replaceState(_state: unknown, _title: string, url: string) {
        navigation.push(url);
      },
    },
    navigator: { clipboard: { async writeText() {} } },
    state,
  });

  await app.bootstrap();

  assert.equal(state.currentRoute, "/login");
  assert.deepEqual(navigation, ["/admin/login"]);
  assert.equal(appRoot.innerHTML.includes("登录后台"), true);
});

test("bootstrap redirects authenticated login route to overview", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const dataByPath = {
      "/api/admin/me": {
        id: "admin-1",
        username: "alice",
        role: "admin",
      },
      "/readyz": {
        status: "ready",
        checks: { roomStore: "ok" },
      },
      "/api/admin/overview": {
        service: {
          instanceId: "instance-1",
          name: "bili-syncplay-server",
          version: "1.0.0-test",
          uptimeMs: 1000,
        },
        storage: { provider: "memory", redisConnected: false },
        runtime: {
          connectionCount: 1,
          activeRoomCount: 1,
          activeMemberCount: 1,
        },
        rooms: { totalNonExpired: 1, idle: 0 },
        events: {
          lastMinute: {
            room_created: 0,
            room_joined: 0,
            rate_limited: 0,
            ws_connection_rejected: 0,
          },
          totals: {
            room_created: 0,
            room_joined: 0,
            rate_limited: 0,
            ws_connection_rejected: 0,
          },
        },
      },
    } satisfies Record<string, unknown>;

    const pathname = new URL(url, "http://localhost").pathname;
    return {
      ok: true,
      status: 200,
      headers: {
        get() {
          return "application/json";
        },
      },
      async json() {
        return {
          ok: true,
          data: dataByPath[pathname],
        };
      },
    } as Response;
  };

  try {
    const { createAdminApp } = await loadAdminAppModule();
    const { document, appRoot } = createDocumentStub();
    const navigation: string[] = [];
    const state = {
      demo: false,
      token: "token-1",
      me: null,
      currentRoute: "/overview",
      notice: null,
      dialog: null,
      refreshHandle: null,
      lastOverviewData: null,
      instanceId: "",
      overviewAutoRefresh: false,
    };

    const app = createAdminApp({
      document,
      location: {
        pathname: "/admin/login",
        search: "",
        origin: "http://localhost",
      },
      history: {
        pushState() {},
        replaceState(_state: unknown, _title: string, url: string) {
          navigation.push(url);
        },
      },
      navigator: { clipboard: { async writeText() {} } },
      state,
    });

    await app.bootstrap();
    await waitFor(() => appRoot.innerHTML.includes("连接数"));

    assert.equal(state.currentRoute, "/overview");
    assert.deepEqual(navigation, ["/admin/overview"]);
    assert.deepEqual(state.me, {
      id: "admin-1",
      username: "alice",
      role: "admin",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function waitFor(check: () => boolean, timeoutMs = 200) {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
