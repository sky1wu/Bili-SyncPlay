import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createRedisEventStore,
  type RedisEventStoreClient,
  type RedisEventStoreMulti,
  type RedisEventStoreOptions,
} from "../src/admin/redis-event-store.js";

/**
 * The failure every test here is about: a command that is accepted and never
 * answered. No reachable Redis produces it on demand — a half-open TCP
 * connection or a blocked server does, and neither is something a unit test can
 * arrange — so the client is the seam (#264).
 */
function createFakeEventRedis(options: { xadd?: () => Promise<string> } = {}): {
  client: RedisEventStoreClient;
  xaddCalls: () => number;
  quitCalls: () => number;
  disconnectCalls: () => number;
  issued: () => string[];
} {
  let xaddCalls = 0;
  let quitCalls = 0;
  let disconnectCalls = 0;
  let nextStreamId = 0;
  const issued: string[] = [];

  // ONE connection, replies matched in order — the property that makes this
  // fixture worth trusting. ioredis puts every command, `QUIT` included, on a
  // single `commandQueue` and pairs replies with it front-first, so a command
  // issued behind an unanswered one cannot answer first. A fake that let each
  // call settle independently would let a test "prove" that reads and shutdown
  // sail past a hung write, which is the opposite of what happens (#264
  // review).
  let connection: Promise<unknown> = Promise.resolve();
  function command<T>(name: string, run: () => Promise<T>): Promise<T> {
    // Recorded when issued, not when answered: the order commands reach the
    // connection is exactly what several of these tests are about.
    issued.push(name);
    const reply = connection.then(run);
    connection = reply.then(
      () => undefined,
      () => undefined,
    );
    return reply;
  }

  const multi: RedisEventStoreMulti = {
    zadd: () => multi,
    exec: () => command("exec", async () => []),
  };

  const client: RedisEventStoreClient = {
    connect: async () => undefined,
    quit: () =>
      command("quit", async () => {
        quitCalls += 1;
      }),
    disconnect: () => {
      disconnectCalls += 1;
    },
    eval: () => command("eval", async () => 0),
    // 1, so construction skips the counts backfill — this fixture is about the
    // append path, and a startup that reads the stream would only add noise.
    exists: () => command("exists", async () => 1),
    scan: () => command("scan", async () => ["0", []]),
    unlink: () => command("unlink", async () => 0),
    multi: () => multi,
    xadd: () =>
      command("xadd", async () => {
        xaddCalls += 1;
        if (options.xadd) {
          return await options.xadd();
        }
        nextStreamId += 1;
        return `${nextStreamId}-0`;
      }),
    xtrim: () => command("xtrim", async () => "OK"),
    xrange: () => command("xrange", async () => []),
    xrevrange: () => command("xrevrange", async () => []),
    hset: () => command("hset", async () => "OK"),
    hmget: (_key, ...fields) =>
      command("hmget", async () => fields.map(() => null)),
    hincrby: () => command("hincrby", async () => 1),
    zadd: () => command("zadd", async () => 1),
    zcount: () => command("zcount", async () => 0),
    zremrangebyscore: () => command("zremrangebyscore", async () => 0),
  };

  return {
    client,
    xaddCalls: () => xaddCalls,
    quitCalls: () => quitCalls,
    disconnectCalls: () => disconnectCalls,
    issued: () => [...issued],
  };
}

/**
 * A write that answers only when the test says so.
 *
 * Always released before the test ends, even where the point is that it never
 * answered: an unreleased call leaves its cap timer armed, and a cap of
 * `appendTimeoutMs` holds the runner's event loop open for exactly that long.
 */
function createBlockedWrite(options: { blockedCalls?: number } = {}): {
  write: () => Promise<string>;
  release: () => void;
} {
  const blockedCalls = options.blockedCalls ?? Number.POSITIVE_INFINITY;
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    write: async () => {
      calls += 1;
      if (calls <= blockedCalls) {
        await blocked;
      }
      return `${calls}-0`;
    },
    release,
  };
}

