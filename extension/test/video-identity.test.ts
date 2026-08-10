import assert from "node:assert/strict";
import test from "node:test";
import {
  contradictsAddressBarEpisode,
  lacksAddressBarEpisodeConfirmation,
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

test("using an identity takes confirmation, while discarding a record takes proof", () => {
  // The two bars are deliberately different. An `ep` address bar answers identity
  // completely, so an unconfirmed snapshot is free to reject; it answers nothing
  // about titles, so a record is only discarded on proof.
  const unknownEpisodeOnEpRoute = {
    pathname: "/bangumi/play/ep396139",
    episodeId: null,
  };
  assert.equal(
    lacksAddressBarEpisodeConfirmation(unknownEpisodeOnEpRoute),
    true,
    "a bvid:cid snapshot is not confirmed to be this episode",
  );
  assert.equal(
    contradictsAddressBarEpisode(unknownEpisodeOnEpRoute),
    false,
    "and it does not prove the list item stale either",
  );
});

test("a route that names no episode confirms everything and refutes nothing", () => {
  // Both predicates must stay inert off the `ep` route, or a season page ends up
  // with no resolvable video at all.
  for (const pathname of [
    "/bangumi/play/ss357",
    "/festival/MyMuji",
    "/video/BV199W9zEEcH",
  ]) {
    assert.equal(
      lacksAddressBarEpisodeConfirmation({ pathname, episodeId: null }),
      false,
      pathname,
    );
    assert.equal(
      lacksAddressBarEpisodeConfirmation({ pathname, episodeId: "ep396138" }),
      false,
      pathname,
    );
    assert.equal(
      contradictsAddressBarEpisode({ pathname, episodeId: "ep396138" }),
      false,
      pathname,
    );
  }
});
