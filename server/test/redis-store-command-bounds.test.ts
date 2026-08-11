/**
 * On the two caller-bounded connections, every command a request issues answers
 * its caller — and every command a maintenance pass issues still does not.
 *
 * #271 settled which connections may take `commandTimeout` and recorded what
 * that leaves open: the room store's request path and the runtime store's had
 * no caller-side bound at all, so a Redis that accepted commands and stopped
 * replying held a WebSocket join open with nothing counting down anywhere
 * (#277).
 *
 * Two things are proved here, and they pull in opposite directions, which is
 * why both need saying:
 *
 * - A request-path method answers even when one of its commands never does.
 *   Per COMMAND, not per method: the sweep hangs the k-th command of a healthy
 *   run for every k, so a method that bounds its first command and not its
 *   third fails here rather than in production.
 * - A method a maintenance pass drives does NOT answer, deliberately. Its cap
 *   lives in `maintenance-pass`, whose `stalled` outcome is derived from this
 *   very silence; capping it here would let the next tick run a second pass on
 *   top of the first (#261, #263).
 *
 * The classification tests are the mechanical half: every method of both stores
 * must appear in exactly one table, so a method added later cannot inherit
 * "unbounded" by saying nothing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createRedisRuntimeStore } from "../src/redis-runtime-store.js";
import {
  createRedisRoomStore,
  type RedisRoomStoreClient,
} from "../src/redis-room-store.js";
import { RedisStoreUnavailableError } from "../src/redis-store-unavailable.js";
import type { RuntimeReadCaller } from "../src/runtime-store.js";
import { settleWithin } from "../src/retry-pacer.js";

/** Short enough to keep the sweep fast; the mechanism is the same at 5s. */
const BUDGET_MS = 40;
/** Comfortably past the budget, so "answered" cannot mean "answered late". */
const OBSERVATION_MS = 400;

/**
 * A command that never answers, at a chosen position in the sequence.
 *
 * `hangAt` is an index over the commands the method issues, so a probe can walk
 * a whole method one command at a time. `issuedCount` is what makes the
 * admission test meaningful: a refusal must mean the command was never sent.
 */
function createProbeCommands(hangAt: number | null) {
  let issued = 0;
  return {
    issuedCount: () => issued,
    next<T>(value: T): Promise<T> {
      const index = issued;
      issued += 1;
      if (index === hangAt) {
        return new Promise<T>(() => undefined);
      }
      return Promise.resolve(value);
    },
  };
}

type ProbeCommands = ReturnType<typeof createProbeCommands>;

/**
 * Answers every runtime-store command with the smallest reply that still walks
 * the loops: one member in the room and one field-bearing session, so
 * `loadSession` runs rather than being skipped for an empty hash.
 */
function createRuntimeProbeClient(commands: ProbeCommands) {
  const hashFor = (key: string): Record<string, string> => {
    if (key.endsWith(":members")) {
      return { "member-1": "session-1" };
    }
    if (key.endsWith(":member-tokens")) {
      return { "member-1": "token-1" };
    }
    if (key.includes(":session:")) {
      // Seated, and belonging to the instance `purgeSessionsByInstance` is
      // asked about. A session that failed either test made that method skip
      // its whole loop body, so the probe walked past two uncapped commands
      // reporting success — the reason a probe has to be checked against the
      // command COUNT it produces, not only against its verdict.
      return {
        id: "session-1",
        displayName: "session-1",
        instanceId: "session-1-node",
        roomCode: "ROOM01",
        memberId: "member-1",
      };
    }
    return {};
  };
  const multi = {
    sadd: () => multi,
    srem: () => multi,
    del: () => multi,
    hset: () => multi,
    hdel: () => multi,
    zadd: () => multi,
    zrem: () => multi,
    exec: () => commands.next<unknown>(null),
  };
  return {
    async connect() {},
    async quit() {},
    disconnect() {},
    multi: () => multi,
    hgetall: (key: string) => commands.next(hashFor(key)),
    hget: () => commands.next<string | null>(null),
    smembers: () => commands.next<string[]>(["session-1"]),
    scard: () => commands.next(0),
    sadd: () => commands.next<unknown>(null),
    srem: () => commands.next<unknown>(null),
    zadd: () => commands.next<unknown>(null),
    zremrangebyscore: () => commands.next<unknown>(null),
    zrange: () => commands.next<string[]>([]),
    zrem: () => commands.next<unknown>(null),
    zscore: () => commands.next<string | null>(null),
    set: () => commands.next<string | null>("OK"),
    eval: () => commands.next<unknown>(null),
    del: () => commands.next<unknown>(null),
    get: () => commands.next<string | null>(null),
  };
}

