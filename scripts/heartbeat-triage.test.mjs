import assert from "node:assert/strict";
import test from "node:test";

import {
  UNKNOWN_ACCEPT_TOLERANCE_MS,
  formatReport,
  onlineAtFrom,
  originFamily,
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

test("prefixOf groups IPv4 by /16 and IPv6 by /32", () => {
  assert.equal(prefixOf("39.144.10.20"), "39.144.0.0/16");
  assert.equal(prefixOf("::ffff:39.144.10.20"), "39.144.0.0/16");
  // privacy addresses inside one network collapse to one prefix
  assert.equal(prefixOf("2408:8207:1:2::5"), "2408:8207::/32");
  assert.equal(prefixOf("2408:8207:abcd:ef01:1:2:3:4"), "2408:8207::/32");
  assert.equal(prefixOf("2408:0000::1"), "2408:0::/32");
  assert.equal(prefixOf("fe80::1%eth0"), "fe80:0::/32");
  // not an address: kept verbatim rather than guessed at
  assert.equal(prefixOf("2001::db8::1"), "2001::db8::1");
  assert.equal(prefixOf("1:2:3:4:5:6:7:8:9"), "1:2:3:4:5:6:7:8:9");
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
    [0, 1, 0, 0, 1, 0],
  );
  assert.ok(Math.abs(result.median - 90) < 1e-9);
});

test("triage reports distribution, per-origin kill ratio within one cohort, and renders", () => {
  const events = [
    accepted("a", "39.144.1.1", "2026-10-21T10:00:00.000Z", "ext-a"),
    accepted("b", "59.50.1.1", "2026-10-21T10:00:00.000Z", "ext-a"),
    accepted("c", "59.50.2.2", "2026-10-21T10:00:00.000Z", "ext-b"),
    accepted("d", "1.2.3.4", "2026-10-21T10:00:00.000Z", "ext-b"),
    kill("a", "39.144.1.1", "2026-10-21T13:31:05.000Z", "R1", "ext-a"),
    kill("b", "59.50.1.1", "2026-10-21T13:31:40.000Z", "R2", "ext-a"),
    kill("c", "59.50.2.2", "2026-10-21T13:33:00.000Z", "R2", "ext-b"),
    // reconnects during the window are outside the cohort: neither the
    // reconnect nor its second kill may enter the per-origin ratio
    accepted("a2", "39.144.1.1", "2026-10-21T13:31:08.000Z", "ext-a"),
    accepted("b2", "59.50.1.1", "2026-10-21T13:31:45.000Z", "ext-a"),
    joined("a2", "m-a", "39.144.1.1", "2026-10-21T13:31:09.000Z"),
    kill("a2", "39.144.1.1", "2026-10-21T13:34:00.000Z", "R1", "ext-a"),
  ];
  const report = triage(events, WINDOW);
  assert.equal(report.kills, 4);
  assert.deepEqual(report.perMinute, [
    ["2026-10-21T13:31", 2],
    ["2026-10-21T13:33", 1],
    ["2026-10-21T13:34", 1],
  ]);
  assert.deepEqual(report.acceptedPerMinute, [["2026-10-21T13:31", 2]]);
  assert.deepEqual(
    new Map(report.prefixes),
    new Map([
      ["39.144.0.0/16", 2],
      ["59.50.0.0/16", 2],
    ]),
  );
  assert.equal(report.rooms.length, 2);
  assert.deepEqual(
    report.origins.rows.map(({ origin, alive, killed }) => [
      origin,
      alive,
      killed,
    ]),
    [
      ["ext-a", 2, 2],
      ["ext-b", 2, 1],
    ],
  );
  assert.equal(report.origins.alive, 4);
  assert.equal(report.origins.killed, 3);
  assert.equal(report.cohorts, null);
  const text = formatReport(report);
  assert.match(text, /heartbeat kills in window: 4/);
  assert.match(text, /1\/4 reconnected/);
  assert.doesNotMatch(text, /WARNING/);
});

