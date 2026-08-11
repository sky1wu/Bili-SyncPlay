# Bili-SyncPlay Multi-Node Operations Runbook

[English](./multi-node-operations.md) | [简体中文](./multi-node-operations.zh-CN.md)

This document is written for day-to-day operations and on-call response. It covers scaling multiple room nodes, the dedicated global admin, Redis-backed shared control plane, Redis incidents, admin credential rotation, and triage for common alerts.

## Scope

- End users connect through a single entrypoint such as `wss://sync.example.com`.
- Room nodes run `server/dist/index.js` and serve WebSocket traffic, `/healthz`, and `/readyz`.
- The global admin runs `server/dist/global-admin-index.js` and serves `/admin` and `/api/admin/*`.
- Redis backs persisted room base state, runtime indexes, event streams, audit streams, the room event bus, admin sessions, and the admin command bus.

## Topology

```mermaid
flowchart LR
  user[Browser extension users] --> edge[Edge / LB<br/>Nginx, HAProxy, ALB]
  sre[SRE / operator] --> adminEdge[Admin edge / LB]
  edge --> roomA[room-node-a<br/>server/dist/index.js]
  edge --> roomB[room-node-b<br/>server/dist/index.js]
  adminEdge --> globalAdmin[global-admin<br/>server/dist/global-admin-index.js]
  roomA --> redis[(Redis)]
  roomB --> redis
  globalAdmin --> redis
```

Room nodes do not implement load balancing. The production edge layer must handle TLS termination, WebSocket reverse proxying, and connection distribution. WebSocket traffic is long-lived, so prefer `least_conn` at the edge, then plain round-robin; sticky routing is only an operational fallback during rollout, not a correctness requirement for multi-node deployments.

## Baseline Configuration

Every room node and the global admin should point at the same Redis and keep the following settings aligned:

```bash
REDIS_URL=redis://10.0.0.11:6379
ROOM_STORE_PROVIDER=redis
ADMIN_SESSION_STORE_PROVIDER=redis
ADMIN_EVENT_STORE_PROVIDER=redis
ADMIN_AUDIT_STORE_PROVIDER=redis
RUNTIME_STORE_PROVIDER=redis
ROOM_EVENT_BUS_PROVIDER=redis
ADMIN_COMMAND_BUS_PROVIDER=redis
NODE_HEARTBEAT_ENABLED=true
```

Every process must use a unique `INSTANCE_ID`. Room nodes listen on `PORT` with `GLOBAL_ADMIN_ENABLED=false`; the global admin listens on `GLOBAL_ADMIN_PORT` with `GLOBAL_ADMIN_ENABLED=true`.

If `REDIS_NAMESPACE` is set, it prefixes every Redis key and channel (rooms, runtime indexes, event streams, room event bus, admin command bus), so it must be identical on every room node and the global admin; leaving it unset everywhere means all nodes share the default `bsp` prefix. Mixed namespaces split the cluster — the global admin stops seeing rooms and heartbeats, and cross-node fanout and admin commands silently fail.

Production should also set these explicitly and keep them aligned:

- `ALLOWED_ORIGINS`
- `TRUSTED_PROXY_ADDRESSES`
- `MAX_MEMBERS_PER_ROOM`
- `MAX_MESSAGE_BYTES`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_SESSION_SECRET`
- `ADMIN_SESSION_TTL_MS`
- `ADMIN_ROLE`

### Room-index orphan cleanup handoff

Redis 6.0 or newer is supported. With ACLs enabled, every room node and
global-admin must have read/write access to `bsp:rooms-by-expiry` and both
`bsp:room-index-orphans` (tokened claims) and
`bsp:room-index-orphans-queue` (their bounded rotating delivery index). Replace
`bsp` with the configured `REDIS_NAMESPACE`. A broad existing `bsp:*` grant
already covers them; narrower room-key grants must be extended before rollout.

Back up the hash and sorted set together. Monitor the hash with
`HLEN bsp:room-index-orphans`; sustained growth means room-node reaping or
runtime teardown is not settling. Once initialized, the queue normally has one
extra reserved sequence member, so persistent divergence between `ZCARD` and
`HLEN + 1` points to an ACL, key-type, or partial-write problem.

The first rollout of this handoff must not mix old and new room-store holders:
drain traffic and stop every old room node and global-admin before starting the
new build. For a rollback, an instantaneous pre-shutdown `HLEN=0` is not a
stable barrier because shutdown stops the reaper before the reconciler. Stop
every current process first and check after all have exited. If claims remain,
start one current room node isolated from traffic, wait for successful reaper
sweeps until the hash is empty, stop it cleanly, and check again after exit;
repeat or abort if that post-stop check is nonzero. Do not delete either
handoff key. If the target build uses the legacy room indexes, also follow the
rebuild procedure in the
[multi-node deployment guide](../operations/multi-node.md).

## Common Verification Commands

```bash
# Redis connectivity
redis-cli -u "$REDIS_URL" ping

# Room node health checks
curl -fsS http://10.0.0.11:8787/healthz
curl -fsS http://10.0.0.11:8787/readyz

# Global admin health checks
curl -fsS http://10.0.0.11:8788/healthz
curl -fsS http://10.0.0.11:8788/readyz

# Prometheus text metrics
curl -fsS http://10.0.0.11:8787/metrics