type RuntimeStoreUnderTest = Awaited<
  ReturnType<typeof createRedisRuntimeStore>
>;

async function withRuntimeStore<T>(
  hangAt: number | null,
  use: (store: RuntimeStoreUnderTest, commands: ProbeCommands) => Promise<T>,
): Promise<T> {
  const commands = createProbeCommands(hangAt);
  const store = await createRedisRuntimeStore("redis://unused", {
    redisClient: createRuntimeProbeClient(commands),
    pendingOperationTimeoutMs: BUDGET_MS,
    closeQuitTimeoutMs: BUDGET_MS,
    onPendingOperationError() {},
    onCloseUnfinished() {},
  });
  try {
    return await use(store, commands);
  } finally {
    await store.close();
  }
}

/**
 * Request-path methods: each must answer its caller with one command hung, for
 * every command it issues.
 */
const RUNTIME_REQUEST_PATH: Record<
  string,
  (store: RuntimeStoreUnderTest) => Promise<unknown>
> = {
  getRoom: (store) => Promise.resolve(store.getRoom("ROOM01")),
  findMemberIdByToken: (store) =>
    Promise.resolve(store.findMemberIdByToken("ROOM01", "token-1")),
  isMemberTokenBlocked: (store) =>
    Promise.resolve(store.isMemberTokenBlocked("ROOM01", "token-1", 1_000)),
  hasRoomResidue: (store) => Promise.resolve(store.hasRoomResidue("ROOM01")),
  getRoomGeneration: (store) =>
    Promise.resolve(store.getRoomGeneration("ROOM01")),
  tryClaimMessageSlot: (store) =>
    Promise.resolve(
      store.tryClaimMessageSlot("ROOM01", "share:1", "claim-token", 60_000),
    ),
  releaseMessageSlot: (store) =>
    Promise.resolve(
      store.releaseMessageSlot("ROOM01", "share:1", "claim-token"),
    ),
  acquireRoomLock: (store) =>
    Promise.resolve(store.acquireRoomLock("ROOM01", "join", "tok", 60_000)),
  releaseRoomLock: (store) =>
    Promise.resolve(store.releaseRoomLock("ROOM01", "join", "tok")),
  listClusterSessionsByRoom: (store) =>
    Promise.resolve(store.listClusterSessionsByRoom?.("ROOM01")),
  countClusterActiveRooms: (store) =>
    Promise.resolve(store.countClusterActiveRooms?.()),
  listClusterActiveRoomCodes: (store) =>
    Promise.resolve(store.listClusterActiveRoomCodes?.()),
  purgeSessionsByInstance: (store) =>
    Promise.resolve(store.purgeSessionsByInstance?.("session-1-node")),
};

/**
 * Methods that issue Redis commands whose bound belongs to an OUTER caller.
 * The reason is the point: each names who stops waiting, so the exemption
 * cannot be taken by omission the way it was before #271.
 */
