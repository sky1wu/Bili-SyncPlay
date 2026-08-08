import assert from "node:assert/strict";
import test from "node:test";
import { createMetricsCollector } from "../src/admin/metrics.js";
import { createInMemoryRuntimeStore } from "../src/runtime-store.js";

test("metrics collector renders event counters, histograms, and redis failure counters", async () => {
  const runtimeStore = createInMemoryRuntimeStore(() => 0);
  const metrics = createMetricsCollector({
    runtimeStore,
    roomStore: {
      async countRooms() {
        return 2;
      },
    },
    serviceVersion: "9.9.9-test",
  });

  runtimeStore.registerSession({
    id: "session-1",
    connectionState: "detached",
    socket: null,
    instanceId: "instance-1",
    remoteAddress: "127.0.0.1",
    origin: "chrome-extension://allowed-extension",
    roomCode: null,
    memberId: null,
    displayName: "Alice",
    memberToken: null,
    joinedAt: null,
    invalidMessageCount: 0,
    rateLimitState: {
      roomCreate: { windowStart: 0, count: 0 },
      roomJoin: { windowStart: 0, count: 0 },
      videoShare: { windowStart: 0, count: 0 },
      playbackUpdate: { tokens: 0, lastRefillAt: 0 },
      syncRequest: { windowStart: 0, count: 0 },
      syncPing: { tokens: 0, lastRefillAt: 0 },
    },
  });
  runtimeStore.markSessionJoinedRoom("session-1", "ROOM01");

  metrics.recordEvent("room_created");
  metrics.recordRateLimited("sync:request");
  metrics.recordRateLimited("sync:request");
  metrics.recordSessionProtocolVersion("2");
  metrics.recordSessionProtocolVersion("legacy");
  metrics.observeMessageHandlerDuration("room:join", 12);
  metrics.observeRedisRuntimeStoreDuration("register_session", 8);
  metrics.observeRedisRuntimeStoreFailure("register_session");
  metrics.observeRedisRoomStoreDuration("update_room", 6);
  metrics.observeRedisRoomStoreFailure("update_room");
  metrics.observeRedisRoomEventBusPublishDuration(5);
  metrics.observeRedisRoomEventBusPublishFailure();
  metrics.recordRoomEventPublishDropped("room_member_changed");
  metrics.recordRoomEventPublishDropped("room_member_changed");

  const rendered = await metrics.render();

  assert.equal(rendered.includes("bili_syncplay_connections 1"), true);
  assert.equal(rendered.includes("bili_syncplay_active_rooms 1"), true);
  assert.equal(rendered.includes("bili_syncplay_rooms_non_expired 2"), true);
  assert.equal(
    rendered.includes('bili_syncplay_build_info{version="9.9.9-test"} 1'),
    true,
  );
  const startTimeMatch = rendered.match(
    /^bili_syncplay_process_start_time_seconds (\d+(?:\.\d+)?)$/m,
  );
  assert.notEqual(startTimeMatch, null);
  assert.equal(Number(startTimeMatch![1]) > 0, true);
  assert.equal(
    rendered.includes(
      'bili_syncplay_rate_limited_total{message_type="sync:request"} 2',
    ),
    true,
  );
  // Pre-seeded to 0 so "never limited" is distinguishable from "metric absent".
  assert.equal(
    rendered.includes(
      'bili_syncplay_rate_limited_total{message_type="playback:update"} 0',
    ),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_session_protocol_versions_total{protocol_version="2"} 1',
    ),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_session_protocol_versions_total{protocol_version="legacy"} 1',
    ),
    true,
  );
  assert.equal(
    rendered.includes('bili_syncplay_events_total{event="room_created"} 1'),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_message_handler_duration_seconds_count{message_type="room:join"} 1',
    ),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_redis_runtime_store_duration_seconds_count{operation="register_session"} 1',
    ),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_redis_room_event_bus_publish_duration_seconds_count{operation="publish"} 1',
    ),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_redis_operation_failures_total{component="room_event_bus",operation="publish"} 1',
    ),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_redis_operation_failures_total{component="runtime_store",operation="register_session"} 1',
    ),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_redis_room_store_duration_seconds_count{operation="update_room"} 1',
    ),
    true,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_redis_operation_failures_total{component="room_store",operation="update_room"} 1',
    ),
    true,
  );
  // The 15ms bucket fills the 10–25ms gap where playback:update P95 lives.
  assert.equal(
    rendered.includes(
      'bili_syncplay_message_handler_duration_seconds_bucket{le="0.015",message_type="room:join"}',
    ),
    true,
  );
  for (const stat of ["mean", "p50", "p99", "max"]) {
    assert.match(
      rendered,
      new RegExp(
        `^bili_syncplay_nodejs_eventloop_lag_seconds\\{stat="${stat}"\\} `,
        "m",
      ),
    );
  }
  for (const gauge of [
    "bili_syncplay_nodejs_heap_used_bytes",
    "bili_syncplay_nodejs_heap_total_bytes",
    "bili_syncplay_nodejs_process_rss_bytes",
  ]) {
    const match = rendered.match(new RegExp(`^${gauge} (\\d+)$`, "m"));
    assert.notEqual(match, null, gauge);
    assert.equal(Number(match![1]) > 0, true, gauge);
  }
  // CPU time is the headroom signal for a single-process server: rate() over
  // this counter is cores consumed, and the JS main thread tops out at 1.0.
  for (const mode of ["user", "system"]) {
    const match = rendered.match(
      new RegExp(
        `^bili_syncplay_process_cpu_seconds_total\\{mode="${mode}"\\} (\\d+(?:\\.\\d+)?)$`,
        "m",
      ),
    );
    assert.notEqual(match, null, mode);
    // Only user time is reliably non-zero this early in a process; asserting
    // system > 0 here would be flaky.
    assert.equal(Number(match![1]) >= 0, true, mode);
  }
  assert.match(
    rendered,
    /^bili_syncplay_process_cpu_seconds_total\{mode="user"\} (?!0$)\d+(?:\.\d+)?$/m,
  );
  const coresMatch = rendered.match(
    /^bili_syncplay_process_cpu_cores_available (\d+)$/m,
  );
  assert.notEqual(coresMatch, null);
  assert.equal(Number(coresMatch![1]) >= 1, true);
  // GC kinds are pre-seeded so "no major GC" is an explicit zero series.
  for (const kind of ["major", "minor", "incremental", "weakcb"]) {
    assert.match(
      rendered,
      new RegExp(
        `^bili_syncplay_nodejs_gc_duration_seconds_count\\{kind="${kind}"\\} \\d+$`,
        "m",
      ),
    );
  }
  // Member-affecting drops are counted under their own event_type label so a
  // critical room_member_changed drop is never hidden behind high-frequency
  // room_state_updated drops.
  assert.equal(
    rendered.includes(
      'bili_syncplay_room_event_publish_dropped_total{event_type="room_member_changed"} 2',
    ),
    true,
  );
  // Pre-seeded to 0 so "no drops" is distinguishable from "metric absent".
  assert.equal(
    rendered.includes(
      'bili_syncplay_room_event_publish_dropped_total{event_type="room_state_updated"} 0',
    ),
    true,
  );
});

