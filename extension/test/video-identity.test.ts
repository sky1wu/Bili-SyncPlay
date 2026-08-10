import assert from "node:assert/strict";
import test from "node:test";
import {
  contradictsAddressBarEpisode,
  readAddressBarEpisodeId,
} from "../src/content/video-identity";

// #274 turned on one distinction: which routes name their video in the address
// bar. Getting it wrong in either direction is a bug, so both polarities are
// asserted here rather than only through the share controller.

test("an ep route names its episode in the address bar", () => {
  assert.equal(
    readAddressBarEpisodeId("/bangumi/play/ep396139"),
    "ep396139",
    "the reported page",
  );
  assert.equal(readAddressBarEpisodeId("/bangumi/play/ep396139/"), "ep396139");
  assert.equal(readAddressBarEpisodeId("/bangumi/play/EP396139"), "ep396139");
});

test("routes whose address bar does not name the playing video answer null", () => {
  // Opposite polarity: a season route names no episode, and a festival route
  // keeps a frozen `?bvid=` while the player walks a whole playlist. Reading an
  // episode out of either would refute the very snapshots they depend on.
  assert.equal(readAddressBarEpisodeId("/bangumi/play/ss357"), null);
  assert.equal(readAddressBarEpisodeId("/festival/MyMuji"), null);
  assert.equal(readAddressBarEpisodeId("/video/BV199W9zEEcH"), null);
  assert.equal(readAddressBarEpisodeId("/bangumi/play/ep396139/extra"), null);
});

test("a contradiction needs both sides to be known", () => {
  assert.equal(
    contradictsAddressBarEpisode({
      pathname: "/bangumi/play/ep396139",
      episodeId: "ep396138",
    }),
    true,
  );
  assert.equal(
    contradictsAddressBarEpisode({
      pathname: "/bangumi/play/ep396139",
      episodeId: "ep396139",
    }),
    false,
  );
  // A `bvid:cid` snapshot names no episode, so it cannot be compared — refuting
  // it would be a guess, not a contradiction.
  assert.equal(
    contradictsAddressBarEpisode({
      pathname: "/bangumi/play/ep396139",
      episodeId: null,
    }),
    false,
  );
  assert.equal(
    contradictsAddressBarEpisode({
      pathname: "/bangumi/play/ss357",
      episodeId: "ep396138",
    }),
    false,
  );
  assert.equal(
    contradictsAddressBarEpisode({
      pathname: "/festival/MyMuji",
      episodeId: "ep396138",
    }),
    false,
  );
});
