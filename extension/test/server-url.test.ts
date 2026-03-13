import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SERVER_URL } from "../src/background/runtime-state";
import {
  INVALID_SERVER_URL_MESSAGE,
  resolvePersistedServerUrl,
  resolveServerUrlOrDefault,
  validateServerUrl
} from "../src/background/server-url";

test("maps empty input back to the default server URL", () => {
  assert.deepEqual(validateServerUrl("   "), {
    ok: true,
    normalizedUrl: DEFAULT_SERVER_URL
  });
  assert.equal(resolveServerUrlOrDefault(""), DEFAULT_SERVER_URL);
});

test("accepts ws and wss server URLs", () => {
  assert.deepEqual(validateServerUrl("ws://localhost:8787"), {
    ok: true,
    normalizedUrl: "ws://localhost:8787"
  });
  assert.deepEqual(validateServerUrl("wss://sync.example/ws"), {
    ok: true,
    normalizedUrl: "wss://sync.example/ws"
  });
});

test("rejects unsupported protocols and malformed URLs", () => {
  assert.deepEqual(validateServerUrl("http://localhost:8787"), {
    ok: false,
    message: INVALID_SERVER_URL_MESSAGE
  });
  assert.deepEqual(validateServerUrl("ftp://localhost:8787"), {
    ok: false,
    message: INVALID_SERVER_URL_MESSAGE
  });
  assert.deepEqual(validateServerUrl("not a url"), {
    ok: false,
    message: INVALID_SERVER_URL_MESSAGE
  });
  assert.equal(resolveServerUrlOrDefault("http://localhost:8787"), DEFAULT_SERVER_URL);
});

test("keeps invalid persisted server URLs visible and blocks auto connect", () => {
  assert.deepEqual(resolvePersistedServerUrl("http://localhost:8787"), {
    serverUrl: "http://localhost:8787",
    lastError: INVALID_SERVER_URL_MESSAGE,
    shouldAutoConnect: false
  });
  assert.deepEqual(resolvePersistedServerUrl("  "), {
    serverUrl: DEFAULT_SERVER_URL,
    lastError: null,
    shouldAutoConnect: true
  });
});
