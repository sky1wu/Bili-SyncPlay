import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  AuditStoreUnavailableError,
  createRedisAuditStore,
  type RedisAuditStoreClient,
  type RedisAuditStoreOptions,
} from "../src/admin/redis-audit-store.js";
import type { AdminSession, AuditLogRecord } from "../src/admin/types.js";

const ACTOR: AdminSession = {
  id: "session-1",
  adminId: "admin-1",
  username: "admin",
  role: "admin",
  createdAt: 1,
  expiresAt: 1_000,
  lastSeenAt: 1,
};

/**
 * The failure every test here is about: a command that is accepted and never
 * answered. No reachable Redis produces it on demand — a half-open TCP
 * connection or a blocked server does, and neither is something a unit test can
 * arrange — so the client is the seam (#267).
 */
function createFakeAuditRedis(
  options: {
    xadd?: () => Promise<string>;
    /** Injected the same way `xadd` is, so the read path gets a seam too. */
    xrevrange?: () => Promise<Array<[string, string[]]>>;
  } = {},
): {
  client: RedisAuditStoreClient;
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

  const client: RedisAuditStoreClient = {
    connect: async () => undefined,
    quit: () =>
      command("quit", async () => {
        quitCalls += 1;
      }),
    disconnect: () => {
      disconnectCalls += 1;
    },
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
    xrevrange: () =>
      command("xrevrange", async () =>
        options.xrevrange ? await options.xrevrange() : [],
      ),
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
  actor: AdminSession;
  action: string;
  targetType: "room";
  targetId: string;
  result: "ok";
} {
  return {
    actor: ACTOR,
    action: "close_room",
    targetType: "room",
    targetId: `ROOM${index}`,
    result: "ok",
  };
}

async function createStore(
  client: RedisAuditStoreClient,
  options: Omit<RedisAuditStoreOptions, "redisClient"> = {},
): ReturnType<typeof createRedisAuditStore> {
  return await createRedisAuditStore("redis://unused", {
    redisClient: client,
    ...options,
  });
}

/** The union `GlobalAuditStore.append` declares, as one promise to assert on. */
function appended(
  record: AuditLogRecord | Promise<AuditLogRecord>,
): Promise<AuditLogRecord> {
  return Promise.resolve(record);
}

async function refusalReasonOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof AuditStoreUnavailableError);
    return error.reason;
  }
  throw new Error("expected the append to be refused");
}

test("a hung write stops the queue growing, and every refused record says so", async () => {
  const hung = createBlockedWrite();
  const redis = createFakeAuditRedis({ xadd: hung.write });
  const store = await createStore(redis.client, {
    appendTimeoutMs: 20,
    maxPendingAppends: 100,
    closeSettleTimeoutMs: 20,
  });

  const stalling = appended(store.append(appendInput(0)));
  stalling.catch(() => undefined);

  try {
    // Past the cap, so the store knows the write is not coming back.
    await delay(60);

    const refusals = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        refusalReasonOf(appended(store.append(appendInput(index)))),
      ),
    );

    // The whole defect: before this, every one of those appends chained a
    // closure onto a promise that could only settle when Redis did, and none of
    // them ever answered their caller.
    assert.deepEqual(new Set(refusals), new Set(["stalled"]));
    // ...while the connection carries exactly the one command it already had.
    assert.equal(redis.xaddCalls(), 1);
    // Refused, not shed. `redis-event-store` answers a dropped event
    // successfully because rejecting would cost one stdout error line per log
    // line; an audit record is an accountability record written at admin-action
    // rate, so losing one quietly is not a trade this store may make — every
    // refusal becomes an `admin_audit_log_append_failed` line (#267).
    assert.equal(await settledWithin(stalling, 20), false);
  } finally {
    hung.release();
    await store.close();
  }
});

test("a write that is merely slow still bounds the queue", async () => {
  const slow = createBlockedWrite();
  const redis = createFakeAuditRedis({ xadd: slow.write });
  const store = await createStore(redis.client, {
    // Far longer than this test runs: the point is that Redis is ANSWERING,
    // just slower than records arrive, so the per-write cap never fires and it
    // is the depth limit doing all the work.
    appendTimeoutMs: 60_000,
    maxPendingAppends: 3,
  });

  try {
    const appends = Array.from({ length: 10 }, (_, index) =>
      appended(store.append(appendInput(index))),
    );
    const refused = await Promise.all(
      appends.slice(3).map((append) => refusalReasonOf(append)),
    );

    assert.deepEqual(new Set(refused), new Set(["overflow"]));
    slow.release();
    await Promise.all(appends.slice(0, 3));
    // Three queued and written, seven refused at the door. Without the depth
    // limit all ten would have queued, and a stream of them would have grown
    // the queue for as long as Redis stayed behind.
    assert.equal(redis.xaddCalls(), 3);
  } finally {
    slow.release();
    await store.close();
  }
});

