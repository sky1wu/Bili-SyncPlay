import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  distDirName,
  resolveTargetBrowser,
} from "../../scripts/target-browser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const workspaceRootDir = path.resolve(rootDir, "..");
const targetBrowser = resolveTargetBrowser();
const distDir = path.join(rootDir, distDirName(targetBrowser));
const packageJsonPath = path.join(workspaceRootDir, "package.json");
const manifestPath = path.join(rootDir, "public", "manifest.json");
const defaultServerUrl = resolveDefaultServerUrl(
  process.env.BILI_SYNCPLAY_DEFAULT_SERVER_URL,
);

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const rootPackage = JSON.parse(await readFile(packageJsonPath, "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.version = rootPackage.version;
if (targetBrowser === "firefox") {
  manifest.permissions = (manifest.permissions ?? []).filter(
    (permission) => permission !== "offscreen",
  );
  // Firefox 必需 add-on ID；manifest.key 是 Chrome 专属，对 Firefox 无意义。
  delete manifest.key;
  manifest.browser_specific_settings = {
    gecko: {
      id: "bili-syncplay@bilibili-tools.local",
      strict_min_version: "121.0",
      // Firefox 新规：新扩展须声明数据收集/传输（与目的地无关，发往
      // 用户自建服务端也算）。本扩展把同步的 B 站视频 URL
      // （browsingActivity）与播放操作交互（websiteActivity）发往用户
      // 配置的 WebSocket 服务端；房间码/token 为临时会话标识，昵称为
      // 用户自填的临时假名句柄（按扩展设计意图不属 PII），故不声明
      // personallyIdentifyingInfo；无遥测故无 technicalAndInteraction。
      //
      // 该键 Firefox 140（桌面）/142（Android）才识别，本扩展 min
      // 版本为 121——旧版按"未知键忽略"处理（前向兼容、不破坏，121–139
      // 仍正常运行，仅无数据同意 UI），140+ 强制并展示。故 web-ext lint
      // 的 KEY_FIREFOX[_ANDROID]_UNSUPPORTED_BY_MIN_VERSION 为预期软告警，
      // 不上调 strict_min_version（否则白丢 121–139 用户且无功能收益）。
      data_collection_permissions: {
        required: ["browsingActivity", "websiteActivity"],
      },
    },
  };
  // Firefox 不支持 MV3 background.service_worker（Bugzilla 1573659），
  // 必须用 background.scripts（event page）。Firefox 121+ 才会在
  // service_worker 存在时启动 background page，且支持 type:"module"
  // ES module 后台脚本——与上面的 strict_min_version 对齐。
  // 这是专用 Firefox 产物，去掉 Chrome 专属的 service_worker 键，
  // 避免 web-ext lint 对不支持字段告警。
  manifest.background = {
    scripts: ["background.js"],
    type: "module",
  };
  // MV3 默认 CSP 隐含 upgrade-insecure-requests，Firefox 会据此把扩展
  // 自身发起的 ws:// 升级为 wss://（无 Chrome 那种 localhost 豁免），
  // 导致连不上明文 WebSocket 服务端。本扩展显式支持用户配置 ws:// 服务端，
  // 故按 Mozilla 文档显式覆盖 extension_pages CSP，去掉该升级指令；
  // 其余沿用 MV3 默认（script-src/object-src 'self'）。
  manifest.content_security_policy = {
    extension_pages: "script-src 'self'; object-src 'self'",
  };
} else {
  const extensionKey = normalizeExtensionKey(
    process.env.BILI_SYNCPLAY_EXTENSION_KEY,
  );

  if (extensionKey) {
    manifest.key = extensionKey;
  } else {
    delete manifest.key;
  }
}

await Promise.all([
  build({
    entryPoints: {
      background: path.join(rootDir, "src/background/index.ts"),
      content: path.join(rootDir, "src/content/index.ts"),
      "page-bridge": path.join(rootDir, "src/content/page-bridge.ts"),
      popup: path.join(rootDir, "src/popup/index.ts"),
      offscreen: path.join(rootDir, "src/offscreen/voice-host.ts"),
      "voice-permission": path.join(rootDir, "src/voice-permission/index.ts"),
    },
    bundle: true,
    format: "esm",
    target: ["chrome120", "firefox121"],
    outdir: distDir,
    sourcemap: true,
    define: {
      __BILI_SYNCPLAY_DEFAULT_SERVER_URL__: JSON.stringify(defaultServerUrl),
    },
  }),
  writeFile(
    path.join(distDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  ),
  cp(
    path.join(rootDir, "public", "popup.html"),
    path.join(distDir, "popup.html"),
  ),
  cp(
    path.join(rootDir, "public", "offscreen.html"),
    path.join(distDir, "offscreen.html"),
  ),
  cp(
    path.join(rootDir, "public", "voice-permission.html"),
    path.join(distDir, "voice-permission.html"),
  ),
  cp(
    path.join(rootDir, "public", "popup.css"),
    path.join(distDir, "popup.css"),
  ),
  cp(
    path.join(rootDir, "public", "voice-permission.css"),
    path.join(distDir, "voice-permission.css"),
  ),
  cp(path.join(rootDir, "public", "_locales"), path.join(distDir, "_locales"), {
    recursive: true,
  }),
  cp(
    path.join(rootDir, "public", "icon-16.png"),
    path.join(distDir, "icon-16.png"),
  ),
  cp(
    path.join(rootDir, "public", "icon-48.png"),
    path.join(distDir, "icon-48.png"),
  ),
  cp(
    path.join(rootDir, "public", "icon-128.png"),
    path.join(distDir, "icon-128.png"),
  ),
]);

function normalizeExtensionKey(rawValue) {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");

  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) {
    throw new Error(
      "BILI_SYNCPLAY_EXTENSION_KEY must be a Chrome extension public key body or a PEM-formatted public key.",
    );
  }

  return normalized;
}

function resolveDefaultServerUrl(rawValue) {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return "ws://localhost:8787";
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error(
      "BILI_SYNCPLAY_DEFAULT_SERVER_URL must be a valid ws:// or wss:// URL.",
    );
  }

  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    throw new Error(
      "BILI_SYNCPLAY_DEFAULT_SERVER_URL must use ws:// or wss://.",
    );
  }

  return parsedUrl.toString();
}
