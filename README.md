# Bili-SyncPlay

[English](./README.md) | [简体中文](./README.zh-CN.md)

Bili-SyncPlay is a Chrome extension for synchronized Bilibili watching. Users can create or join a room, share the current video, and keep playback, pause, seek, and playback rate in sync across participants.

This repository is a monorepo with:
- a Chrome extension
- a WebSocket room server
- a shared protocol package

## Features

- Create a room and get an invite string
- Join a room with `roomCode:joinToken`
- Share the current page video from the popup
- Sync play, pause, seek, and playback rate
- Automatically open the currently shared video for room members
- Show in-page room toasts for:
  - member join and leave
  - shared video changes
  - play and pause
  - seek
  - playback rate changes
- Keep non-shared pages local-only while staying in a room
  - non-shared pages do not broadcast playback back to the room
  - manual playback on a non-shared page stays local
- Support multiple Bilibili page types:
  - `https://www.bilibili.com/video/*`
  - `https://www.bilibili.com/bangumi/play/*`
  - `https://www.bilibili.com/festival/*`
  - `https://www.bilibili.com/list/watchlater*` when the page URL carries `bvid`
  - `https://www.bilibili.com/medialist/play/watchlater*` when the page URL carries `bvid`
- Support per-part / per-episode variants:
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

## Quick Start

### Load the Extension

1. Run `npm install`
2. Run `npm run build`
3. Open `chrome://extensions`
4. Enable Developer mode
5. Click `Load unpacked`
6. Select `extension/dist`

### Start the Local Server

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

Default server URL:

```text
ws://localhost:8787
```

### Basic Usage

1. Open the extension popup
2. Create a room or join an existing room with an invite string
3. Open a supported Bilibili video page
4. Click `Sync current page video` in the popup
5. Other room members will open the same video and enter sync mode
6. If a member browses to a different non-shared video while still in the room, that page stays local and does not affect the room unless they explicitly sync it

### Open the Admin Control Panel

To use the management UI locally, start the server with admin auth configured and then open:

```text
http://localhost:8787/admin
```

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
- the popup can reconnect into the current room only while the browser session still holds both `roomCode` and `joinToken`
- `memberToken` is intentionally cleared on disconnect and re-issued after a successful rejoin
- if the persisted server URL becomes invalid, the extension keeps that value visible and stops auto reconnect until the URL is fixed
- closing the browser does not restore the previous room automatically on the next launch

### Server Deployment

Recommended setup:
- Node.js 20 or 22
- Redis
- Nginx reverse proxy
- `wss://` server URL for production

The extension supports changing the server URL from the popup, so you can switch from local development to a deployed server such as:

```text
wss://sync.example.com
```

Only `ws://` and `wss://` server URLs are accepted. Empty input falls back to `ws://localhost:8787`.

For local unpacked-extension development, `ALLOWED_ORIGINS` must include the current `chrome-extension://<extension-id>` or the server will reject the WebSocket handshake with `origin_not_allowed`.

The current server implementation:
- listens on `PORT` only, defaulting to `8787`
- serves WebSocket traffic and a simple health check on the same port
- returns `{"ok":true,"service":"bili-syncplay-server"}` on `GET /`
- exposes the admin control panel and APIs on the same port: `/admin`, `/healthz`, `/readyz`, `/api/admin/*`
- supports `memory` and `redis` room storage providers
- persists room base state when `ROOM_STORE_PROVIDER=redis`
- requires `roomCode + joinToken` for room join and `memberToken` for room messages
- reissues `memberToken` after reconnect or server restart
- keeps empty rooms until `EMPTY_ROOM_TTL_MS` expires instead of deleting them immediately
- supports origin allowlists, connection throttling, message throttling, and structured security logs

### Security Environment Variables

The server accepts the following environment variables. Safe defaults are built in, but production should set them explicitly:

