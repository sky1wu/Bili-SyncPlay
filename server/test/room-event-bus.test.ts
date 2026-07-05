import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemoryRoomEventBus,
  createNoopRoomEventBus,
} from "../src/room-event-bus.js";

test("in-memory room event bus delivers published messages to subscribers", async () => {
  const bus = createInMemoryRoomEventBus();
  const received: Array<{ type: string; roomCode: string }> = [];

  const unsubscribe = await bus.subscribe((message) => {
    received.push({
      type: message.type,
      roomCode: message.roomCode,
    });
  });

  await bus.publish({
    type: "room_member_changed",
    roomCode: "ROOM01",
    sourceInstanceId: "instance-a",
    emittedAt: 1_000,
  });

  assert.deepEqual(received, [
    {
      type: "room_member_changed",
      roomCode: "ROOM01",
    },
  ]);

  await unsubscribe();
  await bus.publish({
    type: "room_deleted",
    roomCode: "ROOM01",
    sourceInstanceId: "instance-a",
    emittedAt: 1_100,
  });

  assert.equal(received.length, 1);
});

test("in-memory room event bus isolates throwing subscribers from the rest", async () => {
  const bus = createInMemoryRoomEventBus();
  const received: string[] = [];

  await bus.subscribe(() => {
    throw new Error("sync boom");
  });
  await bus.subscribe(async () => {
    throw new Error("async boom");
  });
  await bus.subscribe((message) => {
    received.push(message.roomCode);
  });

  await bus.publish({
    type: "room_state_updated",
    roomCode: "ROOM01",
    sourceInstanceId: "instance-a",
    emittedAt: 1_000,
  });

  assert.deepEqual(received, ["ROOM01"]);
});

test("noop room event bus accepts publish and subscribe without side effects", async () => {
  const bus = createNoopRoomEventBus();
  const unsubscribe = await bus.subscribe(() => {
    throw new Error("noop room event bus must not invoke subscribers");
  });

  await bus.publish({
    type: "room_state_updated",
    roomCode: "ROOM02",
    sourceInstanceId: "instance-b",
    emittedAt: 2_000,
  });

  await unsubscribe();
  assert.ok(true);
});
