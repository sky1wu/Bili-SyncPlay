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
function createFakeEventRedis(
  options: {
    xadd?: () => Promise<string>;
    /** Injected the same way `xadd` is, so the read path gets a seam too. */
    xrevrange?: () => Promise<Array<[string, string[]]>>;
  } = {},
): {
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
    xrevrange: () =>
      command("xrevrange", async () =>
        options.xrevrange ? await options.xrevrange() : [],
      ),
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

test("a read is refused, not queued, while the connection is not answering", async () => {
  const hung = createBlockedWrite();
  const redis = createFakeEventRedis({ xadd: hung.write });
  const store = await createStore(redis.client, {
    appendTimeoutMs: 20,
    readSettleTimeoutMs: 20,
    closeSettleTimeoutMs: 20,
  });

  try {
    void store.append(appendInput(0));
    // Past the cap: the write is not coming back, so nothing sent now will
    // come back either.
    await delay(60);

    const issuedBefore = redis.issued().length;
    await assert.rejects(
      Promise.resolve(store.query({ page: 1, pageSize: 10 })),
      /not answering/,
    );
    await assert.rejects(
      Promise.resolve(store.totalCountsByEvent(["room_created"])),
      /not answering/,
    );
    await assert.rejects(
      Promise.resolve(store.countsByEventInWindow(["room_created"], 0, 1)),
      /not answering/,
    );

    // The point is the command that was NOT sent. Waiting longer was the wrong
    // lever: the read goes out on the same connection, behind a write that has
    // already outlived its cap, and never comes back — while the admin console
    // polls events and the overview every 15s, so each poll would leave another
    // read and its closure in ioredis's queue for as long as the stall lasts
    // (#266 review).
    assert.equal(redis.issued().length, issuedBefore);
  } finally {
    hung.release();
    await store.close();
  }
});

test("a read still waits, briefly, for a queue that is merely slow", async () => {
  let streamId = 0;
  const redis = createFakeEventRedis({
    // Every write ANSWERS — just slowly enough that ten of them cannot drain
    // inside the read's budget. Modelling "slow" as a write that never comes
    // back is what let the earlier version of this test pass while the real
    // slow case was broken (#269 review).
    xadd: async () => {
      await delay(15);
      streamId += 1;
      return `${streamId}-0`;
    },
  });
  const store = await createStore(redis.client, {
    // The cap has NOT fired, and would not for another minute: Redis is
    // answering, just behind. Refusing here would take the admin console down
    // on a Redis that is working.
    appendTimeoutMs: 60_000,
    maxPendingAppends: 20,
    readSettleTimeoutMs: 60,
    closeSettleTimeoutMs: 2_000,
  });

  try {
    const appends = Array.from({ length: 10 }, (_, index) =>
      store.append(appendInput(index)),
    );
    const query = store.query({ page: 1, pageSize: 10 });

    assert.equal(await settledWithin(Promise.resolve(query), 500), true);
    // The read went out with writes still queued behind it. `await
    // pendingAppend` used to make it wait for all ten round trips, most of
    // which had not even been issued.
    const issuedAtRead = redis.issued().indexOf("xrevrange");
    const xaddsBeforeRead = redis
      .issued()
      .slice(0, issuedAtRead)
      .filter((command) => command === "xadd").length;
    assert.ok(
      xaddsBeforeRead < 10,
      `expected the read to precede some writes, saw ${xaddsBeforeRead}`,
    );

    assert.equal(await settledWithin(Promise.all(appends), 2_000), true);
  } finally {
    await store.close();
  }
});

test("a read is refused before the append cap has even fired", async () => {
  const hung = createBlockedWrite();
  const redis = createFakeEventRedis({ xadd: hung.write });
  const store = await createStore(redis.client, {
    // The cap is a minute away and will not fire during this test. That is the
    // production shape: the cap is 5s because tripping it costs events, while
    // the read's budget is 1s because an operator waiting longer has already
    // been failed. Waiting for the cap before refusing left every read in
    // between queued behind a command that was not coming back (#269 review).
    appendTimeoutMs: 60_000,
    readSettleTimeoutMs: 20,
    closeSettleTimeoutMs: 20,
  });

  try {
    void store.append(appendInput(0));
    await delay(60);

    const issuedBefore = redis.issued().length;
    await assert.rejects(
      Promise.resolve(store.query({ page: 1, pageSize: 10 })),
      /not answering/,
    );
    assert.equal(redis.issued().length, issuedBefore);
  } finally {
    hung.release();
    await store.close();
  }
});

test("close gives up on a hung write inside its budget, and says so", async () => {
  const hung = createBlockedWrite();
  const redis = createFakeEventRedis({ xadd: hung.write });
  const abandoned: Array<{
    pendingWrites: number;
    queuedAppends: number;
    quitOutcome: string;
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
    {
      pendingWrites: 1,
      queuedAppends: 1,
      // Never attempted: the drain had already run out, so the socket went
      // down instead of a `QUIT` that would have queued behind the write.
      quitOutcome: "skipped",
      budgetMs: 20,
    },
  ]);
  hung.release();
});