test("an input with no relevant events is flagged, not reported as calm", () => {
  const text = formatReport(triage(parseEvents(["no json here"]), WINDOW));
  assert.match(text, /WARNING: no connection\/heartbeat\/join events/);
  assert.match(text, /LOG_LEVEL=info/);
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
  // the right shape but not a real UTC minute
  for (const bogus of [
    "2026-13-40T25:99",
    "2026-02-30T10:00",
    "2026-10-21T24:00",
  ]) {
    assert.throws(
      () => parseArgs(["--from", bogus, "--to", "2026-12-31T00:00"]),
      /UTC minute/,
    );
  }
  assert.throws(
    () =>
      parseArgs([
        "--from",
        "2026-10-21T13:29",
        "--to",
        "2026-10-21T13:36",
        "--worker-reload",
        "2026-02-30T00:00",
      ]),
    /UTC time/,
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

test("reconnectGaps counts a rejoin stamped shortly before the kill as already back", () => {
  const events = [
    // the killed session's own join, seconds before the kill: never a reconnect
    joined("a", "m-a", "1.1.1.1", "2026-10-21T13:30:58.000Z"),
    kill("a", "1.1.1.1", "2026-10-21T13:31:00.000Z"),
    // a replacement session (client reconnected first, or a node clock behind)
    joined("a2", "m-a", "1.1.1.1", "2026-10-21T13:30:59.000Z"),
    // beyond the tolerance: an earlier, unrelated join of the same member
    joined("b0", "m-b", "2.2.2.2", "2026-10-21T13:30:00.000Z"),
    kill("b", "2.2.2.2", "2026-10-21T13:31:00.000Z"),
  ];
  const result = reconnectGaps(events, WINDOW);
  assert.equal(result.reconnected, 1);
  assert.equal(result.earlyRejoins, 1);
  assert.ok(Math.abs(result.earliest + 1) < 1e-9);
  assert.deepEqual(
    result.buckets.map((b) => b.count),
    [1, 0, 0, 0, 0, 0],
  );
  assert.ok(UNKNOWN_ACCEPT_TOLERANCE_MS < 60_000);
  const text = formatReport(triage(events, WINDOW));
  assert.match(
    text,
    /<0s: 1 members were back in a room before their kill \(earliest 1\.0s before\)/,
  );
  assert.doesNotMatch(text, /clocks disagree, so/);
});

test("one member killed twice pairs each kill with its own later rejoin", () => {
  const events = [
    kill("a", "1.1.1.1", "2026-10-21T13:31:00.000Z"),
    joined("a2", "m-a", "1.1.1.1", "2026-10-21T13:31:03.000Z"),
    // the reconnected session keeps the member id, so its kill carries m-a too
    kill("a2", "1.1.1.1", "2026-10-21T13:33:00.000Z", "ROOM01", "ext-a", "m-a"),
    joined("a3", "m-a", "1.1.1.1", "2026-10-21T13:33:20.000Z"),
  ];
  const result = reconnectGaps(events, WINDOW);
  assert.equal(result.reconnected, 2);
  assert.deepEqual(
    result.buckets.map((b) => b.count),
    [0, 1, 0, 1, 0, 0],
  );
  assert.equal(result.earlyRejoins, 0);
});

test("Firefox per-install origins are grouped into one family", () => {
  assert.equal(
    originFamily("moz-extension://87af4953-024c-4a21-81c3-27897350af19"),
    originFamily("moz-extension://e72fb32a-ade4-4ca8-a39b-67d1cb9d6601"),
  );
  assert.equal(
    originFamily("chrome-extension://cpgcalajpoihfgfeidmnijcdimnjniam"),
    "chrome-extension://cpgcalajpoihfgfeidmnijcdimnjniam",
  );
  const events = [
    accepted("f1", "1.1.1.1", "2026-10-21T10:00:00.000Z", "moz-extension://u1"),
    accepted("f2", "1.1.1.2", "2026-10-21T10:00:00.000Z", "moz-extension://u2"),
    accepted("f3", "1.1.1.3", "2026-10-21T10:00:00.000Z", "moz-extension://u3"),
    kill(
      "f1",
      "1.1.1.1",
      "2026-10-21T13:31:00.000Z",
      "R",
      "moz-extension://u1",
    ),
  ];
  const { rows } = triage(events, WINDOW).origins;
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].alive, rows[0].killed], [3, 1]);
});

test("kills whose accept is missing from the input are always flagged", () => {
  const events = [
    accepted("a", "1.1.1.1", "2026-10-21T10:00:00.000Z"),
    // accepted before the journal starts: not in the input
    kill("old", "2.2.2.2", "2026-10-21T13:31:00.000Z"),
  ];
  const report = triage(events, WINDOW);
  assert.equal(report.acceptedUnknown, 1);
  assert.equal(report.cohorts, null);
  assert.match(
    formatReport(report),
    /WARNING: 1 killed sessions have no ws_connection_accepted/,
  );
  assert.doesNotMatch(
    formatReport(
      triage([accepted("a", "1.1.1.1", "2026-10-21T10:00:00.000Z")], WINDOW),
    ),
    /no ws_connection_accepted/,
  );
});

test("a single rejoin is credited to only one kill", () => {
  const events = [
    // two sessions of the same member (two tabs) dropped together, one rejoin
    kill("t1", "1.1.1.1", "2026-10-21T13:31:00.000Z", "R", "ext-a", "m-x"),
    kill("t2", "1.1.1.1", "2026-10-21T13:31:01.000Z", "R", "ext-a", "m-x"),
    joined("t3", "m-x", "1.1.1.1", "2026-10-21T13:31:04.000Z"),
  ];
  assert.equal(reconnectGaps(events, WINDOW).reconnected, 1);
});

test("a rejoin is never credited across the same member's next kill", () => {
  const events = [
    kill("k1", "1.1.1.1", "2026-10-21T13:31:00.000Z", "R", "ext-a", "m-y"),
    kill("k2", "1.1.1.1", "2026-10-21T13:32:00.000Z", "R", "ext-a", "m-y"),
    joined("j", "m-y", "1.1.1.1", "2026-10-21T13:32:01.000Z"),
  ];
  const result = reconnectGaps(events, WINDOW);
  assert.equal(result.reconnected, 1);
  // credited to the second kill (1 s), not the first (61 s)
  assert.deepEqual(
    result.buckets.map((b) => b.count),
    [0, 1, 0, 0, 0, 0],
  );
});

