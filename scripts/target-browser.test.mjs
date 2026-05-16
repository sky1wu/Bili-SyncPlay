import assert from "node:assert/strict";
import test from "node:test";
import { distDirName, resolveTargetBrowser } from "./target-browser.mjs";

test("默认目标为 chrome", () => {
  assert.equal(resolveTargetBrowser([], {}), "chrome");
});

test("环境变量 TARGET_BROWSER 生效", () => {
  assert.equal(
    resolveTargetBrowser([], { TARGET_BROWSER: "firefox" }),
    "firefox",
  );
});

test("CLI --target=value 形式", () => {
  assert.equal(resolveTargetBrowser(["--target=firefox"], {}), "firefox");
});

test("CLI --target value 形式", () => {
  assert.equal(resolveTargetBrowser(["--target", "firefox"], {}), "firefox");
});

test("CLI 参数优先于环境变量", () => {
  assert.equal(
    resolveTargetBrowser(["--target=chrome"], { TARGET_BROWSER: "firefox" }),
    "chrome",
  );
});

test("多个 --target 时后者覆盖（npm 脚本分层）", () => {
  // 基础脚本固定 --target=chrome，调用方追加 --target=firefox 覆盖
  assert.equal(
    resolveTargetBrowser(["--target=chrome", "--target=firefox"], {}),
    "firefox",
  );
  assert.equal(
    resolveTargetBrowser(["--target", "chrome", "--target", "firefox"], {}),
    "firefox",
  );
});

test("显式 --target 不被环境变量劫持（后者覆盖时仍然 CLI 优先）", () => {
  assert.equal(
    resolveTargetBrowser(["--target=chrome", "--target=firefox"], {
      TARGET_BROWSER: "chrome",
    }),
    "firefox",
  );
});

test("大小写与空白被归一", () => {
  assert.equal(
    resolveTargetBrowser([], { TARGET_BROWSER: " FireFox " }),
    "firefox",
  );
});

test("不支持的目标抛错", () => {
  assert.throws(
    () => resolveTargetBrowser(["--target=safari"], {}),
    /Unsupported target browser "safari"/,
  );
});

test("distDirName 映射", () => {
  assert.equal(distDirName("chrome"), "dist");
  assert.equal(distDirName("firefox"), "dist-firefox");
});
