import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BILIBILI_VIDEO_URL_PATTERNS } from "../src/background/runtime-state";

const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../public/manifest.json", import.meta.url)),
    "utf8",
  ),
) as { content_scripts: { matches: string[] }[] };

const manifestMatches = manifest.content_scripts[0].matches;

/**
 * Chrome match patterns only support `*`, so this is the whole translation the
 * patterns in this repository need: escape everything else, expand `*`.
 */
function matchPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

function isInjected(url: string): boolean {
  return manifestMatches.some((pattern) =>
    matchPatternToRegExp(pattern).test(url),
  );
}

test("the background tab query patterns are the manifest's content script matches", () => {
  // The background queries tabs with these patterns to find the shared video's
  // tab; a pattern the manifest does not inject into finds a tab with no content
  // script, and a manifest match the background does not query is a tab it can
  // never reuse.
  assert.deepEqual(
    [...BILIBILI_VIDEO_URL_PATTERNS].sort(),
    [...manifestMatches].sort(),
  );
});

test("the content script is injected into every supported list playback route", () => {
  assert.equal(
    isInjected(
      "https://www.bilibili.com/list/ml67024054?spm_id_from=333.1387.0.0&oid=116993365643772&bvid=BV1px3A6GEmJ",
    ),
    true,
  );
  assert.equal(
    isInjected(
      "https://www.bilibili.com/list/12345678?sid=4567890&bvid=BV1px3A6GEmJ",
    ),
    true,
  );
  assert.equal(
    isInjected("https://www.bilibili.com/list/watchlater?bvid=BV1px3A6GEmJ"),
    true,
  );
  assert.equal(
    isInjected(
      "https://www.bilibili.com/medialist/play/ml67024054?bvid=BV1px3A6GEmJ",
    ),
    true,
  );
});

test("the content script stays out of unrelated routes under the same prefixes", () => {
  assert.equal(isInjected("https://www.bilibili.com/list/fav"), false);
  assert.equal(
    isInjected("https://www.bilibili.com/medialist/detail/ml67024054"),
    false,
  );
  assert.equal(isInjected("https://www.bilibili.com/anime"), false);
});
