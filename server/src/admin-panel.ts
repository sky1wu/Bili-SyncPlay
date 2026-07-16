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

export type AdminPanelRedirect = {
  fromBasePath: string;
  toBasePath: string;
};

const defaultTargets: readonly AdminPanelTarget[] = [
  { basePath: "/admin-next", rootDir: nextAdminUiDir },
  // 旧面板保留在 /admin-legacy 作为切换后的回退入口，随删除 PR 下线。
  { basePath: "/admin-legacy", rootDir: legacyAdminUiDir },
];

// /admin 正式指向新控制台：302 保留子路径与查询串。
const defaultRedirects: readonly AdminPanelRedirect[] = [
  { fromBasePath: "/admin", toBasePath: "/admin-next" },
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
  redirects: readonly AdminPanelRedirect[] = defaultRedirects,
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

    for (const redirect of redirects) {
      if (
        url.pathname === redirect.fromBasePath ||
        url.pathname.startsWith(`${redirect.fromBasePath}/`)
      ) {
        const location = `${redirect.toBasePath}${url.pathname.slice(
          redirect.fromBasePath.length,
        )}${url.search}`;
        response.writeHead(302, { location });
        response.end();
        return true;
      }
    }

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

    // Vite 产物在 assets/ 下且文件名含内容 hash，内容变则 URL 变，
    // 可安全地长缓存；index.html 与旧面板的非 hash 文件维持禁缓存，
    // 保证发版即生效。
    const isImmutableAsset =
      !shouldServeIndex && sanitizedPath.startsWith(`assets${path.sep}`);

    try {
      const body = await readFile(filePath);
      const contentType =
        assetTypes.get(path.extname(filePath)) ?? "application/octet-stream";
      response.writeHead(200, {
        "content-type": contentType,
        "cache-control": isImmutableAsset
          ? "public, max-age=31536000, immutable"
          : "no-cache, no-store, must-revalidate",
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
              demoEnabled: adminUiConfig.demoEnabled === true,
              apiBaseUrl:
                typeof adminUiConfig.apiBaseUrl === "string" &&
                adminUiConfig.apiBaseUrl.length > 0
                  ? adminUiConfig.apiBaseUrl
                  : undefined,
              enabled: adminUiConfig.enabled ?? true,
            }),
          )
          // 旧面板 index.html 的资源引用硬编码 /admin/ 前缀；面板挂载
          // 前缀可变（如回退入口 /admin-legacy），服务时改写为实际前缀。
          .replaceAll('="/admin/', `="${target.basePath}/`);
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
