import assert from "node:assert/strict";
import test from "node:test";

import {
  formatReport,
  onlineAtFrom,
  parseArgs,
  parseEvents,
  prefixOf,
  reconnectGaps,
  triage,
  workerCohorts,
} from "./heartbeat-triage.mjs";

const line = (event) => `node[1]: ${JSON.stringify(event)}`;
const accepted = (sessionId, remoteAddress, timestamp, origin = "ext-a") => ({
  event: "ws_connection_accepted",
  sessionId,
  remoteAddress,
  timestamp,
  origin,
});
const kill = (
  sessionId,
  remoteAddress,
  timestamp,
  roomCode = "ROOM01",
  origin = "ext-a",
  memberId = `m-${sessionId}`,
) => ({
  event: "ws_heartbeat_timeout_terminated",
  sessionId,
  remoteAddress,
  timestamp,
  roomCode,
  origin,
  memberId,
});
const joined = (sessionId, memberId, remoteAddress, timestamp) => ({
  event: "room_joined",
  sessionId,
  memberId,
  remoteAddress,
  timestamp,
});
const closed = (sessionId, timestamp) => ({
  event: "ws_connection_closed",
  sessionId,
  timestamp,
});

const WINDOW = { from: "2026-10-21T13:29", to: "2026-10-21T13:36" };

test("parseEvents keeps journal JSON lines and skips noise", () => {
  const events = parseEvents([
    line(accepted("a", "1.1.1.1", "2026-10-21T01:00:00.000Z")),
    "Oct 21 lemon-server systemd[1]: Started something",
    "node[1]: {not json",
    '{"event":"x"}',
    // irrelevant event types are dropped, even when they mention a session
    line({
      event: "room_event_published",
      sessionId: "p",
      timestamp: "2026-10-21T01:00:00.000Z",
    }),
    // a relevant name inside another event's payload does not make it relevant
    line({
      event: "playback_update_applied",
      note: "ws_connection_accepted",
      timestamp: "2026-10-21T01:00:00.000Z",
    }),
  ]);
  assert.deepEqual(
    events.map((e) => e.sessionId),
    ["a"],
  );
  // only the fields the report uses are retained
  assert.deepEqual(
    parseEvents([
      line({
        ...accepted("b", "1.1.1.1", "2026-10-21T01:00:00.000Z"),
        bulky: "x".repeat(100),
      }),
    ])[0],
    accepted("b", "1.1.1.1", "2026-10-21T01:00:00.000Z"),
  );
});

test("prefixOf groups IPv4 by /16, including IPv4-mapped IPv6", () => {
  assert.equal(prefixOf("39.144.10.20"), "39.144.0.0/16");
  assert.equal(prefixOf("::ffff:39.144.10.20"), "39.144.0.0/16");
  assert.equal(prefixOf("2408::1"), "2408::1");
  assert.equal(prefixOf(undefined), "unknown");
});

test("workerCohorts counts only sessions online at --from, by reload generation", () => {
  const events = [
    accepted("old", "1.1.1.1", "2026-10-20T14:00:00.000Z"),
    accepted("mid", "2.2.2.2", "2026-10-20T20:00:00.000Z"),
    accepted("new", "3.3.3.3", "2026-10-21T05:00:00.000Z"),
    // closed before the window: not online at --from
    accepted("gone", "4.4.4.4", "2026-10-21T06:00:00.000Z"),
    closed("gone", "2026-10-21T07:00:00.000Z"),
    // accepted inside the window: not part of the population at --from
    accepted("late", "5.5.5.5", "2026-10-21T13:31:00.000Z"),
    kill("mid", "2.2.2.2", "2026-10-21T13:31:10.000Z"),
    // killed outside the window: does not count
    kill("new", "3.3.3.3", "2026-10-21T13:40:00.000Z"),
    // killed in window but its accept predates the input
    kill("orphan", "6.6.6.6", "2026-10-21T13:32:00.000Z"),
  ];
  const { cohorts, acceptedUnknown } = workerCohorts(
    onlineAtFrom(events, WINDOW),
    ["2026-10-21T02:23", "2026-10-20T14:23"],
  );
  assert.deepEqual(
    cohorts.map(({ alive, killed }) => [alive, killed]),
    [
      [1, 0],
      [1, 1],
      [1, 0],
    ],
  );
  assert.equal(cohorts[1].label, ">= 2026-10-20T14:23");
  assert.equal(acceptedUnknown, 1);
});