test("the chain does not run a second write on top of an unanswered one", async () => {
  const hung = createBlockedWrite({ blockedCalls: 1 });
  const redis = createFakeAuditRedis({ xadd: hung.write });
  const store = await createStore(redis.client, {
    appendTimeoutMs: 20,
    maxPendingAppends: 10,
    closeSettleTimeoutMs: 50,
  });

  try {
    const first = appended(store.append(appendInput(0)));
    const second = appended(store.append(appendInput(1)));
    await delay(60);

    // The cap answered `first`'s own bookkeeping, but it cannot cancel the
    // command, so the queued `second` must stay put: two writes outstanding
    // against a dependency that has answered neither would land out of order if
    // it recovered.
    assert.equal(redis.xaddCalls(), 1);

    hung.release();
    await Promise.all([first, second]);
    assert.equal(redis.xaddCalls(), 2);
  } finally {
    await store.close();
  }
});

test("an audit query is refused, not queued, while the connection is not answering", async () => {
  const hung = createBlockedWrite();
  const redis = createFakeAuditRedis({ xadd: hung.write });
  const store = await createStore(redis.client, {
    appendTimeoutMs: 20,
    readSettleTimeoutMs: 20,
    closeSettleTimeoutMs: 20,
  });

  try {
    appended(store.append(appendInput(0))).catch(() => undefined);
    // Past the cap: the write is not coming back, so nothing sent now will come
    // back either.
    await delay(60);

    const issuedBefore = redis.issued().length;
    await assert.rejects(
      Promise.resolve(store.query({ page: 1, pageSize: 10 })),
      /not answering/,
    );

    // The point is the command that was NOT sent. `await pendingAppend` used to
    // put the audit page on the same unbounded wait as the writes, and a
    // console that polls would leave another read and its closure in ioredis's
    // queue for as long as the stall lasts (#267).
    assert.equal(redis.issued().length, issuedBefore);
  } finally {
    hung.release();
    await store.close();
  }
});