const RUNTIME_BOUNDED_ELSEWHERE: Record<string, string> = {
  registerSession: "durable write queue: withAttemptTimeout per attempt",
  unregisterSession: "durable write queue: withAttemptTimeout per attempt",
  markSessionJoinedRoom: "durable write queue: withAttemptTimeout per attempt",
  markSessionLeftRoom: "durable write queue: withAttemptTimeout per attempt",
  removeMember: "durable write queue: withAttemptTimeout per attempt",
  addMember: "trackOperation's cap at pendingOperationTimeoutMs",
  flush: "its own barrier at pendingOperationTimeoutMs",
  confirmWrites: "the durable write queue it confirms",
  close: "settleWithin and quitWithin, both inside the shutdown step's budget",
  heartbeatNode: "maintenance-pass: node-heartbeat's per-tick cap",
  purgeNodeStatus: "maintenance-pass: runtime-index-reaper's per-tick cap",
};

/**
 * Reads whose bound travels with the CALL, because both kinds of caller use
 * them: the runtime index reaper (through `maintenance-pass`) and
 * `/api/admin/overview`. Classifying them by method is what #277's first round
 * got wrong — and the excuse for it, that Node's `requestTimeout` catches the
 * HTTP side, is not true: it bounds RECEIVING a request, not producing its
 * response.
 */
const RUNTIME_CALLER_CHOSEN: Record<
  string,
  (store: RuntimeStoreUnderTest, caller: RuntimeReadCaller) => Promise<unknown>
> = {
  listNodeStatuses: (store, caller) =>
    Promise.resolve(store.listNodeStatuses?.(caller, 1_000)),
  listClusterSessions: (store, caller) =>
    Promise.resolve(store.listClusterSessions?.(caller)),
};

/**
 * The five durable writes #237 argued must never be told they failed while
 * their write may still land. Their side effect does not expire on its own, so
 * bounding them re-opens that trade — deliberately still open (#277).
 */
const RUNTIME_UNBOUNDED_DURABLE_WRITES: Record<string, string> = {
  blockMemberToken:
    "#237: an answer that can be wrong is worse than a slow one",
  evictMemberToken:
    "#237: an answer that can be wrong is worse than a slow one",
  revokeMemberToken:
    "#237: an answer that can be wrong is worse than a slow one",
  markRoomGeneration:
    "#237: an answer that can be wrong is worse than a slow one",
  deleteRoom: "#237: an answer that can be wrong is worse than a slow one",
};

/** Methods that answer from the in-process mirror and issue no command. */
const RUNTIME_LOCAL_ONLY = [
  "recordEvent",
  "getSession",
  "listSessionsByRoom",
  "getConnectionCount",
  "getActiveRoomCount",
  "getActiveMemberCount",
  "getStartedAt",
  "getRecentEventCounts",
  "getLifetimeEventCounts",
  "getActiveRoomCodes",
  "getOrCreateRoom",
];

test("every runtime store method is classified by what bounds its commands", async () => {
  await withRuntimeStore(null, async (store) => {
    const classified = new Set([
      ...Object.keys(RUNTIME_REQUEST_PATH),
      ...Object.keys(RUNTIME_BOUNDED_ELSEWHERE),
      ...Object.keys(RUNTIME_CALLER_CHOSEN),
      ...Object.keys(RUNTIME_UNBOUNDED_DURABLE_WRITES),
      ...RUNTIME_LOCAL_ONLY,
    ]);
    const unclassified = Object.keys(store).filter(
      (method) => !classified.has(method),
    );
    assert.deepEqual(
      unclassified,
      [],
      "a new runtime store method must declare what bounds its Redis commands",
    );
  });
});

test("every request-path runtime command answers its caller, whichever one stalls", async () => {
  for (const [method, call] of Object.entries(RUNTIME_REQUEST_PATH)) {
    // How many commands a healthy run issues. Hanging each of them in turn is
    // what makes this a per-command claim rather than a per-method one: a
    // method that bounds its first read and not the write after it passes a
    // single-probe test and fails here.
    const issued = await withRuntimeStore(null, async (store, commands) => {
      await call(store).catch(() => undefined);
      return commands.issuedCount();
    });
    assert.ok(
      issued > 0,
      `${method} issued no Redis command; the probe proves nothing`,
    );

    for (let hangAt = 0; hangAt < issued; hangAt += 1) {
      await withRuntimeStore(hangAt, async (store) => {
        const answered = await settleWithin(
          call(store).catch(() => undefined),
          OBSERVATION_MS,
        );
        assert.equal(
          answered,
          true,
          `${method} never answered with command #${hangAt} unanswered`,
        );
      });
    }
  }
});

