import assert from "node:assert/strict";
import test from "node:test";
import {
  areSharedVideoUrlsEqual,
  normalizeSharedVideoUrl,
} from "../src/shared/url";

test("normalizeSharedVideoUrl reuses bilibili url normalization", () => {
  assert.equal(
    normalizeSharedVideoUrl(
      "https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD&p=1",
    ),
    "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
  );
  assert.equal(
    normalizeSharedVideoUrl(
      "https://www.bilibili.com/festival/example?bvid=BV1xx411c7mD",
    ),
    "https://www.bilibili.com/video/BV1xx411c7mD",
  );
});

test("areSharedVideoUrlsEqual compares normalized shared video urls", () => {
  assert.equal(
    areSharedVideoUrlsEqual(
      "https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD&p=2",
      "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
    ),
    true,
  );
  assert.equal(
    areSharedVideoUrlsEqual(
      "https://www.bilibili.com/list/ml67024054?oid=116993365643772&bvid=BV1px3A6GEmJ",
      "https://www.bilibili.com/video/BV1px3A6GEmJ",
    ),
    true,
  );
  assert.equal(
    areSharedVideoUrlsEqual(
      "https://www.bilibili.com/video/BV1xx411c7mD",
      "https://www.bilibili.com/video/BV2xx411c7mD",
    ),
    false,
  );
  assert.equal(
    areSharedVideoUrlsEqual("https://example.com/video", null),
    false,
  );
});