test("a rejoin both kills can reach is credited once", () => {
  const events = [
    kill("k1", "1.1.1.1", "2026-10-21T13:31:00.000Z", "R", "ext-a", "m-z"),
    // within the tolerance before the next kill: reachable from both kills
    joined("j", "m-z", "1.1.1.1", "2026-10-21T13:31:58.000Z"),
    kill("k2", "1.1.1.1", "2026-10-21T13:32:00.000Z", "R", "ext-a", "m-z"),
  ];
  assert.equal(reconnectGaps(events, WINDOW).reconnected, 1);
});

test("a rejoin owed to a kill before the window is not claimed by one inside it", () => {
  const events = [
    // before --from (13:29): its reconnect belongs to it
    kill("p", "1.1.1.1", "2026-10-21T13:28:58.000Z", "R", "ext-a", "m-w"),
    joined("p2", "m-w", "1.1.1.1", "2026-10-21T13:28:59.000Z"),
    // inside the window, 1 s after that rejoin
    kill("q", "1.1.1.1", "2026-10-21T13:29:00.000Z", "R", "ext-a", "m-w"),
  ];
  const result = reconnectGaps(events, WINDOW);
  assert.equal(result.kills, 1);
  assert.equal(result.reconnected, 0);
  assert.equal(result.earlyRejoins, 0);
});

test("a replacement session that joined well before the kill counts as already back", () => {
  const events = [
    accepted("old", "1.1.1.1", "2026-10-21T12:00:00.000Z"),
    // the client noticed first and reconnected; the node reaps the old socket 40 s later
    joined("new", "m-old", "1.1.1.1", "2026-10-21T13:30:20.000Z"),
    kill("old", "1.1.1.1", "2026-10-21T13:31:00.000Z"),
    // a different session of the same member that joined BEFORE the killed session
    // existed is not its replacement
    accepted("older", "2.2.2.2", "2026-10-21T11:00:00.000Z"),
    joined("before", "m-older", "2.2.2.2", "2026-10-21T11:30:00.000Z"),
    accepted("older", "2.2.2.2", "2026-10-21T12:00:00.000Z"),
    kill("older", "2.2.2.2", "2026-10-21T13:31:00.000Z"),
  ];
  const result = reconnectGaps(events, WINDOW);
  assert.equal(result.reconnected, 1);
  assert.equal(result.earlyRejoins, 1);
  assert.ok(Math.abs(result.earliest + 40) < 1e-9);
});

test("worker cohorts split at the reload second, not the minute", () => {
  const events = [
    accepted("before", "1.1.1.1", "2026-10-21T02:23:10.000Z"),
    accepted("after", "2.2.2.2", "2026-10-21T02:23:55.000Z"),
  ];
  const { cohorts } = workerCohorts(onlineAtFrom(events, WINDOW), [
    "2026-10-21T02:23:50",
  ]);
  assert.deepEqual(
    cohorts.map((c) => c.alive),
    [1, 1],
  );
  // a minute-only bound still works and means :00
  assert.deepEqual(
    workerCohorts(onlineAtFrom(events, WINDOW), [
      "2026-10-21T02:23",
    ]).cohorts.map((c) => c.alive),
    [0, 2],
  );
  assert.deepEqual(
    parseArgs([
      "--from",
      "2026-10-21T13:29",
      "--to",
      "2026-10-21T13:36",
      "--worker-reload",
      "2026-10-21T02:23:50",
    ]).workerReloads,
    ["2026-10-21T02:23:50"],
  );
  assert.throws(
    () =>
      parseArgs(["--from", "2026-10-21T13:29:00", "--to", "2026-10-21T13:36"]),
    /UTC minute/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--from",
        "2026-10-21T13:29",
        "--to",
        "2026-10-21T13:36",
        "--worker-reload",
        "2026-10-21T02:23:61",
      ]),
    /UTC time/,
  );
});

test("a replacement that closed again before the kill is not counted as back", () => {
  const events = [
    accepted("old", "1.1.1.1", "2026-10-21T12:00:00.000Z"),
    // an earlier replacement that itself dropped before the kill
    joined("flaky", "m-old", "1.1.1.1", "2026-10-21T13:30:10.000Z"),
    closed("flaky", "2026-10-21T13:30:40.000Z"),
    kill("old", "1.1.1.1", "2026-10-21T13:31:00.000Z"),
    // the real reconnect after the kill
    joined("back", "m-old", "1.1.1.1", "2026-10-21T13:31:04.000Z"),
  ];
  const result = reconnectGaps(events, WINDOW);
  assert.equal(result.reconnected, 1);
  assert.equal(result.earlyRejoins, 0);
  assert.deepEqual(
    result.buckets.map((b) => b.count),
    [0, 1, 0, 0, 0, 0],
  );
});
