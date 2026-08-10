import assert from "node:assert/strict";
import test from "node:test";
import {
  markStalePageRecords,
  titleRecordKey,
} from "../src/content/page-record-staleness";

// #274 came back six review rounds running, each time as another page source
// rebuilding the answer the previous fix had cut. The space is small enough to
// enumerate, so it is enumerated here rather than sampled one bug at a time:
// four record kinds, three ways for two records to be the same one, one seed
// rule, one immunity rule.

const EP_PAGE = "/bangumi/play/ep396139";

test("a record naming another episode is stale, and one naming this episode is not", () => {
  assert.deepEqual(
    markStalePageRecords({
      pathname: EP_PAGE,
      records: [{ episodeId: "ep396138" }, { episodeId: "ep396139" }, {}],
    }),
    [true, false, false],
  );
});

test("staleness propagates across each of the three ways records match", () => {
  // The seed is always the same; only the link changes. Each of these is a bug
  // that was reported separately.
  for (const [label, linked] of [
    ["episode id", { episodeId: "ep396138" }],
    ["cid", { cid: "1200334" }],
    ["title", { title: "44 连影" }],
  ] as const) {
    assert.deepEqual(
      markStalePageRecords({
        pathname: EP_PAGE,
        records: [
          { episodeId: "ep396138", cid: "1200334", title: "44 连影" },
          linked,
        ],
      }),
      [true, true],
      label,
    );
  }
});

test("staleness follows a chain, not just a direct link", () => {
  // The round-six report: the list item is stale by its own episode id, the
  // snapshot inherits it through a shared cid, and `h1` inherits it from the
  // snapshot's title. A single pass over the records would stop at the snapshot.
  assert.deepEqual(
    markStalePageRecords({
      pathname: EP_PAGE,
      records: [
        { episodeId: "ep396138", cid: "1200334", title: "第44话" },
        { cid: "1200334", title: "44 连影" },
        { title: "44 连影" },
        { title: "45 某话_番剧_bilibili" },
      ],
    }),
    [true, true, true, false],
  );
});

test("a chain is followed in either direction", () => {
  // Order in the list is presentation, not evidence: the same three records with
  // the seed last must reach the same answer.
  assert.deepEqual(
    markStalePageRecords({
      pathname: EP_PAGE,
      records: [
        { title: "44 连影" },
        { cid: "1200334", title: "44 连影" },
        { episodeId: "ep396138", cid: "1200334" },
      ],
    }),
    [true, true, true],
  );
});

test("a record confirmed by the address bar is never marked, whatever it links to", () => {
  // Direct confirmation outranks propagation. Inconsistent page data must not
  // let a shared cid overrule the one source that cannot be stale.
  assert.deepEqual(
    markStalePageRecords({
      pathname: EP_PAGE,
      records: [
        { episodeId: "ep396138", cid: "1200334" },
        { episodeId: "ep396139", cid: "1200334" },
      ],
    }),
    [true, false],
  );
});

test("titles are linked on the key the resolver compares, suffix and all", () => {
  // `OVA_1` and the `OVA` cut out of `OVA_1_番剧_bilibili` are one title.
  assert.deepEqual(
    markStalePageRecords({
      pathname: EP_PAGE,
      records: [
        { episodeId: "ep396138", title: "OVA_1" },
        { title: "OVA_1_番剧_bilibili" },
        { title: "OVA" },
      ],
    }),
    [true, true, true],
  );
});

test("nothing is marked without a seed", () => {
  assert.deepEqual(
    markStalePageRecords({
      pathname: EP_PAGE,
      records: [
        { episodeId: "ep396139", cid: "1200334", title: "45 某话" },
        { cid: "1200334", title: "45 某话" },
        { title: "45 某话" },
      ],
    }),
    [false, false, false],
  );
});

test("routes whose address bar names no episode mark nothing at all", () => {
  // Reverse polarity. A season or festival route has nothing to prove anything
  // against, and marking there would leave those pages with no title and no
  // resolvable video.
  for (const pathname of [
    "/bangumi/play/ss357",
    "/festival/MyMuji",
    "/video/BV199W9zEEcH",
  ]) {
    assert.deepEqual(
      markStalePageRecords({
        pathname,
        records: [
          { episodeId: "ep396138", cid: "1200334", title: "44 连影" },
          { cid: "1200334" },
          { title: "44 连影" },
        ],
      }),
      [false, false, false],
      pathname,
    );
  }
});

test("absent records and empty fields link nothing", () => {
  // An empty string is not a shared value; treating it as one would collapse
  // every record that simply knows nothing into a single stale blob.
  assert.deepEqual(
    markStalePageRecords({
      pathname: EP_PAGE,
      records: [
        { episodeId: "ep396138" },
        null,
        { cid: "", title: "" },
        { episodeId: null, cid: null, title: null },
      ],
    }),
    [true, false, false, false],
  );
});

test("title keys cut the site suffix and survive titles without one", () => {
  assert.equal(titleRecordKey("44 连影_番剧_bilibili"), "44 连影");
  assert.equal(titleRecordKey("44 连影"), "44 连影");
  assert.equal(titleRecordKey("  44 连影  "), "44 连影");
  assert.equal(titleRecordKey("_番剧_bilibili"), "_番剧_bilibili");
});
