import assert from "node:assert/strict";
import test from "node:test";
import {
  getConnectionErrorMessage,
  getSocketErrorMessage,
} from "../src/background/connection-error";
import { setLocaleForTests } from "../src/shared/i18n";

test("returns the generic message when the healthcheck endpoint is unreachable", () => {
  setLocaleForTests("zh-CN");
  assert.equal(
    getConnectionErrorMessage({
      healthcheckReachable: false,
      extensionOrigin: "chrome-extension://abc123",
    }),
    "无法连接到同步服务器。",
  );
});

test("mentions the extension origin when the websocket handshake is rejected after a reachable healthcheck", () => {
  setLocaleForTests("zh-CN");
  assert.equal(
    getConnectionErrorMessage({
      healthcheckReachable: true,
      extensionOrigin: "chrome-extension://abc123",
    }),
    "服务器可达，但 WebSocket 握手被拒绝。请检查服务端 ALLOWED_ORIGINS 是否包含 chrome-extension://abc123，以及反向代理是否已正确转发 WebSocket。",
  );
});

test("returns a generic reachable-but-rejected message for non-origin handshake failures", () => {
  setLocaleForTests("zh-CN");
  assert.equal(
    getConnectionErrorMessage({
      healthcheckReachable: true,
      extensionOrigin: "chrome-extension://abc123",
      reason: "proxy_rejected",
    }),
    "服务器可达，但 WebSocket 握手被拒绝。请检查服务端状态，以及反向代理是否已正确转发 WebSocket。",
  );
});

test("falls back to a generic handshake rejection hint when the extension origin is unavailable", () => {
  setLocaleForTests("zh-CN");
  assert.equal(
    getConnectionErrorMessage({
      healthcheckReachable: true,
      extensionOrigin: "   ",
    }),
    "服务器可达，但 WebSocket 握手被拒绝。请检查服务端 ALLOWED_ORIGINS，以及反向代理是否已正确转发 WebSocket。",
  );
});

test("a socket error after open reports a dropped connection, not a handshake rejection", () => {
  setLocaleForTests("zh-CN");
  assert.equal(
    getSocketErrorMessage({ sawOpen: true, healthcheckReachable: true }),
    "与同步服务器的连接已断开，正在尝试重连。",
  );
});

test("a socket error before open with an unreachable healthcheck reports unreachable", () => {
  setLocaleForTests("zh-CN");
  assert.equal(
    getSocketErrorMessage({ sawOpen: false, healthcheckReachable: false }),
    "无法连接到同步服务器。",
  );
});

test("a socket error before open with a reachable healthcheck avoids blaming ALLOWED_ORIGINS with confidence", () => {
  setLocaleForTests("zh-CN");
  assert.equal(
    getSocketErrorMessage({ sawOpen: false, healthcheckReachable: true }),
    "服务器 HTTP 可达，但 WebSocket 连接失败。服务端可能正在启动或重启；若持续出现，请检查反向代理的 WebSocket 转发与服务端 ALLOWED_ORIGINS。",
  );
});

test("returns English connection guidance when the UI language is English", () => {
  setLocaleForTests("en-US");
  assert.equal(
    getConnectionErrorMessage({
      healthcheckReachable: false,
      extensionOrigin: "chrome-extension://abc123",
    }),
    "Unable to connect to the sync server.",
  );
  assert.equal(
    getConnectionErrorMessage({
      healthcheckReachable: true,
      extensionOrigin: "chrome-extension://abc123",
    }),
    "The server is reachable, but the WebSocket handshake was rejected. Check whether ALLOWED_ORIGINS includes chrome-extension://abc123, and make sure the reverse proxy forwards WebSocket correctly.",
  );
  setLocaleForTests(null);
});
