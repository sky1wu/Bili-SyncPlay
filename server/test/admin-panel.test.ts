import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAdminPanelHandler } from "../src/admin-panel.js";

type CapturedResponse = {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
};

function createRequest(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage;
}

function createResponse(): {
  response: ServerResponse;
  captured: CapturedResponse;
} {
  const captured: CapturedResponse = { statusCode: 0, headers: {}, body: "" };
  const response = {
    writeHead(statusCode: number, headers?: Record<string, unknown>) {
      captured.statusCode = statusCode;
      captured.headers = headers ?? {};
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk) {
        captured.body = chunk.toString();
      }
      return this;
    },
  } as unknown as ServerResponse;
  return { response, captured };
}

async function createFixtureDirs() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "admin-panel-test-"));
  const legacyDir = path.join(baseDir, "legacy");
  const nextDir = path.join(baseDir, "next");
  await mkdir(legacyDir, { recursive: true });
  await mkdir(path.join(nextDir, "assets"), { recursive: true });
  await writeFile(
    path.join(legacyDir, "index.html"),
    '<title>legacy</title><script>window.__ADMIN_UI_CONFIG__ = "__ADMIN_UI_CONFIG__";</script>',
  );
  await writeFile(
    path.join(nextDir, "index.html"),
    '<title>next</title><script>window.__ADMIN_UI_CONFIG__ = "__ADMIN_UI_CONFIG__";</script>',
  );
  await writeFile(path.join(nextDir, "assets", "app.js"), "console.log(1);");
  return { legacyDir, nextDir };
}

async function createHandler() {
  const { legacyDir, nextDir } = await createFixtureDirs();
  return createAdminPanelHandler([
    { basePath: "/admin-next", rootDir: nextDir },
    { basePath: "/admin", rootDir: legacyDir },
  ]);
}

test("serves the legacy panel index at /admin", async () => {
  const handler = await createHandler();
  const { response, captured } = createResponse();

  const handled = await handler(createRequest("GET", "/admin"), response);

  assert.equal(handled, true);
  assert.equal(captured.statusCode, 200);
  assert.match(captured.body, /legacy/);
});

test("serves the next panel at /admin-next instead of the legacy index", async () => {
  const handler = await createHandler();
  const { response, captured } = createResponse();

  const handled = await handler(createRequest("GET", "/admin-next"), response);

  assert.equal(handled, true);
  assert.equal(captured.statusCode, 200);
  assert.match(captured.body, /next/);
  assert.doesNotMatch(captured.body, /legacy/);
  // 精确命中 basePath 也必须注入运行时配置，不能返回原始占位符。
  assert.match(captured.body, /"demoEnabled":false/);
  assert.doesNotMatch(captured.body, /"__ADMIN_UI_CONFIG__"/);
});

test("serves SPA index for nested /admin-next routes and injects config", async () => {
  const handler = await createHandler();
  const { response, captured } = createResponse();

  const handled = await handler(
    createRequest("GET", "/admin-next/rooms"),
    response,
    { demoEnabled: true, apiBaseUrl: "https://api.example.com", enabled: true },
  );

  assert.equal(handled, true);
  assert.equal(captured.statusCode, 200);
  assert.match(captured.body, /next/);
  assert.match(captured.body, /"demoEnabled":true/);
  assert.match(captured.body, /"apiBaseUrl":"https:\/\/api\.example\.com"/);
});

test("serves hashed assets under /admin-next/assets", async () => {
  const handler = await createHandler();
  const { response, captured } = createResponse();

  const handled = await handler(
    createRequest("GET", "/admin-next/assets/app.js"),
    response,
  );

  assert.equal(handled, true);
  assert.equal(captured.statusCode, 200);
  assert.equal(
    captured.headers["content-type"],
    "text/javascript; charset=utf-8",
  );
  assert.equal(captured.body, "console.log(1);");
});

test("rejects path traversal outside the panel root", async () => {
  const handler = await createHandler();
  const { response, captured } = createResponse();

  const handled = await handler(
    createRequest("GET", "/admin-next/..%2f..%2fsecret.txt"),
    response,
  );

  assert.equal(handled, true);
  assert.equal(captured.statusCode, 404);
});

test("ignores unrelated paths and disabled panels", async () => {
  const handler = await createHandler();

  const unrelated = createResponse();
  assert.equal(
    await handler(createRequest("GET", "/admin-nextish"), unrelated.response),
    false,
  );

  const disabled = createResponse();
  assert.equal(
    await handler(createRequest("GET", "/admin-next"), disabled.response, {
      demoEnabled: false,
      enabled: false,
    }),
    false,
  );
});
