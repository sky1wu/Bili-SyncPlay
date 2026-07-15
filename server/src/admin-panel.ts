import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { AdminUiConfig } from "./types.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const legacyAdminUiDir = path.resolve(moduleDir, "../admin-ui");
const nextAdminUiDir = path.resolve(moduleDir, "../../packages/admin-ui/dist");

export type AdminPanelTarget = {
  basePath: string;
  rootDir: string;
};

const defaultTargets: readonly AdminPanelTarget[] = [
  { basePath: "/admin-next", rootDir: nextAdminUiDir },
  { basePath: "/admin", rootDir: legacyAdminUiDir },
];

const defaultAdminUiConfig: AdminUiConfig = {
  demoEnabled: false,
  apiBaseUrl: undefined,
  enabled: true,
};

const assetTypes = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".png", "image/png"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function matchTarget(
  pathname: string,
  targets: readonly AdminPanelTarget[],
): AdminPanelTarget | null {
  for (const target of targets) {
    if (
      pathname === target.basePath ||
      pathname.startsWith(`${target.basePath}/`)
    ) {
      return target;
    }
  }
  return null;
}

export function createAdminPanelHandler(
  targets: readonly AdminPanelTarget[] = defaultTargets,
) {
  return async function tryHandle(
    request: IncomingMessage,
    response: ServerResponse,
    adminUiConfig: AdminUiConfig = defaultAdminUiConfig,
  ): Promise<boolean> {
    if (adminUiConfig.enabled === false) {
      return false;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return false;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const target = matchTarget(url.pathname, targets);
    if (!target) {
      return false;
    }

    const isBasePathRequest =
      url.pathname === target.basePath ||
      url.pathname === `${target.basePath}/`;
    const relativePath = isBasePathRequest
      ? "index.html"
      : url.pathname.slice(`${target.basePath}/`.length);

    const sanitizedPath = path
      .normalize(relativePath)
      .replace(/^(\.\.(\/|\\|$))+/, "");
    const assetPath = path.resolve(target.rootDir, sanitizedPath);
    // 用 path.relative 判定越界：字符串前缀比较会放行与根目录同名前缀的
    // 兄弟目录（如 dist-backup），也挡不住双斜线带来的绝对路径。
    const relativeAssetPath = path.relative(target.rootDir, assetPath);
    if (
      relativeAssetPath.startsWith("..") ||
      path.isAbsolute(relativeAssetPath)
    ) {
      response.writeHead(404);
      response.end();
      return true;
    }

    const shouldServeIndex =
      isBasePathRequest ||
      sanitizedPath === "index.html" ||
      !path.extname(sanitizedPath) ||
      sanitizedPath.includes(`${path.sep}.`) ||
      sanitizedPath.endsWith("/") ||
      sanitizedPath === ".";

    const filePath = shouldServeIndex
      ? path.join(target.rootDir, "index.html")
      : assetPath;

    try {
      const body = await readFile(filePath);
      const contentType =
        assetTypes.get(path.extname(filePath)) ?? "application/octet-stream";
      response.writeHead(200, {
        "content-type": contentType,
        "cache-control": "no-cache, no-store, must-revalidate",
      });

      if (request.method === "HEAD") {
        response.end();
        return true;
      }

      if (shouldServeIndex) {
        const html = body.toString("utf8").replace(
          '"__ADMIN_UI_CONFIG__"',
          JSON.stringify({
            demoEnabled: adminUiConfig.demoEnabled === true,
            apiBaseUrl:
              typeof adminUiConfig.apiBaseUrl === "string" &&
              adminUiConfig.apiBaseUrl.length > 0
                ? adminUiConfig.apiBaseUrl
                : undefined,
            enabled: adminUiConfig.enabled ?? true,
          }),
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
  };
}

export const tryHandleAdminPanel = createAdminPanelHandler();
