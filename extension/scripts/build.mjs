import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await Promise.all([
  build({
    entryPoints: {
      background: path.join(rootDir, "src/background/index.ts"),
      content: path.join(rootDir, "src/content/index.ts"),
      popup: path.join(rootDir, "src/popup/index.ts")
    },
    bundle: true,
    format: "esm",
    target: "chrome120",
    outdir: distDir,
    sourcemap: true
  }),
  cp(path.join(rootDir, "public", "manifest.json"), path.join(distDir, "manifest.json")),
  cp(path.join(rootDir, "public", "popup.html"), path.join(distDir, "popup.html")),
  cp(path.join(rootDir, "public", "popup.css"), path.join(distDir, "popup.css")),
  cp(path.join(rootDir, "public", "icon-16.png"), path.join(distDir, "icon-16.png")),
  cp(path.join(rootDir, "public", "icon-48.png"), path.join(distDir, "icon-48.png")),
  cp(path.join(rootDir, "public", "icon-128.png"), path.join(distDir, "icon-128.png"))
]);
