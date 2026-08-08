import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBangumiEpisodeShareUrl,
  buildBvidCidShareUrl,
  buildFestivalShareUrl,
  createSharePayload,
  resolvePageSharedVideo,
  resolveSharedVideoTitle,
} from "../src/content/page-video";

test("resolves standard page video and prefers current part title", () => {
  const video = resolvePageSharedVideo({
    pageUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
    pathname: "/video/BV1xx411c7mD",
    documentTitle: "Doc Title_哔哩哔哩",
    headingTitle: "Heading Title",
    currentPartTitle: "P2 Title",
    festivalSnapshot: null,
  });

  assert.deepEqual(video, {
    videoId: "BV1xx411c7mD:p2",
    url: "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
    title: "P2 Title",
  });
});

test("normalizes standard video share url and strips tracking query params", () => {
  const video = resolvePageSharedVideo({
    pageUrl:
      "https://www.bilibili.com/video/BV199W9zEEcH/?trackid=web_pegasus_0.router-web-pegasus-2479516-sm4rx.1774190259001.845&track_id=pbaes.nJHUokmlMgNKY6ahLsFY_Vlskz4FyoCSdXkr1otdqbbbIgWSL0pTE5Fudk-JApG58k_xZt0ILnIgHz5-XLvNGUg8EYTpU_o4MoinI6Er15VuK5i5FxQPuBeggPcboJq5Nm7NXhcCICPKoTd226kNeKrJZjkcGSGJbCz_4Pbl5QjVxworUhivCszJ-6MGRlUD&caid=__CAID__&resource_id=__RESOURCEID__&source_id=5614&request_id=1774190259003q172a24a62a50q693&from_spmid=__FROMSPMID__&creative_id=1228378938&linked_creative_id=1239263497&vd_source=90fe97386ffebd7ca4de9b85a001ebfb",
    pathname: "/video/BV199W9zEEcH/",
    documentTitle: "Doc Title_哔哩哔哩",
    headingTitle: "Heading Title",
    currentPartTitle: null,
    festivalSnapshot: null,
  });

  assert.deepEqual(video, {
    videoId: "BV199W9zEEcH",
    url: "https://www.bilibili.com/video/BV199W9zEEcH",
    title: "Heading Title",
  });
});

test("resolves page snapshot ahead of bangumi season URL fallback", () => {
  const video = resolvePageSharedVideo({
    pageUrl: "https://www.bilibili.com/bangumi/play/ss357",
    pathname: "/bangumi/play/ss357",
    documentTitle: "猫和老鼠_番剧_bilibili",
    headingTitle: "猫和老鼠",
    currentPartTitle: "第46话",
    pageSnapshot: {
      videoId: "ep508404",
      url: "https://www.bilibili.com/bangumi/play/ep508404",
      title: "第46话",
    },
    festivalSnapshot: null,
  });

  assert.deepEqual(video, {
    videoId: "ep508404",
    url: "https://www.bilibili.com/bangumi/play/ep508404",
    title: "第46话",
  });
});

test("resolves festival snapshot ahead of URL fallback", () => {
  const video = resolvePageSharedVideo({
    pageUrl: "https://www.bilibili.com/festival/demo",
    pathname: "/festival/demo",
    documentTitle: "Festival",
    headingTitle: null,
    currentPartTitle: null,
    festivalSnapshot: {
      videoId: "BVfestival:123",
      url: "https://www.bilibili.com/festival/demo?bvid=BVfestival&cid=123",
      title: "Festival Episode",
    },
  });

  assert.deepEqual(video, {
    videoId: "BVfestival:123",
    url: "https://www.bilibili.com/festival/demo?bvid=BVfestival&cid=123",
    title: "Festival Episode",
  });
});

test("builds share payload from video playback snapshot", () => {
  const payload = createSharePayload({
    sharedVideo: {
      videoId: "BV1xx411c7mD",
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
      title: "Video",
    },
    playback: {
      currentTime: 42,
      playbackRate: 1.25,
      playState: "playing",
    },
    actorId: "member-1",
    seq: 7,
    updatedAt: 99,
  });

  assert.equal(payload.playback?.seq, 7);
  assert.equal(payload.playback?.currentTime, 42);
  assert.equal(payload.playback?.actorId, "member-1");
});

test("falls back through title sources in order", () => {
  assert.equal(
    resolveSharedVideoTitle({
      currentPartTitle: null,
      headingTitle: "Heading",
      documentTitle: "Doc_哔哩哔哩",
    }),
    "Heading",
  );
  assert.equal(
    resolveSharedVideoTitle({
      currentPartTitle: null,
      headingTitle: null,
      documentTitle: "Doc_哔哩哔哩",
    }),
    "Doc",
  );
});

test("builds festival share URL with bvid and cid", () => {
  assert.equal(
    buildFestivalShareUrl(
      "https://www.bilibili.com/festival/demo?foo=1#hash",
      "BV1abc",
      "22",
    ),
    "https://www.bilibili.com/festival/demo?foo=1&bvid=BV1abc&cid=22",
  );
});

test("builds canonical episode and cid share URLs", () => {
  assert.equal(
    buildBangumiEpisodeShareUrl("508404"),
    "https://www.bilibili.com/bangumi/play/ep508404",
  );
  assert.equal(
    buildBangumiEpisodeShareUrl("ep508404"),
    "https://www.bilibili.com/bangumi/play/ep508404",
  );
  assert.equal(
    buildBvidCidShareUrl("BV1abc", "22"),
    "https://www.bilibili.com/video/BV1abc?cid=22",
  );
});

test("refuses the frozen festival address bar once a snapshot has resolved before", () => {
  // The festival player has moved on (the snapshot just got cleared for a
  // re-resolve), but the address bar still carries the `?bvid=` the page was
  // opened with. Answering with it would name a video that is not playing.
  const video = resolvePageSharedVideo({
    pageUrl: "https://www.bilibili.com/festival/MyMuji?bvid=BVfrozen",
    pathname: "/festival/MyMuji",
    documentTitle: "MyMuji_哔哩哔哩",
    headingTitle: null,
    currentPartTitle: null,
    festivalSnapshot: null,
    addressBarIdentityRefuted: true,
  });

  assert.equal(video, null);
});

test("still uses the festival address bar before any snapshot has resolved", () => {
  // A festival page opened from a share link: the frozen `?bvid=` IS the video
  // about to play, and until the bridge resolves it is the only identity there.
  const video = resolvePageSharedVideo({
    pageUrl: "https://www.bilibili.com/festival/MyMuji?bvid=BVshared&cid=99",
    pathname: "/festival/MyMuji",
    documentTitle: "MyMuji_哔哩哔哩",
    headingTitle: null,
    currentPartTitle: null,
    festivalSnapshot: null,
    addressBarIdentityRefuted: false,
  });

  assert.deepEqual(video, {
    videoId: "BVshared:99",
    url: "https://www.bilibili.com/video/BVshared?cid=99",
    title: "MyMuji",
  });
});
