import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import { createRedisRoomEventBus } from "../src/redis-room-event-bus.js";
import type { RoomEventBusMessage } from "../src/room-event-bus.js";

const REDIS_URL = process.env.REDIS_URL;

function createChannel(): string {
  return `bsp:test:room-events:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

test("redis room event bus reports invalid payloads without invoking handlers", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const channel = createChannel();
  const invalidPayloads: string[] = [];
  const received: RoomEventBusMessage[] = [];
  const bus = await createRedisRoomEventBus(REDIS_URL, {
    channel,
    onInvalidMessage: (payload) => {
      invalidPayloads.push(payload);
    },
  });
  const rawPublisher = new Redis(REDIS_URL);

  try {
    await bus.subscribe((message) => {
      received.push(message);
    });

    const badPayloads = [
      "not-json",
      JSON.stringify(null),
      JSON.stringify({ type: "room_state_updated" }),
      JSON.stringify({
        type: "unknown_event",
        roomCode: "ROOM01",
        sourceInstanceId: "instance-a",
        emittedAt: Date.now(),
      }),
      JSON.stringify({
        type: "room_member_joined",
        roomCode: "ROOM01",
        sourceInstanceId: "instance-a",
        emittedAt: Date.now(),
      }),
    ];
    for (const payload of badPayloads) {
      await rawPublisher.publish(channel, payload);
    }

    await waitUntil(() => invalidPayloads.length >= badPayloads.length);
    assert.deepEqual(invalidPayloads, badPayloads);
    assert.equal(received.length, 0);
  } finally {
    await rawPublisher.quit();
    await bus.close();
  }
});

test("redis room event bus delivers member events with member fields", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const channel = createChannel();
  const received: RoomEventBusMessage[] = [];
  const bus = await createRedisRoomEventBus(REDIS_URL, { channel });

  try {
    await bus.subscribe((message) => {
      received.push(message);
    });

    const event: RoomEventBusMessage = {
      type: "room_member_left",
      roomCode: "ROOM01",
      sourceInstanceId: "instance-a",
      emittedAt: 1234,
      memberId: "member-1",
      displayName: "Alice",
    };
    await bus.publish(event);

    await waitUntil(() => received.length >= 1);
    assert.deepEqual(received, [event]);
  } finally {
    await bus.close();
  }
});

test("redis room event bus reports handler errors", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const channel = createChannel();
  const handlerErrors: Array<{
    message: RoomEventBusMessage;
    error: unknown;
  }> = [];
  const bus = await createRedisRoomEventBus(REDIS_URL, {
    channel,
    onHandlerError: (message, error) => {
      handlerErrors.push({ message, error });
    },
  });

  try {
    await bus.subscribe(async () => {
      throw new Error("handler boom");
    });

    await bus.publish({
      type: "room_state_updated",
      roomCode: "ROOM01",
      sourceInstanceId: "instance-a",
      emittedAt: Date.now(),
    });

    await waitUntil(() => handlerErrors.length >= 1);
    assert.equal(handlerErrors[0]?.message.roomCode, "ROOM01");
    assert.equal((handlerErrors[0]?.error as Error).message, "handler boom");
  } finally {
    await bus.close();
  }
});

test("redis room event bus stops delivery after unsubscribe and tolerates double unsubscribe", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const channel = createChannel();
  const keptDeliveries: RoomEventBusMessage[] = [];
  const removedDeliveries: RoomEventBusMessage[] = [];
  const bus = await createRedisRoomEventBus(REDIS_URL, { channel });

  try {
    await bus.subscribe((message) => {
      keptDeliveries.push(message);
    });
    const unsubscribe = await bus.subscribe((message) => {
      removedDeliveries.push(message);
    });

    await unsubscribe();
    await unsubscribe();

    await bus.publish({
      type: "room_state_updated",
      roomCode: "ROOM01",
      sourceInstanceId: "instance-a",
      emittedAt: Date.now(),
    });

    await waitUntil(() => keptDeliveries.length >= 1);
    assert.equal(removedDeliveries.length, 0);
  } finally {
    await bus.close();
  }
});

test("redis room event bus ignores publish and subscribe after close", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const channel = createChannel();
  const received: RoomEventBusMessage[] = [];
  const bus = await createRedisRoomEventBus(REDIS_URL, { channel });
  await bus.subscribe((message) => {
    received.push(message);
  });
  await bus.close();

  await bus.publish({
    type: "room_state_updated",
    roomCode: "ROOM01",
    sourceInstanceId: "instance-a",
    emittedAt: Date.now(),
  });
  const unsubscribe = await bus.subscribe((message) => {
    received.push(message);
  });
  await unsubscribe();

  assert.equal(received.length, 0);
});

test("redis room event bus records publish metrics on success and failure", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const channel = createChannel();
  const durations: number[] = [];
  let failures = 0;
  const bus = await createRedisRoomEventBus(REDIS_URL, {
    channel,
    metricsCollector: {
      observeRedisRoomEventBusPublishDuration: (duration) => {
        durations.push(duration);
      },
      observeRedisRoomEventBusPublishFailure: () => {
        failures += 1;
      },
    },
  });

  try {
    await bus.publish({
      type: "room_state_updated",
      roomCode: "ROOM01",
      sourceInstanceId: "instance-a",
      emittedAt: Date.now(),
    });
    assert.equal(durations.length, 1);
    assert.equal(failures, 0);

    const circular: Record<string, unknown> = {
      type: "room_state_updated",
      roomCode: "ROOM01",
      sourceInstanceId: "instance-a",
      emittedAt: Date.now(),
    };
    circular.self = circular;
    await assert.rejects(
      bus.publish(circular as unknown as RoomEventBusMessage),
      TypeError,
    );
    assert.equal(failures, 1);
    assert.equal(durations.length, 2);
  } finally {
    await bus.close();
  }
});
