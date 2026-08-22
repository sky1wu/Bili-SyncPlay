import assert from "node:assert/strict";
import test from "node:test";
import { Redis } from "ioredis";
import {
  RedisCommandAdmissionError,
  RedisStartupTimeoutError,
} from "../src/redis-command-timeout.js";
import { createRedisRoomEventBus } from "../src/redis-room-event-bus.js";
import type { RoomEventBusMessage } from "../src/room-event-bus.js";
import { createFakeRedisPubSubClient } from "./redis-pubsub-test-helpers.js";

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

test("redis room event bus closes and reports both clients when QUIT never answers", async () => {
  const publisher = createFakeRedisPubSubClient(
    () => new Promise(() => undefined),
  );
  const subscriber = createFakeRedisPubSubClient(
    () => new Promise(() => undefined),
  );
  const unfinished: Array<{
    role: string;
    quitOutcome: string;
    budgetMs: number;
  }> = [];
  const bus = await createRedisRoomEventBus("redis://unused", {
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
    closeQuitTimeoutMs: 20,
    onCloseUnfinished: (info) => {
      unfinished.push(info);
    },
  });
  // Model the terminal state reached after the consumer's unsubscribe has
  // already been sent but Redis stopped answering it. `close()` must go
  // straight to bounded QUIT instead of waiting on a second UNSUBSCRIBE.
  await bus.subscribe(() => undefined);
  subscriber.client.unsubscribe = () => new Promise(() => undefined);

  const startedAt = Date.now();
  await bus.close();
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(publisher.disconnectCalls(), 1);
  assert.equal(subscriber.disconnectCalls(), 1);
  assert.deepEqual(
    unfinished.sort((left, right) => left.role.localeCompare(right.role)),
    [
      { role: "publisher", quitOutcome: "timed_out", budgetMs: 20 },
      { role: "subscriber", quitOutcome: "timed_out", budgetMs: 20 },
    ],
  );
});

test("redis room event bus holds publish admission until Redis really answers", async () => {
  let releaseFirstPublish = (): void => {};
  const firstPublish = new Promise<void>((resolve) => {
    releaseFirstPublish = resolve;
  });
  let publishCalls = 0;
  const publisher = createFakeRedisPubSubClient(async () => "OK", {
    publish: async () => {
      publishCalls += 1;
      if (publishCalls === 1) {
        await firstPublish;
      }
      return 1;
    },
  });
  const subscriber = createFakeRedisPubSubClient(async () => "OK");
  const bus = await createRedisRoomEventBus("redis://unused", {
    maxPendingPublishCommands: 1,
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });
  const event = (roomCode: string): RoomEventBusMessage => ({
    type: "room_state_updated",
    roomCode,
    sourceInstanceId: "instance-a",
    emittedAt: 1,
  });

  try {
    const first = bus.publish(event("ROOM01"));
    await new Promise((resolve) => setImmediate(resolve));
    const secondOutcome = await Promise.race([
      bus.publish(event("ROOM02")).then(
        () => "settled" as const,
        (error: unknown) => error,
      ),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 50),
      ),
    ]);

    assert.ok(secondOutcome instanceof RedisCommandAdmissionError);
    assert.equal(publishCalls, 1);

    releaseFirstPublish();
    await first;
    await bus.publish(event("ROOM03"));
    assert.equal(publishCalls, 2);
  } finally {
    releaseFirstPublish();
    await bus.close();
  }
});

test("redis room event bus bounds the first SUBSCRIBE after connect", async () => {
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: () => new Promise(() => undefined),
  });
  const bus = await createRedisRoomEventBus("redis://unused", {
    subscriptionTimeoutMs: 20,
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    const outcome = await Promise.race([
      bus
        .subscribe(() => undefined)
        .then(
          () => "settled" as const,
          (error: unknown) => error,
        ),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 100),
      ),
    ]);

    assert.ok(outcome instanceof RedisStartupTimeoutError);
    assert.equal(outcome.operation, "room event bus SUBSCRIBE");
    assert.equal(subscriber.disconnectCalls(), 1);
    assert.equal(subscriber.messageListenerCount(), 0);
  } finally {
    await bus.close();
  }
});

test("a room event delivered with the SUBSCRIBE acknowledgement sees its handler", async () => {
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  let handled = false;
  const event: RoomEventBusMessage = {
    type: "room_state_updated",
    roomCode: "ROOM01",
    sourceInstanceId: "instance-a",
    emittedAt: 1,
  };
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: async () => {
      subscriber.emitMessage("bsp:room-events", JSON.stringify(event));
      return 1;
    },
  });
  const bus = await createRedisRoomEventBus("redis://unused", {
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    await bus.subscribe(() => {
      handled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handled, true);
  } finally {
    await bus.close();
  }
});

