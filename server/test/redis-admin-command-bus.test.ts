import assert from "node:assert/strict";
import test from "node:test";
import { createRedisAdminCommandBus } from "../src/redis-admin-command-bus.js";
import { createFakeRedisPubSubClient } from "./redis-pubsub-test-helpers.js";

const REDIS_URL = process.env.REDIS_URL;

function createChannelPrefix(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}:`;
}

test("redis admin command bus closes and reports both clients when QUIT never answers", async () => {
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
  const bus = await createRedisAdminCommandBus("redis://unused", {
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
    closeQuitTimeoutMs: 20,
    onCloseUnfinished: (info) => {
      unfinished.push(info);
    },
  });

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

test("redis admin command bus routes commands to the target instance and returns results", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const commandChannelPrefix = createChannelPrefix("bsp:test:admin-command");
  const resultChannelPrefix = createChannelPrefix(
    "bsp:test:admin-command-result",
  );
  const busA = await createRedisAdminCommandBus(REDIS_URL, {
    commandChannelPrefix,
    resultChannelPrefix,
  });
  const busB = await createRedisAdminCommandBus(REDIS_URL, {
    commandChannelPrefix,
    resultChannelPrefix,
  });

  const unsubscribe = await busB.subscribe("node-b", async (command) => ({
    requestId: command.requestId,
    targetInstanceId: command.targetInstanceId,
    executorInstanceId: "node-b",
    status: "ok",
    roomCode: command.kind === "kick_member" ? command.roomCode : null,
    memberId: command.kind === "kick_member" ? command.memberId : undefined,
    sessionId:
      command.kind === "disconnect_session" ? command.sessionId : undefined,
    completedAt: 5_000,
  }));

  try {
    const result = await busA.request({
      kind: "disconnect_session",
      requestId: "req-redis-1",
      targetInstanceId: "node-b",
      sessionId: "session-1",
      requestedAt: 4_000,
    });

    assert.deepEqual(result, {
      requestId: "req-redis-1",
      targetInstanceId: "node-b",
      executorInstanceId: "node-b",
      status: "ok",
      roomCode: null,
      memberId: undefined,
      sessionId: "session-1",
      completedAt: 5_000,
    });
  } finally {
    await unsubscribe();
    await busA.close();
    await busB.close();
  }
});

test("redis admin command bus reports stale target when no subscriber responds", async (t) => {
  if (!REDIS_URL) {
    t.skip("REDIS_URL is not configured.");
    return;
  }

  const bus = await createRedisAdminCommandBus(REDIS_URL, {
    commandChannelPrefix: createChannelPrefix("bsp:test:admin-command"),
    resultChannelPrefix: createChannelPrefix("bsp:test:admin-command-result"),
  });

  try {
    const result = await bus.request(
      {
        kind: "kick_member",
        requestId: "req-redis-2",
        targetInstanceId: "missing-node",
        roomCode: "ROOM01",
        memberId: "member-a",
        requestedAt: 6_000,
      },
      100,
    );

    assert.equal(result.status, "stale_target");
    assert.equal(result.code, "command_timeout");
  } finally {
    await bus.close();
  }
});

test("a failing cleanup UNSUBSCRIBE does not replace the request's answer", async () => {
  // `request` runs three commands on the subscriber connection: SUBSCRIBE, the
  // reply wait, and an UNSUBSCRIBE in a `finally`. Only the middle one is the
  // answer. Since #271 gave this client a `commandTimeout`, a stalled Redis
  // rejects the cleanup instead of hanging in it — and an unguarded `finally`
  // would throw that rejection over a well-formed result, precisely on the
  // stall the `command_timeout` result exists to describe.
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    unsubscribe: async () => {
      throw new Error("Command timed out");
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    // Nothing replies, so the reply timer produces the answer.
    const result = await bus.request(
      {
        kind: "kick_member",
        requestId: "request-1",
        targetInstanceId: "instance-1",
        roomCode: "ABC123",
        memberId: "member-1",
        requestedAt: 1,
      },
      20,
    );

    assert.equal(result.status, "stale_target");
    assert.equal(
      result.status === "stale_target" ? result.code : null,
      "command_timeout",
    );
  } finally {
    await bus.close();
  }
});

test("a fallback result that cannot be published is reported, not thrown at the process", async () => {
  // Three publishes can fail on this path and the third has nowhere to go: the
  // handler's result publish rejects, its `.catch()` publishes a fallback on
  // the SAME stalled connection, and that rejection escapes a `void`-ed chain.
  // Under Node's default that is an `unhandledRejection` and the process exits,
  // so a Redis outage would take the server down with it. Reachable since #271
  // gave this client a `commandTimeout`; before that the publish hung instead
  // (#271 review).
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  const publisher = createFakeRedisPubSubClient(async () => "OK", {
    publish: async () => {
      throw new Error("Command timed out");
    },
  });
  const subscriber = createFakeRedisPubSubClient(async () => "OK");
  const reported: Array<{ requestId: string; error: unknown }> = [];
  const bus = await createRedisAdminCommandBus("redis://unused", {
    commandChannelPrefix: "cmd:",
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
    onResultPublishFailed: (command, error) => {
      reported.push({ requestId: command.requestId, error });
    },
  });

  try {
    await bus.subscribe("instance-1", async (command) => ({
      requestId: command.requestId,
      targetInstanceId: command.targetInstanceId,
      executorInstanceId: "instance-1",
      status: "ok",
      roomCode: null,
      completedAt: 1,
    }));

    subscriber.emitMessage(
      "cmd:instance-1",
      JSON.stringify({
        kind: "kick_member",
        requestId: "request-1",
        targetInstanceId: "instance-1",
        roomCode: "ABC123",
        memberId: "member-1",
        requestedAt: 1,
      }),
    );

    // Let the handler chain settle: result publish → fallback publish → report.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(reported.length, 1);
    assert.equal(reported[0]?.requestId, "request-1");
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await bus.close();
  }
});

test("a SUBSCRIBE that outlived its timeout resets the subscriber", async () => {
  // The reply channel is named after the requestId, so a subscription left
  // behind is one per failed request, forever. `commandTimeout` rejects the
  // caller while the SUBSCRIBE stays on the connection and can still land once
  // Redis recovers. Resetting the subscriber sheds that unknown subscription
  // and its queued command together; another command on the same generation
  // cannot prove whether the first attempt landed (#271 review).
  const unsubscribed: string[] = [];
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: async () => {
      throw new Error("Command timed out");
    },
    unsubscribe: async (...channels: string[]) => {
      unsubscribed.push(...channels);
      return 1;
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    resultChannelPrefix: "result:",
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    const result = await bus.request(
      {
        kind: "kick_member",
        requestId: "request-1",
        targetInstanceId: "instance-1",
        roomCode: "ABC123",
        memberId: "member-1",
        requestedAt: 1,
      },
      20,
    );

    // A diagnosable result, not a rejection: `action-service` turns this into a
    // retryable 503 carrying the code, where a bare throw reached the router's
    // catch-all and answered a Redis outage with `internal_error` (#271 review).
    assert.equal(result.status, "error");
    assert.equal(
      result.status === "error" ? result.code : null,
      "command_bus_unavailable",
    );
    assert.deepEqual(unsubscribed, []);
    assert.equal(subscriber.disconnectCalls(), 1);
  } finally {
    await bus.close();
  }
});

test("a synchronous subscriber reset failure is retried with backoff", async () => {
  const resetDelays: number[] = [];
  const drops: number[] = [];
  let disconnectAttempt = 0;
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: async () => {
      throw new Error("Command timed out");
    },
    disconnect: () => {
      disconnectAttempt += 1;
      if (disconnectAttempt === 1) {
        throw new Error("connector unavailable");
      }
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
    subscriptionRestoreSleep: async (delayMs) => {
      resetDelays.push(delayMs);
    },
    onConnectionDropped: ({ consecutiveFailures }) => {
      drops.push(consecutiveFailures);
    },
  });

  try {
    const result = await bus.request({
      kind: "disconnect_session",
      requestId: "request-1",
      targetInstanceId: "instance-1",
      sessionId: "session-1",
      requestedAt: 1,
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(result.status, "error");
    assert.equal(subscriber.disconnectCalls(), 2);
    assert.deepEqual(resetDelays, [250]);
    assert.deepEqual(drops, [1]);
  } finally {
    await bus.close();
  }
});

test("a synchronous subscriber reset retry stays single-flight", async () => {
  let releaseResetRetry = (): void => {};
  const resetRetryWait = new Promise<void>((resolve) => {
    releaseResetRetry = resolve;
  });
  const unsubscribeFailures: Array<(error: Error) => void> = [];
  let disconnectAttempt = 0;
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    unsubscribe: () =>
      new Promise<number>((_resolve, reject) => {
        unsubscribeFailures.push(reject);
      }),
    disconnect: () => {
      disconnectAttempt += 1;
      if (disconnectAttempt === 1) {
        throw new Error("connector unavailable");
      }
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
    subscriptionRestoreSleep: async () => resetRetryWait,
  });

  try {
    const makeStaleTarget = async (command: {
      requestId: string;
      targetInstanceId: string;
    }) => ({
      requestId: command.requestId,
      targetInstanceId: command.targetInstanceId,
      executorInstanceId: command.targetInstanceId,
      status: "stale_target" as const,
      code: "stale_target",
      message: "Target instance is unavailable.",
      completedAt: 1,
    });
    const unsubscribeOne = await bus.subscribe("instance-1", makeStaleTarget);
    const unsubscribeTwo = await bus.subscribe("instance-2", makeStaleTarget);
    const firstCleanup = unsubscribeOne();
    const secondCleanup = unsubscribeTwo();

    unsubscribeFailures[0]?.(new Error("Command timed out"));
    await assert.rejects(firstCleanup, /Command timed out/);
    assert.equal(subscriber.disconnectCalls(), 1);

    unsubscribeFailures[1]?.(new Error("Command timed out"));
    await assert.rejects(secondCleanup, /Command timed out/);
    assert.equal(subscriber.disconnectCalls(), 1);

    releaseResetRetry();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(subscriber.disconnectCalls(), 2);
  } finally {
    releaseResetRetry();
    await bus.close();
  }
});

test("a reconnect restores command channels without restoring one-shot result channels", async () => {
  const subscriptions: string[] = [];
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: async (...channels: string[]) => {
      subscriptions.push(...channels);
      return channels.length;
    },
    unsubscribe: async () => {
      throw new Error("Command timed out");
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    commandChannelPrefix: "cmd:",
    resultChannelPrefix: "result:",
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    await bus.subscribe("instance-1", async (command) => ({
      requestId: command.requestId,
      targetInstanceId: command.targetInstanceId,
      executorInstanceId: "instance-1",
      status: "ok",
      roomCode: null,
      completedAt: 1,
    }));
    await bus.request(
      {
        kind: "disconnect_session",
        requestId: "request-1",
        targetInstanceId: "instance-1",
        sessionId: "session-1",
        requestedAt: 1,
      },
      20,
    );

    // A failed cleanup leaves the server-side subscription set unknown. The
    // subscriber is reset immediately; otherwise a successful SUBSCRIBE on the
    // next request would keep clearing a shared three-failure counter and one
    // unique result channel could leak per request forever.
    assert.equal(subscriber.disconnectCalls(), 1);
    subscriber.emitReady();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(subscriptions, [
      "cmd:instance-1",
      "result:request-1",
      "cmd:instance-1",
    ]);
  } finally {
    await bus.close();
  }
});

test("a reconnect restores a result channel while its request is still waiting", async () => {
  const subscriptions: string[] = [];
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: async (...channels: string[]) => {
      subscriptions.push(...channels);
      return channels.length;
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    resultChannelPrefix: "result:",
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    const requesting = bus.request(
      {
        kind: "disconnect_session",
        requestId: "request-1",
        targetInstanceId: "instance-1",
        sessionId: "session-1",
        requestedAt: 1,
      },
      1_000,
    );
    await new Promise((resolve) => setImmediate(resolve));

    subscriber.emitReady();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(subscriptions, ["result:request-1", "result:request-1"]);

    subscriber.emitMessage(
      "result:request-1",
      JSON.stringify({
        requestId: "request-1",
        targetInstanceId: "instance-1",
        executorInstanceId: "instance-1",
        status: "ok",
        roomCode: null,
        sessionId: "session-1",
        completedAt: 2,
      }),
    );
    const result = await requesting;
    assert.equal(result.status, "ok");
  } finally {
    await bus.close();
  }
});

test("a cleanup failure defers subscriber reset until other active requests finish", async () => {
  const published: string[] = [];
  const publisher = createFakeRedisPubSubClient(async () => "OK", {
    publish: async (_channel, payload) => {
      const command = JSON.parse(payload) as { requestId: string };
      published.push(command.requestId);
      if (command.requestId === "request-a") {
        subscriber.emitMessage(
          "result:request-a",
          JSON.stringify({
            requestId: "request-a",
            targetInstanceId: "instance-1",
            executorInstanceId: "instance-1",
            status: "ok",
            roomCode: null,
            sessionId: "session-a",
            completedAt: 2,
          }),
        );
      }
      return 1;
    },
  });
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    unsubscribe: async () => {
      throw new Error("NOPERM unsubscribe denied");
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    resultChannelPrefix: "result:",
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    const requestB = bus.request(
      {
        kind: "disconnect_session",
        requestId: "request-b",
        targetInstanceId: "instance-1",
        sessionId: "session-b",
        requestedAt: 1,
      },
      1_000,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const resultA = await bus.request(
      {
        kind: "disconnect_session",
        requestId: "request-a",
        targetInstanceId: "instance-1",
        sessionId: "session-a",
        requestedAt: 1,
      },
      1_000,
    );

    assert.equal(resultA.status, "ok");
    assert.equal(subscriber.disconnectCalls(), 0);
    const refused = await bus.request({
      kind: "disconnect_session",
      requestId: "request-c",
      targetInstanceId: "instance-1",
      sessionId: "session-c",
      requestedAt: 1,
    });
    assert.equal(refused.status, "error");
    assert.equal(
      refused.status === "error" ? refused.code : null,
      "command_bus_unavailable",
    );
    assert.deepEqual(published, ["request-b", "request-a"]);

    subscriber.emitMessage(
      "result:request-b",
      JSON.stringify({
        requestId: "request-b",
        targetInstanceId: "instance-1",
        executorInstanceId: "instance-1",
        status: "ok",
        roomCode: null,
        sessionId: "session-b",
        completedAt: 3,
      }),
    );
    const resultB = await requestB;
    assert.equal(resultB.status, "ok");
    assert.equal(subscriber.disconnectCalls(), 1);
  } finally {
    await bus.close();
  }
});

test("a request whose reply SUBSCRIBE crosses an owed reset is not published", async () => {
  const published: string[] = [];
  let finishRequestBSubscribe = (): void => {};
  const publisher = createFakeRedisPubSubClient(async () => "OK", {
    publish: async (_channel, payload) => {
      published.push((JSON.parse(payload) as { requestId: string }).requestId);
      return 1;
    },
  });
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: async (...channels: string[]) => {
      if (channels.includes("result:request-b")) {
        await new Promise<void>((resolve) => {
          finishRequestBSubscribe = resolve;
        });
      }
      return channels.length;
    },
    unsubscribe: async () => {
      throw new Error("NOPERM unsubscribe denied");
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    resultChannelPrefix: "result:",
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    const requestA = bus.request({
      kind: "disconnect_session",
      requestId: "request-a",
      targetInstanceId: "instance-1",
      sessionId: "session-a",
      requestedAt: 1,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const requestB = bus.request(
      {
        kind: "disconnect_session",
        requestId: "request-b",
        targetInstanceId: "instance-1",
        sessionId: "session-b",
        requestedAt: 1,
      },
      50,
    );
    await new Promise((resolve) => setImmediate(resolve));

    subscriber.emitMessage(
      "result:request-a",
      JSON.stringify({
        requestId: "request-a",
        targetInstanceId: "instance-1",
        executorInstanceId: "instance-1",
        status: "ok",
        roomCode: null,
        completedAt: 2,
      }),
    );
    assert.equal((await requestA).status, "ok");
    assert.deepEqual(published, ["request-a"]);

    finishRequestBSubscribe();
    const resultB = await requestB;
    assert.equal(resultB.status, "error");
    assert.equal(
      resultB.status === "error" ? resultB.code : null,
      "command_bus_unavailable",
    );
    assert.deepEqual(published, ["request-a"]);
    assert.equal(subscriber.disconnectCalls(), 1);
  } finally {
    await bus.close();
  }
});

test("a request is not published while reconnect restoration awaits its ACK", async () => {
  let finishRestore = (): void => {};
  let subscribeCalls = 0;
  let publishes = 0;
  const publisher = createFakeRedisPubSubClient(async () => "OK", {
    publish: async () => {
      publishes += 1;
      return 1;
    },
  });
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: async () => {
      subscribeCalls += 1;
      if (subscribeCalls === 2) {
        await new Promise<void>((resolve) => {
          finishRestore = resolve;
        });
      }
      return 1;
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    commandChannelPrefix: "cmd:",
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    await bus.subscribe("instance-1", async (command) => ({
      requestId: command.requestId,
      targetInstanceId: command.targetInstanceId,
      executorInstanceId: "instance-1",
      status: "ok",
      roomCode: null,
      completedAt: 1,
    }));
    subscriber.emitReady();
    await new Promise((resolve) => setImmediate(resolve));

    const result = await bus.request({
      kind: "disconnect_session",
      requestId: "request-1",
      targetInstanceId: "instance-1",
      sessionId: "session-1",
      requestedAt: 1,
    });
    assert.equal(result.status, "error");
    assert.equal(
      result.status === "error" ? result.code : null,
      "command_bus_unavailable",
    );
    assert.equal(publishes, 0);

    finishRestore();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await bus.close();
  }
});

test("a late failure from an old subscriber generation cannot reset the new one", async () => {
  const rejectUnsubscribe: Array<(error: Error) => void> = [];
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    unsubscribe: () =>
      new Promise<number>((_resolve, reject) => {
        rejectUnsubscribe.push(reject);
      }),
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    resultChannelPrefix: "result:",
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    const requestA = bus.request({
      kind: "disconnect_session",
      requestId: "request-a",
      targetInstanceId: "instance-1",
      sessionId: "session-a",
      requestedAt: 1,
    });
    const requestB = bus.request({
      kind: "disconnect_session",
      requestId: "request-b",
      targetInstanceId: "instance-1",
      sessionId: "session-b",
      requestedAt: 1,
    });
    await new Promise((resolve) => setImmediate(resolve));
    for (const requestId of ["request-a", "request-b"]) {
      subscriber.emitMessage(
        `result:${requestId}`,
        JSON.stringify({
          requestId,
          targetInstanceId: "instance-1",
          executorInstanceId: "instance-1",
          status: "ok",
          roomCode: null,
          completedAt: 2,
        }),
      );
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejectUnsubscribe.length, 2);

    rejectUnsubscribe[0]!(new Error("first old-generation failure"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(subscriber.disconnectCalls(), 1);
    subscriber.emitReady();
    rejectUnsubscribe[1]!(new Error("late old-generation failure"));

    const [resultA, resultB] = await Promise.all([requestA, requestB]);
    assert.equal(resultA.status, "ok");
    assert.equal(resultB.status, "ok");
    assert.equal(subscriber.disconnectCalls(), 1);
  } finally {
    await bus.close();
  }
});

test("admin command admission bounds active reply subscriptions", async () => {
  let publishes = 0;
  let subscriptions = 0;
  const publisher = createFakeRedisPubSubClient(async () => "OK", {
    publish: async () => {
      publishes += 1;
      return 1;
    },
  });
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: async () => {
      subscriptions += 1;
      return 1;
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    resultChannelPrefix: "result:",
    maxActiveRequests: 1,
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    const first = bus.request(
      {
        kind: "disconnect_session",
        requestId: "request-1",
        targetInstanceId: "instance-1",
        sessionId: "session-1",
        requestedAt: 1,
      },
      1_000,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const refused = await bus.request(
      {
        kind: "disconnect_session",
        requestId: "request-2",
        targetInstanceId: "instance-1",
        sessionId: "session-2",
        requestedAt: 1,
      },
      20,
    );

    assert.equal(refused.status, "error");
    assert.equal(
      refused.status === "error" ? refused.code : null,
      "command_bus_unavailable",
    );
    assert.equal(subscriptions, 1);
    assert.equal(publishes, 1);

    subscriber.emitMessage(
      "result:request-1",
      JSON.stringify({
        requestId: "request-1",
        targetInstanceId: "instance-1",
        executorInstanceId: "instance-1",
        status: "ok",
        roomCode: null,
        sessionId: "session-1",
        completedAt: 2,
      }),
    );
    assert.equal((await first).status, "ok");
  } finally {
    await bus.close();
  }
});

test("a failed publish cancels its reply listener before releasing admission", async () => {
  const publisher = createFakeRedisPubSubClient(async () => "OK", {
    publish: async () => {
      throw new Error("publisher unavailable");
    },
  });
  const subscriber = createFakeRedisPubSubClient(async () => "OK");
  const bus = await createRedisAdminCommandBus("redis://unused", {
    resultChannelPrefix: "result:",
    maxActiveRequests: 1,
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    // The one permanent listener dispatches command channels. A request adds a
    // second listener only while it is genuinely waiting for a result.
    assert.equal(subscriber.messageListenerCount(), 1);
    for (const requestId of ["request-1", "request-2"]) {
      const result = await bus.request(
        {
          kind: "disconnect_session",
          requestId,
          targetInstanceId: "instance-1",
          sessionId: `session-${requestId}`,
          requestedAt: 1,
        },
        1_000,
      );
      assert.equal(result.status, "error");
      assert.equal(subscriber.messageListenerCount(), 1);
    }
  } finally {
    await bus.close();
  }
});

test("subscriber admission refusal does not reset a healthy connection", async () => {
  let releaseUnsubscribe = (): void => {};
  let markUnsubscribeStarted = (): void => {};
  const unsubscribeStarted = new Promise<void>((resolve) => {
    markUnsubscribeStarted = resolve;
  });
  const blockedUnsubscribe = new Promise<number>((resolve) => {
    releaseUnsubscribe = () => resolve(1);
  });
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    unsubscribe: async () => {
      markUnsubscribeStarted();
      return await blockedUnsubscribe;
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    resultChannelPrefix: "result:",
    maxPendingCommandsPerConnection: 1,
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    const first = bus.request(
      {
        kind: "disconnect_session",
        requestId: "request-1",
        targetInstanceId: "instance-1",
        sessionId: "session-1",
        requestedAt: 1,
      },
      1_000,
    );
    await new Promise((resolve) => setImmediate(resolve));
    subscriber.emitMessage(
      "result:request-1",
      JSON.stringify({
        requestId: "request-1",
        targetInstanceId: "instance-1",
        executorInstanceId: "instance-1",
        status: "ok",
        roomCode: null,
        sessionId: "session-1",
        completedAt: 2,
      }),
    );
    await unsubscribeStarted;

    const refused = await bus.request(
      {
        kind: "disconnect_session",
        requestId: "request-2",
        targetInstanceId: "instance-1",
        sessionId: "session-2",
        requestedAt: 1,
      },
      1_000,
    );
    assert.equal(refused.status, "error");
    assert.equal(subscriber.disconnectCalls(), 0);

    releaseUnsubscribe();
    assert.equal((await first).status, "ok");
  } finally {
    releaseUnsubscribe();
    await bus.close();
  }
});

test("a refused cleanup UNSUBSCRIBE resets the stale subscription set", async () => {
  let releaseFirstCleanup = (): void => {};
  let markFirstCleanupStarted = (): void => {};
  const firstCleanupStarted = new Promise<void>((resolve) => {
    markFirstCleanupStarted = resolve;
  });
  const blockedFirstCleanup = new Promise<number>((resolve) => {
    releaseFirstCleanup = () => resolve(1);
  });
  const subscriptions = new Set<string>();
  let cleanupCalls = 0;
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: async (...channels: string[]) => {
      for (const channel of channels) {
        subscriptions.add(channel);
      }
      return channels.length;
    },
    unsubscribe: async (...channels: string[]) => {
      cleanupCalls += 1;
      if (cleanupCalls === 1) {
        markFirstCleanupStarted();
        await blockedFirstCleanup;
      }
      for (const channel of channels) {
        subscriptions.delete(channel);
      }
      return channels.length;
    },
    disconnect: () => subscriptions.clear(),
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    resultChannelPrefix: "result:",
    maxPendingCommandsPerConnection: 1,
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });
  const command = (requestId: string) => ({
    kind: "disconnect_session" as const,
    requestId,
    targetInstanceId: "instance-1",
    sessionId: `session-${requestId}`,
    requestedAt: 1,
  });
  const result = (requestId: string) =>
    JSON.stringify({
      requestId,
      targetInstanceId: "instance-1",
      executorInstanceId: "instance-1",
      status: "ok",
      roomCode: null,
      sessionId: `session-${requestId}`,
      completedAt: 2,
    });

  try {
    const first = bus.request(command("request-1"), 1_000);
    await new Promise((resolve) => setImmediate(resolve));
    const second = bus.request(command("request-2"), 1_000);
    await new Promise((resolve) => setImmediate(resolve));
    subscriber.emitMessage("result:request-1", result("request-1"));
    await firstCleanupStarted;

    subscriber.emitMessage("result:request-2", result("request-2"));
    assert.equal((await second).status, "ok");
    assert.equal(subscriber.disconnectCalls(), 1);
    assert.deepEqual([...subscriptions], []);

    releaseFirstCleanup();
    assert.equal((await first).status, "ok");
  } finally {
    releaseFirstCleanup();
    await bus.close();
  }
});

test("a duplicate in-flight request id is refused without sharing its reply channel", async () => {
  let publishes = 0;
  const publisher = createFakeRedisPubSubClient(async () => "OK", {
    publish: async () => {
      publishes += 1;
      return 1;
    },
  });
  const subscriber = createFakeRedisPubSubClient(async () => "OK");
  const bus = await createRedisAdminCommandBus("redis://unused", {
    resultChannelPrefix: "result:",
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });
  const command = {
    kind: "disconnect_session" as const,
    requestId: "request-1",
    targetInstanceId: "instance-1",
    sessionId: "session-1",
    requestedAt: 1,
  };

  try {
    const first = bus.request(command, 1_000);
    await new Promise((resolve) => setImmediate(resolve));
    const duplicate = await bus.request(command, 1_000);
    assert.equal(duplicate.status, "error");
    assert.equal(
      duplicate.status === "error" ? duplicate.code : null,
      "duplicate_request_id",
    );
    assert.equal(publishes, 1);

    subscriber.emitMessage(
      "result:request-1",
      JSON.stringify({
        requestId: "request-1",
        targetInstanceId: "instance-1",
        executorInstanceId: "instance-1",
        status: "ok",
        roomCode: null,
        sessionId: "session-1",
        completedAt: 2,
      }),
    );
    assert.equal((await first).status, "ok");
  } finally {
    await bus.close();
  }
});

test("a command delivered with the SUBSCRIBE acknowledgement sees its handler", async () => {
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  let handled = false;
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: async (...channels: string[]) => {
      if (channels.includes("cmd:instance-1")) {
        // Models ioredis dispatching a message from the same socket read as the
        // SUBSCRIBE ACK, before the awaiting continuation can run.
        subscriber.emitMessage(
          "cmd:instance-1",
          JSON.stringify({
            kind: "disconnect_session",
            requestId: "request-1",
            targetInstanceId: "instance-1",
            sessionId: "session-1",
            requestedAt: 1,
          }),
        );
      }
      return channels.length;
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    commandChannelPrefix: "cmd:",
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });

  try {
    await bus.subscribe("instance-1", async (command) => {
      handled = true;
      return {
        requestId: command.requestId,
        targetInstanceId: command.targetInstanceId,
        executorInstanceId: "instance-1",
        status: "ok",
        roomCode: null,
        completedAt: 1,
      };
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(handled, true);
  } finally {
    await bus.close();
  }
});

test("durable restore paces an admission refusal without resetting Redis", async () => {
  const subscriptions: string[][] = [];
  const restoreDelays: number[] = [];
  let releaseUnsubscribe = (): void => {};
  let markUnsubscribeStarted = (): void => {};
  let releaseRestoreDelay = (): void => {};
  const unsubscribeStarted = new Promise<void>((resolve) => {
    markUnsubscribeStarted = resolve;
  });
  const blockedUnsubscribe = new Promise<number>((resolve) => {
    releaseUnsubscribe = () => resolve(1);
  });
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: async (...channels: string[]) => {
      subscriptions.push(channels);
      return channels.length;
    },
    unsubscribe: async () => {
      markUnsubscribeStarted();
      return await blockedUnsubscribe;
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    commandChannelPrefix: "cmd:",
    resultChannelPrefix: "result:",
    maxPendingCommandsPerConnection: 1,
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
    subscriptionRestoreSleep: async (delayMs) => {
      restoreDelays.push(delayMs);
      await new Promise<void>((resolve) => {
        releaseRestoreDelay = resolve;
      });
    },
  });

  try {
    await bus.subscribe("instance-1", async (command) => ({
      requestId: command.requestId,
      targetInstanceId: command.targetInstanceId,
      executorInstanceId: "instance-1",
      status: "ok",
      roomCode: null,
      completedAt: 1,
    }));
    const request = bus.request(
      {
        kind: "disconnect_session",
        requestId: "request-1",
        targetInstanceId: "instance-1",
        sessionId: "session-1",
        requestedAt: 1,
      },
      1_000,
    );
    await new Promise((resolve) => setImmediate(resolve));
    subscriber.emitMessage(
      "result:request-1",
      JSON.stringify({
        requestId: "request-1",
        targetInstanceId: "instance-1",
        executorInstanceId: "instance-1",
        status: "ok",
        roomCode: null,
        sessionId: "session-1",
        completedAt: 2,
      }),
    );
    await unsubscribeStarted;

    subscriber.emitReady();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(restoreDelays, [250]);
    assert.equal(subscriber.disconnectCalls(), 0);
    assert.deepEqual(subscriptions, [["cmd:instance-1"], ["result:request-1"]]);

    releaseUnsubscribe();
    assert.equal((await request).status, "ok");
    releaseRestoreDelay();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(subscriptions, [
      ["cmd:instance-1"],
      ["result:request-1"],
      ["cmd:instance-1"],
    ]);
    assert.equal(subscriber.disconnectCalls(), 0);
  } finally {
    releaseUnsubscribe();
    releaseRestoreDelay();
    await bus.close();
  }
});

test("a failed durable restore resets the subscriber and retries on its next ready", async () => {
  const subscriptions: string[][] = [];
  const restoreDelays: number[] = [];
  let attempt = 0;
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: async (...channels: string[]) => {
      subscriptions.push(channels);
      attempt += 1;
      if (attempt === 2 || attempt === 3) {
        throw new Error("NOPERM subscription denied");
      }
      return channels.length;
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    commandChannelPrefix: "cmd:",
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
    subscriptionRestoreSleep: async (delayMs) => {
      restoreDelays.push(delayMs);
    },
  });

  try {
    await bus.subscribe("instance-1", async (command) => ({
      requestId: command.requestId,
      targetInstanceId: command.targetInstanceId,
      executorInstanceId: "instance-1",
      status: "ok",
      roomCode: null,
      completedAt: 1,
    }));

    subscriber.emitReady();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(subscriber.disconnectCalls(), 1);

    // ioredis resets its retry attempt count on every ready event, so its own
    // retryStrategy would reconnect every 50ms forever on a command-level
    // NOPERM. The bus carries failure count across ready generations instead.
    subscriber.emitReady();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(subscriber.disconnectCalls(), 2);
    subscriber.emitReady();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(subscriptions, [
      ["cmd:instance-1"],
      ["cmd:instance-1"],
      ["cmd:instance-1"],
      ["cmd:instance-1"],
    ]);
    assert.deepEqual(restoreDelays, [250, 500]);
  } finally {
    await bus.close();
  }
});

test("a subscribe awaiting Redis cannot register a handler after close", async () => {
  let finishSubscribe = (): void => {};
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: () =>
      new Promise<number>((resolve) => {
        finishSubscribe = () => resolve(1);
      }),
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    commandChannelPrefix: "cmd:",
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });
  let handled = false;

  const subscribing = bus.subscribe("instance-1", async (command) => {
    handled = true;
    return {
      requestId: command.requestId,
      targetInstanceId: command.targetInstanceId,
      executorInstanceId: "instance-1",
      status: "ok",
      roomCode: null,
      completedAt: 1,
    };
  });
  const rejected = assert.rejects(subscribing, /command bus is closed/i);
  await bus.close();
  finishSubscribe();
  await rejected;

  subscriber.emitMessage(
    "cmd:instance-1",
    JSON.stringify({
      kind: "disconnect_session",
      requestId: "request-1",
      targetInstanceId: "instance-1",
      sessionId: "session-1",
      requestedAt: 1,
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handled, false);
});

test("a duplicate command-handler registration is rejected", async () => {
  const subscriptions: string[] = [];
  const unsubscribed: string[] = [];
  const publisher = createFakeRedisPubSubClient(async () => "OK");
  const subscriber = createFakeRedisPubSubClient(async () => "OK", {
    subscribe: async (...channels: string[]) => {
      subscriptions.push(...channels);
      return channels.length;
    },
    unsubscribe: async (...channels: string[]) => {
      unsubscribed.push(...channels);
      return channels.length;
    },
  });
  const bus = await createRedisAdminCommandBus("redis://unused", {
    commandChannelPrefix: "cmd:",
    redisClients: {
      publisher: publisher.client,
      subscriber: subscriber.client,
    },
  });
  let handlerCalls = 0;

  try {
    const unsubscribe = await bus.subscribe("instance-1", async (command) => {
      handlerCalls += 1;
      return {
        requestId: command.requestId,
        targetInstanceId: command.targetInstanceId,
        executorInstanceId: "instance-1",
        status: "ok",
        roomCode: null,
        completedAt: 1,
      };
    });
    await assert.rejects(
      bus.subscribe("instance-1", async () => {
        throw new Error("duplicate handler must not run");
      }),
      /already registered/,
    );

    assert.deepEqual(subscriptions, ["cmd:instance-1"]);
    subscriber.emitMessage(
      "cmd:instance-1",
      JSON.stringify({
        kind: "disconnect_session",
        requestId: "request-1",
        targetInstanceId: "instance-1",
        sessionId: "session-1",
        requestedAt: 1,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handlerCalls, 1);

    await unsubscribe();
    assert.deepEqual(unsubscribed, ["cmd:instance-1"]);
  } finally {
    await bus.close();
  }
});
