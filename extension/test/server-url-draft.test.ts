import assert from "node:assert/strict";
import test from "node:test";
import {
  createServerUrlDraftState,
  getRenderedServerUrlValue,
  syncServerUrlDraft,
  updateServerUrlDraft
} from "../src/popup/server-url-draft";

test("render keeps dirty server URL draft after input loses focus", () => {
  const state = createServerUrlDraftState();
  syncServerUrlDraft(state, "ws://localhost:8787");
  updateServerUrlDraft(state, "ws://example.com/socket", "ws://localhost:8787");

  const rendered = getRenderedServerUrlValue(state, "ws://localhost:8787", false);

  assert.equal(rendered, "ws://example.com/socket");
  assert.equal(state.dirty, true);
});

test("render syncs clean draft from persisted server URL", () => {
  const state = createServerUrlDraftState();

  const rendered = getRenderedServerUrlValue(state, "ws://localhost:8787", false);

  assert.equal(rendered, "ws://localhost:8787");
  assert.equal(state.dirty, false);
});