# systemd logs
sudo journalctl -u bili-syncplay-room-node-a -f
sudo journalctl -u bili-syncplay-global-admin -f
```

The examples use the per-node systemd unit names from the [deployment guide](../operations/deployment.md) (`bili-syncplay-room-node-a`, `bili-syncplay-room-node-b`, …); substitute the unit of the node you are operating on.

If a dedicated metrics port is deployed, scrape `/metrics` from the address configured by `METRICS_PORT`.

## Scaling Out a Room Node

Goal: add a room node and let the edge layer start distributing new connections to it.

1. Pick a unique instance name, for example `room-node-c`.
2. Install Node.js 22, dependencies, and build artifacts on the new machine; the version should match the existing nodes.
3. Configure the same `REDIS_URL`, providers, security, rate-limit, room-capacity, and admin auth settings as the existing nodes.
4. Configure the unique settings:

   ```bash
   INSTANCE_ID=room-node-c
   PORT=8787
   GLOBAL_ADMIN_ENABLED=false
   ```

5. Start the service:

   ```bash
   sudo systemctl enable --now bili-syncplay-room-node-c
   sudo systemctl status bili-syncplay-room-node-c
   ```

6. Add the new upstream at the edge layer, but start with a low weight or only a small share of canary traffic.
7. Verify the new node:

   ```bash
   curl -fsS http://10.0.0.13:8787/readyz
   curl -fsS http://10.0.0.13:8787/metrics
   ```

8. Log in to the global admin and confirm `room-node-c` appears in the overview with a continuously refreshing heartbeat.
9. Create a test room with one client connected to an old node and another client connected to the new node, and verify shared video and playback state stay in sync across nodes.
10. Observe for 10 to 15 minutes; once the error rate and Redis latency are stable, raise the edge-layer weight to its target value.

Scale-out completion criteria:

- `/readyz` returns 200.
- The new node shows `health` as `ok` in the global admin overview.
- `bili_syncplay_connections` grows in line with edge-layer distribution.
- `bili_syncplay_redis_operation_failures_total` shows no sustained growth.

## Scaling In or Safely Draining a Room Node

Goal: stop accepting new connections, wait out or migrate existing rooms, then shut down a single node.

1. Remove the target node from the edge upstream, or set its weight to 0.
2. Keep the process running; do not stop the service immediately.
3. Watch the connection count on the target node:

   ```bash
   curl -fsS http://10.0.0.12:8787/metrics | grep bili_syncplay_connections
   ```

4. Check in the global admin which rooms and sessions the node still carries.
5. For rooms that still have active members, prefer asking users to reconnect briefly; reconnecting clients re-enter through the edge layer onto other nodes.
6. If immediate migration is required, use the global admin to disconnect the sessions on the target node. Do not delete the rooms — room base state is retained in Redis and users can reconnect with `roomCode + joinToken`.
7. Wait for `bili_syncplay_connections` to drop to 0, or confirm the remaining connections have been handled within the change window.
8. Stop the target node:

   ```bash
   sudo systemctl stop bili-syncplay-room-node-b
   ```

9. Wait at least one `NODE_HEARTBEAT_TTL_MS` cycle and confirm the node disappears from the global admin or is marked as expired.
10. Permanently remove the upstream from the edge configuration and reload the edge layer.

Scale-in completion criteria:

- The edge layer no longer forwards new connections to the target node.
- `bili_syncplay_connections` on the target node is 0.
- The global admin no longer shows the target node as healthy and active.
- `/readyz` and cross-node sync on the remaining room nodes are normal.

## Redis Incident Handling

When the providers are configured as `redis`, Bili-SyncPlay does not transparently fail over to in-memory. Redis being unavailable at startup causes the affected process to fail to start; a Redis outage at runtime affects room persistence, runtime indexes, cross-node fanout, admin sessions, audit events, and admin commands.

### Quick Triage

```bash
redis-cli -u "$REDIS_URL" ping
curl -fsS http://10.0.0.11:8787/readyz
curl -fsS http://10.0.0.11:8787/metrics | grep bili_syncplay_redis_operation_failures_total
sudo journalctl -u bili-syncplay-room-node-a --since "15 min ago" | grep -E "redis|Redis|node_heartbeat_failed"