test("reconnectGaps pairs each kill with the same member's next rejoin", () => {
  const events = [
    kill("a", "1.1.1.1", "2026-10-21T13:31:00.100Z"),
    joined("a2", "m-a", "1.1.1.1", "2026-10-21T13:31:01.300Z"),
    kill("b", "2.2.2.2", "2026-10-21T13:31:00.000Z"),
    joined("b2", "m-b", "2.2.2.2", "2026-10-21T13:32:30.000Z"),
    // never comes back; another member behind the SAME address (NAT) joining
    // right after must not be taken for its reconnect
    kill("c", "3.3.3.3", "2026-10-21T13:31:00.000Z"),
    joined("x", "m-other", "3.3.3.3", "2026-10-21T13:31:00.500Z"),
    // a rejoin BEFORE the kill must not be paired with it
    joined("e0", "m-e", "5.5.5.5", "2026-10-21T13:30:00.000Z"),
    kill("e", "5.5.5.5", "2026-10-21T13:33:00.000Z"),
    // a kill outside the window, even one that reconnects, is not counted
    kill("z", "7.7.7.7", "2026-10-21T13:50:00.000Z"),
    joined("z2", "m-z", "7.7.7.7", "2026-10-21T13:50:02.000Z"),
    // a session that never joined a room has no memberId to follow
    kill("n", "8.8.8.8", "2026-10-21T13:32:00.000Z", "ROOM01", "ext-a", null),
  ];
  const result = reconnectGaps(events, WINDOW);
  assert.equal(result.kills, 5);
  assert.equal(result.withoutMember, 1);
  assert.equal(result.reconnected, 2);
  assert.deepEqual(
    result.buckets.map((b) => b.count),
    [1, 0, 0, 1, 0],
  );
  assert.ok(Math.abs(result.median - 90) < 1e-9);
});

test("triage reports distribution, origin share against baseline, and renders", () => {
  const events = [
    accepted("a", "39.144.1.1", "2026-10-21T10:00:00.000Z", "ext-a"),
    accepted("b", "59.50.1.1", "2026-10-21T10:00:00.000Z", "ext-a"),
    accepted("c", "59.50.2.2", "2026-10-21T10:00:00.000Z", "ext-b"),
    accepted("d", "1.2.3.4", "2026-10-21T10:00:00.000Z", "ext-b"),
    kill("a", "39.144.1.1", "2026-10-21T13:31:05.000Z", "R1", "ext-a"),
    kill("b", "59.50.1.1", "2026-10-21T13:31:40.000Z", "R2", "ext-a"),
    kill("c", "59.50.2.2", "2026-10-21T13:33:00.000Z", "R2", "ext-b"),
    // reconnects during the window are not part of the baseline: if they were,
    // ext-a's reconnect storm would inflate ext-a's own baseline share
    accepted("a2", "39.144.1.1", "2026-10-21T13:31:08.000Z", "ext-a"),
    accepted("b2", "59.50.1.1", "2026-10-21T13:31:45.000Z", "ext-a"),
    joined("a2", "m-a", "39.144.1.1", "2026-10-21T13:31:09.000Z"),
  ];
  const report = triage(events, WINDOW);
  assert.equal(report.kills, 3);
  assert.deepEqual(report.perMinute, [
    ["2026-10-21T13:31", 2],
    ["2026-10-21T13:33", 1],
  ]);
  assert.deepEqual(report.acceptedPerMinute, [["2026-10-21T13:31", 2]]);
  assert.deepEqual(report.prefixes[0], ["59.50.0.0/16", 2]);
  assert.deepEqual(report.rooms[0], ["R2", 2]);
  const extA = report.origins.find((o) => o.origin === "ext-a");
  assert.equal(extA.killed, 2);
  assert.ok(Math.abs(extA.baselineShare - 2 / 4) < 1e-9);
  assert.equal(report.cohorts, null);
  const text = formatReport(report);
  assert.match(text, /heartbeat kills in window: 3/);
  assert.match(text, /1\/3 reconnected/);
});

test("parseArgs requires UTC minutes and both window bounds", () => {
  assert.deepEqual(
    parseArgs([
      "--from",
      "2026-10-21T13:29",
      "--to=2026-10-21T13:36",
      "--worker-reload",
      "2026-10-21T02:23",
    ]),
    {
      from: "2026-10-21T13:29",
      to: "2026-10-21T13:36",
      workerReloads: ["2026-10-21T02:23"],
    },
  );
  assert.throws(
    () => parseArgs(["--from", "21:29", "--to", "2026-10-21T13:36"]),
    /UTC minute/,
  );
  assert.throws(() => parseArgs(["--from", "2026-10-21T13:29"]), /required/);
  assert.throws(
    () => parseArgs(["--from", "2026-10-21T13:36", "--to", "2026-10-21T13:29"]),
    /is after --to/,
  );
  assert.throws(
    () => parseArgs(["--bogus", "2026-10-21T13:29"]),
    /unknown option/,
  );
});
