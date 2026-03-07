import { access, mkdir, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const extensionDir = path.join(rootDir, "extension");
const distDir = path.join(extensionDir, "dist");
const releaseDir = path.join(rootDir, "release");

const extensionPackageRaw = await readFile(path.join(extensionDir, "package.json"), "utf8");
const extensionPackage = JSON.parse(extensionPackageRaw);
const version = extensionPackage.version;
const zipName = `bili-syncplay-extension-v${version}.zip`;
const zipPath = path.join(releaseDir, zipName);

await access(distDir, constants.F_OK);
await mkdir(releaseDir, { recursive: true });
await rm(zipPath, { force: true });

if (process.platform === "win32") {
  await run(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Compress-Archive -Path '${distDir}\\*' -DestinationPath '${zipPath}' -Force`
    ],
    rootDir
  );
} else {
  await run("zip", ["-rq", zipPath, "."], distDir);
}

console.log(`Release package created: ${zipPath}`);

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}
