import assert from "node:assert/strict";
import test from "node:test";
import type { RoomState } from "@bili-syncplay/protocol";
import { createClockController } from "../src/background/clock-controller";
import type {
  ClockState,
  ConnectionState,
} from "../src/background/runtime-state";

function createHarness(): {
  controller: ReturnType<typeof createClockController>;
  clockState: ClockState;
  setMonotonicNow: (value: number) => void;
} {
  let monotonicNow = 1_000;
  const clockState: ClockState = {
    clockOffsetMs: null,
    rttMs: null,
    clockSamples: [],
    clockSyncTimer: null,
  };
  const controller = createClockController({
    connectionState: { connected: true } as unknown as ConnectionState,
    clockState,
    sendToServer: () => {},
    log: () => {},
    getMonotonicNow: () => monotonicNow,
  });

  return {
    controller,
    clockState,
    setMonotonicNow: (value) => {
      monotonicNow = value;
    },
  };
}

function roomState(args: {
  seq: number;
  currentTime: number;
  playState?: "playing" | "paused";
  playbackRate?: number;
  serverTime?: number;
}): RoomState {
  return {
    roomCode: "ABC123",
    members: [],
    sharedVideo: null,
    playback: {
      actorId: "peer",
      seq: args.seq,
      url: "https://www.bilibili.com/video/BV1",
      playState: args.playState ?? "playing",
      currentTime: args.currentTime,
      playbackRate: args.playbackRate ?? 1,
      serverTime: args.serverTime ?? 0,
    },
  } as unknown as RoomState;
}

test("a freshly arrived snapshot is passed through as reported", () => {
  const { controller } = createHarness();

  const compensated = controller.compensateRoomState(
    roomState({ seq: 1, currentTime: 42 }),
  );

  assert.equal(compensated.playback!.currentTime, 42);
});

test("replaying the same snapshot advances it by the time since it arrived", () => {
  const { controller, setMonotonicNow } = createHarness();
  const state = roomState({ seq: 1, currentTime: 42 });

  controller.compensateRoomState(state);
  setMonotonicNow(3_500);

  // 2.5s of real time passed since this snapshot arrived, so the room has moved
  // on by 2.5s of content — a late-binding tab must be told where it is *now*.
  assert.ok(
    Math.abs(
      controller.compensateRoomState(state).playback!.currentTime - 44.5,
    ) < 0.001,
  );
});

test("anchors on the supplied arrival stamp, not on the call", () => {
  // Work between arrival and applying a snapshot (persisting state, opening the
  // shared video's tab) is not instant, and the room plays on through it.
  const { controller, setMonotonicNow } = createHarness();
  setMonotonicNow(1_800);

  const compensated = controller.compensateRoomState(
    roomState({ seq: 1, currentTime: 42 }),
    1_000,
  );

  assert.ok(Math.abs(compensated.playback!.currentTime - 42.8) < 0.001);
});

test("keeps extrapolating from the arrival stamp on later replays", () => {
  const { controller, setMonotonicNow } = createHarness();
  const state = roomState({ seq: 1, currentTime: 42 });
  setMonotonicNow(1_500);
  controller.compensateRoomState(state, 1_000);

  setMonotonicNow(3_000);

  assert.ok(
    Math.abs(controller.compensateRoomState(state).playback!.currentTime - 44) <
      0.001,
  );
});

test("each new snapshot re-anchors instead of accumulating", () => {
  const { controller, setMonotonicNow } = createHarness();

  controller.compensateRoomState(roomState({ seq: 1, currentTime: 42 }));
  setMonotonicNow(3_100);
  const next = controller.compensateRoomState(
    roomState({ seq: 2, currentTime: 44.1 }),
  );

  assert.equal(next.playback!.currentTime, 44.1);
});

test("a wall-clock step cannot move the extrapolated position", () => {
  // The failure this design exists to remove: the server in WSL and the browser
  // on the host disagree by an amount that jumps by ~1s within a ping interval.
  // Anchoring on a monotonic local clock makes `serverTime` — and therefore any
  // disagreement with it — irrelevant.
  const { controller, setMonotonicNow } = createHarness();
  const arrived = roomState({ seq: 1, currentTime: 42, serverTime: 1_000 });
  controller.compensateRoomState(arrived);

  setMonotonicNow(2_000);
  const stepped = controller.compensateRoomState(
    roomState({ seq: 1, currentTime: 42, serverTime: 1_000 }),
  );

  assert.ok(Math.abs(stepped.playback!.currentTime - 43) < 0.001);
});