test("close falls back to the socket when QUIT itself is not answered, and says so", async () => {
  const redis = createFakeEventRedis();
  const abandoned: Array<{
    pendingWrites: number;
    quitOutcome: string;
  }> = [];
  const store = await createStore(redis.client, {
    closeSettleTimeoutMs: 20,
    onAppendsAbandonedAtShutdown: ({ pendingWrites, quitOutcome }) => {
      abandoned.push({ pendingWrites, quitOutcome });
    },
  });

  // Nothing queued, so the drain succeeds and close takes the graceful path —
  // and then the reply never comes, which is what a half-open connection looks
  // like once there is no write left to blame.
  const stalledQuit = createBlockedWrite();
  const gracefulClient = redis.client as { quit: () => Promise<unknown> };
  gracefulClient.quit = () => stalledQuit.write();

  assert.equal(await settledWithin(store.close(), 500), true);
  assert.equal(redis.disconnectCalls(), 1);
  // Bounded and silent is the trade this whole area exists to refuse: nothing
  // else was outstanding, so without this line a Redis failure that consumed
  // the entire close budget would be recorded as a clean shutdown (#266
  // review).
  assert.deepEqual(abandoned, [{ pendingWrites: 0, quitOutcome: "timed_out" }]);
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

test("a QUIT that answers with an error drops the socket and reports it", async () => {
  const redis = createFakeEventRedis();
  const abandoned: Array<{
    pendingWrites: number;
    quitOutcome: string;
  }> = [];
  const store = await createStore(redis.client, {
    closeSettleTimeoutMs: 200,
    onAppendsAbandonedAtShutdown: ({ pendingWrites, quitOutcome }) => {
      abandoned.push({ pendingWrites, quitOutcome });
    },
  });

  const failingClient = redis.client as { quit: () => Promise<unknown> };
  failingClient.quit = () => Promise.reject(new Error("Connection is closed."));

  await store.close();

  // A rejected `QUIT` settles just as promptly as a successful one, so a
  // "did it settle" answer calls this a graceful close and records a clean
  // shutdown — with the connection left in a state nobody checked (#266
  // review).
  assert.deepEqual(abandoned, [{ pendingWrites: 0, quitOutcome: "failed" }]);
  assert.equal(redis.disconnectCalls(), 1);
});

test("the shedding line is throttled per reason, and never paired", async () => {
  let clock = 1_000;
  const hung = createBlockedWrite();
  const redis = createFakeEventRedis({ xadd: hung.write });
  const dropped: string[] = [];
  const store = await createStore(redis.client, {
    appendTimeoutMs: 20,
    maxPendingAppends: 2,
    closeSettleTimeoutMs: 20,
    now: () => clock,
    onAppendsDropped: ({ reason }) => {
      dropped.push(reason);
    },
  });

  try {
    // Redis is behind but inside its cap: the depth limit trips first.
    void store.append(appendInput(0));
    void store.append(appendInput(1));
    void store.append(appendInput(2));
    void store.append(appendInput(3));
    assert.deepEqual(dropped, ["overflow"]);

    // ...then the same write blows its cap. A different reason means a
    // different diagnosis — Redis went from behind to not answering — so it
    // gets its own line without any notion of an incident to re-open.
    await delay(60);
    void store.append(appendInput(4));
    void store.append(appendInput(5));
    assert.deepEqual(dropped, ["overflow", "stalled"]);

    // Still shedding a minute later: one more line, because a stall that lasts
    // an hour should not be one line an hour old. No pairing, no terminator —
    // whether it is STILL happening is the metric's question, and it answers
    // it without any state that can be wrong (#266 review).
    clock += 60_000;
    void store.append(appendInput(6));
    void store.append(appendInput(7));
    assert.deepEqual(dropped, ["overflow", "stalled", "stalled"]);
  } finally {
    hung.release();
    await store.close();
  }
});

test("a read that slipped past the check still ends in an answer", async () => {
  // The residual the head-of-connection check cannot cover: it is evidence
  // about the past, and this stall begins in the gap between the check and the
  // command. Nothing is in flight when the read is admitted; the read's own
  // command is the one that hangs.
  const hungRead = createBlockedWrite();
  const redis = createFakeEventRedis({
    xrevrange: async () => {
      await hungRead.write();
      return [];
    },
  });
  const store = await createStore(redis.client, {
    readSettleTimeoutMs: 20,
    readCommandTimeoutMs: 30,
    closeSettleTimeoutMs: 200,
  });

  try {
    // Without this bound the caller waits until Node's default 300s
    // `requestTimeout` kills the request (#269 review).
    const query = Promise.resolve(store.query({ page: 1, pageSize: 10 }));
    assert.equal(await settledWithin(query, 500), true);
    await assert.rejects(query, /not answering/);
  } finally {
    hungRead.release();
    await store.close();
  }
});
