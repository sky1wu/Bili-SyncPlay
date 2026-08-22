import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBilibiliUrl, parseBilibiliVideoRef } from "../src/index.js";

test("parses a standard video URL", () => {
  assert.deepEqual(
    parseBilibiliVideoRef("https://www.bilibili.com/video/BV1xx411c7mD"),
    {
      videoId: "BV1xx411c7mD",
      normalizedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
    },
  );
});

test("parses a bangumi URL", () => {
  assert.deepEqual(
    parseBilibiliVideoRef("https://www.bilibili.com/bangumi/play/ep123456"),
    {
      videoId: "ep123456",
      normalizedUrl: "https://www.bilibili.com/bangumi/play/ep123456",
    },
  );
});

test("parses a festival URL carrying bvid and cid", () => {
  assert.deepEqual(
    parseBilibiliVideoRef(
      "https://www.bilibili.com/festival/demo?bvid=BV1ab411c7mD&cid=987654",
    ),
    {
      videoId: "BV1ab411c7mD:987654",
      normalizedUrl: "https://www.bilibili.com/video/BV1ab411c7mD?cid=987654",
    },
  );
});

test("parses a paged video URL", () => {
  assert.deepEqual(
    parseBilibiliVideoRef("https://www.bilibili.com/video/BV1xx411c7mD?p=3"),
    {
      videoId: "BV1xx411c7mD:p3",
      normalizedUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=3",
    },
  );
});

test("parses watchlater URLs only through explicit supported paths", () => {
  assert.deepEqual(
    parseBilibiliVideoRef(
      "https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD",
    ),
    {
      videoId: "BV1xx411c7mD",
      normalizedUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
    },
  );
  assert.deepEqual(
    parseBilibiliVideoRef(
      "https://www.bilibili.com/medialist/play/watchlater?bvid=BV1xx411c7mD&cid=42",
    ),
    {
      videoId: "BV1xx411c7mD:42",
      normalizedUrl: "https://www.bilibili.com/video/BV1xx411c7mD?cid=42",
    },
  );
});

test("parses favourites-folder list playback URLs", () => {
  // The real URL Bilibili puts in the address bar for "play all" on a
  // favourites folder: the list id names the folder, `bvid` names the video.
  assert.deepEqual(
    parseBilibiliVideoRef(
      "https://www.bilibili.com/list/ml67024054?spm_id_from=333.1387.0.0&oid=116993365643772&bvid=BV1px3A6GEmJ",
    ),
    {
      videoId: "BV1px3A6GEmJ",
      normalizedUrl: "https://www.bilibili.com/video/BV1px3A6GEmJ",
    },
  );
  assert.deepEqual(
    parseBilibiliVideoRef(
      "https://www.bilibili.com/medialist/play/ml67024054?bvid=BV1px3A6GEmJ&p=2",
    ),
    {
      videoId: "BV1px3A6GEmJ:p2",
      normalizedUrl: "https://www.bilibili.com/video/BV1px3A6GEmJ?p=2",
    },
  );
});

test("parses creator collection list playback URLs", () => {
  assert.deepEqual(
    parseBilibiliVideoRef(
      "https://www.bilibili.com/list/12345678?sid=4567890&oid=116993365643772&bvid=BV1px3A6GEmJ",
    ),
    {
      videoId: "BV1px3A6GEmJ",
      normalizedUrl: "https://www.bilibili.com/video/BV1px3A6GEmJ",
    },
  );
});

test("returns null for a list playback URL without bvid", () => {
  assert.equal(
    parseBilibiliVideoRef("https://www.bilibili.com/list/ml67024054"),
    null,
  );
  assert.equal(
    parseBilibiliVideoRef("https://www.bilibili.com/medialist/play/ml67024054"),
    null,
  );
});

test("returns null for invalid or unsupported URLs", () => {
  assert.equal(parseBilibiliVideoRef("not-a-url"), null);
  assert.equal(
    parseBilibiliVideoRef("https://www.bilibili.com/list/watchlater"),
    null,
  );
  assert.equal(parseBilibiliVideoRef("https://example.com/anything"), null);
  assert.equal(
    parseBilibiliVideoRef("https://evil.example/?bvid=BV1xx411c7mD"),
    null,
  );
  assert.equal(
    parseBilibiliVideoRef(
      "https://evil.example/festival/demo?bvid=BV1ab411c7mD&cid=987654",
    ),
    null,
  );
  assert.equal(
    parseBilibiliVideoRef(
      "https://www.bilibili.com/list/fav?bvid=BV1xx411c7mD",
    ),
    null,
  );
  assert.equal(
    parseBilibiliVideoRef(
      "https://www.bilibili.com/medialist/detail/ml67024054?bvid=BV1xx411c7mD",
    ),
    null,
  );
  assert.equal(
    parseBilibiliVideoRef(
      "https://www.bilibili.com/list/ml67024054/extra?bvid=BV1xx411c7mD",
    ),
    null,
  );
});

test("parses a video URL with cid and preserves it", () => {
  assert.deepEqual(
    parseBilibiliVideoRef(
      "https://www.bilibili.com/video/BV1ab411c7mD?cid=987654",
    ),
    {
      videoId: "BV1ab411c7mD:987654",
      normalizedUrl: "https://www.bilibili.com/video/BV1ab411c7mD?cid=987654",
    },
  );
});

test("normalization is idempotent for festival URLs with cid", () => {
  const festivalUrl =
    "https://www.bilibili.com/festival/demo?bvid=BV1ab411c7mD&cid=987654";
  const firstPass = normalizeBilibiliUrl(festivalUrl);
  assert.equal(
    firstPass,
    "https://www.bilibili.com/video/BV1ab411c7mD?cid=987654",
  );
  const secondPass = normalizeBilibiliUrl(firstPass);
  assert.equal(secondPass, firstPass);
});

test("normalizes supported URLs and rejects unsupported ones", () => {
  assert.equal(
    normalizeBilibiliUrl(
      "https://www.bilibili.com/festival/demo?cid=987654&bvid=BV1ab411c7mD",
    ),
    "https://www.bilibili.com/video/BV1ab411c7mD?cid=987654",
  );
  assert.equal(
    normalizeBilibiliUrl(
      "https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD&p=2",
    ),
    "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
  );
  assert.equal(
    normalizeBilibiliUrl("https://www.bilibili.com/list/watchlater"),
    null,
  );
  assert.equal(
    normalizeBilibiliUrl(
      "https://evil.example/festival/demo?cid=987654&bvid=BV1ab411c7mD",
    ),
    null,
  );
});