test("an audit query still waits, briefly, for a queue that is merely slow", async () => {
  let streamId = 0;
  const redis = createFakeAuditRedis({
    // Every write ANSWERS — just slowly enough that ten of them cannot drain
    // inside the read's budget. That is the distinction the read has to make,
    // and modelling "slow" as a write that never comes back is what let the
    // earlier version of this test pass while the real slow case was broken
    // (#269 review).
    xadd: async () => {
      await delay(15);
      streamId += 1;
      return `${streamId}-0`;
    },
  });
  const store = await createStore(redis.client, {
    // The cap has NOT fired, and would not for another minute: Redis is
    // answering, just behind. Refusing here would take the audit page down on a
    // Redis that is working.
    appendTimeoutMs: 60_000,
    maxPendingAppends: 20,
    readSettleTimeoutMs: 60,
    closeSettleTimeoutMs: 2_000,
  });

  try {
    const appends = Array.from({ length: 10 }, (_, index) =>
      appended(store.append(appendInput(index))),
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

test("an audit query is refused before the append cap has even fired", async () => {
  const hung = createBlockedWrite();
  const redis = createFakeAuditRedis({ xadd: hung.write });
  const store = await createStore(redis.client, {
    // The cap is a minute away and will not fire during this test. That is the
    // production shape: the cap is 5s because tripping it costs records, while
    // the read's budget is 1s because an operator waiting longer has already
    // been failed.
    appendTimeoutMs: 60_000,
    readSettleTimeoutMs: 20,
    closeSettleTimeoutMs: 20,
  });

  try {
    appended(store.append(appendInput(0))).catch(() => undefined);
    await delay(60);

    const issuedBefore = redis.issued().length;
    // Before this, the read waited out its budget, ignored the fact that
    // nothing had settled, and issued `XREVRANGE` anyway — onto a connection
    // whose head command was not coming back. The request hung forever, and the
    // console's 15s poll left another one there every time (#269 review).
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
  const redis = createFakeAuditRedis({ xadd: hung.write });
  const unfinished: Array<{
    pendingWrites: number;
    queuedAppends: number;
    quitOutcome: string;
    budgetMs: number;
  }> = [];
  const store = await createStore(redis.client, {
    appendTimeoutMs: 60_000,
    closeSettleTimeoutMs: 20,
    onCloseUnfinished: (info) => {
      unfinished.push(info);
    },
  });

  appended(store.append(appendInput(0))).catch(() => undefined);

  // Unbounded, this never returns, and `close_admin_services` reports a failed
  // shutdown step on its own 5s budget every time Redis is hung (#267).
  assert.equal(await settledWithin(store.close(), 500), true);
  // The socket, not `QUIT`. `QUIT` is a command on the same queue as the write
  // that is not answering, so waiting for its reply would hand the step back
  // exactly the timeout the drain budget just removed.
  assert.equal(redis.disconnectCalls(), 1);
  assert.equal(redis.quitCalls(), 0);
  // Bounded is not the same as quiet: the record was still on the connection
  // that just went down, and that used to be visible only because the step
  // timed out.
  assert.deepEqual(unfinished, [
    {
      pendingWrites: 1,
      queuedAppends: 1,
      quitOutcome: "skipped",
      budgetMs: 20,
    },
  ]);
  hung.release();
});

test("close falls back to the socket when QUIT itself is not answered, and says so", async () => {
  const redis = createFakeAuditRedis();
  const unfinished: Array<{ pendingWrites: number; quitOutcome: string }> = [];
  const store = await createStore(redis.client, {
    closeSettleTimeoutMs: 20,
    onCloseUnfinished: ({ pendingWrites, quitOutcome }) => {
      unfinished.push({ pendingWrites, quitOutcome });
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
  assert.deepEqual(unfinished, [
    { pendingWrites: 0, quitOutcome: "timed_out" },
  ]);
  stalledQuit.release();
});

test("a QUIT that answers with an error drops the socket and reports it", async () => {
  const redis = createFakeAuditRedis();
  const unfinished: Array<{ quitOutcome: string }> = [];
  const store = await createStore(redis.client, {
    closeSettleTimeoutMs: 200,
    onCloseUnfinished: ({ quitOutcome }) => {
      unfinished.push({ quitOutcome });
    },
  });

  const failingClient = redis.client as { quit: () => Promise<unknown> };
  failingClient.quit = () => Promise.reject(new Error("Connection is closed."));

  await store.close();

  // A rejected `QUIT` settles just as promptly as a successful one, so a "did
  // it settle" answer would call this a graceful close and record a clean
  // shutdown — with the connection left in a state nobody checked (#266
  // review).
  assert.deepEqual(unfinished, [{ quitOutcome: "failed" }]);
  assert.equal(redis.disconnectCalls(), 1);
});

test("close still flushes a healthy queue, and stays quiet doing it", async () => {
  const redis = createFakeAuditRedis();
  let unfinishedCalls = 0;
  const store = await createStore(redis.client, {
    closeSettleTimeoutMs: 500,
    onCloseUnfinished: () => {
      unfinishedCalls += 1;
    },
  });

  // Not awaited: the append is still queued when close starts, which is the
  // ordinary shutdown case — dropping it would lose the last admin action of
  // every clean restart.
  const pending = appended(store.append(appendInput(0)));
  await store.close();
  await pending;

  assert.equal(redis.xaddCalls(), 1);
  // An ordinary shutdown must not log a degraded line, or the signal means
  // nothing on the one shutdown where it matters.
  assert.equal(unfinishedCalls, 0);
  assert.equal(redis.quitCalls(), 1);
  assert.equal(redis.disconnectCalls(), 0);
});

test("a record close already gave up on is reported lost, not answered as written", async () => {
  const hung = createBlockedWrite({ blockedCalls: 1 });
  const redis = createFakeAuditRedis({ xadd: hung.write });
  const store = await createStore(redis.client, {
    appendTimeoutMs: 60_000,
    closeSettleTimeoutMs: 20,
  });

  const first = appended(store.append(appendInput(0)));
  const second = appended(store.append(appendInput(1)));
  await store.close();
  assert.equal(redis.disconnectCalls(), 1);

  hung.release();

  // `second` was still queued when close ran out of budget. Writing it now
  // would issue a command on a closed connection; answering it successfully
  // would tell the caller an audit record landed when it did not.
  assert.equal(await refusalReasonOf(second), "closing");
  await first.catch(() => undefined);
  assert.equal(redis.xaddCalls(), 1);
});

test("a read that slipped past the check still ends in an answer", async () => {
  // The residual the head-of-connection check cannot cover: it is evidence
  // about the past, and this stall begins in the gap between the check and the
  // command. Here that is arranged exactly — nothing is in flight when the read
  // is admitted, and the read's own command is the one that hangs.
  const hungRead = createBlockedWrite();
  const redis = createFakeAuditRedis({
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
    // `requestTimeout` kills the request (#269 review). The command itself
    // cannot be cancelled either way — what changes is that the operator gets
    // an answer.
    const query = Promise.resolve(store.query({ page: 1, pageSize: 10 }));
    assert.equal(await settledWithin(query, 500), true);
    await assert.rejects(query, /not answering/);
  } finally {
    hungRead.release();
    await store.close();
  }
});

test("an ordinary read is not touched by the command bound", async () => {
  const redis = createFakeAuditRedis();
  const store = await createStore(redis.client, {
    readSettleTimeoutMs: 20,
    readCommandTimeoutMs: 30,
    closeSettleTimeoutMs: 200,
  });

  try {
    // The other half: a backstop that fired on a working Redis would be worse
    // than the hang it exists for.
    const result = await store.query({ page: 1, pageSize: 10 });
    assert.deepEqual(result, { items: [], total: 0 });
  } finally {
    await store.close();
  }
});