/** A write that answers one call at a time, so a test can hold the queue at its limit. */
function createSteppedWrite(): {
  write: () => Promise<string>;
  step: () => void;
  releaseAll: () => void;
} {
  const waiting: Array<() => void> = [];
  let released = false;
  let calls = 0;
  return {
    write: async () => {
      calls += 1;
      const id = calls;
      if (!released) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      return `${id}-0`;
    },
    step: () => {
      waiting.shift()?.();
    },
    releaseAll: () => {
      released = true;
      while (waiting.length > 0) {
        waiting.shift()?.();
      }
    },
  };
}

/**
 * Local rather than the production `settleWithin`, so a defect in that helper
 * cannot make these tests agree with the code they are checking.
 */
async function settledWithin(
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let settled = false;
  const answered = work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.race([answered, delay(timeoutMs)]);
  return settled;
}

function appendInput(index: number): {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
} {
  return {
    event: "room_created",
    timestamp: new Date(1_800_000_000_000 + index).toISOString(),
    data: { roomCode: `ROOM${index}`, result: "ok" },
  };
}

async function createStore(
  client: RedisEventStoreClient,
  options: Omit<RedisEventStoreOptions, "redisClient"> = {},
): ReturnType<typeof createRedisEventStore> {
  return await createRedisEventStore("redis://unused", {
    redisClient: client,
    ...options,
  });
}

test("a hung write stops the queue growing instead of collecting one closure per log line", async () => {
  const hung = createBlockedWrite();
  const redis = createFakeEventRedis({ xadd: hung.write });
  const dropped: string[] = [];
  const store = await createStore(redis.client, {
    appendTimeoutMs: 20,
    maxPendingAppends: 100,
    closeSettleTimeoutMs: 20,
    onAppendsDropped: ({ reason }) => {
      dropped.push(reason);
    },
  });

  try {
    const stalling = store.append(appendInput(0));
    // Past the cap, so the store knows the write is not coming back.
    await delay(60);

    const shed = Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        store.append(appendInput(index)),
      ),
    );

    // The whole defect: before this, every one of those appends chained a
    // closure — capturing its own event payload — onto a promise that could
    // only settle when Redis did, and none of them ever answered their caller.
    // Bounded, so a regression shows up as this assertion instead of as a
    // runner that drains the loop and cancels every test after it.
    assert.equal(await settledWithin(shed, 200), true);
    // ...while the connection carries exactly the one command it already had.
    assert.equal(redis.xaddCalls(), 1);
    // Reported once for the incident, not once per dropped line: the report is
    // itself a log line, and the append path is the thing already overloaded.
    assert.deepEqual(dropped, ["stalled"]);
    assert.equal(await settledWithin(Promise.resolve(stalling), 20), false);
  } finally {
    hung.release();
    await store.close();
  }
});

test("a write that is merely slow still bounds the queue", async () => {
  const slow = createBlockedWrite();
  const redis = createFakeEventRedis({ xadd: slow.write });
  const dropped: string[] = [];
  const store = await createStore(redis.client, {
    // Far longer than this test runs: the point is that Redis is ANSWERING,
    // just slower than events arrive, so the per-write cap never fires and it
    // is the depth limit doing all the work.
    appendTimeoutMs: 60_000,
    maxPendingAppends: 3,
    onAppendsDropped: ({ reason }) => {
      dropped.push(reason);
    },
  });

  try {
    const appends = Array.from({ length: 10 }, (_, index) =>
      store.append(appendInput(index)),
    );

    assert.deepEqual(dropped, ["overflow"]);
    slow.release();
    await Promise.all(appends);
    // Three queued and written, seven refused at the door. Without the depth
    // limit all ten would have queued, and a stream of them would have grown
    // the queue for as long as Redis stayed behind.
    assert.equal(redis.xaddCalls(), 3);
  } finally {
    await store.close();
  }
});