test("a runtime command whose bound belongs to a maintenance pass is left unanswered", async () => {
  // The control, and the half that keeps this change from undoing #261/#263:
  // `maintenance-pass` decides a pass is stalled precisely because this call
  // has not come back. An answer here would be the connection-wide backstop's
  // behaviour, arrived at by another route.
  for (const [method, call] of Object.entries(RUNTIME_CALLER_CHOSEN)) {
    await withRuntimeStore(0, async (store) => {
      const answered = await settleWithin(
        call(store, "maintenance_pass").catch(() => undefined),
        OBSERVATION_MS,
      );
      assert.equal(
        answered,
        false,
        `${method} must not answer a maintenance pass`,
      );
    });
  }
});

test("the same runtime read DOES answer when an HTTP request is the caller", async () => {
  // The other polarity, and the finding this test exists for: both of these
  // also serve /api/admin/overview, where nothing else is counting down.
  // `requestTimeout` is not a backstop there — it bounds receiving a request,
  // not producing its response (measured, #277 review).
  for (const [method, call] of Object.entries(RUNTIME_CALLER_CHOSEN)) {
    const issued = await withRuntimeStore(null, async (store, commands) => {
      await call(store, "request").catch(() => undefined);
      return commands.issuedCount();
    });
    assert.ok(issued > 0, `${method} issued no Redis command`);

    for (let hangAt = 0; hangAt < issued; hangAt += 1) {
      await withRuntimeStore(hangAt, async (store) => {
        const answered = await settleWithin(
          call(store, "request").catch(() => undefined),
          OBSERVATION_MS,
        );
        assert.equal(
          answered,
          true,
          `${method} never answered a request with command #${hangAt} unanswered`,
        );
      });
    }
  }
});

test("runtime command timeouts and admission refusals are retryable store errors", async () => {
  const commands = createProbeCommands(0);
  const store = await createRedisRuntimeStore("redis://unused", {
    redisClient: createRuntimeProbeClient(commands),
    pendingOperationTimeoutMs: BUDGET_MS,
    closeQuitTimeoutMs: BUDGET_MS,
    maxPendingOperations: 1,
    onPendingOperationError() {},
    onCloseUnfinished() {},
  });
  try {
    await assert.rejects(
      Promise.resolve(store.getRoomGeneration("ROOM01")),
      (error: unknown) =>
        error instanceof RedisStoreUnavailableError &&
        error.store === "runtime" &&
        error.reason === "timeout",
    );
    const issuedAfterTimeout = commands.issuedCount();
    await assert.rejects(
      Promise.resolve(store.getRoomGeneration("ROOM02")),
      (error: unknown) =>
        error instanceof RedisStoreUnavailableError &&
        error.store === "runtime" &&
        error.reason === "admission",
    );
    assert.equal(
      commands.issuedCount(),
      issuedAfterTimeout,
      "runtime admission refusal must not issue another command",
    );
  } finally {
    await store.close();
  }
});

test("a runtime command that is merely slow is not judged dead", async () => {
  // The failure the cap must not manufacture: answering late is not the same
  // as not answering, and a bound that cannot tell them apart converts a
  // degraded Redis into a failed one.
  const commands = createProbeCommands(null);
  const slowClient = createRuntimeProbeClient(commands);
  const store = await createRedisRuntimeStore("redis://unused", {
    redisClient: {
      ...slowClient,
      get: async () => {
        await new Promise((resolve) => setTimeout(resolve, BUDGET_MS / 2));
        return "generation-1";
      },
    },
    pendingOperationTimeoutMs: BUDGET_MS,
    closeQuitTimeoutMs: BUDGET_MS,
    onPendingOperationError() {},
  });
  try {
    assert.equal(await store.getRoomGeneration("ROOM01"), "generation-1");
  } finally {
    await store.close();
  }
});

