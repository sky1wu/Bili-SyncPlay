# Security Environment Variables

[English](./security-env.md) | [简体中文](./security-env.zh-CN.md)

The server accepts the following environment variables. Safe defaults are built in, but production should set them explicitly:

- `BILI_SYNCPLAY_CONFIG`: optional path to a JSON config file; when unset, the server looks for `server.config.json` in the current working directory
- `ALLOWED_ORIGINS`: comma-separated WebSocket `Origin` allowlist
- if `ALLOWED_ORIGINS` is empty, the server rejects all explicit `Origin` values by default
- `ALLOW_MISSING_ORIGIN_IN_DEV`: allow missing `Origin` headers when set to `true`
- `ALLOW_ANY_FIREFOX_EXTENSION_ORIGIN`: when `true`, accept any well-formed `moz-extension://<uuid>` origin; Firefox assigns a random per-install UUID that a public/shared server cannot enumerate in `ALLOWED_ORIGINS`. Still rejects web-page origins (a page can never present a `moz-extension://` origin) and does not replace room/member-token auth; default `false`
- `TRUSTED_PROXY_ADDRESSES`: comma-separated proxy socket IP allowlist; only requests arriving from these proxies can use `X-Forwarded-For`
- `MAX_CONNECTIONS_PER_IP`: max concurrent WebSocket connections per IP
- `CONNECTION_ATTEMPTS_PER_MINUTE`: max handshake attempts per IP per minute
- `MAX_MEMBERS_PER_ROOM`: room member cap
- `MAX_MESSAGE_BYTES`: WebSocket message size cap in bytes
- `INVALID_MESSAGE_CLOSE_THRESHOLD`: number of invalid messages before disconnect
- `WS_HEARTBEAT_ENABLED`: enables server-side WebSocket ping/pong liveness checks that terminate half-open dead connections (ghost members); defaults to `true`
- `WS_HEARTBEAT_INTERVAL_MS`: WebSocket heartbeat ping interval in milliseconds; a connection is terminated after two consecutive missed pongs; defaults to `30000`
- `ROOM_STORE_PROVIDER`: `memory` or `redis`
- `EMPTY_ROOM_TTL_MS`: how long an empty room is retained before deletion
- `ROOM_CLEANUP_INTERVAL_MS`: how often the server deletes expired rooms
- `REDIS_URL`: Redis connection URL when `ROOM_STORE_PROVIDER=redis`
- `ADMIN_USERNAME`: admin login username
- `ADMIN_PASSWORD_HASH`: admin password hash, currently supports `sha256:<hex>` or `scrypt:<salt>:<base64url>`
- `ADMIN_SESSION_SECRET`: secret used to bind bearer tokens to server-side sessions
- `ADMIN_SESSION_TTL_MS`: admin session lifetime in milliseconds
- `ADMIN_ROLE`: admin role, one of `viewer`, `operator`, `admin`
- `ADMIN_UI_DEMO_ENABLED`: enables the built-in admin UI demo mode for local / non-production preview; defaults to `false`
- `ADMIN_SESSION_STORE_PROVIDER`: `memory` or `redis`
- `ADMIN_EVENT_STORE_PROVIDER`: `memory` or `redis`
- `ADMIN_AUDIT_STORE_PROVIDER`: `memory` or `redis`
- `RUNTIME_STORE_PROVIDER`: `memory` or `redis`
- `ROOM_EVENT_BUS_PROVIDER`: `none`, `memory`, or `redis`
- `ADMIN_COMMAND_BUS_PROVIDER`: `none`, `memory`, or `redis`
- `GLOBAL_ADMIN_ENABLED`: when `false`, a room node keeps `/`, `/healthz`, `/readyz`, but disables `/admin` and `/api/admin/*`
- `GLOBAL_ADMIN_API_BASE_URL`: optional admin UI API base URL override
- `GLOBAL_ADMIN_PORT`: HTTP port for `server/dist/global-admin-index.js`
- `NODE_HEARTBEAT_ENABLED`: enables node heartbeat reporting
- `NODE_HEARTBEAT_INTERVAL_MS`: heartbeat interval in milliseconds
- `NODE_HEARTBEAT_TTL_MS`: heartbeat TTL in milliseconds
- `RATE_LIMIT_ROOM_CREATE_PER_MINUTE`
- `RATE_LIMIT_ROOM_JOIN_PER_MINUTE`
- `RATE_LIMIT_VIDEO_SHARE_PER_10_SECONDS`
- `RATE_LIMIT_PLAYBACK_UPDATE_PER_SECOND`
- `RATE_LIMIT_PLAYBACK_UPDATE_BURST`
- `RATE_LIMIT_SYNC_REQUEST_PER_10_SECONDS`
- `RATE_LIMIT_SYNC_PING_PER_SECOND`
- `RATE_LIMIT_SYNC_PING_BURST`

Example:

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