test("the chain does not run a second write on top of an unanswered one", async () => {
  const hung = createBlockedWrite({ blockedCalls: 1 });
  const redis = createFakeEventRedis({ xadd: hung.write });
  const store = await createStore(redis.client, {
    appendTimeoutMs: 20,
    maxPendingAppends: 10,
    closeSettleTimeoutMs: 50,
  });

  try {
    const first = store.append(appendInput(0));
    const second = store.append(appendInput(1));
    await delay(60);

    // The cap answered `first`'s own bookkeeping, but it cannot cancel the
    // command, so the queued `second` must stay put: two writes outstanding
    // against a dependency that has answered neither would land out of order
    // if it recovered.
    assert.equal(redis.xaddCalls(), 1);

    hung.release();
    await Promise.all([first, second]);
    assert.equal(redis.xaddCalls(), 2);
  } finally {
    await store.close();
  }
});

test("shedding ends when the write answers, and reports what the incident cost", async () => {
  const hung = createBlockedWrite({ blockedCalls: 1 });
  const redis = createFakeEventRedis({ xadd: hung.write });
  const resumed: Array<{ reason: string; droppedEvents: number }> = [];
  const store = await createStore(redis.client, {
    appendTimeoutMs: 20,
    maxPendingAppends: 10,
    onAppendsResumed: (info) => {
      resumed.push(info);
    },
  });

  try {
    const stalling = store.append(appendInput(0));
    await delay(60);
    await store.append(appendInput(1));
    await store.append(appendInput(2));
    // Still shedding, so nothing is reported yet — a resume line is what says
    // the list is complete again, and it must not arrive before it is.
    assert.deepEqual(resumed, []);

    hung.release();
    await stalling;

    // Reported off the write settling, with NO further append. A low-traffic
    // node whose logs went quiet during the stall would otherwise be left with
    // a dropped line and no end to it, and nothing in the log would separate
    // "recovered" from "still down" (#266 review).
    //
    // The magnitude is the point of the line: the metric counts drops as they
    // happen, this says what the whole incident cost once it is over.
    assert.deepEqual(resumed, [
      { reason: "stalled", startedAsReason: "stalled", droppedEvents: 2 },
    ]);
  } finally {
    await store.close();
  }
});

test("an overflow that becomes a stall closes as a stall, still as one pair", async () => {
  const hung = createBlockedWrite({ blockedCalls: 1 });
  const redis = createFakeEventRedis({ xadd: hung.write });
  const dropped: string[] = [];
  const resumed: Array<{
    reason: string;
    startedAsReason: string;
    droppedEvents: number;
  }> = [];
  const recorded: string[] = [];
  const appends: Array<Promise<unknown> | unknown> = [];
  const store = await createStore(redis.client, {
    appendTimeoutMs: 40,
    maxPendingAppends: 2,
    closeSettleTimeoutMs: 200,
    metricsCollector: {
      declareEventStoreAppends: () => undefined,
      recordEventStoreAppendDropped: (reason) => {
        recorded.push(reason);
      },
    },
    onAppendsDropped: ({ reason }) => {
      dropped.push(reason);
    },
    onAppendsResumed: (info) => {
      resumed.push(info);
    },
  });

  try {
    // Redis is behind, not dead: the depth limit trips first, while the write
    // in flight is still inside its cap.
    for (let index = 0; index < 3; index += 1) {
      appends.push(store.append(appendInput(index)));
    }
    assert.deepEqual(dropped, ["overflow"]);

    // ...and then the same write blows its cap.
    await delay(80);
    appends.push(store.append(appendInput(3)));

    // No second start line. Two starts against one end is a pair an operator
    // cannot match up (#266 review) — so the stage change goes to the metric,
    // which is where the runbook sends them for the live picture anyway.
    assert.deepEqual(dropped, ["overflow"]);
    assert.deepEqual(recorded, ["overflow", "stalled"]);

    hung.release();
    await Promise.all(appends);

    // And the line that closes the incident carries the whole arc: what it
    // ended as, what it began as, and what it cost across both stages.
    // Reporting it as `overflow` would call a Redis that stopped answering a
    // slow one, and those need different repairs.
    assert.deepEqual(resumed, [
      { reason: "stalled", startedAsReason: "overflow", droppedEvents: 2 },
    ]);
  } finally {
    hung.release();
    await store.close();
  }
});

