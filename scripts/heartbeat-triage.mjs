// 心跳超时踢线的事后取证：读 room node 的 journal（JSON 行），回答
// 「被踢的是谁、什么时候、踢完多久连回来」，用来区分入口层 / 客户端 / 网络路径。
//
// 用法见 docs/runbook/multi-node-operations.md 的
// 「Why are clients being dropped by heartbeat timeouts?」。
//
//   journalctl -u <room-node> --since <进程启动时刻> -o cat \
//     | node scripts/heartbeat-triage.mjs --from 2026-10-21T13:29 --to 2026-10-21T13:36 \
//         [--worker-reload 2026-10-20T14:23 --worker-reload 2026-10-21T02:23]
//
// 时间参数一律是 UTC、精确到分钟（与日志 timestamp 前 16 位直接比较）。
// --since 要早到覆盖窗口内在线会话的 ws_connection_accepted，否则这些会话
// 进不了 cohort 分组，会计入 acceptedUnknown。

const KILL = "ws_heartbeat_timeout_terminated";
const ACCEPTED = "ws_connection_accepted";
const CLOSED = "ws_connection_closed";
const JOINED = "room_joined";

const RELEVANT = [KILL, ACCEPTED, CLOSED, JOINED];
const FIELDS = [
  "event",
  "timestamp",
  "sessionId",
  "memberId",
  "remoteAddress",
  "origin",
  "roomCode",
];

// 一行 journal → 精简后的事件，或 null。输入从进程启动读起会有千万行级的
// room_event_* 等无关事件，所以先用字符串筛掉，只为四类相关事件付 JSON.parse，
// 且只留统计用到的字段：常驻内存与相关事件数成正比，而不是与日志量成正比。
export function parseEvent(line) {
  const start = line.indexOf("{");
  if (start < 0 || !RELEVANT.some((name) => line.includes(`"${name}"`))) {
    return null;
  }
  let raw;
  try {
    raw = JSON.parse(line.slice(start));
  } catch {
    return null;
  }
  if (!RELEVANT.includes(raw.event) || typeof raw.timestamp !== "string") {
    return null;
  }
  const event = {};
  for (const field of FIELDS) {
    if (raw[field] !== undefined) {
      event[field] = raw[field];
    }
  }
  return event;
}

export function parseEvents(lines) {
  const events = [];
  for (const line of lines) {
    const event = parseEvent(line);
    if (event) {
      events.push(event);
    }
  }
  return events;
}

const minuteOf = (timestamp) => timestamp.slice(0, 16);
const inWindow = (timestamp, from, to) =>
  minuteOf(timestamp) >= from && minuteOf(timestamp) <= to;

function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function share(counts) {
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  return new Map(counts.map(([key, n]) => [key, total ? n / total : 0]));
}

// IPv4 取 /16，其他地址原样：只为看「是否集中在少数网段」，不做精确归属。
export function prefixOf(address) {
  const match = /^(?:::ffff:)?(\d+\.\d+)\.\d+\.\d+$/.exec(address ?? "");
  return match ? `${match[1]}.0.0/16` : (address ?? "unknown");
}

// from 时刻的在线人群：accepted 早于 from、且 from 之前没有断开的会话。
// 代际对照和 origin 基线都以它为分母——用整段输入的 accepted 当基线会被
// 进程运行时长和故障期间的重连本身污染（重连越多的 origin 基线反而越高）。
export function onlineAtFrom(events, { from, to }) {
  const accepted = new Map();
  const closed = new Map();
  const killed = new Set();
  for (const event of events) {
    if (!event.sessionId) {
      continue;
    }
    if (event.event === ACCEPTED) {
      accepted.set(event.sessionId, event);
    } else if (event.event === CLOSED && !closed.has(event.sessionId)) {
      closed.set(event.sessionId, event.timestamp);
    } else if (event.event === KILL && inWindow(event.timestamp, from, to)) {
      killed.add(event.sessionId);
    }
  }
  const online = [];
  for (const [sessionId, event] of accepted) {
    if (minuteOf(event.timestamp) >= from) {
      continue;
    }
    const closedAt = closed.get(sessionId);
    if (closedAt && minuteOf(closedAt) < from) {
      continue;
    }
    online.push({ ...event, killed: killed.has(sessionId) });
  }
  const acceptedUnknown = [...killed].filter((id) => !accepted.has(id)).length;
  return { online, acceptedUnknown };
}

