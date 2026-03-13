import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBilibiliUrl, parseBilibiliVideoRef } from "../src/index";

test("parses a standard video URL", () => {
  assert.deepEqual(parseBilibiliVideoRef("https://www.bilibili.com/video/BV1xx411c7mD"), {
    videoId: "BV1xx411c7mD",
    normalizedUrl: "https://www.bilibili.com/video/BV1xx411c7mD"
  });
});

test("parses a bangumi URL", () => {
  assert.deepEqual(parseBilibiliVideoRef("https://www.bilibili.com/bangumi/play/ep123456"), {
    videoId: "ep123456",
    normalizedUrl: "https://www.bilibili.com/bangumi/play/ep123456"
  });
});

test("parses a festival URL carrying bvid and cid", () => {
  assert.deepEqual(parseBilibiliVideoRef("https://www.bilibili.com/festival/demo?bvid=BV1ab411c7mD&cid=987654"), {
    videoId: "BV1ab411c7mD:987654",
    normalizedUrl: "https://www.bilibili.com/video/BV1ab411c7mD?cid=987654"
  });
});

test("parses a paged video URL", () => {
  assert.deepEqual(parseBilibiliVideoRef("https://www.bilibili.com/video/BV1xx411c7mD?p=3"), {
    videoId: "BV1xx411c7mD:p3",
    normalizedUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=3"
  });
});

test("parses watchlater URLs only through explicit supported paths", () => {
  assert.deepEqual(parseBilibiliVideoRef("https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD"), {
    videoId: "BV1xx411c7mD",
    normalizedUrl: "https://www.bilibili.com/video/BV1xx411c7mD"
  });
  assert.deepEqual(parseBilibiliVideoRef("https://www.bilibili.com/medialist/play/watchlater?bvid=BV1xx411c7mD&cid=42"), {
    videoId: "BV1xx411c7mD:42",
    normalizedUrl: "https://www.bilibili.com/video/BV1xx411c7mD?cid=42"
  });
});

test("returns null for invalid or unsupported URLs", () => {
  assert.equal(parseBilibiliVideoRef("not-a-url"), null);
  assert.equal(parseBilibiliVideoRef("https://www.bilibili.com/list/watchlater"), null);
  assert.equal(parseBilibiliVideoRef("https://example.com/anything"), null);
  assert.equal(parseBilibiliVideoRef("https://evil.example/?bvid=BV1xx411c7mD"), null);
  assert.equal(parseBilibiliVideoRef("https://evil.example/festival/demo?bvid=BV1ab411c7mD&cid=987654"), null);
  assert.equal(parseBilibiliVideoRef("https://www.bilibili.com/list/fav?bvid=BV1xx411c7mD"), null);
});

test("normalizes supported URLs and rejects unsupported ones", () => {
  assert.equal(
    normalizeBilibiliUrl("https://www.bilibili.com/festival/demo?cid=987654&bvid=BV1ab411c7mD"),
    "https://www.bilibili.com/video/BV1ab411c7mD?cid=987654"
  );
  assert.equal(
    normalizeBilibiliUrl("https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD&p=2"),
    "https://www.bilibili.com/video/BV1xx411c7mD?p=2"
  );
  assert.equal(normalizeBilibiliUrl("https://www.bilibili.com/list/watchlater"), null);
  assert.equal(normalizeBilibiliUrl("https://evil.example/festival/demo?cid=987654&bvid=BV1ab411c7mD"), null);
});