function createRoomStoreProbeClient(
  commands: ProbeCommands,
): RedisRoomStoreClient {
  return {
    async connect() {},
    async quit() {},
    disconnect() {},
    get: () => commands.next<string | null>(null),
    scan: () => commands.next<[string, string[]]>(["0", []]),
    zscan: () => commands.next<[string, string[]]>(["0", []]),
    zcard: () => commands.next(0),
    zcount: () => commands.next(0),
    zrange: () => commands.next<string[]>([]),
    zrangebyscore: () => commands.next<string[]>([]),
    zscore: () => commands.next<string | null>(null),
    eval: () => commands.next<unknown>(null),
    ping: () => commands.next("PONG"),
  };
}

type RoomStoreUnderTest = Awaited<ReturnType<typeof createRedisRoomStore>>;

async function withRoomStore<T>(
  hangAt: number | null,
  use: (store: RoomStoreUnderTest, commands: ProbeCommands) => Promise<T>,
  options: {
    maxPendingCommands?: number;
    /**
     * Let the bootstrap reconcile finish before the probe runs, so the command
     * indices below belong to the method under test. It walks the keyspace at
     * construction, and its commands are counted like any other.
     */
    settleBootstrap?: boolean;
  } = {},
): Promise<T> {
  const { settleBootstrap = false, ...storeOptions } = options;
  const commands = createProbeCommands(hangAt);
  const store = await createRedisRoomStore("redis://unused", {
    redisClient: createRoomStoreProbeClient(commands),
    commandTimeoutMs: BUDGET_MS,
    closeQuitTimeoutMs: BUDGET_MS,
    ...storeOptions,
  });
  try {
    if (settleBootstrap) {
      await store.reconcileRoomIndex();
    }
    return await use(store, commands);
  } finally {
    await store.close();
  }
}

const ROOM_REQUEST_PATH: Record<
  string,
  (store: RoomStoreUnderTest) => Promise<unknown>
> = {
  getRoom: (store) => store.getRoom("ROOM01"),
  listRooms: (store) =>
    store.listRooms({
      keyword: "",
      includeExpired: true,
      page: 1,
      pageSize: 10,
      sortBy: "createdAt",
      sortOrder: "desc",
    }),
  countRooms: (store) =>
    store.countRooms({ keyword: "", includeExpired: true }),
  isReady: (store) => store.isReady(),
};

const ROOM_BOUNDED_ELSEWHERE: Record<string, string> = {
  deleteExpiredRooms: "maintenance-pass: room-reaper's per-tick sweep cap",
  acknowledgeOrphanedIndexClaims:
    "maintenance-pass: room-reaper's per-tick sweep cap",
  reconcileRoomIndex: "maintenance-pass: room-index-reconciler's per-tick cap",
  close: "quitWithin, inside the shutdown step's budget",
};

const ROOM_UNBOUNDED_DURABLE_WRITES: Record<string, string> = {
  createRoom:
    "#237's trade: the write may land after the caller is told it did not",
  saveRoom:
    "#237's trade: the write may land after the caller is told it did not",
  updateRoom: "read half capped; the CAS is #237's trade",
  deleteRoom:
    "#237's trade: the write may land after the caller is told it did not",
};

test("every room store method is classified by what bounds its commands", async () => {
  await withRoomStore(null, async (store) => {
    const classified = new Set([
      ...Object.keys(ROOM_REQUEST_PATH),
      ...Object.keys(ROOM_BOUNDED_ELSEWHERE),
      ...Object.keys(ROOM_UNBOUNDED_DURABLE_WRITES),
    ]);
    const unclassified = Object.keys(store).filter(
      (method) => !classified.has(method),
    );
    assert.deepEqual(
      unclassified,
      [],
      "a new room store method must declare what bounds its Redis commands",
    );
  });
});

