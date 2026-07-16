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
  const nextDir = path.join(baseDir, "next");
  // 与静态根目录同名前缀的兄弟目录，用于验证越界防护不是字符串前缀比较。
  const siblingDir = `${nextDir}-secret`;
  await mkdir(path.join(nextDir, "assets"), { recursive: true });
  await mkdir(siblingDir, { recursive: true });
  await writeFile(path.join(siblingDir, "leak.js"), "leaked-content");
  await writeFile(
    path.join(nextDir, "index.html"),
    '<title>next</title><script>window.__ADMIN_UI_CONFIG__ = "__ADMIN_UI_CONFIG__";</script>',
  );
  await writeFile(path.join(nextDir, "assets", "app.js"), "console.log(1);");
  return { nextDir, siblingDir };
}

async function createHandler() {
  const { nextDir, siblingDir } = await createFixtureDirs();
  const handler = createAdminPanelHandler(
    [{ basePath: "/admin-next", rootDir: nextDir }],
    [{ fromBasePath: "/admin", toBasePath: "/admin-next" }],
  );
  return { handler, siblingDir };
}

test("redirects /admin to /admin-next preserving subpath and query", async () => {
  const { handler } = await createHandler();

  const root = createResponse();
  assert.equal(
    await handler(createRequest("GET", "/admin"), root.response),
    true,
  );
  assert.equal(root.captured.statusCode, 302);
  assert.equal(root.captured.headers["location"], "/admin-next");

  const nested = createResponse();
  assert.equal(
    await handler(
      createRequest("GET", "/admin/rooms?keyword=a&page=2"),
      nested.response,
    ),
    true,
  );
  assert.equal(nested.captured.statusCode, 302);
  assert.equal(
    nested.captured.headers["location"],
    "/admin-next/rooms?keyword=a&page=2",
  );
});

test("serves the panel index at /admin-next with config injection", async () => {
  const { handler } = await createHandler();
  const { response, captured } = createResponse();

  const handled = await handler(createRequest("GET", "/admin-next"), response);

  assert.equal(handled, true);
  assert.equal(captured.statusCode, 200);
  assert.match(captured.body, /next/);
  // 精确命中 basePath 也必须注入运行时配置，不能返回原始占位符。
  assert.match(captured.body, /"enabled":true/);
  assert.doesNotMatch(captured.body, /"__ADMIN_UI_CONFIG__"/);
});

test("serves SPA index for nested /admin-next routes and injects config", async () => {
  const { handler } = await createHandler();
  const { response, captured } = createResponse();

  const handled = await handler(
    createRequest("GET", "/admin-next/rooms"),
    response,
    { apiBaseUrl: "https://api.example.com", enabled: true },
  );

  assert.equal(handled, true);
  assert.equal(captured.statusCode, 200);
  assert.match(captured.body, /next/);
  assert.match(captured.body, /"apiBaseUrl":"https:\/\/api\.example\.com"/);
});

test("serves hashed assets under /admin-next/assets", async () => {
  const { handler } = await createHandler();
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
  // assets/ 下的内容寻址产物可长缓存。
  assert.equal(
    captured.headers["cache-control"],
    "public, max-age=31536000, immutable",
  );
});

test("keeps no-store caching for index and non-hashed files", async () => {
  const { handler } = await createHandler();

  const index = createResponse();
  await handler(createRequest("GET", "/admin-next"), index.response);
  assert.equal(
    index.captured.headers["cache-control"],
    "no-cache, no-store, must-revalidate",
  );

  const indexFile = createResponse();
  await handler(
    createRequest("GET", "/admin-next/index.html"),
    indexFile.response,
  );
  assert.equal(
    indexFile.captured.headers["cache-control"],
    "no-cache, no-store, must-revalidate",
  );
});

test("rejects path traversal outside the panel root", async () => {
  const { handler } = await createHandler();
  const { response, captured } = createResponse();

  const handled = await handler(
    createRequest("GET", "/admin-next/..%2f..%2fsecret.txt"),
    response,
  );

  assert.equal(handled, true);
  assert.equal(captured.statusCode, 404);
});

test("rejects absolute-path escape into sibling directories sharing the root prefix", async () => {
  const { handler, siblingDir } = await createHandler();
  const { response, captured } = createResponse();

  // 双斜线让 relativePath 变成绝对路径，字符串前缀检查会放行
  // next-secret 这类与根目录同名前缀的兄弟目录。
  const handled = await handler(
    createRequest("GET", `/admin-next/${path.join(siblingDir, "leak.js")}`),
    response,
  );

  assert.equal(handled, true);
  assert.equal(captured.statusCode, 404);
  assert.doesNotMatch(captured.body, /leaked-content/);
});

test("ignores unrelated paths and disabled panels", async () => {
  const { handler } = await createHandler();

  const unrelated = createResponse();
  assert.equal(
    await handler(createRequest("GET", "/admin-nextish"), unrelated.response),
    false,
  );

  const disabled = createResponse();
  assert.equal(
    await handler(createRequest("GET", "/admin-next"), disabled.response, {
      enabled: false,
    }),
    false,
  );
});
