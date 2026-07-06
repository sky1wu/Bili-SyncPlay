# Multi-Node Deployment and Global Admin

[English](./multi-node.md) | [简体中文](./multi-node.zh-CN.md)

The server supports a full multi-node topology with shared admin sessions, shared event and audit streams, shared runtime indexes, cross-node room-state fanout, cross-node admin commands, and a dedicated global admin entrypoint.

## Core model

- end users connect to a single public URL such as `wss://sync.example.com`
- the edge layer handles TLS termination, reverse proxying, and connection distribution
- room nodes carry WebSocket traffic and health probes
- the global admin process serves `/admin` and `/api/admin/*`
- Redis backs shared persistence, runtime indexes, buses, and admin sessions

Recommended production topology:

- edge entrypoint: `Nginx`, `HAProxy`, `SLB/ALB`, or another reverse proxy / load balancer for TLS termination and WebSocket fan-in
- `room-node-a`: WebSocket room traffic plus health probes
- `room-node-b`: WebSocket room traffic plus health probes
- `global-admin`: `/admin` and `/api/admin/*`
- `redis`: shared persistence, runtime index, event bus, and command bus backend

The server does not implement L4/L7 load balancing inside the application process. Multi-node deployments require an external entrypoint layer that accepts user connections on a single public URL and forwards them to room nodes. End users should connect to one public address such as `wss://sync.example.com`, not pick node addresses manually.

> Note
> If you are only doing local development or one-node deployment, you can stay on the single-node setup. The rest of this section is mainly for production multi-node rollout.

For day-2 operations such as scaling, Redis incidents, admin credential rotation, and alert triage, see the
[multi-node operations runbook](../runbook/multi-node-operations.md).

## Minimum required shared settings

Recommended provider settings for a full multi-node rollout:

- `ROOM_STORE_PROVIDER=redis`
- `ADMIN_SESSION_STORE_PROVIDER=redis`
- `ADMIN_EVENT_STORE_PROVIDER=redis`
- `ADMIN_AUDIT_STORE_PROVIDER=redis`
- `RUNTIME_STORE_PROVIDER=redis`
- `ROOM_EVENT_BUS_PROVIDER=redis`
- `ADMIN_COMMAND_BUS_PROVIDER=redis`
- `NODE_HEARTBEAT_ENABLED=true`

Room node example:

```bash
BILI_SYNCPLAY_CONFIG=/etc/bili-syncplay/server.config.json \
PORT=8787 \
INSTANCE_ID=room-node-a \
ADMIN_SESSION_STORE_PROVIDER=redis \
ADMIN_EVENT_STORE_PROVIDER=redis \
ADMIN_AUDIT_STORE_PROVIDER=redis \
GLOBAL_ADMIN_ENABLED=false \
node server/dist/index.js
```

Dedicated global admin example:

```bash
BILI_SYNCPLAY_CONFIG=/etc/bili-syncplay/server.config.json \
GLOBAL_ADMIN_PORT=8788 \
INSTANCE_ID=global-admin \
ADMIN_SESSION_STORE_PROVIDER=redis \
ADMIN_EVENT_STORE_PROVIDER=redis \
ADMIN_AUDIT_STORE_PROVIDER=redis \
GLOBAL_ADMIN_ENABLED=true \
node server/dist/global-admin-index.js
```

If the admin UI should talk to a separate API origin, set `GLOBAL_ADMIN_API_BASE_URL=https://admin.example.com`.

## Node role configuration matrix

| Role           | Typical process                     | External responsibility                                                           | Must be unique                                     | Must stay aligned                                                         | Recommended value / note               |
| -------------- | ----------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| `room-node`    | `server/dist/index.js`              | WebSocket, `/`, `/healthz`, `/readyz`                                             | `INSTANCE_ID`, bind address / port                 | `REDIS_URL`, shared `*_PROVIDER` values, security and rate-limit settings | `GLOBAL_ADMIN_ENABLED=false`           |
| `global-admin` | `server/dist/global-admin-index.js` | `/admin`, `/api/admin/*`                                                          | `INSTANCE_ID`, `GLOBAL_ADMIN_PORT`                 | `REDIS_URL`, admin auth settings, shared provider settings                | `GLOBAL_ADMIN_ENABLED=true`            |
| `edge`         | `nginx` / `haproxy` / cloud LB      | TLS termination, single public entrypoint, reverse proxy, connection distribution | public hostname, certificate, upstream definitions | backend node list                                                         | end users connect only to the edge URL |
| `redis`        | `redis-server`                      | shared persistence, runtime indexes, buses                                        | instance address, password, ACL                    | every node must point to the same Redis                                   | production should keep it private      |

## Which settings must match and which must differ

### Shared across nodes

Settings that should stay aligned across every room node and the global admin process:

- `REDIS_URL`
- `ROOM_STORE_PROVIDER=redis`
- `ADMIN_SESSION_STORE_PROVIDER=redis`
- `ADMIN_EVENT_STORE_PROVIDER=redis`
- `ADMIN_AUDIT_STORE_PROVIDER=redis`
- `RUNTIME_STORE_PROVIDER=redis`
- `ROOM_EVENT_BUS_PROVIDER=redis`
- `ADMIN_COMMAND_BUS_PROVIDER=redis`
- `NODE_HEARTBEAT_ENABLED=true`
- correctness-sensitive room, security, and rate-limit settings such as `MAX_MEMBERS_PER_ROOM`, `MAX_MESSAGE_BYTES`, and `ALLOWED_ORIGINS`
- admin auth settings such as `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, and `ADMIN_SESSION_SECRET`

### Unique per node

Settings that must differ per process or by role:

- `INSTANCE_ID`: every process must use a unique value such as `room-node-a`, `room-node-b`, or `global-admin`
- `PORT`: used by each room node
- `GLOBAL_ADMIN_PORT`: used only by `global-admin`
- `GLOBAL_ADMIN_ENABLED`: `false` on room nodes, `true` on the dedicated admin process
- bind addresses, firewall rules, systemd unit names, and log paths

## Two-server deployment example

If you currently have only two machines, a practical rollout looks like this:

- server 1: `Nginx + Redis + room-node-a + global-admin`
- server 2: `room-node-b`

### Port layout

Suggested port layout:

| Machine  | Role           | Suggested bind                      | Publicly exposed | Notes                    |
| -------- | -------------- | ----------------------------------- | ---------------- | ------------------------ |
| server 1 | `nginx`        | `80/443`                            | yes              | single public entrypoint |
| server 1 | `room-node-a`  | `127.0.0.1:8787` or private IP      | no               | proxied by the edge      |
| server 1 | `global-admin` | `127.0.0.1:8788` or private IP      | no               | proxied by the edge      |
| server 1 | `redis`        | `127.0.0.1:6379` or private IP      | no               | allow only node access   |
| server 2 | `room-node-b`  | private IP such as `10.0.0.12:8787` | no               | proxied by server 1 edge |

### Environment examples

Example room node environment on server 1:

```bash
BILI_SYNCPLAY_CONFIG=/etc/bili-syncplay/server.config.json \
PORT=8787 \
INSTANCE_ID=room-node-a \
REDIS_URL=redis://10.0.0.11:6379 \
ROOM_STORE_PROVIDER=redis \
ADMIN_SESSION_STORE_PROVIDER=redis \
ADMIN_EVENT_STORE_PROVIDER=redis \
ADMIN_AUDIT_STORE_PROVIDER=redis \
RUNTIME_STORE_PROVIDER=redis \
ROOM_EVENT_BUS_PROVIDER=redis \
ADMIN_COMMAND_BUS_PROVIDER=redis \
NODE_HEARTBEAT_ENABLED=true \
GLOBAL_ADMIN_ENABLED=false \
node server/dist/index.js
```

Example room node environment on server 2:

```bash
BILI_SYNCPLAY_CONFIG=/etc/bili-syncplay/server.config.json \
PORT=8787 \
INSTANCE_ID=room-node-b \
REDIS_URL=redis://10.0.0.11:6379 \
ROOM_STORE_PROVIDER=redis \
ADMIN_SESSION_STORE_PROVIDER=redis \
ADMIN_EVENT_STORE_PROVIDER=redis \
ADMIN_AUDIT_STORE_PROVIDER=redis \
RUNTIME_STORE_PROVIDER=redis \
ROOM_EVENT_BUS_PROVIDER=redis \
ADMIN_COMMAND_BUS_PROVIDER=redis \
NODE_HEARTBEAT_ENABLED=true \
GLOBAL_ADMIN_ENABLED=false \
node server/dist/index.js
```

Example global admin environment on server 1:

```bash
BILI_SYNCPLAY_CONFIG=/etc/bili-syncplay/server.config.json \
GLOBAL_ADMIN_PORT=8788 \
INSTANCE_ID=global-admin \
REDIS_URL=redis://10.0.0.11:6379 \
ROOM_STORE_PROVIDER=redis \
ADMIN_SESSION_STORE_PROVIDER=redis \
ADMIN_EVENT_STORE_PROVIDER=redis \
ADMIN_AUDIT_STORE_PROVIDER=redis \
RUNTIME_STORE_PROVIDER=redis \
ROOM_EVENT_BUS_PROVIDER=redis \
ADMIN_COMMAND_BUS_PROVIDER=redis \
NODE_HEARTBEAT_ENABLED=true \
GLOBAL_ADMIN_ENABLED=true \
node server/dist/global-admin-index.js
```

### Weighting advice

If the edge machine also carries `room-node-a`, `global-admin`, and `redis`, it will usually absorb more network and CPU pressure than the other nodes. In that case, prefer `least_conn` at the edge and consider giving the remote room node a higher weight rather than splitting long-lived WebSocket traffic 1:1.

Redis key families used by the multi-node control plane:

- `bsp:room:*`, `bsp:room-index`, `bsp:room-expiry`: persisted room base state
- `bsp:runtime:*`: shared sessions, room members, blocked member tokens, and node heartbeats
- `bsp:admin:session:*`: shared admin bearer sessions
- `bsp:events`: runtime event stream
- `bsp:audit-logs`: admin audit stream
- `bsp:room-events`: room event bus channel
- `bsp:admin-command:*`, `bsp:admin-command-result:*`: admin command channels