test("metrics collector counts reclaimed rooms apart from reaper sweeps", async () => {
  const metrics = createMetricsCollector({
    runtimeStore: createInMemoryRuntimeStore(() => 0),
    roomStore: {
      async countRooms() {
        return 0;
      },
    },
  });

  // Pre-seeded to 0 so "the reaper has not collected anything yet" is
  // distinguishable from "metric absent" — the difference between a young
  // process and a wedged reaper.
  const initial = await metrics.render();
  assert.match(initial, /^bili_syncplay_rooms_expired_deleted_total 0$/m);
  // Absent until a reaper declares itself. The standalone global admin builds
  // this same collector and never creates one, so an always-on series would
  // sit at 0 there and make "rate dropped to 0" fire on a healthy process.
  assert.equal(
    initial.includes("bili_syncplay_room_reaper_sweeps_total"),
    false,
  );

  metrics.declareRoomReaper();
  const declared = await metrics.render();
  // Once declared, every outcome is pre-seeded even before the first sweep, so
  // "never failed" and "has not swept yet" stay distinguishable from "absent".
  for (const result of ["ok", "error", "skipped"]) {
    assert.match(
      declared,
      new RegExp(
        `^bili_syncplay_room_reaper_sweeps_total\\{result="${result}"\\} 0$`,
        "m",
      ),
    );
  }

  // HELP is the only description a scraper or an operator reading /metrics
  // gets, and this counter is fed by the lazy read path as well as by reaper
  // sweeps. Describing it as reaper-only turns it into a liveness signal it
  // cannot serve — the reaper can be dead while this still climbs.
  const help = initial.match(
    /^# HELP bili_syncplay_rooms_expired_deleted_total (.*)$/m,
  );
  assert.notEqual(help, null);
  assert.match(help![1], /reaper/);
  assert.match(help![1], /lazy/);

  // Two sweeps, five rooms. The event counter these panels used to read says
  // 2 for exactly this history, which is why the room count needs its own
  // series before it can be rated against room_created_total.
  metrics.recordEvent("room_expired_deleted");
  metrics.recordRoomsExpiredDeleted(3);
  metrics.recordEvent("room_expired_deleted");
  metrics.recordRoomsExpiredDeleted(2);

  const rendered = await metrics.render();
  assert.match(rendered, /^bili_syncplay_rooms_expired_deleted_total 5$/m);

  // Sweep liveness is a separate series on purpose: both counters above stay
  // flat on a healthy but idle reaper, and the lazy read path can keep the
  // reclaimed count climbing after the reaper has died.
  metrics.declareRoomReaper();
  metrics.recordRoomReaperSweep("ok");
  metrics.recordRoomReaperSweep("ok");
  metrics.recordRoomReaperSweep("error");
  metrics.recordRoomReaperSweep("skipped");
  const swept = await metrics.render();
  assert.match(
    swept,
    /^bili_syncplay_room_reaper_sweeps_total\{result="ok"\} 2$/m,
  );
  assert.match(
    swept,
    /^bili_syncplay_room_reaper_sweeps_total\{result="error"\} 1$/m,
  );
  // Its own label, not `error`: a tick that found the previous sweep still
  // inside its cap means the interval is shorter than a sweep takes, and
  // counting that as a failure raises the alerting rate on a reaper that is
  // working (#262 review).
  assert.match(
    swept,
    /^bili_syncplay_room_reaper_sweeps_total\{result="skipped"\} 1$/m,
  );
  assert.equal(
    rendered.includes(
      'bili_syncplay_events_total{event="room_expired_deleted"} 2',
    ),
    true,
  );
});