// 按 accepted 落在哪两次 nginx reload 之间，把 from 时的在线会话分代，
// 看各代 worker 承载的连接被踢的比例。
// 注意幸存者偏差：越老的一代只剩长寿连接，而长寿本身就意味着网络稳定。
export function workerCohorts(population, workerReloads) {
  const bounds = [...workerReloads].sort();
  const cohorts = [
    `< ${bounds[0] ?? "∞"}`,
    ...bounds.map((b) => `>= ${b}`),
  ].map((label) => ({ label, alive: 0, killed: 0 }));
  for (const session of population.online) {
    const minute = minuteOf(session.timestamp);
    const cohort = cohorts[bounds.filter((b) => minute >= b).length];
    cohort.alive += 1;
    cohort.killed += session.killed ? 1 : 0;
  }
  return { cohorts, acceptedUnknown: population.acceptedUnknown };
}

// 每次踢线后，同一 memberId 下一次 room_joined 隔了多久。带着仍有效的
// memberToken 重连时服务端沿用原 memberId（room-service 的 reconnectMemberId），
// 所以这是按客户端配对；按 remoteAddress 配对会在 NAT 共用出口时把别人的新连接
// 算成重连，制造假的秒级间隔。
// 秒级连回 = 踢线那一刻客户端收到了关闭，路径是通的；
// 一分钟以上 = 客户端靠扩展的 reconnect watchdog（每分钟）才回来，路径当时仍断。
export function reconnectGaps(events, { from, to }) {
  const relevant = events
    .filter(
      (e) =>
        e.memberId &&
        (e.event === JOINED ||
          (e.event === KILL && inWindow(e.timestamp, from, to))),
    )
    .map((e) => ({ ...e, at: Date.parse(e.timestamp) }))
    .filter((e) => Number.isFinite(e.at))
    .sort((a, b) => a.at - b.at);
  const pending = new Map();
  const gaps = [];
  for (const event of relevant) {
    if (event.event === KILL) {
      pending.set(event.memberId, event.at);
    } else if (pending.has(event.memberId)) {
      gaps.push((event.at - pending.get(event.memberId)) / 1000);
      pending.delete(event.memberId);
    }
  }
  const kills = events.filter(
    (e) => e.event === KILL && inWindow(e.timestamp, from, to),
  );
  const withoutMember = kills.filter((e) => !e.memberId).length;
  gaps.sort((a, b) => a - b);
  const buckets = [
    [0, 5],
    [5, 15],
    [15, 60],
    [60, 300],
    [300, Infinity],
  ].map(([lo, hi]) => ({
    lo,
    hi,
    count: gaps.filter((g) => g >= lo && g < hi).length,
  }));
  const quantile = (q) =>
    gaps.length
      ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))]
      : null;
  return {
    kills: kills.length,
    withoutMember,
    reconnected: gaps.length,
    buckets,
    median: quantile(0.5),
    p90: quantile(0.9),
  };
}