test("every request-path room command answers its caller, whichever one stalls", async () => {
  for (const [method, call] of Object.entries(ROOM_REQUEST_PATH)) {
    // The bootstrap reconcile issues the same commands in every run, so its
    // count is a stable offset rather than something to guess at.
    const { firstOwnCommand, issued } = await withRoomStore(
      null,
      async (store, commands) => {
        const before = commands.issuedCount();
        await call(store).catch(() => undefined);
        return { firstOwnCommand: before, issued: commands.issuedCount() };
      },
      { settleBootstrap: true },
    );
    assert.ok(
      issued > firstOwnCommand,
      `${method} issued no Redis command; the probe proves nothing`,
    );

    for (let hangAt = firstOwnCommand; hangAt < issued; hangAt += 1) {
      await withRoomStore(
        hangAt,
        async (store) => {
          const answered = await settleWithin(
            call(store).catch(() => undefined),
            OBSERVATION_MS,
          );
          assert.equal(
            answered,
            true,
            `${method} never answered with command #${hangAt} unanswered`,
          );
        },
        { settleBootstrap: true },
      );
    }
  }
});

test("a room listing is not held open by the migration pass it merely joined", async () => {
  // A separate mechanism from the per-command cap, and the reason it exists:
  // the reconcile's own commands are deliberately uncapped, so a listing that
  // waits for the first pass inherits an unbounded wait unless the WAIT is
  // bounded. The pass keeps running either way — only this caller stops.
  await withRoomStore(0, async (store) => {
    const answered = await settleWithin(
      store
        .countRooms({ keyword: "", includeExpired: true })
        .catch(() => undefined),
      OBSERVATION_MS,
    );
    assert.equal(answered, true);
  });
});

test("a long but progressing migration does not fail the listings waiting on it", async () => {
  // The bootstrap pass walks the whole keyspace, so on a large database it
  // legitimately runs far longer than any one command may. A total budget on
  // this wait would fail every admin listing for the length of a healthy
  // migration — the same mistake as giving a startup migration one budget
  // (#271 review). The bound is on SILENCE, so this pass keeps its caller by
  // answering commands slowly rather than quickly.
  const commands = createProbeCommands(null);
  let scans = 0;
  const store = await createRedisRoomStore("redis://unused", {
    redisClient: {
      ...createRoomStoreProbeClient(commands),
      scan: async (): Promise<[string, string[]]> => {
        scans += 1;
        await new Promise((resolve) => setTimeout(resolve, BUDGET_MS * 0.8));
        // Four chunks, so the whole walk takes several budgets while no single
        // command does.
        return [scans < 4 ? String(scans) : "0", []];
      },
    },
    commandTimeoutMs: BUDGET_MS,
    closeQuitTimeoutMs: BUDGET_MS,
  });
  try {
    assert.equal(
      await store.countRooms({ keyword: "", includeExpired: true }),
      0,
    );
    assert.ok(scans >= 4, "the migration must have outlasted several budgets");
  } finally {
    await store.close();
  }
});

test("the room reaper's sweep is left unanswered, so its pass can report stalled", async () => {
  // Bootstrap is settled first so the hung command is the SWEEP itself rather
  // than the migration wait ahead of it — two different uncapped things, and
  // only one of them is what `maintenance-pass` reads as `stalled`.
  const bootstrapCommands = await withRoomStore(
    null,
    async (_store, commands) => commands.issuedCount(),
    { settleBootstrap: true },
  );

  await withRoomStore(
    bootstrapCommands,
    async (store) => {
      const answered = await settleWithin(
        store.deleteExpiredRooms(1_000).catch(() => undefined),
        OBSERVATION_MS,
      );
      assert.equal(answered, false);
    },
    { settleBootstrap: true },
  );
});

test("the room reaper's orphan acknowledgement is left unanswered too", async () => {
  const bootstrapCommands = await withRoomStore(
    null,
    async (_store, commands) => commands.issuedCount(),
    { settleBootstrap: true },
  );

  await withRoomStore(
    bootstrapCommands,
    async (store) => {
      const acknowledge = store.acknowledgeOrphanedIndexClaims;
      assert.ok(acknowledge);
      const answered = await settleWithin(
        acknowledge([{ code: "ROOM01", token: "claim-1" }]).catch(
          () => undefined,
        ),
        OBSERVATION_MS,
      );
      assert.equal(answered, false);
    },
    { settleBootstrap: true },
  );
});

