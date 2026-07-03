import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const nextVersion = process.argv[2]?.trim();

if (!nextVersion) {
  console.error("Usage: npm run release:version -- <version>");
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(nextVersion)) {
  console.error(`Invalid version: ${nextVersion}`);
  process.exit(1);
}

const packagePaths = [
  path.join(rootDir, "package.json"),
  path.join(rootDir, "packages", "protocol", "package.json"),
  path.join(rootDir, "server", "package.json"),
  path.join(rootDir, "extension", "package.json"),
];
const extensionManifestPath = path.join(
  rootDir,
  "extension",
  "public",
  "manifest.json",
);

for (const packagePath of packagePaths) {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  packageJson.version = nextVersion;

  if (packageJson.dependencies?.["@bili-syncplay/protocol"]) {
    packageJson.dependencies["@bili-syncplay/protocol"] = nextVersion;
  }

  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

const extensionManifest = JSON.parse(
  await readFile(extensionManifestPath, "utf8"),
);
extensionManifest.version = nextVersion;
await writeFile(
  extensionManifestPath,
  `${JSON.stringify(extensionManifest, null, 2)}\n`,
);

if (process.platform === "win32") {
  await run(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", "npm install --package-lock-only"],
    rootDir,
  );
} else {
  await run("npm", ["install", "--package-lock-only"], rootDir);
}

// JSON.stringify 的输出与仓库 Prettier 风格不完全一致（如 manifest.json 的
// 数组换行），不格式化会被预提交的 format:check 拦下。
const prettierTargets = [...packagePaths, extensionManifestPath].map(
  (filePath) => path.relative(rootDir, filePath),
);

if (process.platform === "win32") {
  await run(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", `npx prettier --write ${prettierTargets.join(" ")}`],
    rootDir,
  );
} else {
  await run("npx", ["prettier", "--write", ...prettierTargets], rootDir);
}

console.log(`Updated workspace version to ${nextVersion}`);

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false,
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