test("holding the queue at its limit does not log a line per freed slot", async () => {
  const stepped = createSteppedWrite();
  const redis = createFakeEventRedis({ xadd: stepped.write });
  const dropped: string[] = [];
  const resumed: Array<{ reason: string; droppedEvents: number }> = [];
  const store = await createStore(redis.client, {
    appendTimeoutMs: 60_000,
    maxPendingAppends: 4,
    closeSettleTimeoutMs: 200,
    onAppendsDropped: ({ reason }) => {
      dropped.push(reason);
    },
    onAppendsResumed: (info) => {
      resumed.push(info);
    },
  });
  const appends: Array<Promise<unknown> | unknown> = [];

  try {
    // Four queued, the fifth refused.
    for (let index = 0; index < 5; index += 1) {
      appends.push(store.append(appendInput(index)));
    }
    assert.deepEqual(dropped, ["overflow"]);

    // Now hold the edge: free exactly one slot, refill it, overload again.
    // This is what a Redis that is steadily a little too slow looks like.
    //
    // The first wait is load-bearing: `append` is synchronous up to the `.then`
    // that chains it, so the first write has not reached the client yet and
    // there would be nothing to step.
    await delay(20);
    stepped.step();
    await delay(20);
    appends.push(store.append(appendInput(5)));
    appends.push(store.append(appendInput(6)));

    // Still one incident and one line. Resuming the moment a single slot frees
    // leaves the store one event away from shedding again, so a sustained
    // overload would log a resumed/dropped pair per completed write — the
    // per-line noise this whole design exists to avoid, moved to the other
    // edge (#266 review).
    assert.deepEqual(resumed, []);
    assert.deepEqual(dropped, ["overflow"]);

    // And when it really does recover, the incident is closed exactly once,
    // carrying what it cost: two refused at the door, across both phases.
    stepped.releaseAll();
    await Promise.all(appends);
    assert.deepEqual(resumed, [
      { reason: "overflow", startedAsReason: "overflow", droppedEvents: 2 },
    ]);
  } finally {
    stepped.releaseAll();
    await store.close();
  }
});

test("a read is issued behind the write in flight, not behind the whole queue", async () => {
  const slow = createBlockedWrite();
  const redis = createFakeEventRedis({ xadd: slow.write });
  const store = await createStore(redis.client, {
    appendTimeoutMs: 60_000,
    readSettleTimeoutMs: 20,
    closeSettleTimeoutMs: 200,
  });

  try {
    const appends = Array.from({ length: 5 }, (_, index) =>
      store.append(appendInput(index)),
    );
    const query = store.query({ page: 1, pageSize: 10 });
    await delay(60);

    // What the bound actually buys, stated as the order commands reach the
    // connection. Four of those five writes have not been ISSUED yet — the
    // chain is serial — so `await pendingAppend` made the read wait for four
    // round trips that had not even started. Now it waits for one.
    //
    // What it does not buy: skipping the write in flight. `XREVRANGE` still
    // goes out behind that `XADD` on the one connection, and against a Redis
    // that has genuinely stopped answering the read stops too. That is the
    // `commandTimeout` decision deferred by #261 and #263, not this one.
    assert.deepEqual(redis.issued().slice(-2), ["xadd", "xrevrange"]);

    slow.release();
    assert.equal(
      await settledWithin(Promise.all([query, ...appends]), 500),
      true,
    );
  } finally {
    slow.release();
    await store.close();
  }
});

test("close gives up on a hung write inside its budget, and says so", async () => {
  const hung = createBlockedWrite();
  const redis = createFakeEventRedis({ xadd: hung.write });
  const abandoned: Array<{
    pendingWrites: number;
    queuedAppends: number;
    budgetMs: number;
  }> = [];
  const store = await createStore(redis.client, {
    appendTimeoutMs: 60_000,
    closeSettleTimeoutMs: 20,
    onAppendsAbandonedAtShutdown: (info) => {
      abandoned.push(info);
    },
  });

  void store.append(appendInput(0));

  // Unbounded, this never returns, and `close_event_store` reports a failed
  // shutdown step on its own 5s budget every time Redis is hung.
  assert.equal(await settledWithin(store.close(), 500), true);
  // The socket, not `QUIT`. `QUIT` is a command on the same queue as the write
  // that is not answering, so waiting for its reply would hand the step back
  // exactly the timeout the drain budget just removed.
  assert.equal(redis.disconnectCalls(), 1);
  assert.equal(redis.quitCalls(), 0);
  // Bounded is not the same as quiet: the command was still on the connection
  // that just went down, and that used to be visible only because the step
  // timed out.
  assert.deepEqual(abandoned, [
    { pendingWrites: 1, queuedAppends: 1, budgetMs: 20 },
  ]);
  hung.release();
});

