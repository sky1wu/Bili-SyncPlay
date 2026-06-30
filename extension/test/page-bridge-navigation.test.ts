import assert from "node:assert/strict";
import test from "node:test";
import {
  installHistoryNavigationHooks,
  NAVIGATION_MESSAGE_TYPE,
  type NavigationHookTarget,
} from "../src/content/page-bridge-navigation";

interface PostedMessage {
  message: unknown;
  targetOrigin: string;
}

function createTarget(): {
  target: NavigationHookTarget;
  posted: PostedMessage[];
  pushStateCalls: unknown[][];
  replaceStateCalls: unknown[][];
  firePopstate: () => void;
} {
  const posted: PostedMessage[] = [];
  const pushStateCalls: unknown[][] = [];
  const replaceStateCalls: unknown[][] = [];
  const popstateListeners: Array<() => void> = [];

  const history = {
    pushState(...args: unknown[]) {
      pushStateCalls.push(args);
    },
    replaceState(...args: unknown[]) {
      replaceStateCalls.push(args);
    },
  } as unknown as History;

  const target: NavigationHookTarget = {
    history,
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({ message, targetOrigin });
    },
    addEventListener(type: string, listener: () => void) {
      if (type === "popstate") {
        popstateListeners.push(listener);
      }
    },
  };

  return {
    target,
    posted,
    pushStateCalls,
    replaceStateCalls,
    firePopstate: () => {
      for (const listener of popstateListeners) {
        listener();
      }
    },
  };
}

test("installHistoryNavigationHooks posts a navigation signal on pushState and forwards the call", () => {
  const harness = createTarget();
  installHistoryNavigationHooks(harness.target);

  harness.target.history.pushState({ a: 1 }, "", "/video/BV1");

  assert.deepEqual(harness.pushStateCalls, [[{ a: 1 }, "", "/video/BV1"]]);
  assert.deepEqual(harness.posted, [
    { message: { type: NAVIGATION_MESSAGE_TYPE }, targetOrigin: "*" },
  ]);
});

test("installHistoryNavigationHooks posts a navigation signal on replaceState and popstate", () => {
  const harness = createTarget();
  installHistoryNavigationHooks(harness.target);

  harness.target.history.replaceState(null, "", "/video/BV2");
  harness.firePopstate();

  assert.deepEqual(harness.replaceStateCalls, [[null, "", "/video/BV2"]]);
  assert.equal(harness.posted.length, 2);
  assert.deepEqual(
    harness.posted.map((entry) => entry.message),
    [{ type: NAVIGATION_MESSAGE_TYPE }, { type: NAVIGATION_MESSAGE_TYPE }],
  );
});

test("installHistoryNavigationHooks does not re-wrap on a second install (no duplicate signals)", () => {
  const harness = createTarget();
  installHistoryNavigationHooks(harness.target);
  // A duplicate bridge injection re-runs the installer against the same window.
  installHistoryNavigationHooks(harness.target);

  harness.target.history.pushState(null, "", "/video/BV3");

  // Exactly one signal — the second install was a no-op because the guard flag
  // was already set.
  assert.equal(harness.posted.length, 1);
});

test("installHistoryNavigationHooks swallows postMessage failures", () => {
  const harness = createTarget();
  harness.target.postMessage = () => {
    throw new Error("cross-origin teardown");
  };
  installHistoryNavigationHooks(harness.target);

  assert.doesNotThrow(() => {
    harness.target.history.pushState(null, "", "/video/BV4");
  });
});
