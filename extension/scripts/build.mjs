import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const workspaceRootDir = path.resolve(rootDir, "..");
const distDir = path.join(rootDir, "dist");
const packageJsonPath = path.join(workspaceRootDir, "package.json");
const manifestPath = path.join(rootDir, "public", "manifest.json");
const defaultServerUrl = resolveDefaultServerUrl(process.env.BILI_SYNCPLAY_DEFAULT_SERVER_URL);

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const rootPackage = JSON.parse(await readFile(packageJsonPath, "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.version = rootPackage.version;
const extensionKey = normalizeExtensionKey(process.env.BILI_SYNCPLAY_EXTENSION_KEY);

if (extensionKey) {
  manifest.key = extensionKey;
} else {
  delete manifest.key;
}

await Promise.all([
  build({
    entryPoints: {
      background: path.join(rootDir, "src/background/index.ts"),
      content: path.join(rootDir, "src/content/index.ts"),
      "page-bridge": path.join(rootDir, "src/content/page-bridge.ts"),
      popup: path.join(rootDir, "src/popup/index.ts")
    },
    bundle: true,
    format: "esm",
    target: "chrome120",
    outdir: distDir,
    sourcemap: true,
    define: {
      __BILI_SYNCPLAY_DEFAULT_SERVER_URL__: JSON.stringify(defaultServerUrl)
    }
  }),
  writeFile(path.join(distDir, "manifest.json"), JSON.stringify(manifest, null, 2)),
  cp(path.join(rootDir, "public", "popup.html"), path.join(distDir, "popup.html")),
  cp(path.join(rootDir, "public", "popup.css"), path.join(distDir, "popup.css")),
  cp(path.join(rootDir, "public", "_locales"), path.join(distDir, "_locales"), { recursive: true }),
  cp(path.join(rootDir, "public", "icon-16.png"), path.join(distDir, "icon-16.png")),
  cp(path.join(rootDir, "public", "icon-48.png"), path.join(distDir, "icon-48.png")),
  cp(path.join(rootDir, "public", "icon-128.png"), path.join(distDir, "icon-128.png"))
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
      "BILI_SYNCPLAY_EXTENSION_KEY must be a Chrome extension public key body or a PEM-formatted public key."
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
    throw new Error("BILI_SYNCPLAY_DEFAULT_SERVER_URL must be a valid ws:// or wss:// URL.");
  }

  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    throw new Error("BILI_SYNCPLAY_DEFAULT_SERVER_URL must use ws:// or wss://.");
  }

  return parsedUrl.toString();
}
