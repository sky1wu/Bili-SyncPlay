import assert from "node:assert/strict";
import test from "node:test";
import { createTabController } from "../src/background/tab-controller";
import { createBackgroundRuntimeState } from "../src/background/runtime-state";

function createController() {
  const state = createBackgroundRuntimeState();
  const controller = createTabController({
    roomSessionState: state.room,
    shareState: state.share,
    log: () => {},
    normalizeUrl: (url) => url ?? null,
    bilibiliVideoUrlPatterns: [],
  });
  return { controller, shareState: state.share };
}

test("reclaimSharedSourceTabIfUnclaimed claims an unbound source tab", () => {
  const { controller, shareState } = createController();
  shareState.sharedTabId = null;

  assert.equal(controller.reclaimSharedSourceTabIfUnclaimed(42), true);
  assert.equal(shareState.sharedTabId, 42);
  assert.equal(controller.isRememberedSharedSourceTab(42), true);
});

test("reclaimSharedSourceTabIfUnclaimed does not hijack a tab already bound to another", () => {
  const { controller, shareState } = createController();
  shareState.sharedTabId = 7;

  assert.equal(controller.reclaimSharedSourceTabIfUnclaimed(42), false);
  // The existing binding is left untouched so a non-source tab cannot steal it.
  assert.equal(shareState.sharedTabId, 7);
});

test("reclaimSharedSourceTabIfUnclaimed ignores an undefined tab id", () => {
  const { controller, shareState } = createController();
  shareState.sharedTabId = null;

  assert.equal(controller.reclaimSharedSourceTabIfUnclaimed(undefined), false);
  assert.equal(shareState.sharedTabId, null);
});

test("canReclaimSharedSourceTab reports reclaimability without mutating the binding", () => {
  const { controller, shareState } = createController();

  shareState.sharedTabId = null;
  assert.equal(controller.canReclaimSharedSourceTab(42), true);
  // The probe must not claim the binding — the real claim happens later, only
  // after the auto-share payload validates.
  assert.equal(shareState.sharedTabId, null);

  assert.equal(controller.canReclaimSharedSourceTab(undefined), false);

  shareState.sharedTabId = 7;
  assert.equal(controller.canReclaimSharedSourceTab(42), false);
  assert.equal(shareState.sharedTabId, 7);
});