# Default namespace; substitute your configured prefix
redis-cli -u "$REDIS_URL" type bsp:room-index-orphans
redis-cli -u "$REDIS_URL" type bsp:room-index-orphans-queue
redis-cli -u "$REDIS_URL" hlen bsp:room-index-orphans
redis-cli -u "$REDIS_URL" zcard bsp:room-index-orphans-queue
```

Also check the global admin overview:

- Whether room node heartbeats have expired.
- Whether the Redis-related providers are still `redis`.
- Whether the room list, room detail, and event stream return errors or noticeable latency.

### Prefer Restoring Redis

1. Check the Redis process, disk, memory, network ACLs, and password.
2. If you use managed Redis, complete the primary/replica or instance failover first and keep `REDIS_URL` pointing at an available instance.
3. After Redis recovers, restart the affected processes:

   ```bash
   sudo systemctl restart bili-syncplay-room-node-a   # repeat for every room node
   sudo systemctl restart bili-syncplay-global-admin
   ```

4. Verify `/readyz`, the global admin overview, cross-node sync, and the Redis failure counters.

### Emergency Downgrade to In-Memory

Use this only when Redis cannot be restored in time and the business can accept temporarily running single-node or with weakened multi-node capabilities.

Downgrade configuration:

```bash
ROOM_STORE_PROVIDER=memory
ADMIN_SESSION_STORE_PROVIDER=memory
ADMIN_EVENT_STORE_PROVIDER=memory
ADMIN_AUDIT_STORE_PROVIDER=memory
RUNTIME_STORE_PROVIDER=memory
ROOM_EVENT_BUS_PROVIDER=memory
ADMIN_COMMAND_BUS_PROVIDER=memory
NODE_HEARTBEAT_ENABLED=false
```

Downgrade impact:

- Rooms already stored in Redis are not read by in-memory nodes; users may need to recreate or rejoin rooms.
- Room state, runtime sessions, admin sessions, events, and audit logs fall back to per-process local storage.
- The global admin can only reliably manage the local state visible to its own process.
- Cross-node room-state fanout and cross-node admin commands no longer have production semantics.
- When multiple room nodes run in-memory simultaneously, the edge layer must enable sticky routing, or temporarily keep only one room node serving traffic.

Downgrade steps:

1. Declare emergency mode; freeze scaling operations and bulk admin actions.
2. Keep only one room node at the edge layer, or turn on sticky routing and reduce change frequency.
3. Change the room node and global admin environment variables to the in-memory configuration above.
4. Restart the services:

   ```bash
   sudo systemctl restart bili-syncplay-room-node-a   # repeat for every room node
   sudo systemctl restart bili-syncplay-global-admin
   ```

5. Verify `/readyz`, admin login, creating a test room, and playback sync.
6. Announce that old rooms may be unrecoverable and users need to recreate rooms or reconnect.

### Recovering from In-Memory Back to Redis

1. Confirm Redis is stable and `redis-cli -u "$REDIS_URL" ping` returns `PONG`.
2. Switch the providers on every room node and the global admin back to `redis`, and restore `NODE_HEARTBEAT_ENABLED=true`.
3. Start one room node and the global admin first; verify admin login, room creation, the event stream, and `/metrics`.
4. Bring the remaining room nodes back one by one, adding one upstream at a time.
5. Watch `bili_syncplay_redis_operation_failures_total` and Redis latency for at least 15 minutes.

## Admin Credential Rotation

Goal: change the admin password, and rotate the session secret at the same time when existing tokens must be invalidated.

1. Generate the new password hash. `sha256:<hex>` and `scrypt:<salt>:<base64url>` are supported; the quick command in the [security environment variable reference](../reference/security-env.md) uses `sha256`:

   ```bash
   node -e "const { createHash } = require('node:crypto'); console.log('sha256:' + createHash('sha256').update(process.argv[1]).digest('hex'));" 'new-admin-password'
   ```

2. Store the new `ADMIN_PASSWORD_HASH` in your secret system or deployment configuration.
3. To force all existing admin tokens to expire, also generate and distribute a new `ADMIN_SESSION_SECRET`:

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

4. Update every room node and the global admin together. In multi-node deployments these admin auth settings must stay identical.
5. Rolling restart:

   ```bash
   sudo systemctl restart bili-syncplay-room-node-a   # repeat for every room node
   sudo systemctl restart bili-syncplay-global-admin
   ```

6. Open `/admin` and log in with the new password.
7. Run read-only verification: check the overview, room list, events, and audit logs.
8. For the minimal write verification, use a test room to avoid touching production rooms by accident.
9. Confirm the old password can no longer log in; if `ADMIN_SESSION_SECRET` was rotated, confirm old pages require a fresh login after refresh.

## Global Admin Restart

The global admin carries no WebSocket room traffic and can be rolling-restarted independently.

```bash
sudo systemctl restart bili-syncplay-global-admin
curl -fsS http://10.0.0.11:8788/readyz
```

With `ADMIN_SESSION_STORE_PROVIDER=redis` and an unchanged `ADMIN_SESSION_SECRET`, existing admin sessions keep working; with `memory` or a rotated secret, admins need to log in again.

## Common Alerts and Triage

| Alert or symptom                                                  | Key metrics / signals                                                                  | Check first                                                                  | Direction                                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Abnormal drop in WebSocket connections                            | `bili_syncplay_connections`                                                            | Edge upstreams, room node `/readyz`, process logs                            | Restore the node or remove the unhealthy node from the LB                      |
| Abnormal drop in active rooms                                     | `bili_syncplay_active_rooms`, `bili_syncplay_rooms_non_expired`                        | Redis connectivity, room expiry settings, restart history                    | Restore Redis; confirm `ROOM_STORE_PROVIDER` was not switched to memory        |
| Expired rooms stop being reclaimed (reaper stalled)               | `bili_syncplay_room_reaper_sweeps_total`                                               | See [Is the room reaper still sweeping?](#is-the-room-reaper-still-sweeping) | Restore Redis; confirm `ROOM_CLEANUP_INTERVAL_MS` was not raised               |
| Orphan-cleanup claim hash grows or diverges from its queue        | `HLEN bsp:room-index-orphans`, `ZCARD bsp:room-index-orphans-queue`                    | Room reaper outcomes, runtime teardown logs, ACLs, `TYPE` for both keys      | Restore the reaper/runtime store; repair ACL or wrong-type keys before restart |
| Redis operation failures                                          | `bili_syncplay_redis_operation_failures_total`                                         | Redis process, network, ACLs, password, slow queries                         | Restore Redis first; downgrade to in-memory only if necessary                  |
| Completed admin command result publish paths fail                 | `bili_syncplay_admin_command_result_publish_failures_total`                            | Admin command bus publisher saturation, Redis pub/sub, result publish logs   | Restore Redis; confirm close-room fan-out and command-bus capacity are healthy |
| Elevated Redis runtime store latency                              | `bili_syncplay_redis_runtime_store_duration_seconds_bucket`                            | Redis CPU, memory, network RTT, command queueing                             | Scale Redis or reduce edge-layer traffic                                       |
| Redis room event bus publish latency or failures                  | `bili_syncplay_redis_room_event_bus_publish_duration_seconds_bucket`, failure counters | Redis pub/sub connectivity, network jitter, room node logs                   | Restore Redis and the network; verify cross-node playback sync                 |
| Increase in rejected connections                                  | `bili_syncplay_ws_connection_rejected_total`, structured `origin_not_allowed` logs     | `ALLOWED_ORIGINS`, whether the edge rewrites `Origin`                        | Fix the origin allowlist or the reverse-proxy configuration                    |
| Increase in rate limiting                                         | `bili_syncplay_rate_limited_total`                                                     | Source IPs, real IP forwarding at the edge, `TRUSTED_PROXY_ADDRESSES`        | Tune the limits or fix the proxy address configuration                         |
| Elevated message handling latency                                 | `bili_syncplay_message_handler_duration_seconds_bucket`                                | Node CPU, Redis latency, room member counts, errors in logs                  | Rate-limit, scale room nodes, investigate slow Redis                           |
| Global admin missing a node, or a node shown as expired           | Global admin overview, `node_heartbeat_failed` logs                                    | `NODE_HEARTBEAT_ENABLED`, `INSTANCE_ID`, Redis runtime store                 | Fix the heartbeat configuration or the Redis runtime store                     |
| Admin login failures or frequent re-login prompts                 | `/api/admin/auth/login` responses, audit logs                                          | Whether `ADMIN_PASSWORD_HASH` / `ADMIN_SESSION_SECRET` are consistent        | Align the admin auth settings and restart                                      |
| Cross-node room actions fail, e.g. kick or close room returns 503 | Audit logs, `ADMIN_COMMAND_BUS_PROVIDER`, target node heartbeat                        | Admin command bus, target `INSTANCE_ID`, Redis                               | Restore the Redis command bus or perform the action locally on the target node |

### Is the room reaper still sweeping?

`bili_syncplay_room_reaper_sweeps_total` is the only signal that answers this.
Every tick records exactly one of `result="ok"`, `result="error"` or
`result="skipped"` — including a tick whose sweep never came back, which is
capped and recorded as an error rather than waited on forever (#261) — so the
three add up to every tick the timer fired.

`skipped` is not a failure and only appears where `ROOM_CLEANUP_INTERVAL_MS` is
set shorter than a sweep takes: the tick found the previous sweep still running
inside its 30s cap and did not start a second one. Redis is answering; the
reaper is behind. Lengthen the interval.

Replace `<window>` with several times your deployed `ROOM_CLEANUP_INTERVAL_MS`
before running these. The setting only has to be a positive integer, so there is
no window that is safe by default: pick one too short and a healthy reaper falls
between samples and reads as zero.

```promql
# Passes per second. rate() is per second and the setting is milliseconds, so
# a healthy node sits at 1000/ROOM_CLEANUP_INTERVAL_MS — 1/60 at the 60000 default.
sum(rate(bili_syncplay_room_reaper_sweeps_total[<window>])) by (instance)

