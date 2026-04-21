# Bili-SyncPlay

[English](./README.md) | [简体中文](./README.zh-CN.md)

Bili-SyncPlay is a Chrome extension plus a WebSocket server for synchronized Bilibili watching. Users can create or join a room, share the current video, and keep playback, pause, seek, and playback rate in sync across participants.

It supports the full local workflow:

- load the unpacked extension in Chrome or Edge
- run the local sync server
- create a room and share an invite string
- keep everyone on the same shared video in sync

This repository is a monorepo:

- `extension/`: Chrome extension
- `server/`: WebSocket room server and admin panel
- `packages/protocol/`: shared protocol types

## At a Glance

- Invite format: `roomCode:joinToken`
- Default local server: `ws://localhost:8787`
- Supported browsers for development: Chrome, Edge
- Recommended production server URL: `wss://<your-domain>`

## Quick Start

If you want to use the published extension directly, install it from one of the published stores:

- [Bili-SyncPlay on Chrome Web Store](https://chromewebstore.google.com/detail/bili-syncplay/lbmckljnginagfabglpfdepofoglfdkj)
- [Bili-SyncPlay on Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/bili-syncplay/cpgcalajpoihfgfeidmnijcdimnjniam)

### 1. Install and build

```bash
npm install
npm run build
```

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select `extension/dist`

### 3. Start the local server

Before connecting the unpacked extension to a local server, allow the current extension origin in `ALLOWED_ORIGINS`.

PowerShell:

```powershell
$env:ALLOWED_ORIGINS="chrome-extension://<extension-id>"
npm run dev:server
```

Bash:

```bash
ALLOWED_ORIGINS=chrome-extension://<extension-id> \
npm run dev:server
```

### 4. Use it

1. Open the popup
2. Create a room, or join one with `roomCode:joinToken`
3. Open a supported Bilibili video page
4. Click `Sync current page video`
5. Other members will open the same video and enter sync mode

If a member later browses to a different non-shared video while still in the room, that page stays local and does not affect the room unless they explicitly sync it.

## Features

- Room lifecycle
  - create a room and get an invite string
  - join a room with `roomCode:joinToken`
  - copy and share invites directly from the popup
- Playback sync
  - share the current page video from the popup
  - sync play, pause, seek, and playback rate
  - automatically open the currently shared video for room members
- In-page feedback
  - member join and leave toasts
  - shared video change toasts
  - play, pause, seek, and rate-change toasts
- Safe local browsing while still in a room
  - non-shared pages do not broadcast playback back to the room
  - manual playback on a non-shared page stays local

## Supported Pages

- `https://www.bilibili.com/video/*`
- `https://www.bilibili.com/bangumi/play/*`
- `https://www.bilibili.com/festival/*`
- `https://www.bilibili.com/list/watchlater*` when the page URL carries `bvid`
- `https://www.bilibili.com/medialist/play/watchlater*` when the page URL carries `bvid`

Video variants:

- multi-part videos via `?p=`
- festival pages via `bvid + cid`

## Project Structure

```text
Bili-SyncPlay/
  extension/            Chrome extension
  server/               WebSocket room server
  packages/protocol/    Shared protocol types
  scripts/              Release packaging scripts
  .github/workflows/    GitHub Actions workflows
```

## Requirements

- Node.js 18+
- npm 8+
- Chrome or Edge for loading the unpacked extension

## Local Defaults

- Default server URL: `ws://localhost:8787`
- Empty server URL input falls back to the build-time default
- Only `ws://` and `wss://` are accepted
- Local unpacked extension development requires `ALLOWED_ORIGINS=chrome-extension://<extension-id>`

### Open the Admin Control Panel

To use the management UI locally, start the server with admin auth configured and then open:

```text
http://localhost:8787/admin
```

This is the single-process local development mode, where the admin UI and WebSocket service share the same `npm run dev:server` process.

If you run a dedicated global admin process instead, the entrypoint is usually one of these:

```text
http://localhost:8788/admin
https://admin.example.com/admin
```

In practice:

- `http://localhost:8787/admin`: single-process development or non-separated admin mode
- `http://localhost:8788/admin`: local direct access to `server/dist/global-admin-index.js`
- `https://admin.example.com/admin`: production admin URL behind a reverse proxy

PowerShell example:

```powershell
$env:ADMIN_USERNAME="admin"
$env:ADMIN_PASSWORD_HASH="sha256:<hex-password-hash>"
$env:ADMIN_SESSION_SECRET="<random-secret>"
$env:ADMIN_ROLE="admin"
npm run dev:server
```

To enable the built-in admin demo data in a non-production environment, opt in explicitly:

```powershell
$env:ADMIN_UI_DEMO_ENABLED="true"
npm run dev:server
```

When this flag is not enabled, `?demo=1` is ignored by the admin UI.

Generate a `sha256:<hex>` password hash locally:

PowerShell:

```powershell
$password = "secret-123"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($password)
$hash = [System.BitConverter]::ToString(
  [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
).Replace("-", "").ToLower()
"sha256:$hash"
```

Node.js:

```bash
node -e "const { createHash } = require('node:crypto'); const password = 'secret-123'; console.log('sha256:' + createHash('sha256').update(password).digest('hex'));"
```

After login, the current UI includes:

- overview
- room list and room detail
- runtime events
- audit logs
- config summary
- existing admin actions such as close room, expire room, clear shared video, kick member, and disconnect session
- kicked members are temporarily blocked from immediately rejoining with their previous `memberToken`

## Developer Reference

### Local Development

Install dependencies:

```bash
npm install
```

Before running repository checks locally, make sure dependencies have been installed with `npm install`. In CI, use `npm ci` for a clean lockfile-based install before running the same checks.

Recommended root workspace commands:

```bash
npm run lint
npm run format:check
npm run typecheck
npm run build
npm test
```

Useful command matrix:

- `npm run lint`: run repository-wide ESLint checks
- `npm run lint:fix`: apply safe ESLint fixes
- `npm run format`: rewrite files with Prettier
- `npm run format:check`: verify formatting without rewriting
- `npm run typecheck`: run TypeScript semantic checks across protocol, server, and extension source code
- `npm run build`: build `protocol`, `server`, and `extension` in dependency order
- `npm test`: run repository-wide protocol, server, and extension tests
- `npm run test:server:redis`: run the explicit Redis regression entry point for server persistence

Development constraints:

- Keep entry files thin and keep shared rules in a single source of truth.
- Install dependencies with `npm install` before running local checks; use `npm ci` in CI before the same verification flow.
- Run `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build`, and `npm test` before committing changes.
- See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contribution and refactoring constraints.

### Benchmark Baselines

The repository now includes reproducible benchmark entry points under `bench/` for the main high-load scenarios discussed in issue `#67`.

Commands:

```bash
npm run bench:single-room
npm run bench:redis-broadcast
npm run bench:reconnect-storm
```

Each script prints standardized JSON to stdout and can also write to a file with `--output <path>`.

Examples:

```bash
npm run bench:single-room -- --output .tmp/bench-single.json
npm run bench:redis-broadcast -- --duration-seconds 30 --sample-watchers 12
npm run bench:reconnect-storm -- --members 500 --output .tmp/bench-reconnect.json
```

Scenario defaults:

- `bench:single-room`: one node, one room, 100 members, `playback:update` at 10 Hz for 60 seconds
- `bench:redis-broadcast`: two room nodes bridged through Redis, same load as above, owner pinned to node A and followers pinned to node B
- `bench:reconnect-storm`: one room with 500 members, then simultaneous reconnects using the previous `memberToken`

Redis behavior:

- `bench:redis-broadcast` uses `REDIS_URL` when provided.
- If `REDIS_URL` is absent and `redis-server` is available in `PATH`, the script starts an ephemeral local Redis instance automatically.
- The generated JSON is stable and diff-friendly: config, throughput, latency percentiles (`P50` / `P95` / `P99`), and error rate are always emitted in the same shape.

Result shape:

```json
{
  "schemaVersion": 1,
  "scenario": "redis-broadcast",
  "startedAt": "2026-04-22T10:00:00.000Z",
  "completedAt": "2026-04-22T10:01:00.250Z",
  "config": {},
  "metrics": {
    "throughput": {},
    "latency": {},
    "errorRatePercent": 0,
    "errors": 0
  },
  "notes": []
}
```

Notes:

- Broadcast latency is sampled from a configurable subset of watcher sockets so the load generator does not serialize on every client ack.
- Reconnect latency measures the full path from socket open to the first post-join `room:state`.

Build everything:

```bash
npm run build
```

Build the extension with a fixed Chrome extension ID:

```powershell
$env:BILI_SYNCPLAY_EXTENSION_KEY="<chrome-web-store-public-key>"
npm run build -w @bili-syncplay/extension
```

If `BILI_SYNCPLAY_EXTENSION_KEY` is set, the build writes it to `extension/dist/manifest.json` as `manifest.key`. Use the same public key as the Chrome Web Store item so locally loaded builds keep the same extension ID as the published one.

Run the automated test suites:

```bash
npm test
```

Current test coverage in this repository includes:

- protocol client message validation
- server WebSocket validation, auth, origin filtering, and rate-limit checks
- background room-state race handling

Workspace-level test commands are also available:

```bash
npm run test -w @bili-syncplay/protocol
npm run test -w @bili-syncplay/server
npm run test:redis -w @bili-syncplay/server
npm run test -w @bili-syncplay/extension
```

Redis integration test notes:

- `npm run test -w @bili-syncplay/server` keeps Redis-specific tests optional and may skip them when `REDIS_URL` is not configured
- `npm run test:redis -w @bili-syncplay/server` is the explicit Redis regression entry point
- `npm run test:server:redis` runs the same Redis regression from the workspace root
- `REDIS_URL` is required for those explicit Redis test commands and they fail fast when it is missing

### Code Organization

The repository now follows a "thin entrypoint + named modules" structure.

- `extension/src/background`
  - `index.ts` is assembly only
  - runtime state lives in `state-store.ts`
  - socket, room session, popup state, diagnostics, and tab coordination live in dedicated controllers
- `extension/src/content`
  - `index.ts` is assembly only
  - runtime state lives in `content-store.ts`
  - playback sync, room-state hydration, navigation, playback binding, and sharing logic live in dedicated controllers
- `extension/src/popup`
  - `index.ts` is assembly only
  - local UI state lives in `popup-store.ts`
  - template, refs, render, actions, and background port sync live in separate modules
- `extension/src/shared`
  - shared extension helpers such as normalized video URL handling must live here instead of being redefined in feature entrypoints
- `packages/protocol/src`
  - protocol types live under `types/*`
  - guards live under `guards/*`
  - `index.ts` is the compatibility export surface
- `server/src`
  - `app.ts` is runtime assembly only
  - env parsing lives under `config/*`
  - bootstrap glue lives under `bootstrap/*`
  - admin route dispatch lives under `admin/routes/*`

Current regression coverage is intentionally aligned with those boundaries and now includes store/controller/helper coverage for the refactored modules, not only end-to-end behavior checks.

### Contribution Constraints

When making follow-up changes, keep the current structure stable:

- prefer adding behavior to an existing named module over growing `index.ts`
- keep entry files focused on initialization, dependency wiring, and listener registration
- keep shared rules in one place; do not reintroduce local `normalizeUrl()` wrappers or duplicate parser logic
- if a change introduces new state, put it behind the relevant store instead of another top-level mutable variable
- if a change mixes state, IO, and business decisions in one file, split it before it becomes the new largest file in that area
- add or update targeted tests when changing a store, controller, helper, protocol guard, or server config/router boundary

Recommended pre-commit checklist:

```bash
npm run lint
npm run format:check
npm run typecheck
npm run build
npm test
```

Start the local server:

```bash
npm run dev:server
```

Default server URL:

```text
ws://localhost:8787
```

Development notes:

- `@bili-syncplay/server` depends on the built output of `@bili-syncplay/protocol`
- for a clean local setup, prefer `npm run build` instead of building `server` alone
- the extension does not keep a permanent socket by default; it connects when a room already exists in session state or when the user creates / joins a room
- reconnecting into an existing room now requires the stored `joinToken`; stale `memberToken` values are discarded on disconnect
- if you change protocol types or message validation, rebuild both `packages/protocol` and `server`
- the local server rejects extension connections unless `ALLOWED_ORIGINS` includes the current `chrome-extension://<extension-id>`
- you can find the unpacked extension ID on `chrome://extensions`

The extension version shown by Chrome comes from `extension/dist/manifest.json`.
During build, that manifest version is generated automatically from the root `package.json`.

### Runtime Behavior

- if the user clicks `Sync current page video` before joining a room, the extension prompts to create a room first
- if the room is already sharing a different video, the popup asks for confirmation before replacing it
- the background service worker only forwards playback updates from the currently recognized shared tab
- switching the server URL disconnects the current socket and reconnects using the new address if the extension still has an active room or pending room creation
- invalid persisted server URLs remain visible in extension state and block automatic reconnect until corrected
- supported playback pages depend on Bilibili DOM and URL patterns, so festival pages and watch-later pages may need future compatibility updates if Bilibili changes them

### State Persistence

The extension intentionally splits persistent state by lifetime:

- `chrome.storage.session`: `roomCode`, `joinToken`, `memberToken`, `memberId`, `roomState`
- `chrome.storage.local`: `displayName`, `serverUrl`

Practical consequences:

- browser restart does not restore the previous room automatically
- the custom server URL survives browser restart
- room session state and profile preferences are persisted independently, so a room-state write cannot leave `serverUrl` or `displayName` half-updated
- the popup can reconnect into the current room only while the browser session still holds both `roomCode` and `joinToken`
- `memberToken` is intentionally cleared on disconnect and re-issued after a successful rejoin
- if the persisted server URL becomes invalid, the extension keeps that value visible and stops auto reconnect until the URL is fixed
- closing the browser does not restore the previous room automatically on the next launch

### Server Deployment

Recommended setup:

- Node.js 22 (see `.nvmrc`)
- Redis
- Nginx reverse proxy
- `wss://` server URL for production

The extension supports changing the server URL from the popup, so you can switch from local development to a deployed server such as:

```text
wss://sync.example.com
```

Only `ws://` and `wss://` server URLs are accepted. Empty input falls back to the build's embedded default. When `BILI_SYNCPLAY_DEFAULT_SERVER_URL` is unset, that default remains `ws://localhost:8787`.

If you want the Chrome Web Store build to ship with a public server URL while keeping the repository default at `ws://localhost:8787`, set `BILI_SYNCPLAY_DEFAULT_SERVER_URL` when building the extension. For example in PowerShell:

```powershell
$env:BILI_SYNCPLAY_DEFAULT_SERVER_URL="wss://sync.example.com"
npm run build:release
```

When the environment variable is unset, the build output still uses `ws://localhost:8787`. When it is set, clearing the server URL in the popup and saving also falls back to that injected value.

For local unpacked-extension development, `ALLOWED_ORIGINS` must include the current `chrome-extension://<extension-id>` or the server will reject the WebSocket handshake with `origin_not_allowed`.

The server now also supports an optional JSON config file. Resolution order is:

- built-in defaults
- `server.config.json` in the current working directory, or the path from `BILI_SYNCPLAY_CONFIG`
- environment variables

This keeps the existing env-only startup flow fully compatible while allowing production deployments to move shared non-secret settings into a file.

Example `server.config.json`:

```json
{
  "port": 8787,
  "globalAdminPort": 8788,
  "security": {
    "allowedOrigins": [
      "chrome-extension://<extension-id>",
      "https://sync.example.com"
    ],
    "trustedProxyAddresses": ["127.0.0.1", "10.0.0.10"]
  },
  "persistence": {
    "provider": "redis",
    "runtimeStoreProvider": "redis",
    "roomEventBusProvider": "redis",
    "adminCommandBusProvider": "redis",
    "nodeHeartbeatEnabled": true,
    "redisUrl": "redis://127.0.0.1:6379"
  },
  "adminUi": {
    "enabled": false
  }
}
```

Sensitive admin secrets remain env-only:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_SESSION_SECRET`

The current server implementation:

- listens on `PORT` or `server.config.json#port`, defaulting to `8787`
- serves WebSocket traffic and a simple health check on the same port
- returns `{"ok":true,"service":"bili-syncplay-server"}` on `GET /`
- exposes the admin control panel and APIs on the same port: `/admin`, `/healthz`, `/readyz`, `/api/admin/*`
- supports `memory` and `redis` room storage providers
- persists room base state when `ROOM_STORE_PROVIDER=redis`
- requires `roomCode + joinToken` for room join and `memberToken` for room messages
- reissues `memberToken` after reconnect or server restart
- keeps empty rooms until `EMPTY_ROOM_TTL_MS` expires instead of deleting them immediately
- supports origin allowlists, connection throttling, message throttling, and structured security logs

### Multi-Node Deployment and Global Admin

The server now supports a full multi-node topology with shared admin sessions, shared event and audit streams, shared runtime indexes, cross-node room-state fanout, cross-node admin commands, and a dedicated global admin entrypoint.

#### Core model

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

#### Minimum required shared settings

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

#### Node role configuration matrix

| Role           | Typical process                     | External responsibility                                                           | Must be unique                                     | Must stay aligned                                                         | Recommended value / note               |
| -------------- | ----------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| `room-node`    | `server/dist/index.js`              | WebSocket, `/`, `/healthz`, `/readyz`                                             | `INSTANCE_ID`, bind address / port                 | `REDIS_URL`, shared `*_PROVIDER` values, security and rate-limit settings | `GLOBAL_ADMIN_ENABLED=false`           |
| `global-admin` | `server/dist/global-admin-index.js` | `/admin`, `/api/admin/*`                                                          | `INSTANCE_ID`, `GLOBAL_ADMIN_PORT`                 | `REDIS_URL`, admin auth settings, shared provider settings                | `GLOBAL_ADMIN_ENABLED=true`            |
| `edge`         | `nginx` / `haproxy` / cloud LB      | TLS termination, single public entrypoint, reverse proxy, connection distribution | public hostname, certificate, upstream definitions | backend node list                                                         | end users connect only to the edge URL |
| `redis`        | `redis-server`                      | shared persistence, runtime indexes, buses                                        | instance address, password, ACL                    | every node must point to the same Redis                                   | production should keep it private      |

#### Which settings must match and which must differ

##### Shared across nodes

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

##### Unique per node

Settings that must differ per process or by role:

- `INSTANCE_ID`: every process must use a unique value such as `room-node-a`, `room-node-b`, or `global-admin`
- `PORT`: used by each room node
- `GLOBAL_ADMIN_PORT`: used only by `global-admin`
- `GLOBAL_ADMIN_ENABLED`: `false` on room nodes, `true` on the dedicated admin process
- bind addresses, firewall rules, systemd unit names, and log paths

#### Two-server deployment example

If you currently have only two machines, a practical rollout looks like this:

- server 1: `Nginx + Redis + room-node-a + global-admin`
- server 2: `room-node-b`

##### Port layout

Suggested port layout:

| Machine  | Role           | Suggested bind                      | Publicly exposed | Notes                    |
| -------- | -------------- | ----------------------------------- | ---------------- | ------------------------ |
| server 1 | `nginx`        | `80/443`                            | yes              | single public entrypoint |
| server 1 | `room-node-a`  | `127.0.0.1:8787` or private IP      | no               | proxied by the edge      |
| server 1 | `global-admin` | `127.0.0.1:8788` or private IP      | no               | proxied by the edge      |
| server 1 | `redis`        | `127.0.0.1:6379` or private IP      | no               | allow only node access   |
| server 2 | `room-node-b`  | private IP such as `10.0.0.12:8787` | no               | proxied by server 1 edge |

##### Environment examples

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

##### Weighting advice

If the edge machine also carries `room-node-a`, `global-admin`, and `redis`, it will usually absorb more network and CPU pressure than the other nodes. In that case, prefer `least_conn` at the edge and consider giving the remote room node a higher weight rather than splitting long-lived WebSocket traffic 1:1.

Redis key families used by the multi-node control plane:

- `bsp:room:*`, `bsp:room-index`, `bsp:room-expiry`: persisted room base state
- `bsp:runtime:*`: shared sessions, room members, blocked member tokens, and node heartbeats
- `bsp:admin:session:*`: shared admin bearer sessions
- `bsp:events`: runtime event stream
- `bsp:audit-logs`: admin audit stream
- `bsp:room-events`: room event bus channel
- `bsp:admin-command:*`, `bsp:admin-command-result:*`: admin command channels

### Security Environment Variables

The server accepts the following environment variables. Safe defaults are built in, but production should set them explicitly:

- `BILI_SYNCPLAY_CONFIG`: optional path to a JSON config file; when unset, the server looks for `server.config.json` in the current working directory
- `ALLOWED_ORIGINS`: comma-separated WebSocket `Origin` allowlist
- if `ALLOWED_ORIGINS` is empty, the server rejects all explicit `Origin` values by default
- `ALLOW_MISSING_ORIGIN_IN_DEV`: allow missing `Origin` headers when set to `true`
- `TRUSTED_PROXY_ADDRESSES`: comma-separated proxy socket IP allowlist; only requests arriving from these proxies can use `X-Forwarded-For`
- `MAX_CONNECTIONS_PER_IP`: max concurrent WebSocket connections per IP
- `CONNECTION_ATTEMPTS_PER_MINUTE`: max handshake attempts per IP per minute
- `MAX_MEMBERS_PER_ROOM`: room member cap
- `MAX_MESSAGE_BYTES`: WebSocket message size cap in bytes
- `INVALID_MESSAGE_CLOSE_THRESHOLD`: number of invalid messages before disconnect
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

### Admin API

The server now includes a P0 admin backend on the same HTTP port.

Admin control panel:

- open `http://localhost:8787/admin`
- authenticate with the account configured by `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`, and `ADMIN_ROLE`
- the UI covers login, overview, rooms, room detail, events, audit logs, config summary, and the existing admin actions

Role model:

- `viewer`: read-only access to overview, rooms, events, audit logs, and config
- `operator`: viewer permissions plus room/session actions
- `admin`: currently equivalent to operator, with headroom for future governance features

Action behavior notes:

- `kick member` disconnects the current member session and temporarily blocks immediate auto rejoin attempts that reuse the old `memberToken`
- `disconnect session` only closes the specified socket; if the client still holds valid room context, it may join again normally

Implemented endpoints:

- `GET /metrics`
- `GET /healthz`
- `GET /readyz`
- `POST /api/admin/auth/login`
- `POST /api/admin/auth/logout`
- `GET /api/admin/me`
- `GET /api/admin/overview`
- `GET /api/admin/config`
- `GET /api/admin/rooms`
- `GET /api/admin/rooms/:roomCode`
- `GET /api/admin/events`
- `GET /api/admin/audit-logs`
- `POST /api/admin/rooms/:roomCode/close`
- `POST /api/admin/rooms/:roomCode/expire`
- `POST /api/admin/rooms/:roomCode/clear-video`
- `POST /api/admin/rooms/:roomCode/members/:memberId/kick`
- `POST /api/admin/sessions/:sessionId/disconnect`

Authentication model:

- management APIs use `Authorization: Bearer <token>`
- login returns a server-issued session token
- `ADMIN_ROLE` controls the single configured admin account role: `viewer`, `operator`, or `admin`
- `INSTANCE_ID` controls the current server instance identifier, used by overview, room detail, and audit logs
- write actions require `operator` or higher
- if admin environment variables are not configured, admin auth endpoints return unavailable / unauthorized responses

### 1. Prepare the server

Example environment:

- Ubuntu 24.04 LTS
- domain: `sync.example.com`
- app directory: `/opt/bili-syncplay`
- service user: `bili-syncplay`
- internal port: `8787`

Install Node.js 22, Redis, and Nginx first, then clone the repository:

```bash
sudo mkdir -p /opt/bili-syncplay
sudo chown "$USER":"$USER" /opt/bili-syncplay
git clone https://github.com/<your-org>/Bili-SyncPlay.git /opt/bili-syncplay
cd /opt/bili-syncplay
npm install
npm run build
```

Why `npm run build` is recommended for first deployment:

- it builds `packages/protocol`, which is required by the server at runtime
- it avoids partial workspace builds that leave `server` pointing at missing protocol artifacts

If you only want to build the server package:

```bash
npm run build -w @bili-syncplay/server
```

Use that command only when `packages/protocol` is already built and unchanged.

### 2. Run the Node.js server

The production entry file is:

```text
server/dist/index.js
```

You can start it manually first to verify the build:

```bash
cd /opt/bili-syncplay
PORT=8787 ROOM_STORE_PROVIDER=memory node server/dist/index.js
```

If you plan to use Redis-backed room persistence, verify Redis connectivity first:

```bash
redis-cli -u redis://127.0.0.1:6379 ping
```

Expected response:

```text
PONG
```

Expected startup log:

```text
Bili-SyncPlay server listening on http://localhost:8787
```

Verify the local health check in another shell:

```bash
curl http://127.0.0.1:8787/
```

Expected response:

```json
{ "ok": true, "service": "bili-syncplay-server" }
```

### 3. Create systemd services

Create a dedicated user:

```bash
sudo useradd --system --home /opt/bili-syncplay --shell /usr/sbin/nologin bili-syncplay
sudo chown -R bili-syncplay:bili-syncplay /opt/bili-syncplay
```

Create `/etc/systemd/system/bili-syncplay-room-node-a.service`:

```ini
[Unit]
Description=Bili-SyncPlay room node A
After=network.target

[Service]
Type=simple
User=bili-syncplay
Group=bili-syncplay
WorkingDirectory=/opt/bili-syncplay
Environment=BILI_SYNCPLAY_CONFIG=/etc/bili-syncplay/server.config.json
Environment=PORT=8787
Environment=INSTANCE_ID=room-node-a
Environment=REDIS_URL=redis://127.0.0.1:6379
Environment=ROOM_STORE_PROVIDER=redis
Environment=ADMIN_SESSION_STORE_PROVIDER=redis
Environment=ADMIN_EVENT_STORE_PROVIDER=redis
Environment=ADMIN_AUDIT_STORE_PROVIDER=redis
Environment=RUNTIME_STORE_PROVIDER=redis
Environment=ROOM_EVENT_BUS_PROVIDER=redis
Environment=ADMIN_COMMAND_BUS_PROVIDER=redis
Environment=NODE_HEARTBEAT_ENABLED=true
Environment=GLOBAL_ADMIN_ENABLED=false
Environment=ADMIN_USERNAME=admin
Environment=ADMIN_PASSWORD_HASH=sha256:<hex-password-hash>
Environment=ADMIN_SESSION_SECRET=<random-secret>
ExecStart=/usr/bin/node /opt/bili-syncplay/server/dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/bili-syncplay-global-admin.service`:

```ini
[Unit]
Description=Bili-SyncPlay global admin
After=network.target

[Service]
Type=simple
User=bili-syncplay
Group=bili-syncplay
WorkingDirectory=/opt/bili-syncplay
Environment=BILI_SYNCPLAY_CONFIG=/etc/bili-syncplay/server.config.json
Environment=GLOBAL_ADMIN_PORT=8788
Environment=INSTANCE_ID=global-admin
Environment=REDIS_URL=redis://127.0.0.1:6379
Environment=ROOM_STORE_PROVIDER=redis
Environment=ADMIN_SESSION_STORE_PROVIDER=redis
Environment=ADMIN_EVENT_STORE_PROVIDER=redis
Environment=ADMIN_AUDIT_STORE_PROVIDER=redis
Environment=RUNTIME_STORE_PROVIDER=redis
Environment=ROOM_EVENT_BUS_PROVIDER=redis
Environment=ADMIN_COMMAND_BUS_PROVIDER=redis
Environment=NODE_HEARTBEAT_ENABLED=true
Environment=GLOBAL_ADMIN_ENABLED=true
Environment=ADMIN_USERNAME=admin
Environment=ADMIN_PASSWORD_HASH=sha256:<hex-password-hash>
Environment=ADMIN_SESSION_SECRET=<random-secret>
ExecStart=/usr/bin/node /opt/bili-syncplay/server/dist/global-admin-index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Create `/etc/bili-syncplay/server.config.json` for shared non-secret settings:

```json
{
  "security": {
    "allowedOrigins": [
      "chrome-extension://<extension-id>",
      "https://sync.example.com"
    ],
    "trustedProxyAddresses": ["127.0.0.1", "10.0.0.10"]
  },
  "persistence": {
    "provider": "redis",
    "runtimeStoreProvider": "redis",
    "roomEventBusProvider": "redis",
    "adminCommandBusProvider": "redis",
    "nodeHeartbeatEnabled": true,
    "redisUrl": "redis://127.0.0.1:6379",
    "emptyRoomTtlMs": 900000,
    "roomCleanupIntervalMs": 60000
  }
}
```

Enable and start them:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bili-syncplay-room-node-a
sudo systemctl enable --now bili-syncplay-global-admin
sudo systemctl status bili-syncplay-room-node-a
sudo systemctl status bili-syncplay-global-admin
```

View logs:

```bash
sudo journalctl -u bili-syncplay-room-node-a -f
sudo journalctl -u bili-syncplay-global-admin -f
```

### 4. Put Nginx in front of the WebSocket server

The following section starts with a single-node example, then shows a multi-node upstream example. Use the single-node example for local development or one-node production. Use the multi-node example once you enable the full shared Redis-backed topology.

> Recommendation
> WebSocket traffic is long-lived. For multi-node entrypoints, prefer `least_conn` first and plain round-robin second. Keep sticky only as an operational fallback during rollout, not as a correctness requirement.

#### Single-node example

Create `/etc/nginx/sites-available/bili-syncplay.conf`:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

limit_conn_zone $binary_remote_addr zone=conn_per_ip:10m;
limit_req_zone $binary_remote_addr zone=req_per_ip:10m rate=20r/m;
limit_req_zone $binary_remote_addr zone=admin_req_per_ip:10m rate=5r/s;

server {
    listen 80;
    server_name sync.example.com;

    location ^~ /admin {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ^~ /api/admin/ {
        limit_req zone=admin_req_per_ip burst=20 nodelay;
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        limit_conn conn_per_ip 10;
        limit_req zone=req_per_ip burst=10 nodelay;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600;
    }
}
```

Keep the stricter request-rate limit on the default WebSocket entrypoint, but do not reuse it for `/admin` and `/api/admin/*`. The admin UI issues several parallel requests on load and during actions, and the server already enforces its own auth and room-level rate limits.

#### Multi-node upstream example

If the entrypoint machine should distribute WebSocket connections across multiple room nodes, switch to an upstream configuration. The example below uses `least_conn`, which is usually a better fit than plain round-robin for long-lived WebSocket connections:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

limit_conn_zone $binary_remote_addr zone=conn_per_ip:10m;
limit_req_zone $binary_remote_addr zone=req_per_ip:10m rate=20r/m;
limit_req_zone $binary_remote_addr zone=admin_req_per_ip:10m rate=5r/s;

upstream bili_syncplay_ws {
    least_conn;
    server 127.0.0.1:8787;
    server 10.0.0.12:8787;
}

upstream bili_syncplay_admin {
    server 127.0.0.1:8788;
}

server {
    listen 80;
    server_name sync.example.com;

    location ^~ /admin {
        proxy_pass http://bili_syncplay_admin;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ^~ /api/admin/ {
        limit_req zone=admin_req_per_ip burst=20 nodelay;
        proxy_pass http://bili_syncplay_admin;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        limit_conn conn_per_ip 10;
        limit_req zone=req_per_ip burst=10 nodelay;
        proxy_pass http://bili_syncplay_ws;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600;
    }
}
```

In this topology:

- end users connect only to `wss://sync.example.com`
- the edge entrypoint chooses a room node for each new WebSocket connection
- once established, a WebSocket connection stays on the selected node
- the recommended production setup still keeps `/admin` and `/api/admin/*` on a dedicated `global-admin` process
- when all Redis-backed sharing is enabled, room-state correctness no longer depends on sticky routing, though keeping a sticky fallback during initial rollout can still be useful operationally

Enable the site and validate config:

```bash
sudo ln -s /etc/nginx/sites-available/bili-syncplay.conf /etc/nginx/sites-enabled/bili-syncplay.conf
sudo nginx -t
sudo systemctl reload nginx
```

### 5. Enable TLS

WebSocket service for the extension should use `wss://` in production. A common setup is Certbot with Nginx:

```bash
sudo certbot --nginx -d sync.example.com
```

After the certificate is issued, verify:

```bash
curl https://sync.example.com/
```

The extension should then use:

```text
wss://sync.example.com
```

### 6. Update the extension server URL

The extension supports switching server address from the popup, so for production you can point clients at:

```text
wss://sync.example.com
```

For local testing, switch back to:

```text
ws://localhost:8787
```

Room invites are now shared as `roomCode:joinToken`. The popup copy action copies that invite string, and the join field accepts the same format.

### 7. Deploy updates

When you update the server code, pull and rebuild from the application directory first:

```bash
cd /opt/bili-syncplay
git pull
npm install
npm run build
```

If you know only `server/` changed and `packages/protocol` is unchanged, you can rebuild only the server package:

```bash
npm run build -w @bili-syncplay/server
```

Single-node / single-process restart flow:

```bash
sudo systemctl restart bili-syncplay
```

Multi-node restart flow:

```bash
sudo systemctl restart bili-syncplay-room-node-a
sudo systemctl restart bili-syncplay-room-node-b
sudo systemctl restart bili-syncplay-global-admin
```

If you run multiple room nodes, prefer a rolling restart instead of restarting everything at once:

1. restart one room node
2. verify `GET /readyz`, logs, and the global admin overview recover cleanly
3. continue with the next room node
4. restart `global-admin` last

### 8. Operational notes

- With `ROOM_STORE_PROVIDER=memory`, restarting the process still clears all rooms.
- With `ROOM_STORE_PROVIDER=redis`, room base state survives restart until it expires or is deleted.
- Rooms are not deleted immediately when the last member leaves; the server writes `expiresAt` and retains the room until `EMPTY_ROOM_TTL_MS` elapses.
- Room join requires both `roomCode` and `joinToken`; room messages require a valid `memberToken`.
- `memberToken` is session-bound, never restored from persistence, and is re-issued after reconnect or restart.
- Handshake origin checks are deny-by-default unless you explicitly allow missing `Origin` in development.
- `X-Forwarded-For` is ignored unless the socket peer matches `TRUSTED_PROXY_ADDRESSES`.
- Health checks are available on both `GET /` and `GET /healthz`; readiness is `GET /readyz`.
- If you use a cloud firewall, allow inbound `80` and `443`, but keep `8787` private to localhost.
- If you do not want Nginx, you can expose Node directly, but browsers and extensions should still connect over `wss://` with a valid TLS certificate.
- With the Redis-backed providers enabled, persisted room base state, admin sessions, runtime indexes, room-state fanout, and admin command routing are shared across server instances.
- A dedicated global admin process is the recommended production entrypoint for `/admin` and `/api/admin/*`.
- Room nodes can keep `GLOBAL_ADMIN_ENABLED=false` so they expose only WebSocket traffic plus `/`, `/healthz`, and `/readyz`.
- When all Redis-backed providers are enabled, multi-instance deployment no longer depends on sticky routing for room-state correctness.

### Troubleshooting

Common developer-facing failure cases:

- `Cannot connect to sync server.`: the extension could not reach the configured server URL, or the HTTP health probe derived from that URL failed.
- repeated server logs with `origin_not_allowed`: `ALLOWED_ORIGINS` does not include the current `chrome-extension://<extension-id>`
- `Room not found.`: the requested room code does not exist on the current server instance.
- `Room not found.` after a restart can also mean the room expired during the empty-room retention window.
- `Join token is invalid.`: the invite string is wrong, stale, or from another room.
- `Member token is invalid.`: the current session lost its room binding, the server restarted, or the client must rejoin to obtain a fresh token.
- `Too many requests.`: a room action or sync message hit the configured rate limit.
- handshake rejected with `403`: the request `Origin` is not in `ALLOWED_ORIGINS`, or `Origin` is missing while `ALLOW_MISSING_ORIGIN_IN_DEV` is disabled.
- connection-level IP limits appear ineffective: verify whether the reverse proxy socket IP is included in `TRUSTED_PROXY_ADDRESSES`; by default the server uses the real socket address only.
- `Please open a Bilibili video page first.`: the active tab URL does not match the extension content-script targets.
- `Current page does not have a playable video.`: the content script loaded, but the page did not expose a usable video payload.
- `Cannot access the current page.`: Chrome could not deliver the message to the content script, often because the page was not reloaded after loading the unpacked extension or the tab is on an unsupported URL.

Useful checks:

```bash
# Server health check
curl http://127.0.0.1:8787/

# Server tests
npm run test -w @bili-syncplay/server

# Redis integration regression
REDIS_URL=redis://127.0.0.1:6379 npm run test:redis -w @bili-syncplay/server

# Full multi-node regression
REDIS_URL=redis://127.0.0.1:6379 npx tsx --test server/test/multi-node-*.test.ts

# Protocol tests
npm run test -w @bili-syncplay/protocol

# Extension tests
npm run test -w @bili-syncplay/extension
```

Chrome-side debugging tips:

- check the extension service worker logs from `chrome://extensions`
- copy the unpacked extension ID from `chrome://extensions` and use it in `ALLOWED_ORIGINS`
- reload the unpacked extension after rebuilding `extension/dist`
- reload open Bilibili tabs after the extension is reloaded so content scripts are injected again

### Build a Release Package

Update the workspace version first:

```bash
npm run release:version -- 0.9.0
```

This command updates:

- the root `package.json`
- `packages/protocol/package.json`
- `server/package.json`
- `extension/package.json`
- `package-lock.json`

Build the extension release zip:

```bash
npm run build:release
```

Output:

```text
release/bili-syncplay-extension-v<version>.zip
```

### Automated GitHub Release

The repository already includes a GitHub Actions workflow that:

- triggers on `v*` tags
- builds the extension
- creates a GitHub Release
- uploads the zip asset

Example:

```bash
npm run release:version -- 0.9.0
git push origin main
git tag v0.9.0
git push origin v0.9.0
```

## License

This project is licensed under the GNU General Public License v3.0. See [LICENSE](./LICENSE).