export function triage(events, { from, to, workerReloads = [] }) {
  const kills = events.filter(
    (e) => e.event === KILL && inWindow(e.timestamp, from, to),
  );
  const acceptedInWindow = events.filter(
    (e) => e.event === ACCEPTED && inWindow(e.timestamp, from, to),
  );
  const population = onlineAtFrom(events, { from, to });
  const baselineOrigins = share(
    countBy(population.online, (e) => e.origin ?? "unknown"),
  );
  return {
    kills: kills.length,
    perMinute: countBy(kills, (e) => minuteOf(e.timestamp)).sort((a, b) =>
      a[0].localeCompare(b[0]),
    ),
    acceptedPerMinute: countBy(acceptedInWindow, (e) =>
      minuteOf(e.timestamp),
    ).sort((a, b) => a[0].localeCompare(b[0])),
    prefixes: countBy(kills, (e) => prefixOf(e.remoteAddress)),
    rooms: countBy(kills, (e) => e.roomCode ?? "none"),
    origins: countBy(kills, (e) => e.origin ?? "unknown").map(
      ([origin, n]) => ({
        origin,
        killed: n,
        killedShare: kills.length ? n / kills.length : 0,
        baselineShare: baselineOrigins.get(origin) ?? 0,
      }),
    ),
    cohorts: workerReloads.length
      ? workerCohorts(population, workerReloads)
      : null,
    reconnect: reconnectGaps(events, { from, to }),
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

export function formatReport(report) {
  const out = [];
  const top = (rows, n = 10) =>
    rows.slice(0, n).map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`);
  out.push(`heartbeat kills in window: ${report.kills}`);
  out.push(
    "",
    "kills per minute (UTC):",
    ...report.perMinute.map(([k, v]) => `  ${k}  ${v}`),
  );
  out.push(
    "",
    "accepted per minute (UTC):",
    ...report.acceptedPerMinute.map(([k, v]) => `  ${k}  ${v}`),
  );
  out.push(
    "",
    `source /16 prefixes (${report.prefixes.length} distinct, top 10):`,
    ...top(report.prefixes),
  );
  out.push(
    "",
    `rooms (${report.rooms.length} distinct, top 10):`,
    ...top(report.rooms),
  );
  out.push("", "origins (killed share vs sessions online at --from):");
  for (const row of report.origins.slice(0, 10)) {
    out.push(
      `  ${String(row.killed).padStart(5)}  ${pct(row.killedShare).padStart(6)} vs ${pct(row.baselineShare).padStart(6)}  ${row.origin}`,
    );
  }
  if (report.cohorts) {
    out.push(
      "",
      "worker cohorts (sessions online at --from; beware survivorship bias):",
    );
    for (const c of report.cohorts.cohorts) {
      out.push(
        `  ${c.label.padEnd(22)} alive=${String(c.alive).padStart(5)} killed=${String(c.killed).padStart(4)} ratio=${c.alive ? pct(c.killed / c.alive) : "-"}`,
      );
    }
    out.push(
      `  killed sessions with no accepted in input: ${report.cohorts.acceptedUnknown}`,
    );
  }
  const r = report.reconnect;
  out.push(
    "",
    `reconnect gap after kill (same memberId rejoined): ${r.reconnected}/${r.kills} reconnected, ${r.withoutMember} kills had no memberId`,
  );
  for (const b of r.buckets) {
    out.push(
      `  ${(b.hi === Infinity ? `${b.lo}s+` : `${b.lo}-${b.hi}s`).padStart(8)}  ${b.count}`,
    );
  }
  if (r.median !== null) {
    out.push(`  median=${r.median.toFixed(1)}s p90=${r.p90.toFixed(1)}s`);
  }
  return out.join("\n");
}

const MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function parseArgs(argv) {
  const options = { workerReloads: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split("=", 2);
    const value = inline ?? argv[++i];
    if (!MINUTE.test(value ?? "")) {
      throw new Error(
        `${flag} expects a UTC minute like 2026-10-21T13:29, got ${value}`,
      );
    }
    if (flag === "--from") options.from = value;
    else if (flag === "--to") options.to = value;
    else if (flag === "--worker-reload") options.workerReloads.push(value);
    else throw new Error(`unknown option ${flag}`);
  }
  if (!options.from || !options.to) {
    throw new Error("--from and --to are required");
  }
  if (options.from > options.to) {
    throw new Error(
      `--from ${options.from} is after --to ${options.to}; nothing would match`,
    );
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { createInterface } = await import("node:readline");
  const events = [];
  for await (const line of createInterface({ input: process.stdin })) {
    const event = parseEvent(line);
    if (event) {
      events.push(event);
    }
  }
  console.log(formatReport(triage(events, options)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