# Share of ticks that failed, 0 to 1. `skipped` stays in the denominator on
# purpose: it is a tick that collected nothing, just not a broken one.
sum(rate(bili_syncplay_room_reaper_sweeps_total{result="error"}[<window>])) by (instance)
  / sum(rate(bili_syncplay_room_reaper_sweeps_total[<window>])) by (instance)
```

Read them together:

| Passes per second                 | Failure share                | Reading                                                                                                    |
| --------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| ≈ `1000/ROOM_CLEANUP_INTERVAL_MS` | 0                            | Healthy. Collecting nothing is normal — see below                                                          |
| ≈ expected                        | between 0 and 1              | Intermittent failures, most often a flapping Redis. Not a stall; the timer is running and some passes land |
| ≈ expected                        | 1                            | Every pass is failing. The timer runs, the work does not. Read `reason` in the logs to see which           |
| 0                                 | undefined (no passes at all) | No pass recorded an outcome in the window. See the causes below                                            |

When every pass fails, the `reason` on the `room_persist_failed` log line says
which failure it is, and they need different repairs:

- `room_reaper_failed` — Redis answered, with an error. Its message is on the
  same line.
- `room_reaper_sweep_timeout` — Redis did not answer within the sweep's 30s cap.
  A stalled connection, a blocked Redis, or the first sweep after startup still
  waiting on the one-time index bootstrap walk.
- `room_reaper_sweep_stalled` — the tick found the previous sweep's command
  still unanswered **past its cap** and did not issue another. Always follows a
  timeout; on its own it means the stall is ongoing. A tick that finds the
  previous sweep still inside its cap is the `skipped` label above instead, and
  is neither logged nor counted as a failure.

The cap only bounds how long the reaper waits, not the command itself: the room
store's client sets no `commandTimeout`, so the command stays out on the
connection until Redis or the socket ends it. That is deliberate and it is what
makes `stalled` mean anything — #271 evaluated a connection-wide backstop here
and rejected it precisely because settling the command would let the next tick
sweep on top of one that never came back. See
[Which Redis connections bound their commands](#which-redis-connections-bound-their-commands).

A rate of 0 is an observation, not a diagnosis. Every tick records an outcome,
including one that gave up on a hung sweep, so a flat series means no tick
produced anything at all. Separate the causes before acting:

- **The process restarted less than one interval ago.** Compare against
  `bili_syncplay_process_start_time_seconds`; the first pass only lands one
  `ROOM_CLEANUP_INTERVAL_MS` after startup.
- **The timer is gone.** Only after ruling out the above: check the process is
  alive and read its logs.

Room nodes only. The standalone global admin runs no reaper and does not export
this series at all, so its absence there is expected rather than a stall.

**Do not** try to answer this question with any of these:

- `bili_syncplay_rooms_non_expired` — a room leaves that gauge the moment
  `expiresAt` passes, whether or not anything deleted it.
- `bili_syncplay_rooms_expired_deleted_total` — also fed by the lazy read path,
  so it keeps climbing with the reaper dead.
- `bili_syncplay_events_total{event="room_expired_deleted"}` — logged only on a
  pass that collected something. Under steady traffic the lazy read path empties
  the backlog before each sweep, so a healthy reaper can stay silent for hours.

### Why is a node missing or shown as expired?

A node that stops beating drops out of the cluster index: the global admin shows
it stale and then offline, and another node's runtime index reaper eventually
reaps its sessions — while it may still be serving WebSocket clients. Read the
node's OWN logs before believing the view from outside, because the two answer
different questions: "others cannot see it" and "it knows why".

- `node_heartbeat_sent` — beating. Absent for longer than
  `NODE_HEARTBEAT_INTERVAL_MS` with nothing below, and the process itself is
  gone.
- `node_heartbeat_failed`, `reason=node_heartbeat_write_failed` — Redis
  answered, with an error. Message on the same line.
- `node_heartbeat_failed`, `reason=node_heartbeat_write_timeout` — Redis did not
  answer within the beat's cap (half an interval, never more than a third of
  `NODE_HEARTBEAT_TTL_MS`). A stalled connection or a blocked Redis. The cap is
  deliberately well under the TTL, so this line lands **before** other nodes can
  call this one stale — if you are looking at an expired node and its logs show
  these, the stall started roughly one TTL before the expiry (#263).
- `node_heartbeat_failed`, `reason=node_heartbeat_write_stalled` — the tick
  found the previous beat's EXEC still unanswered past its cap and did not issue
  another. Always follows a timeout; on its own it means the stall is ongoing.
- `node_heartbeat_abandoned_at_shutdown` — the node was shutting down with a
  beat still unanswered, so it stopped waiting. Expected on a node whose Redis
  was already stalled; on its own it explains nothing else.

As with the reaper, the cap only bounds how long the heartbeat waits, not the
command — and the runtime store's client is one of the five that deliberately
carry no `commandTimeout`, because its write-admission gate counts commands that
outlived their cap and a backstop would settle them out of that count. The
command stays out on the connection until Redis or the socket ends it.

### Why is the admin event list missing events?

Only with `ADMIN_EVENT_STORE_PROVIDER=redis`. That store writes one chain of
Redis commands per logged event, and when Redis stops answering it **sheds**
rather than queueing: the list goes incomplete and every count derived from the
stream reads low, but the process keeps its memory and shutdown still finishes
(#264).

It does **not** keep the events page available. Reads share the one connection
with the writes and Redis answers in order, so a read whose head-of-connection
write has not answered inside the read's own 1s budget is **refused** with `503
event_store_unavailable` rather than issued behind a command that is not coming
back. That budget is the read's, not the 5s append cap's: the cap is long
because tripping it costs events, and a read that waited that long has already
failed the operator.

A read that was already on its way when the stall began cannot be caught by that
check — nothing observed before a command is issued can see a stall that starts
after it. Those get a 5s bound on their own commands and the same 503, so the
request always ends in an answer rather than in Node's 300s request timeout. It
is one read per stall, not one per poll: a read that ran out of its bound is
remembered exactly as a write past its cap is, so the next poll is refused
before anything is sent — including on a node whose appends are quiet or already
being shed, where there is no write in flight to notice the stall by. A 503 here means Redis, not the admin
process — check Redis first, then retry. What shedding protects is the process,
not the page.

`bili_syncplay_event_store_appends_dropped_total` is the signal, and its
`reason` label is the diagnosis:

- `reason="stalled"` — the write in flight is past its 5s cap. Redis has stopped
  answering: a stalled connection or a blocked server. Everything logged for as
  long as it lasts is dropped, and admin reads are refused.
- `reason="overflow"` — Redis is answering, just slower than events arrive, and
  the queue behind it reached its 1000-event depth limit. The store is behind,
  not broken; the same reading as the reaper's `skipped`. Reads still work.

```promql
# Is it shedding right now, and for which reason?
sum(rate(bili_syncplay_event_store_appends_dropped_total[<window>])) by (instance, reason)