test("close falls back to the socket when QUIT itself is not answered", async () => {
  const redis = createFakeEventRedis();
  const store = await createStore(redis.client, { closeSettleTimeoutMs: 20 });

  // Nothing queued, so the drain succeeds and close takes the graceful path —
  // and then the reply never comes, which is what a half-open connection looks
  // like once there is no write left to blame.
  const stalledQuit = createBlockedWrite();
  const gracefulClient = redis.client as { quit: () => Promise<unknown> };
  gracefulClient.quit = () => stalledQuit.write();

  assert.equal(await settledWithin(store.close(), 500), true);
  assert.equal(redis.disconnectCalls(), 1);
  stalledQuit.release();
});

test("close still flushes a healthy queue, and stays quiet doing it", async () => {
  const redis = createFakeEventRedis();
  let abandonedCalls = 0;
  const store = await createStore(redis.client, {
    closeSettleTimeoutMs: 500,
    onAppendsAbandonedAtShutdown: () => {
      abandonedCalls += 1;
    },
  });

  // Not awaited: the append is still queued when close starts, which is the
  // ordinary shutdown case — dropping it would lose the shutdown's own events
  // on every clean restart.
  void store.append(appendInput(0));
  await store.close();

  assert.equal(redis.xaddCalls(), 1);
  // An ordinary shutdown must not log a degraded line, or the signal means
  // nothing on the one shutdown where it matters.
  assert.equal(abandonedCalls, 0);
  // And it closes gracefully: dropping the socket on a Redis that is answering
  // would abandon replies for no reason.
  assert.equal(redis.quitCalls(), 1);
  assert.equal(redis.disconnectCalls(), 0);
});

test("a queued write does not reach a connection close already gave up on", async () => {
  const hung = createBlockedWrite({ blockedCalls: 1 });
  const redis = createFakeEventRedis({ xadd: hung.write });
  const store = await createStore(redis.client, {
    appendTimeoutMs: 60_000,
    closeSettleTimeoutMs: 20,
  });

  const first = store.append(appendInput(0));
  const second = store.append(appendInput(1));
  await store.close();
  assert.equal(redis.disconnectCalls(), 1);

  hung.release();
  await Promise.all([first, second]);

  // `second` was still queued when close ran out of budget. Letting it write
  // now would issue a command on a closed connection, and ioredis rejects
  // those — which the structured logger turns into a `runtime_event_append_failed`
  // line per queued event, after shutdown said it was done.
  assert.equal(redis.xaddCalls(), 1);
});

test("drops reach the metric, in the reason that names the diagnosis", async () => {
  const declared: number[] = [];
  const recorded: string[] = [];
  const hung = createBlockedWrite();
  const redis = createFakeEventRedis({ xadd: hung.write });
  const store = await createStore(redis.client, {
    appendTimeoutMs: 20,
    maxPendingAppends: 100,
    closeSettleTimeoutMs: 20,
    metricsCollector: {
      declareEventStoreAppends: () => {
        declared.push(1);
      },
      recordEventStoreAppendDropped: (reason) => {
        recorded.push(reason);
      },
    },
  });

  try {
    // Declared on construction, not on the first drop: a series that appears
    // only once something went wrong cannot be alerted on before it does.
    assert.deepEqual(declared, [1]);

    void store.append(appendInput(0));
    await delay(60);
    await store.append(appendInput(1));
    await store.append(appendInput(2));

    // Every drop, unlike the log line, which is emitted once per incident —
    // this is the only place the magnitude is visible while it is happening.
    assert.deepEqual(recorded, ["stalled", "stalled"]);
  } finally {
    hung.release();
    await store.close();
  }
});