test("a new handler waits for an in-flight final UNSUBSCRIBE and resubscribes", async () => {
  let releaseFirstUnsubscribe = (): void => {};
  let markFirstUnsubscribeStarted = (): void => {};
  const firstUnsubscribeStarted = new Promise<void>((resolve) => {
    markFirstUnsubscribeStarted = resolve;
  });
  const blockedFirstUnsubscribe = new Promise<void>((resolve) => {
    releaseFirstUnsubscribe = resolve;
  });
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: async () => {
      subscribeCalls += 1;
      return 1;
    },
    unsubscribe: async () => {
      unsubscribeCalls += 1;
      if (unsubscribeCalls === 1) {
        markFirstUnsubscribeStarted();
        await blockedFirstUnsubscribe;
      }
      return 0;
    },
  });
  const bus = await createRedisRoomEventBus("redis://unused", {
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    const removeFirst = await bus.subscribe(() => undefined);
    const removingFirst = removeFirst();
    await firstUnsubscribeStarted;

    let secondSettled = false;
    const secondSubscription = bus
      .subscribe(() => undefined)
      .then((remove) => {
        secondSettled = true;
        return remove;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondSettled, false);

    releaseFirstUnsubscribe();
    await removingFirst;
    const removeSecond = await secondSubscription;
    assert.equal(subscribeCalls, 2);
    assert.equal(subscriber.messageListenerCount(), 1);
    await removeSecond();
    assert.equal(unsubscribeCalls, 2);
  } finally {
    releaseFirstUnsubscribe();
    await bus.close();
  }
});

test("redis room event bus refuses a duplicate handler without leaking a listener", async () => {
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK");
  const bus = await createRedisRoomEventBus("redis://unused", {
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });
  const handler = () => undefined;

  try {
    const remove = await bus.subscribe(handler);
    await assert.rejects(
      bus.subscribe(handler),
      /Room event handler is already subscribed/,
    );
    assert.equal(subscriber.messageListenerCount(), 1);
    await remove();
    assert.equal(subscriber.messageListenerCount(), 0);
  } finally {
    await bus.close();
  }
});

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
      throw new Error("async boom");
    });
    await bus.subscribe(() => {
      throw new Error("sync boom");
    });

    await bus.publish({
      type: "room_state_updated",
      roomCode: "ROOM01",
      sourceInstanceId: "instance-a",
      emittedAt: Date.now(),
    });

    await waitUntil(() => handlerErrors.length >= 2);
    const errorMessages = handlerErrors
      .map((entry) => (entry.error as Error).message)
      .sort();
    assert.deepEqual(errorMessages, ["async boom", "sync boom"]);
    assert.equal(handlerErrors[0]?.message.roomCode, "ROOM01");
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

test("redis room event bus resolves an unsubscribe whose ACK lands after close", async () => {
  // The consumer asked to stop receiving messages, and `close` grants exactly
  // that before the UNSUBSCRIBE is acknowledged. Rejecting here rejects a
  // promise for work that completed; consumers that unsubscribe without
  // awaiting then take the process down with an unhandled rejection.
  let acknowledgeUnsubscribe: () => void = () => undefined;
  let unsubscribeIssued: () => void = () => undefined;
  const unsubscribeReachedRedis = new Promise<void>((resolve) => {
    unsubscribeIssued = resolve;
  });
  const subscriber = createFakeRedisPubSubClient(async () => undefined, {
    unsubscribe: () =>
      new Promise((resolve) => {
        acknowledgeUnsubscribe = () => resolve(1);
        unsubscribeIssued();
      }),
  });
  const publisher = createFakeRedisPubSubClient(async () => undefined);
  const bus = await createRedisRoomEventBus("redis://unused", {
    channel: createChannel(),
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  const unsubscribe = await bus.subscribe(() => undefined);
  const unsubscribed = unsubscribe();
  await unsubscribeReachedRedis;
  const closed = bus.close();
  acknowledgeUnsubscribe();

  await assert.doesNotReject(unsubscribed);
  await closed;
  assert.equal(subscriber.messageListenerCount(), 0);
});

test("redis room event bus rejects a subscribe whose ACK lands after close", async () => {
  // The opposite intent gets the opposite answer: `close` refuses to let a late
  // SUBSCRIBE mark the bus subscribed, so the caller must not be handed a
  // subscription that does not exist.
  let acknowledgeSubscribe: () => void = () => undefined;
  let subscribeIssued: () => void = () => undefined;
  const subscribeReachedRedis = new Promise<void>((resolve) => {
    subscribeIssued = resolve;
  });
  const subscriber = createFakeRedisPubSubClient(async () => undefined, {
    subscribe: () =>
      new Promise((resolve) => {
        acknowledgeSubscribe = () => resolve(1);
        subscribeIssued();
      }),
  });
  const publisher = createFakeRedisPubSubClient(async () => undefined);
  const bus = await createRedisRoomEventBus("redis://unused", {
    channel: createChannel(),
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  const subscribed = bus.subscribe(() => undefined);
  await subscribeReachedRedis;
  const closed = bus.close();
  acknowledgeSubscribe();

  await assert.rejects(subscribed, {
    message: "Room event bus closed while changing its subscription.",
  });
  await closed;
  assert.equal(subscriber.messageListenerCount(), 0);
});
