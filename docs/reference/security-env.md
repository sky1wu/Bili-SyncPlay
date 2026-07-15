# Security Environment Variables

[English](./security-env.md) | [简体中文](./security-env.zh-CN.md)

The server accepts the following environment variables. Safe defaults are built in, but production should set them explicitly. Non-secret settings can also live in `server.config.json`; environment variables always take precedence (see the [deployment guide](../operations/deployment.md)).

## Basic Service

- `BILI_SYNCPLAY_CONFIG`: optional path to a JSON config file; when unset, the server looks for `server.config.json` in the current working directory
- `PORT`: HTTP/WebSocket listen port for a room node; defaults to `8787`
- `METRICS_PORT`: optional dedicated port for `GET /metrics`; when unset, metrics are served on the main service port; must not collide with `PORT` or `GLOBAL_ADMIN_PORT`
- `METRICS_TOKEN`: optional static bearer token guarding `GET /metrics` (both the main-port route and the `METRICS_PORT` server); when set, scrapes must send `Authorization: Bearer <token>` or receive `401`; when unset, the endpoint stays open; `/healthz` and `/readyz` are never affected. Configure Prometheus via `authorization.credentials_file`
- `LOG_LEVEL`: log level, one of `debug`, `info`, `warn`, `error`; defaults to `info`
- `INSTANCE_ID`: identifier for the current server process (e.g. `room-node-a`), shown in the admin overview, room detail, and audit logs; must be unique per process in multi-node deployments; defaults to `instance-1`

## Origin and Connection Security

- `ALLOWED_ORIGINS`: comma-separated `Origin` allowlist for WebSocket connections and cross-origin admin API requests; when empty, the server rejects all explicit cross-origin values by default
- `ALLOW_MISSING_ORIGIN_IN_DEV`: allow missing `Origin` headers when set to `true`; defaults to `false`
- `ALLOW_ANY_FIREFOX_EXTENSION_ORIGIN`: when `true`, accept any well-formed `moz-extension://<uuid>` origin; Firefox assigns a random per-install UUID that a public/shared server cannot enumerate in `ALLOWED_ORIGINS`. Still rejects web-page origins (a page can never present a `moz-extension://` origin) and does not replace room/member-token auth; defaults to `false`
- `TRUSTED_PROXY_ADDRESSES`: comma-separated proxy socket IP allowlist; only requests arriving from these proxies can use `X-Forwarded-For`; defaults to empty
- `MAX_CONNECTIONS_PER_IP`: max concurrent WebSocket connections per IP; defaults to `10`
- `CONNECTION_ATTEMPTS_PER_MINUTE`: max handshake attempts per IP per minute; defaults to `20`
- `MAX_MEMBERS_PER_ROOM`: room member cap; defaults to `8`
- `MAX_MESSAGE_BYTES`: WebSocket message size cap in bytes; defaults to `8192`
- `INVALID_MESSAGE_CLOSE_THRESHOLD`: number of invalid messages before disconnect; defaults to `3`
- `WS_HEARTBEAT_ENABLED`: enables server-side WebSocket ping/pong liveness checks that terminate half-open dead connections (ghost members); defaults to `true`
- `WS_HEARTBEAT_INTERVAL_MS`: WebSocket heartbeat ping interval in milliseconds; a connection is terminated after two consecutive missed pongs; defaults to `30000`

## Message Rate Limits

Room and sync message limits apply per connection (member session); admin login limits apply per IP or per username.

- `RATE_LIMIT_ROOM_CREATE_PER_MINUTE`: max room creations per minute; defaults to `3`
- `RATE_LIMIT_ROOM_JOIN_PER_MINUTE`: max room join attempts per minute; defaults to `10`
- `RATE_LIMIT_VIDEO_SHARE_PER_10_SECONDS`: max shared-video updates per 10 seconds; defaults to `3`
- `RATE_LIMIT_PLAYBACK_UPDATE_PER_SECOND`: sustained playback update rate per second; defaults to `8`
- `RATE_LIMIT_PLAYBACK_UPDATE_BURST`: short-burst allowance (token bucket size) for playback updates; defaults to `12`
- `RATE_LIMIT_SYNC_REQUEST_PER_10_SECONDS`: max sync requests per 10 seconds; defaults to `6`
- `RATE_LIMIT_SYNC_PING_PER_SECOND`: sustained clock-sync ping rate per second; defaults to `1`
- `RATE_LIMIT_SYNC_PING_BURST`: short-burst allowance (token bucket size) for clock-sync pings; defaults to `2`
- `RATE_LIMIT_ADMIN_LOGIN_FAILURES_PER_IP_PER_MINUTE`: max failed admin login attempts per IP per minute before further attempts are rejected; defaults to `10`
- `RATE_LIMIT_ADMIN_LOGIN_FAILURES_PER_USERNAME_PER_MINUTE`: max failed admin login attempts per username per minute; defaults to `5`

