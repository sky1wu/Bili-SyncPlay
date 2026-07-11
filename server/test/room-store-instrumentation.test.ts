import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryRoomStore } from "../src/room-store.js";
import { instrumentRoomStore } from "../src/room-store-instrumentation.js";

function createRecorder() {
  const durations: Array<{ operation: string; durationMs: number }> = [];
  const failures: string[] = [];
  return {
    durations,
    failures,
    collector: {
      observeRedisRoomStoreDuration(operation: string, durationMs: number) {
        durations.push({ operation, durationMs });
      },
      observeRedisRoomStoreFailure(operation: string) {
        failures.push(operation);
      },
    },
  };
}

test("instrumented room store records a duration sample per operation", async () => {
  const recorder = createRecorder();
  const store = instrumentRoomStore(
    createInMemoryRoomStore({ now: () => 0 }),
    recorder.collector,
  );

  const room = await store.createRoom({
    code: "ROOM01",
    joinToken: "join-token-1",
    createdAt: 0,
    ownerMemberId: "member-1",
    ownerDisplayName: "Alice",
  });
  const fetched = await store.getRoom(room.code);
  const missing = await store.getRoom("NOPE01");
  await store.countRooms({ keyword: undefined, includeExpired: true });

  assert.equal(fetched?.code, room.code);
  assert.equal(missing, null);
  assert.deepEqual(
    recorder.durations.map((entry) => entry.operation),
    ["create_room", "get_room", "get_room", "count_rooms"],
  );
  assert.equal(
    recorder.durations.every((entry) => entry.durationMs >= 0),
    true,
  );
  assert.deepEqual(recorder.failures, []);
});

test("instrumented room store counts failures and still records duration", async () => {
  const recorder = createRecorder();
  const store = instrumentRoomStore(
    {
      ...createInMemoryRoomStore({ now: () => 0 }),
      async updateRoom() {
        throw new Error("redis unavailable");
      },
    },
    recorder.collector,
  );

  await assert.rejects(
    store.updateRoom("ROOM01", 1, { expiresAt: null }),
    /redis unavailable/,
  );

  assert.deepEqual(recorder.failures, ["update_room"]);
  assert.deepEqual(
    recorder.durations.map((entry) => entry.operation),
    ["update_room"],
  );
});

test("instrumented room store preserves the underlying close hook", async () => {
  const recorder = createRecorder();
  let closed = 0;
  const store = instrumentRoomStore(
    {
      ...createInMemoryRoomStore({ now: () => 0 }),
      async close() {
        closed += 1;
      },
    } as never,
    recorder.collector,
  );

  // Shutdown probes structurally ("close" in store) — the hook must survive
  // wrapping and forward to the underlying store without being instrumented.
  assert.equal("close" in store, true);
  await (store as { close?: () => Promise<void> }).close?.();
  assert.equal(closed, 1);
  assert.deepEqual(recorder.durations, []);
});

test("instrumented room store adds no close hook when the underlying store has none", () => {
  const recorder = createRecorder();
  const store = instrumentRoomStore(
    createInMemoryRoomStore({ now: () => 0 }),
    recorder.collector,
  );

  assert.equal("close" in store, false);
});
