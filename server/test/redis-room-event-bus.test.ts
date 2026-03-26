import assert from "node:assert/strict";
import test from "node:test";
import { createRedisRoomEventBus } from "../src/redis-room-event-bus.js";

const REDIS_URL = process.env.REDIS_URL;

function createChannel(): string {
  return `bsp:test:room-events:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

test("redis room event bus delivers published events across instances", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const channel = createChannel();
  const publisher = await createRedisRoomEventBus(REDIS_URL, { channel });
  const subscriber = await createRedisRoomEventBus(REDIS_URL, { channel });

  try {
    const receivedPromise = new Promise<{
      type: string;
      roomCode: string;
      sourceInstanceId: string;
    } | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for room event."));
      }, 2_000);

      void subscriber
        .subscribe((message) => {
          clearTimeout(timer);
          void unsubscribePromise.then((unsubscribe) => unsubscribe());
          resolve({
            type: message.type,
            roomCode: message.roomCode,
            sourceInstanceId: message.sourceInstanceId,
          });
        })
        .then((unsubscribe) => {
          unsubscribePromise = Promise.resolve(unsubscribe);
          return publisher.publish({
            type: "room_state_updated",
            roomCode: "ROOM01",
            sourceInstanceId: "instance-a",
            emittedAt: Date.now(),
          });
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });

      let unsubscribePromise = Promise.resolve(async () => {});
    });
    const received = await receivedPromise;

    assert.deepEqual(received, {
      type: "room_state_updated",
      roomCode: "ROOM01",
      sourceInstanceId: "instance-a",
    });
  } finally {
    await publisher.close();
    await subscriber.close();
  }
});