test("scales the advance by the room playback rate", () => {
  const { controller, setMonotonicNow } = createHarness();
  const state = roomState({ seq: 1, currentTime: 42, playbackRate: 2 });

  controller.compensateRoomState(state);
  setMonotonicNow(2_000);

  assert.ok(
    Math.abs(controller.compensateRoomState(state).playback!.currentTime - 44) <
      0.001,
  );
});

test("paused snapshots are never extrapolated", () => {
  const { controller, setMonotonicNow } = createHarness();
  const paused = roomState({ seq: 1, currentTime: 42, playState: "paused" });

  controller.compensateRoomState(paused);
  setMonotonicNow(60_000);

  assert.equal(
    controller.compensateRoomState(paused).playback!.currentTime,
    42,
  );
});

test("a paused snapshot does not become the anchor for the next playing one", () => {
  const { controller, setMonotonicNow } = createHarness();

  controller.compensateRoomState(
    roomState({ seq: 1, currentTime: 42, playState: "paused" }),
  );
  setMonotonicNow(30_000);
  const resumed = controller.compensateRoomState(
    roomState({ seq: 2, currentTime: 42 }),
  );

  assert.equal(resumed.playback!.currentTime, 42);
});

test("updateClockOffset still publishes the diagnostic offset and rtt", () => {
  const { controller, clockState } = createHarness();

  // A round trip of ~40ms with the server clock ~200ms ahead. The reply is timed
  // against the real wall clock inside the controller, so allow a few ms of slack
  // for the call itself.
  const sentAt = Date.now() - 40;
  const serverStamp = sentAt + 20 + 200;
  controller.updateClockOffset(sentAt, serverStamp, serverStamp);

  assert.ok(
    Math.abs(clockState.rttMs! - 40) <= 5,
    `unexpected rtt ${clockState.rttMs}`,
  );
  assert.ok(
    Math.abs(clockState.clockOffsetMs! - 200) <= 5,
    `unexpected offset ${clockState.clockOffsetMs}`,
  );
  assert.equal(clockState.clockSamples.length, 1);
});

test("a reused seq at a repeated position is still a new snapshot", () => {
  // `seq` restarts at 0 on every content-script load, so identity cannot rest on
  // it: a member who reloads and resumes where an early-seq snapshot already was
  // would otherwise match a key the controller has seen, and inherit its anchor.
  const { controller, setMonotonicNow } = createHarness();
  controller.compensateRoomState(
    roomState({ seq: 1, currentTime: 42, serverTime: 1_000 }),
  );

  setMonotonicNow(120_000);
  const afterReload = controller.compensateRoomState(
    roomState({ seq: 1, currentTime: 42, serverTime: 500_000 }),
  );

  assert.equal(afterReload.playback!.currentTime, 42);
});

test("a pause drops the anchor so nothing extrapolates across it", () => {
  const { controller, setMonotonicNow } = createHarness();
  const playing = roomState({ seq: 1, currentTime: 42, serverTime: 1_000 });
  controller.compensateRoomState(playing);

  controller.compensateRoomState(
    roomState({
      seq: 2,
      currentTime: 42,
      serverTime: 2_000,
      playState: "paused",
    }),
  );
  setMonotonicNow(120_000);

  // Same snapshot as before the pause: without dropping the anchor this would be
  // advanced by the whole paused interval.
  assert.equal(
    controller.compensateRoomState(playing).playback!.currentTime,
    42,
  );
});

test("an explicit arrival corrects an anchor a reader established late", () => {
  // A snapshot is readable before its own handler finishes, so a rehydrating
  // content script can ask for it — with no arrival time — first, anchoring it at
  // request time. Reported by Codex review on #210.
  const { controller, setMonotonicNow } = createHarness();
  const state = roomState({ seq: 1, currentTime: 42, serverTime: 1_000 });

  setMonotonicNow(2_500);
  controller.compensateRoomState(state); // hydration read, anchors at 2500
  setMonotonicNow(3_000);
  controller.compensateRoomState(state, 1_000); // handler: it arrived at 1000

  setMonotonicNow(4_000);

  // 3s since the real arrival, not 1.5s since it was first read.
  assert.ok(
    Math.abs(controller.compensateRoomState(state).playback!.currentTime - 45) <
      0.001,
  );
});

test("a later arrival stamp never pushes an anchor forward", () => {
  const { controller, setMonotonicNow } = createHarness();
  const state = roomState({ seq: 1, currentTime: 42, serverTime: 1_000 });
  controller.compensateRoomState(state, 1_000);

  setMonotonicNow(3_000);
  controller.compensateRoomState(state, 2_500);

  assert.ok(
    Math.abs(controller.compensateRoomState(state).playback!.currentTime - 44) <
      0.001,
  );
});