test("the reaper's wait on the migration pass is left unanswered too", async () => {
  // The other half of the same claim, and the polarity a listing gets the
  // opposite answer to: the reaper waits for the first reconcile before it can
  // see any candidate, and that wait is the pass's own — bounding it here would
  // make `stalled` unreachable just as surely as bounding the sweep.
  await withRoomStore(0, async (store) => {
    const answered = await settleWithin(
      store.deleteExpiredRooms(1_000).catch(() => undefined),
      OBSERVATION_MS,
    );
    assert.equal(answered, false);
  });
});

test("room store admission refuses a command instead of issuing it", async () => {
  // The other half of #277: a cap answers the caller but leaves the command on
  // the connection, so without admission a stalled Redis still accumulates one
  // command per request. A refusal is the only answer that carries no "it may
  // have landed" — the command was never sent.
  const bootstrapCommands = await withRoomStore(
    null,
    async (_store, commands) => commands.issuedCount(),
    { settleBootstrap: true },
  );

  await withRoomStore(
    bootstrapCommands,
    async (store, commands) => {
      const stalled = store.getRoom("ROOM01").catch(() => undefined);
      assert.equal(await settleWithin(stalled, OBSERVATION_MS), true);
      const issuedAfterStall = commands.issuedCount();

      await assert.rejects(
        store.getRoom("ROOM02"),
        (error: unknown) =>
          error instanceof RedisStoreUnavailableError &&
          error.store === "room" &&
          error.reason === "admission",
      );
      assert.equal(
        commands.issuedCount(),
        issuedAfterStall,
        "a refused command must never reach the connection",
      );
    },
    { maxPendingCommands: 1, settleBootstrap: true },
  );
});

test("room command timeouts are retryable store errors", async () => {
  const bootstrapCommands = await withRoomStore(
    null,
    async (_store, commands) => commands.issuedCount(),
    { settleBootstrap: true },
  );

  await withRoomStore(
    bootstrapCommands,
    async (store) => {
      await assert.rejects(
        store.getRoom("ROOM01"),
        (error: unknown) =>
          error instanceof RedisStoreUnavailableError &&
          error.store === "room" &&
          error.reason === "timeout",
      );
    },
    { settleBootstrap: true },
  );
});

test("a room store command that is merely slow is not judged dead", async () => {
  const commands = createProbeCommands(null);
  const store = await createRedisRoomStore("redis://unused", {
    redisClient: {
      ...createRoomStoreProbeClient(commands),
      get: async () => {
        await new Promise((resolve) => setTimeout(resolve, BUDGET_MS / 2));
        return null;
      },
    },
    commandTimeoutMs: BUDGET_MS,
    closeQuitTimeoutMs: BUDGET_MS,
  });
  try {
    assert.equal(await store.getRoom("ROOM01"), null);
  } finally {
    await store.close();
  }
});

