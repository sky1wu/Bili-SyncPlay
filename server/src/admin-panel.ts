import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { AdminUiConfig } from "./types.js";

const adminUiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../admin-ui");
const defaultAdminUiConfig: AdminUiConfig = {
  demoEnabled: false
};

const assetTypes = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"]
]);

export async function tryHandleAdminPanel(
  request: IncomingMessage,
  response: ServerResponse,
  adminUiConfig: AdminUiConfig = defaultAdminUiConfig
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/admin")) {
    return false;
  }

  const relativePath =
    url.pathname === "/admin" || url.pathname === "/admin/"
      ? "index.html"
      : url.pathname.slice("/admin/".length);

  const sanitizedPath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const assetPath = path.resolve(adminUiDir, sanitizedPath);
  if (!assetPath.startsWith(adminUiDir)) {
    response.writeHead(404);
    response.end();
    return true;
  }

  const shouldServeIndex =
    !path.extname(sanitizedPath) ||
    sanitizedPath.includes(`${path.sep}.`) ||
    sanitizedPath.endsWith("/") ||
    sanitizedPath === ".";

  const filePath = shouldServeIndex ? path.join(adminUiDir, "index.html") : assetPath;

  try {
    const body = await readFile(filePath);
    const contentType = assetTypes.get(path.extname(filePath)) ?? "application/octet-stream";
    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": shouldServeIndex ? "no-cache" : "public, max-age=300"
    });

    if (request.method === "HEAD") {
      response.end();
      return true;
    }

    if (shouldServeIndex) {
      const html = body
        .toString("utf8")
        .replace(
          '"__ADMIN_UI_CONFIG__"',
          JSON.stringify({
            demoEnabled: adminUiConfig.demoEnabled === true
          })
        );
      response.end(html);
      return true;
    }

    response.end(body);
    return true;
  } catch {
    response.writeHead(404);
    response.end();
    return true;
  }
}
