# Bili-SyncPlay

[English](./README.md) | [简体中文](./README.zh-CN.md)

Bili-SyncPlay is a browser extension (Chrome, Edge, Firefox) plus a WebSocket server for synchronized Bilibili watching. Users can create or join a room, share the current video, and keep playback, pause, seek, and playback rate in sync across participants.

It supports the full local workflow:

- load the unpacked extension in Chrome, Edge, or Firefox 121+
- run the local sync server
- create a room and share an invite string
- keep everyone on the same shared video in sync

This repository is a monorepo:

- `extension/`: browser extension (Chrome/Edge/Firefox)
- `server/`: WebSocket room server and admin panel
- `packages/protocol/`: shared protocol types

## At a Glance

- Invite format: `roomCode:joinToken`
- Default local server: `ws://localhost:8787`
- Supported browsers for development: Chrome, Edge, Firefox 121+
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

**Chrome / Edge** (`npm run build` produces `extension/dist`):

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select `extension/dist`

**Firefox 121+** (build the Firefox target first):

```bash
npm run build:extension:firefox   # produces extension/dist-firefox
```

1. Open `about:debugging#/runtime/this-firefox`
2. Click `Load Temporary Add-on…`
3. Select `extension/dist-firefox/manifest.json`

The Firefox build emits an event-page background (`background.scripts`, since Firefox does not support MV3 `background.service_worker`) and overrides the extension CSP so a plain `ws://` server is not auto-upgraded to `wss://`. The temporary add-on is removed when Firefox closes; reload it after each restart.

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

**Firefox origin note.** Firefox assigns each install a random `moz-extension://<uuid>` (it changes on reinstall and differs per user), so there is no single value that works for everyone like a fixed Chrome extension ID:

- Self-hosted / few users: read the UUID from `about:debugging` (the extension's Internal UUID / Manifest URL) or from the server's rejected-handshake log, then add that exact `moz-extension://<uuid>` to `ALLOWED_ORIGINS`. You must update it after reinstalling the add-on.
- Public / shared server: set `ALLOW_ANY_FIREFOX_EXTENSION_ORIGIN=true` to accept any well-formed `moz-extension://<uuid>` without enumerating UUIDs. It still rejects web-page origins and does not replace room/member-token auth (see the [security environment variable reference](./docs/reference/security-env.md)).

Firefox treats the extension background as a secure context, so non-localhost servers must use `wss://`; the Firefox build already overrides the extension CSP so `ws://localhost` is not force-upgraded during local development.

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
  extension/            Browser extension (Chrome/Edge/Firefox)
  server/               WebSocket room server
  packages/protocol/    Shared protocol types
  scripts/              Release packaging scripts
  docs/                 Operations, migration, and policy docs
  .github/workflows/    GitHub Actions workflows
```

## Documentation

- [Documentation index](./docs/README.md)
- [Architecture overview](./docs/architecture.md) — system parts, sync data flow, where new code belongs
- [Development guide](./docs/development.md) — local commands, tests, benchmarks, code organization, troubleshooting, release packaging
- [Server deployment guide](./docs/operations/deployment.md) — build, systemd, Nginx, TLS, update flow
- [Multi-node deployment and global admin](./docs/operations/multi-node.md)
- [Protocol reference](./docs/reference/protocol.md)
- [Security environment variables](./docs/reference/security-env.md)
- [Admin panel and API](./docs/reference/admin-api.md)
- [Multi-node operations runbook](./docs/runbook/multi-node-operations.md)
- [Multi-node global admin migration](./docs/operations/multi-node-global-admin-migration.md)
- [Privacy policy](./docs/legal/privacy.md)

## Requirements

### Version matrix

| Dependency    | Minimum                    | Recommended    | Notes                                                                                                |
| ------------- | -------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| Node.js       | 22.12                      | 22 LTS         | see `.nvmrc`; Node 18/20 are EOL, `npm run coverage` needs ≥22.5, and Vite 8 (admin-ui) needs ≥22.12 |
| npm           | 10                         | 10             | ships with the corresponding Node.js version                                                         |
| Chrome / Edge | current stable             | current stable | required to load the unpacked extension                                                              |
| Firefox       | 121                        | current stable | optional; uses the Firefox build (`dist-firefox`, event-page background)                             |
| Redis         | 6.0                        | 7+             | optional for single-node; **required** for multi-node deployments and persistence across restarts    |
| Reverse proxy | any with WebSocket support | Nginx 1.18+    | required in production for TLS termination and `wss://`                                              |

### Non-goals

- **No guaranteed multi-node consistency without Redis.** When `ROOM_STORE_PROVIDER=memory`, each server instance keeps its own room state. Members connected to different nodes will see different rooms.
- **No built-in load balancer.** Multi-node deployments depend on an external edge layer (Nginx, HAProxy, cloud SLB/ALB) for WebSocket connection distribution. The server does not implement L4/L7 balancing.
- **No browser session restoration after restart.** Room membership (`roomCode`, `joinToken`, `memberToken`) lives in `chrome.storage.session` and is cleared when the browser closes. Users must rejoin after a browser restart.
- **No multi-user accounts or authentication for end users.** Room access is controlled by `roomCode:joinToken` invite strings only. There is no user registration or login system for viewers.
- **No mobile browser or Safari support.** The extension is Manifest V3 for Chrome/Edge (service-worker background) and Firefox 121+ (event-page background); Safari and mobile browsers are out of scope.

## Local Defaults

- Default server URL: `ws://localhost:8787`
- Empty server URL input falls back to the build-time default
- Only `ws://` and `wss://` are accepted
- Local unpacked extension development requires `ALLOWED_ORIGINS=chrome-extension://<extension-id>` (Chrome/Edge) or the current `moz-extension://<uuid>` / `ALLOW_ANY_FIREFOX_EXTENSION_ORIGIN=true` (Firefox; see "Start the local server")

To open the admin control panel locally or in production, see [Admin Panel and API](./docs/reference/admin-api.md).

## Docker Deployment

The server is also published as a container image on every `v*` release tag:

- `ghcr.io/sky1wu/bili-syncplay-server` ([GHCR package page](https://github.com/sky1wu/Bili-SyncPlay/pkgs/container/bili-syncplay-server))
- `docker.io/sky1wu/bili-syncplay-server` ([Docker Hub page](https://hub.docker.com/r/sky1wu/bili-syncplay-server), mirror)

These are `docker pull` references, not web URLs — to browse in a browser, use the linked pages.

Image tags: `latest`, `<major>.<minor>`, and the full version (e.g. `1.2.2`). Both `linux/amd64` and `linux/arm64` are supported.

Run directly:

```bash
docker run -d --name bili-syncplay-server \
  -p 8787:8787 \
  -e ALLOWED_ORIGINS=chrome-extension://lbmckljnginagfabglpfdepofoglfdkj \
  ghcr.io/sky1wu/bili-syncplay-server:latest
```

Or use the repository's [`docker-compose.yml`](./docker-compose.yml), which includes an optional Redis service for multi-node / restart-persistent deployments.

Notes:

- The container listens on `8787` (override with `PORT`), exposes `/healthz` and `/readyz`, and ships a built-in Docker `HEALTHCHECK`.
- Configuration is entirely environment-variable based, identical to a bare-metal deployment: `ALLOWED_ORIGINS` (required for extensions to connect), Redis persistence (`ROOM_STORE_PROVIDER=redis` plus `REDIS_URL`; `REDIS_URL` alone keeps the in-memory store), admin panel variables (`ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` / `ADMIN_SESSION_SECRET`), and so on — see the [security environment variable reference](./docs/reference/security-env.md) and the [multi-node runbook](./docs/runbook/multi-node-operations.md).
- In production, terminate TLS at a reverse proxy so the extension connects over `wss://` (see the version matrix).
- Build locally from the repository root: `docker build -t bili-syncplay-server .` (the image contains only the server; the extension is distributed separately).

For maintainers: the `Docker Release` workflow pushes to GHCR automatically using the built-in `GITHUB_TOKEN`. To also publish to Docker Hub, configure the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets; when they are absent the Docker Hub push is skipped without failing the release.

## License

This project is licensed under the GNU General Public License v3.0. See [LICENSE](./LICENSE).