- `ALLOWED_ORIGINS`: comma-separated WebSocket `Origin` allowlist
- if `ALLOWED_ORIGINS` is empty, the server rejects all explicit `Origin` values by default
- `ALLOW_MISSING_ORIGIN_IN_DEV`: allow missing `Origin` headers when set to `true`
- `TRUST_PROXY_HEADERS`: only when set to `true`, use `X-Forwarded-For` for connection-level IP limits
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
TRUST_PROXY_HEADERS=true \
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

Install Node.js 20 or 22, Redis, and Nginx first, then clone the repository:

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
{"ok":true,"service":"bili-syncplay-server"}
```

### 3. Create a systemd service

Create a dedicated user:

```bash
sudo useradd --system --home /opt/bili-syncplay --shell /usr/sbin/nologin bili-syncplay
sudo chown -R bili-syncplay:bili-syncplay /opt/bili-syncplay
```

Create `/etc/systemd/system/bili-syncplay.service`:

```ini
[Unit]
Description=Bili-SyncPlay WebSocket server
After=network.target

[Service]
Type=simple
User=bili-syncplay
Group=bili-syncplay
WorkingDirectory=/opt/bili-syncplay
Environment=PORT=8787
Environment=ALLOWED_ORIGINS=chrome-extension://<extension-id>,https://sync.example.com
Environment=ROOM_STORE_PROVIDER=redis
Environment=REDIS_URL=redis://127.0.0.1:6379
Environment=EMPTY_ROOM_TTL_MS=900000
Environment=ROOM_CLEANUP_INTERVAL_MS=60000
ExecStart=/usr/bin/node /opt/bili-syncplay/server/dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bili-syncplay
sudo systemctl status bili-syncplay
```

View logs:

```bash
sudo journalctl -u bili-syncplay -f
```

### 4. Put Nginx in front of the WebSocket server

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
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ^~ /api/admin/ {
        limit_req zone=admin_req_per_ip burst=20 nodelay;
        proxy_pass http://127.0.0.1:8787;
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

When you update the server code:

```bash
cd /opt/bili-syncplay
git pull
npm install
npm run build -w @bili-syncplay/server
sudo systemctl restart bili-syncplay
```

If the shared protocol package changed, rebuild both packages instead:

```bash
npm run build -w @bili-syncplay/protocol
npm run build -w @bili-syncplay/server
```

### 8. Operational notes

- With `ROOM_STORE_PROVIDER=memory`, restarting the process still clears all rooms.
- With `ROOM_STORE_PROVIDER=redis`, room base state survives restart until it expires or is deleted.
- Rooms are not deleted immediately when the last member leaves; the server writes `expiresAt` and retains the room until `EMPTY_ROOM_TTL_MS` elapses.
- Room join requires both `roomCode` and `joinToken`; room messages require a valid `memberToken`.
- `memberToken` is session-bound, never restored from persistence, and is re-issued after reconnect or restart.
- Handshake origin checks are deny-by-default unless you explicitly allow missing `Origin` in development.
- `X-Forwarded-For` is ignored unless `TRUST_PROXY_HEADERS=true`.
- Health checks are available on both `GET /` and `GET /healthz`; readiness is `GET /readyz`.
- If you use a cloud firewall, allow inbound `80` and `443`, but keep `8787` private to localhost.
- If you do not want Nginx, you can expose Node directly, but browsers and extensions should still connect over `wss://` with a valid TLS certificate.
- With `ROOM_STORE_PROVIDER=redis`, persisted room base state is shared across server instances.
- Online members, `memberToken` values, and real-time room-state fanout remain process-local session state.
- Multi-instance deployment still needs routing affinity or an added cross-instance broadcast mechanism to avoid incomplete member views and missed live updates.

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
- connection-level IP limits appear ineffective: verify whether you intended to enable `TRUST_PROXY_HEADERS`; by default the server uses the real socket address only.
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
npm run release:version -- 0.5.4
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
npm run release:version -- 0.5.4
git push origin main
git tag v0.5.4
git push origin v0.5.4
```

## License

This project is licensed under the GNU General Public License v3.0. See [LICENSE](/d:/workspace/Bili-SyncPlay/LICENSE).
