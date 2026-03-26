# Multi-Node Global Admin Migration

This document describes how to roll out the full multi-node room topology plus the dedicated global admin backend, and how to roll it back safely by configuration instead of emergency code reverts.

## Target Topology

- `room-node-*`: handles WebSocket room traffic and health probes
- `global-admin`: handles `/admin` and `/api/admin/*`
- `redis`: shared persistence, runtime indexes, event streams, room event bus, and admin command bus

Every process must have a unique `INSTANCE_ID` and all processes in the same cluster must share the same `REDIS_URL`.

## Required Providers

For full multi-node correctness, enable all shared providers:

- `ROOM_STORE_PROVIDER=redis`
- `ADMIN_SESSION_STORE_PROVIDER=redis`
- `ADMIN_EVENT_STORE_PROVIDER=redis`
- `ADMIN_AUDIT_STORE_PROVIDER=redis`
- `RUNTIME_STORE_PROVIDER=redis`
- `ROOM_EVENT_BUS_PROVIDER=redis`
- `ADMIN_COMMAND_BUS_PROVIDER=redis`
- `NODE_HEARTBEAT_ENABLED=true`

Recommended role split:

- Room nodes: `GLOBAL_ADMIN_ENABLED=false`
- Global admin: `GLOBAL_ADMIN_ENABLED=true`

## Redis Dependencies

Key families used by the rollout:

- `bsp:room:*`, `bsp:room-index`, `bsp:room-expiry`
- `bsp:runtime:*`
- `bsp:admin:session:*`
- `bsp:events`
- `bsp:audit-logs`
- `bsp:room-events`
- `bsp:admin-command:*`
- `bsp:admin-command-result:*`

Before rollout:

1. Confirm Redis connectivity from every node.
2. Confirm Redis persistence and eviction policy are compatible with your retention expectations.
3. Confirm `INSTANCE_ID` values are unique.

## Rollout Order

### Phase 1: Shared Control Plane

Enable:

- `ADMIN_SESSION_STORE_PROVIDER=redis`
- `ADMIN_EVENT_STORE_PROVIDER=redis`
- `ADMIN_AUDIT_STORE_PROVIDER=redis`

Verify:

- login on node A, read on node B
- logout on node B invalidates node A
- events and audit logs aggregate across nodes

Rollback:

- switch the three providers back to `memory`

### Phase 2: Shared Runtime Index and Heartbeat

Enable:

- `RUNTIME_STORE_PROVIDER=redis`
- `NODE_HEARTBEAT_ENABLED=true`

Recommended:

- keep room traffic sticky during the first rollout window even though the shared read model is now cluster-wide

Verify:

- global overview shows aggregated room, member, and connection counts
- node health transitions to `stale` and `offline`
- stale sessions can be reaped from the global room view

Rollback:

- switch `RUNTIME_STORE_PROVIDER=memory`
- switch `NODE_HEARTBEAT_ENABLED=false`

### Phase 3: Cross-Node Room Broadcasts

Enable:

- `ROOM_EVENT_BUS_PROVIDER=redis`

Verify:

- cross-node join updates member lists on both nodes
- video share and playback updates propagate across nodes
- member leave converges globally without duplicate fanout storms

Rollback:

- switch `ROOM_EVENT_BUS_PROVIDER=none`
- temporarily return to sticky routing if room-state correctness must be preserved while investigating

### Phase 4: Cross-Node Admin Commands

Enable:

- `ADMIN_COMMAND_BUS_PROVIDER=redis`

Verify:

- `kick_member` reaches the target node
- `disconnect_session` reaches the target node
- audit logs contain `targetInstanceId`, `executorInstanceId`, and command result metadata

Rollback:

- switch `ADMIN_COMMAND_BUS_PROVIDER=none`
- temporarily stop using cross-node kick/disconnect actions

### Phase 5: Dedicated Global Admin

Deploy:

- `node server/dist/global-admin-index.js`

Room node setting:

- `GLOBAL_ADMIN_ENABLED=false`

Global admin setting:

- `GLOBAL_ADMIN_ENABLED=true`
- optional `GLOBAL_ADMIN_API_BASE_URL` if the UI and API origins differ

Verify:

- the admin UI reads cluster-wide overview, rooms, events, and audit logs from the global backend
- admin write actions still work when the target session lives on another node

Rollback:

- direct operators back to node-local `/admin`
- keep global admin running in read-only observation mode if needed

## Fast Rollback Matrix

| Symptom                                  | First rollback action                                                    | Notes                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Cross-node login issues                  | `ADMIN_SESSION_STORE_PROVIDER=memory`                                    | Admin sessions fall back to node-local only                 |
| Global events or audit query instability | `ADMIN_EVENT_STORE_PROVIDER=memory`, `ADMIN_AUDIT_STORE_PROVIDER=memory` | stdout logging is unchanged                                 |
| Global room/member counts wrong          | `RUNTIME_STORE_PROVIDER=memory`, `NODE_HEARTBEAT_ENABLED=false`          | Restores node-local admin read model                        |
| Cross-node room-state sync issues        | `ROOM_EVENT_BUS_PROVIDER=none`                                           | Re-enable sticky routing while investigating                |
| Cross-node kick/disconnect issues        | `ADMIN_COMMAND_BUS_PROVIDER=none`                                        | Keep read-only global admin if needed                       |
| Global admin rollout issues              | move operators back to node `/admin`                                     | Room nodes can temporarily keep `GLOBAL_ADMIN_ENABLED=true` |

## Operational Checklist

Before each phase:

1. Run the relevant automated tests.
2. Confirm `GET /healthz` and `GET /readyz` on every room node.
3. Confirm `GET /api/admin/overview` from the global admin.
4. Confirm Redis latency and error rates are acceptable.

After each phase:

1. Watch for `room_event_publish_failed`, `room_event_consume_failed`, `admin_command_execution_failed`, and `runtime_index_reaper_failed`.
2. Verify room membership and session counts from the global admin.
3. Verify audit records for every write action executed during rollout.

## Final Validation

Before declaring the migration complete, run:

```bash
npm run lint
npm run format:check
npm run typecheck
npm run build
npm test
```
