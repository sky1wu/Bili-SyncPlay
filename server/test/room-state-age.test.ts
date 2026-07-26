import assert from "node:assert/strict";
import test from "node:test";
import type { PlaybackState, RoomState } from "@bili-syncplay/protocol";
import { withPlaybackAge } from "../src/room-state-age.js";

function roomState(playback: Partial<PlaybackState> | null): RoomState {
  return {
    roomCode: "ROOM01",
    sharedVideo: null,
    members: [{ id: "member-1", name: "Alice" }],
    playback: playback
      ? {
          url: "https://www.bilibili.com/video/BV1xx411c7mD",
          currentTime: 42,
          playState: "playing",
          playbackRate: 1,
          updatedAt: 10_000,
          serverTime: 10_000,
          actorId: "member-1",
          seq: 1,
          ...playback,
        }
      : null,
  };
}

test("reports how long ago the snapshot was stamped", () => {
  const payload = withPlaybackAge(roomState({ serverTime: 10_000 }), 12_100);

  assert.equal(payload.playbackAgeMs, 2_100);
});

test("a snapshot stamped at this instant has no age", () => {
  const payload = withPlaybackAge(roomState({ serverTime: 12_100 }), 12_100);

  assert.equal(payload.playbackAgeMs, 0);
});

test("a snapshot stamped by a node running ahead reports as current", () => {
  // Multi-node: `serverTime` came from another node, whose clock can sit ahead
  // of this one's. A negative duration is meaningless (and rejected by the
  // protocol guard), so report the snapshot as current rather than as one from
  // the future.
  const payload = withPlaybackAge(roomState({ serverTime: 12_500 }), 12_100);

  assert.equal(payload.playbackAgeMs, 0);
});

test("a room with no playback gets no age", () => {
  const payload = withPlaybackAge(roomState(null), 12_100);

  assert.equal(payload.playbackAgeMs, undefined);
  assert.equal("playbackAgeMs" in payload, false);
});

test("the room state is left otherwise untouched", () => {
  const state = roomState({ serverTime: 10_000 });

  const payload = withPlaybackAge(state, 12_100);

  const { playbackAgeMs, ...rest } = payload;
  assert.equal(playbackAgeMs, 2_100);
  assert.deepEqual(rest, state);
  // The stored state must not gain the field: an age is only true at the instant
  // it is sent, and a stored one is a timestamp in disguise.
  assert.equal("playbackAgeMs" in state, false);
});

test("the age is recomputed per send rather than fixed to the snapshot", () => {
  const state = roomState({ serverTime: 10_000 });

  assert.equal(withPlaybackAge(state, 11_000).playbackAgeMs, 1_000);
  assert.equal(withPlaybackAge(state, 13_000).playbackAgeMs, 3_000);
});