## Room Persistence and Redis

- `ROOM_STORE_PROVIDER`: room storage backend, `memory` or `redis`; defaults to `memory`
- `EMPTY_ROOM_TTL_MS`: how long an empty room is retained before deletion; defaults to `900000` (15 minutes)
- `ROOM_CLEANUP_INTERVAL_MS`: how often the server deletes expired rooms; defaults to `60000`
- `REDIS_URL`: Redis connection URL used by all Redis-backed providers; defaults to `redis://localhost:6379`
- `REDIS_NAMESPACE`: prefix for all Redis keys; defaults to `bsp`; set different values to isolate multiple deployments sharing one Redis instance

## Admin Authentication

All three of `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, and `ADMIN_SESSION_SECRET` must be set, otherwise admin auth endpoints stay unavailable.

- `ADMIN_USERNAME`: admin login username
- `ADMIN_PASSWORD_HASH`: admin password hash, currently supports `sha256:<hex>` or `scrypt:<salt>:<base64url>`
- `ADMIN_SESSION_SECRET`: secret used to bind bearer tokens to server-side sessions
- `ADMIN_SESSION_TTL_MS`: admin session lifetime in milliseconds; defaults to `43200000` (12 hours)
- `ADMIN_ROLE`: role of the single configured admin account, one of `viewer`, `operator`, `admin`; defaults to `admin`
- `ADMIN_UI_DEMO_ENABLED`: enables the built-in admin UI demo mode for local / non-production preview; defaults to `false`

## Multi-Node Providers and Global Admin

- `ADMIN_SESSION_STORE_PROVIDER`: admin session storage, `memory` or `redis`; defaults to `memory`
- `ADMIN_EVENT_STORE_PROVIDER`: runtime event storage, `memory` or `redis`; defaults to `memory`
- `ADMIN_AUDIT_STORE_PROVIDER`: audit log storage, `memory` or `redis`; defaults to `memory`
- `RUNTIME_STORE_PROVIDER`: shared runtime index storage (sessions, room members, blocked tokens, node heartbeats), `memory` or `redis`; defaults to `redis` when `ROOM_STORE_PROVIDER=redis`, otherwise `memory`
- `ROOM_EVENT_BUS_PROVIDER`: cross-node room event fanout, `none`, `memory`, or `redis`; defaults to `redis` when `RUNTIME_STORE_PROVIDER=redis`, otherwise `memory`
- `ADMIN_COMMAND_BUS_PROVIDER`: cross-node admin command routing, `none`, `memory`, or `redis`; defaults to `redis` when `RUNTIME_STORE_PROVIDER=redis`, otherwise `memory`
- `GLOBAL_ADMIN_ENABLED`: when `false`, a room node keeps `/`, `/healthz`, `/readyz`, but disables `/admin` and `/api/admin/*`; defaults to `true`
- `GLOBAL_ADMIN_API_BASE_URL`: optional admin UI API base URL override, for serving the admin UI and admin API from different origins; add the UI origin to `ALLOWED_ORIGINS` when using this mode
- `GLOBAL_ADMIN_PORT`: HTTP port for `server/dist/global-admin-index.js`; defaults to `PORT`, or `8788` when `PORT` is also unset
- `NODE_HEARTBEAT_ENABLED`: enables node heartbeat reporting to the shared runtime store; defaults to `false`
- `NODE_HEARTBEAT_INTERVAL_MS`: heartbeat interval in milliseconds; defaults to `15000`
- `NODE_HEARTBEAT_TTL_MS`: heartbeat TTL in milliseconds; a node is considered offline after its heartbeat expires; defaults to `45000`

## Example

```bash
PORT=8787 \
ALLOWED_ORIGINS=chrome-extension://<extension-id>,https://sync.example.com,http://localhost:3000 \
TRUSTED_PROXY_ADDRESSES=127.0.0.1,10.0.0.10 \
ROOM_STORE_PROVIDER=redis \
REDIS_URL=redis://127.0.0.1:6379 \
EMPTY_ROOM_TTL_MS=900000 \
ROOM_CLEANUP_INTERVAL_MS=60000 \
MAX_CONNECTIONS_PER_IP=10 \
CONNECTION_ATTEMPTS_PER_MINUTE=20 \
MAX_MEMBERS_PER_ROOM=8 \
MAX_MESSAGE_BYTES=8192 \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD_HASH=sha256:<hex-password-hash> \
ADMIN_SESSION_SECRET=<random-secret> \
ADMIN_SESSION_TTL_MS=43200000 \
node server/dist/index.js
```

Quick admin hash example:

```bash
node -e "const { createHash } = require('node:crypto'); console.log('sha256:' + createHash('sha256').update('secret-123').digest('hex'));"
```