test("a listing reads more rooms than the admission limit without being refused", async () => {
  // Admission is a refusal boundary, not a scheduler. `listRooms` reads a whole
  // REPAIR_CHUNK_SIZE batch at once, so before the fan-out budget a deployment
  // with more rooms than `maxPendingCommands` failed every listing on a
  // completely healthy Redis — 257 rooms was enough (#277 review).
  const roomCount = 300;
  const codes = Array.from(
    { length: roomCount },
    (_, index) => `ROOM${String(index).padStart(4, "0")}`,
  );
  const bodies = new Map(
    codes.map((code) => [
      code,
      JSON.stringify({
        code,
        joinToken: "join-token-123456",
        version: 1,
        createdAt: 1,
        ownerMemberId: null,
        ownerDisplayName: null,
        sharedVideo: null,
        playback: null,
        lastActiveAt: 1,
        expiresAt: null,
      }),
    ]),
  );
  let peakConcurrentGets = 0;
  let liveGets = 0;
  const commands = createProbeCommands(null);
  const store = await createRedisRoomStore("redis://unused", {
    redisClient: {
      ...createRoomStoreProbeClient(commands),
      zrange: async () => codes,
      get: async (key: string) => {
        liveGets += 1;
        peakConcurrentGets = Math.max(peakConcurrentGets, liveGets);
        await new Promise((resolve) => setTimeout(resolve, 1));
        liveGets -= 1;
        return bodies.get(key.slice(key.lastIndexOf(":") + 1)) ?? null;
      },
    },
    commandTimeoutMs: BUDGET_MS,
    closeQuitTimeoutMs: BUDGET_MS,
    maxPendingCommands: 256,
  });
  try {
    const listed = await store.listRooms({
      keyword: "",
      includeExpired: true,
      page: 1,
      pageSize: roomCount,
      sortBy: "createdAt",
      sortOrder: "desc",
    });
    assert.equal(listed.length, roomCount);
    assert.ok(
      peakConcurrentGets <= 128,
      `fan-out reached ${peakConcurrentGets}, which admission would refuse`,
    );
  } finally {
    await store.close();
  }
});

test("a room with more sessions than the admission limit still lists them", async () => {
  // The same shape one layer down: `listClusterSessionsByRoom` issues one
  // HGETALL per session, all at once.
  const sessionCount = 300;
  const sessionIds = Array.from(
    { length: sessionCount },
    (_, index) => `session-${index}`,
  );
  const commands = createProbeCommands(null);
  const store = await createRedisRuntimeStore("redis://unused", {
    redisClient: {
      ...createRuntimeProbeClient(commands),
      smembers: async () => sessionIds,
      hgetall: async (key: string): Promise<Record<string, string>> => {
        if (!key.includes(":session:")) {
          return {};
        }
        const id = key.slice(key.lastIndexOf(":") + 1);
        return { id, displayName: id };
      },
    },
    pendingOperationTimeoutMs: BUDGET_MS,
    closeQuitTimeoutMs: BUDGET_MS,
    maxPendingOperations: 256,
    onPendingOperationError() {},
    onCloseUnfinished() {},
  });
  try {
    const sessions = await store.listClusterSessionsByRoom?.("ROOM01");
    assert.equal(sessions?.length, sessionCount);
  } finally {
    await store.close();
  }
});

test("a deployment with more nodes than the admission limit still lists them", async () => {
  const nodeCount = 20;
  const instanceIds = Array.from(
    { length: nodeCount },
    (_, index) => `node-${index}`,
  );
  let liveReads = 0;
  let peakConcurrentReads = 0;
  const commands = createProbeCommands(null);
  const store = await createRedisRuntimeStore("redis://unused", {
    redisClient: {
      ...createRuntimeProbeClient(commands),
      smembers: async () => instanceIds,
      hgetall: async (key: string): Promise<Record<string, string>> => {
        const instanceId = key.slice(key.lastIndexOf(":") + 1);
        liveReads += 1;
        peakConcurrentReads = Math.max(peakConcurrentReads, liveReads);
        await new Promise((resolve) => setTimeout(resolve, 1));
        liveReads -= 1;
        return {
          instanceId,
          version: "test",
          startedAt: "1",
          lastHeartbeatAt: "1",
          staleAt: "2000",
          expiresAt: "3000",
          connectionCount: "1",
          activeRoomCount: "1",
          activeMemberCount: "1",
        };
      },
    },
    pendingOperationTimeoutMs: BUDGET_MS,
    closeQuitTimeoutMs: BUDGET_MS,
    maxPendingOperations: 8,
    onPendingOperationError() {},
    onCloseUnfinished() {},
  });
  try {
    const statuses = await store.listNodeStatuses("request", 1_000);
    assert.equal(statuses.length, nodeCount);
    assert.ok(
      peakConcurrentReads <= 4,
      `node fan-out reached ${peakConcurrentReads}, which admission would refuse`,
    );
  } finally {
    await store.close();
  }
});
