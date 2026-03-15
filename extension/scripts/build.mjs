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

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const rootPackage = JSON.parse(await readFile(packageJsonPath, "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.version = rootPackage.version;
const extensionKey = process.env.BILI_SYNCPLAY_EXTENSION_KEY?.trim();

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
    sourcemap: true
  }),
  writeFile(path.join(distDir, "manifest.json"), JSON.stringify(manifest, null, 2)),
  cp(path.join(rootDir, "public", "popup.html"), path.join(distDir, "popup.html")),
  cp(path.join(rootDir, "public", "popup.css"), path.join(distDir, "popup.css")),
  cp(path.join(rootDir, "public", "icon-16.png"), path.join(distDir, "icon-16.png")),
  cp(path.join(rootDir, "public", "icon-48.png"), path.join(distDir, "icon-48.png")),
  cp(path.join(rootDir, "public", "icon-128.png"), path.join(distDir, "icon-128.png"))
]);