# What did an incident cost, over the window you are looking at?
sum(increase(bili_syncplay_event_store_appends_dropped_total[<window>])) by (instance)
```

**Read the metric, not the logs, for "is it still happening" and "how much".**
The logs carry three facts and make no claim beyond them:

- `runtime_event_append_failed` — an event-store append was rejected. Repeated
  failures are throttled by diagnosis to one line per minute, across business
  event names. Up to 32 active diagnoses get independent first lines; past that
  the throttle degrades from per-diagnosis to global — the shared overflow line
  silences **every** untracked diagnosis for a minute, including one whose own
  slot has just expired and a brand-new one appearing for the first time. Under
  a high-cardinality error stream, read the counter and not the lines. This is
  the signal for fast Redis rejections, which do not enter the shedding state,
  so they move `bili_syncplay_events_total{event="runtime_event_append_failed"}`
  rather than the drop counter:

```promql
# How many appends is Redis rejecting outright?
sum(rate(bili_syncplay_events_total{event="runtime_event_append_failed"}[<window>])) by (instance)
```

- `runtime_event_appends_dropped` — the store is shedding, for this `reason`.
  Throttled to one line per reason per minute, so a stall that lasts an hour is
  not one line an hour old and a busy node is not one line per dropped event.
  There is deliberately no matching "resumed" line: a start/end pair is an
  invariant nothing in a log stream can enforce, and #266 spent four review
  rounds finding states that broke it.
- `runtime_event_appends_abandoned_at_shutdown` — shutdown reached the end of
  `close_event_store` with something unfinished: `pendingWrites` appends whose
  commands had not all answered (appends, not Redis commands — one append issues
  three or four), `closingAppends` appends that arrived after `close` started,
  and/or a graceful close that did not work. `quitOutcome` says which:
  `skipped` (the drain had already run out, so the socket was dropped rather
  than sending a `QUIT` that would queue behind the stuck write), `timed_out`
  (a half-open socket with no write left to blame), `failed` (a `QUIT` that came
  back an error), or `ok` when only `closingAppends` made the shutdown
  incomplete. `result` says how the close ENDED, not how much was lost — every
  outcome here loses something, so read `pendingWrites` and `closingAppends` for
  the magnitude. Before this budget existed, Redis stalls appeared as a
  `server_shutdown_step_failed` for `close_event_store` every time.

  A producer whose own shutdown step timed out is not cancelled and can log
  after `close_event_store` returned, so the report repeats with a growing
  `closingAppends` — throttled to one update per minute, because otherwise each
  of those log lines would produce an error line of its own. **Each update
  supersedes the previous one: the other fields are repeated verbatim, not
  incremental, so aggregate `closingAppends` with `max` and never `sum`.** A
  process that force-exits inside the window reports a floor.

All three lines are `error` level regardless of `LOG_LEVEL`. The two
backpressure lines are excluded from the event store on purpose, and append
failures cannot be written there, so stdout is their only path.

As with the reaper and the heartbeat, the cap bounds how long the store waits,
not the command: this client is one of the five that deliberately set no
`commandTimeout`, and the reason is the same one everywhere — a backstop would
race the per-write cap and clear `writeIsStalled`, which is the evidence the
read path refuses on. A read issued
before the store noticed the stall is still exposed, and so is one issued while
Redis is hung with no write of ours in flight to notice it by; that residual is
what the read's own command bound answers.

What this does **not** affect: alerting. `bili_syncplay_*` metrics are in-process
counters served from `/metrics`, and error-level logs go to stdout
unconditionally. Neither path goes through the event store. The admin event list
and the counts on the overview page are the only things that lose data.

Room nodes and the standalone global admin both run this store against the same
Redis, and both report. The in-memory default (`ADMIN_EVENT_STORE_PROVIDER`
unset) is a synchronous array push that cannot drop, and exports no series at
all.

When troubleshooting, check these together first:

```bash
curl -fsS http://<room-node>:8787/metrics
curl -fsS http://<room-node>:8787/readyz
curl -fsS http://<global-admin>:8788/readyz
sudo journalctl -u bili-syncplay-room-node-a --since "30 min ago"
sudo journalctl -u bili-syncplay-global-admin --since "30 min ago"
```

### Why is an audit record missing, or the audit page returning 503?

Only with `ADMIN_AUDIT_STORE_PROVIDER=redis`. That store writes the same kind of
Redis chain as the event store and hits the same bounds when Redis stops
answering, but it makes the **opposite** trade with them (#267).

An audit record is an accountability record — nothing else in the system says
who closed a room or kicked a member — so it is never shed quietly. Past either
bound the append is **refused**, and every refusal becomes one
`admin_audit_log_append_failed` line on stdout plus one increment of
`bili_syncplay_events_total{event="admin_audit_log_append_failed"}`. That is the
signal to alert on; there is no separate drop counter, because this one already
answers "still happening?" and "how much?" statelessly. It can afford a line per
refusal where the event store could not: the audit chain is fed by admin actions
at human rate, not by every log line.

**The admin action itself still succeeds.** The audit write has always been
fire-and-forget, and taking admin controls offline during a Redis outage would
be the worse failure. What is lost is the record, so reconstruct from the
runtime event list (which the same action also produced) for the window the
refusals cover.

```promql
# Are audit records being lost right now?
sum(rate(bili_syncplay_events_total{event="admin_audit_log_append_failed"}[<window>])) by (instance)
```

Like every other `bili_syncplay_events_total` series, this one appears on the
first occurrence and not before, so write alerts as a `rate`/`increase` (absence
is simply no data) rather than expecting the series to exist on a healthy node.

Reads behave exactly as the event store's do: once the store knows the write
path is stalled it **refuses** the audit query with `503
audit_store_unavailable` rather than issuing a command that would queue behind
the stuck write and never return. A 503 here means Redis, not the admin
process — check Redis first, then retry.

At shutdown, `close_admin_services` closes the admin session store and the audit
store, and both are now bounded:

- `admin_audit_appends_abandoned_at_shutdown` — same fields and same
  `quitOutcome` vocabulary as `runtime_event_appends_abandoned_at_shutdown`.
- `admin_session_store_close_unfinished` — the session store's `QUIT` did not
  work, so its socket was dropped. Before the two closes were settled together,
  this unbounded wait could spend the whole 5s budget on its own and prevent the
  audit store's close from being reached.

Before either bound, `close_admin_services` was a guaranteed
`server_shutdown_step_failed` whenever Redis was hung. The bound above is on how
long we wait; since #271 this client's commands are separately bounded by a
`commandTimeout` — it is one of only three connections that may take one — and
that is what turned a stalled session lookup from an unbounded hang on every
admin request into a 503:

- `admin_session_store_command_failed` — a session `save` / `get` / `delete`
  failed, with `operation` and the underlying error. The HTTP response is a 503
  `admin_session_store_unavailable` carrying no Redis detail, because
  `authenticate` runs before any credential is accepted. **Not a 401**: a Redis
  blip must not read as a logout. Every failure increments
  `bili_syncplay_redis_operation_failures_total{component="admin_session_store"}`;
  the diagnostic line is throttled to at most once per `operation` per minute.
  The admin API has no general request-rate limit, which is why the log needs
  its own throttle.

The room node also owns the lifetime of admin command effects that were already
accepted when shutdown began:

- `admin_command_consumer_close_unfinished` — the consumer's shared 4s budget
  expired before its subscription, accepted handlers, and late member evictions
  all settled. `pendingHandlers` counts command handlers still producing a
  result; `pendingMemberEvictions` counts durable kick effects that outlived the
  confirmation returned to their handler; `unsubscribePending` says the command
  channel itself has not acknowledged removal. The consumer closes its dispatch
  gate before taking these snapshots, so none of the counts can be replenished
  by a command the Redis listener had already captured. This event is hidden
  from the default admin feed as shutdown plumbing.

The other Redis-backed shutdown steps use the same bounded-close rule (#270):

- `room_store_close_unfinished` — `close_room_store` could not finish `QUIT`.
- `runtime_store_close_unfinished` — `close_runtime_store` could not finish
  all pre-close work or `QUIT`. Three counts, because they answer three
  different questions and any one of them alone can be the reason the line was
  emitted:
  - `pendingOperations` — live callers still waiting for an answer.
  - `pendingCommands` — commands still on the wire, counted at the runtime
    store's Redis client boundary.
  - `pendingAttempts` — work the command pacer was still holding: a queued
    write's attempt, a tracked `add_member`, a room-generation pin. An attempt
    can span several commands, so **this is the count that stays non-zero while
    an attempt is between two of them and `pendingCommands` reads zero**. A
    degraded line with `quitOutcome: "ok"` and the first two counts at zero
    means exactly that, and it is not a contradiction.

  `pendingOperationBudgetMs` states the caller/command drain budget.

- `admin_command_bus_close_unfinished` and
  `room_event_bus_close_unfinished` — one line per affected `role`
  (`publisher` / `subscriber`), so one socket's failure cannot hide the other.

All four carry `quitOutcome`, `budgetMs` and `result`, force-disconnect the
socket after a non-`ok` outcome, and are hidden from the default admin event
feed as shutdown plumbing. The room store and both buses use 4s inside their
default 5s step. The runtime store's 15s step covers 5s for the write queue's
last attempt and deliberately uncapped live callers, 5s for Redis commands that
outlived that caller wait, and 4s for `QUIT` (14s total). The two
buses close their sockets concurrently and settle both results before rethrowing
an unexpected implementation error. A terminal room-event bus close skips a
second `UNSUBSCRIBE`, because a half-open socket may already be stuck on the
consumer's first one and `QUIT` itself exits subscriber mode.

These bounds govern how long the caller waits. The connection-wide policy that
bounds the command itself is separate, and is below.

### Which Redis connections bound their commands

Settled in #271, after the same defect — a Redis that accepts commands and stops
answering — was found by five different symptoms (#261, #263, #264, #267, #270).
There are two layers and they are not interchangeable:

- **A deadline** is per-behaviour and derived from what its caller can promise.
  It also decides what happens next: shed, refuse, retry.
- **`commandTimeout` is a liveness backstop.** One question — has this
  connection stopped answering? — so one magnitude for every connection that
  takes it, derived from Redis's latency distribution rather than any caller's
  patience. `REDIS_COMMAND_TIMEOUT_MS` is 5s. It never decides what happens
  next; it only makes sure something does.

A connection needs at least one. Four had neither until #271 — and a fifth, the
runtime store, had one over its write queue's attempts and nothing over its
request path, which is the half a WebSocket join blocks on. #277 closed that
half; see below.

**But the two layers do not compose, and that is what decides the table.**
Nearly every deadline in this server is built on one mechanism (`retry-pacer`,
plus the admission gate and the maintenance passes over it): the cap does not
cancel the call, so the call stays tracked, and **the fact that it has still not
answered is the evidence that stops the next attempt**. A backstop settles those
calls, so each of those bounds reads the connection as idle and lets the next
attempt out — it stops being a bound and becomes a rate of one more command per
timeout window. So the criterion is not "is this connection already bounded":

> A connection may take the backstop only if **no caller on it derives a bound
> from a command's failure to answer.**

| Connection                                 | Command bound    | Why                                                                     |
| ------------------------------------------ | ---------------- | ----------------------------------------------------------------------- |
| admin session store                        | `commandTimeout` | one command per HTTP request; no retry, no pacer                        |
| admin command bus (publisher + subscriber) | `commandTimeout` | the reply timer is a `setTimeout`, not evidence about the connection    |
| room store                                 | caller-side      | `maintenance-pass`'s `stalled` for the reaper and the reconciler        |
| runtime store                              | caller-side      | `ensurePendingCapacity` counts commands that outlived their cap         |
| room event bus (publisher + subscriber)    | caller-side      | `pending-resync-queue` keeps at most one publish per room out at a time |
| admin event store                          | caller-side      | `writeIsStalled` gates the read refusal                                 |
| admin audit store                          | caller-side      | the same append chain                                                   |

**The exemptions were not "already fine".** Two of them had command paths with no
caller-side bound at all — the room store's request path and the runtime store's
— so a stalled Redis held a WebSocket join open with nothing counting down. #277
closed that without changing one row above: both stores now put every
request-path command through a caller-side cap that leaves the command tracked,
so the bounds in the "Why" column keep reading exactly the evidence the
connection-wide option would have settled.

Which means a stalled Redis is now **noisy on the request path and still silent
on the background passes**, on purpose:

- Request-path commands answer their caller and log
  `redis_runtime_store_operation_failed reason=timeout`, or reject an admin
  listing. Past `maxPendingCommands` unanswered commands the next one is refused
  before it is issued, which is the only answer that cannot mean "it may have
  landed later".
- The reaper's sweep, the index reconcile and the heartbeat still go unanswered,
  because `maintenance-pass` decides a pass is stalled precisely from that
  silence. Their signals are the caller's, as before:
  `room_reaper_sweep_timeout` → `room_reaper_sweep_stalled`,
  `node_heartbeat_failed`.

Six persistent writes remain uncapped by design: the runtime store's three
writes through `trackAwaitedOperation` (revoke / generation / delete) and the
room store's three room-body writes. Their effects do not expire, so #237's rule
still applies: an answer that may be wrong is worse than a slow one. The unused
standalone `blockMemberToken` operation and the unused unconditional room-store
`saveRoom` write were removed in #277. The atomic
`evictMemberToken` call now caps only the executor's wait: it returns
`status=error, confirmation=unconfirmed, code=block_unconfirmed` at the
deadline, while its original promise keeps the Redis write and local mirrors
converging after a late success, then disconnects the socket so normal leave
cleanup still runs. The real effect owns its terminal success/failure log
independently of that wait. A command-bus timeout after publish uses the same
additive typed confirmation, so the established status remains readable by an
older parser and the informed admin action layer can queue an audit with its
actor and command details without guessing from error codes. A failed result
publish retries the exact executor result; transport failure never rewrites its
execution or confirmation semantics. Retried evictions keep the maximum block
deadline, making their Redis writes safe when different nodes land them out of
order.

Every client is built by `createBoundedRedisClient`, which takes a **required**
declaration of which of the two it has — and a caller-side one has to NAME the
deadline, because "this one is bounded" was believed about the runtime store for
as long as nobody had to write down by what. `connectWithin` bounds the handshake
of every exempt connection, which no per-command deadline reaches:
`connectTimeout` covers the TCP connect and not the `INFO` after it, so without
either, bootstrap could wait forever on a host that accepts the socket and
answers nothing.

`server/test/redis-client-bounds.test.ts` enforces all of it: `new Redis` appears
in one module, the declarations are pinned, and an exempt module must open
through `connectWithin`. That is the part of #271 that is not a threshold — the
option's absence was invisible in a diff five times running.

Two things `commandTimeout` deliberately does **not** do, both verified against
ioredis in `server/test/redis-command-timeout.test.ts`:

- It does not take the command off the connection. ioredis keeps the timed-out
  command in its queue so later replies stay aligned, so **it bounds the
  caller's wait, not the connection's queue depth** — every depth limit in this
  server is still the only thing bounding memory.
- It does not distinguish slow from dead. It is set far above ordinary latency
  precisely so a Redis that is merely behind is not converted into a failed one.

Operationally, a stalled Redis looks different on the three backstopped
connections than on the five exempt ones, and expecting the wrong one wastes an
incident:

- **Admin session store, admin command bus.** Failed commands, not silence.
  Expect `admin_session_store_command_failed`,
  `admin_command_bus_command_failed` and `admin_command_result_publish_failed`,
  a 503 `admin_session_store_unavailable` on admin requests, a 503
  `command_bus_unavailable` on cross-node actions, and
  `bili_syncplay_redis_operation_failures_total{component="admin_session_store"|"admin_command_bus"}`
  climbing. `bili_syncplay_admin_command_result_publish_failures_total` counts
  every completed command whose result/fallback publish path ended in failure,
  including publisher admission refusals that never became Redis operations. It
  is not an end-to-end delivery-loss counter: a timed-out `PUBLISH` can still land.
  After `REDIS_STALL_DROP_THRESHOLD` consecutive failures the socket
  is reset and `admin_command_bus_connection_reset` says so — that reset is
  also what empties ioredis's command queue, which the backstop cannot.
- **Room store, runtime store, room event bus, event store, audit store.** The
  commands stay out on the connection, so the signal is the CALLER's, not the
  command's: `room_reaper_sweep_timeout` then `room_reaper_sweep_stalled`,
  `node_heartbeat_failed`, `redis_runtime_store_operation_failed`, the event
  store's shedding line, a 503 from the audit and event pages. Since #277 the
  request paths on the room and runtime stores are in that list too — they log
  `reason=timeout` and answer their caller. A stalled kick returns
  `status=error, confirmation=unconfirmed`; its complete kick effect remains
  outstanding. Retry is safe because the block deadline only moves later. What
  still stays **silent**
  is the six durable writes named above; a
  revoke, teardown write, or room-body write that never returns is what that
  looks like from outside.

## Post-Change Regression Checklist

- Creating a room, joining a room, sharing a video, and play / pause / seek sync all work.
- At least two clients connected through different room nodes still stay in sync.
- `/healthz`, `/readyz`, and `/metrics` are reachable on every node.
- The global admin allows login and shows the overview, rooms, events, and audit logs.
- `disconnect session`, `kick member`, and `close room` behave as expected on a test room.
- `bili_syncplay_redis_operation_failures_total` shows no sustained growth.
- `bili_syncplay_admin_command_result_publish_failures_total` shows no growth.
- The edge-layer upstream list matches the nodes actually online.