test("metrics collector refuses room counts that would rewind the counter", async () => {
  const metrics = createMetricsCollector({
    runtimeStore: createInMemoryRuntimeStore(() => 0),
    roomStore: {
      async countRooms() {
        return 0;
      },
    },
  });

  metrics.recordRoomsExpiredDeleted(4);
  for (const bogus of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    metrics.recordRoomsExpiredDeleted(bogus);
  }

  // A counter that moves backwards or lands on NaN makes every rate() over it
  // useless, so a nonsense sweep result is dropped rather than added.
  assert.match(
    await metrics.render(),
    /^bili_syncplay_rooms_expired_deleted_total 4$/m,
  );
});

test("metrics collector can rebind to the effective runtime store", async () => {
  const localRuntimeStore = createInMemoryRuntimeStore(() => 0);
  const sharedRuntimeStore = createInMemoryRuntimeStore(() => 0);
  const metrics = createMetricsCollector({
    runtimeStore: localRuntimeStore,
    roomStore: {
      async countRooms() {
        return 0;
      },
    },
  });

  sharedRuntimeStore.registerSession({
    id: "shared-session",
    connectionState: "detached",
    socket: null,
    instanceId: "instance-shared",
    remoteAddress: "127.0.0.1",
    origin: "chrome-extension://allowed-extension",
    roomCode: null,
    memberId: null,
    displayName: "Bob",
    memberToken: null,
    joinedAt: null,
    invalidMessageCount: 0,
    rateLimitState: {
      roomCreate: { windowStart: 0, count: 0 },
      roomJoin: { windowStart: 0, count: 0 },
      videoShare: { windowStart: 0, count: 0 },
      playbackUpdate: { tokens: 0, lastRefillAt: 0 },
      syncRequest: { windowStart: 0, count: 0 },
      syncPing: { tokens: 0, lastRefillAt: 0 },
    },
  });
  sharedRuntimeStore.markSessionJoinedRoom("shared-session", "ROOM99");

  metrics.bindRuntimeStore(sharedRuntimeStore);

  const rendered = await metrics.render();

  assert.equal(rendered.includes("bili_syncplay_connections 1"), true);
  assert.equal(rendered.includes("bili_syncplay_active_rooms 1"), true);
});
