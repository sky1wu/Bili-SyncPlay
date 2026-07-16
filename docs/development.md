# Development Guide

[English](./development.md) | [简体中文](./development.zh-CN.md)

Developer reference for Bili-SyncPlay: local commands, dependency audit gate, benchmarks, code organization, contribution constraints, runtime behavior, state persistence, troubleshooting, and release packaging. For the project overview and quick start, see the [README](../README.md).

## Local Development

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
- `npm test`: run audit gate tests plus repository-wide protocol, server, and extension tests
- `npm run audit`: run the dependency audit gate, failing on unallowlisted `high` or `critical` vulnerabilities
- `npm run test:audit-gate`: run unit tests for the dependency audit gate
- `npm run test:server:redis`: run the explicit Redis regression entry point for server persistence (requires `REDIS_URL`; CI runs it in a dedicated job with a Redis service container)

Development constraints:

- Keep entry files thin and keep shared rules in a single source of truth.
- Install dependencies with `npm install` before running local checks; use `npm ci` in CI before the same verification flow.
- Run `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build`, and `npm test` before committing changes.
- See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full contribution and refactoring constraints.

## Dependency Audit Gate

CI runs `npm run audit` after `npm ci`. The gate executes `npm audit --json --audit-level=high` and fails when any `high` or `critical` vulnerability is not covered by an active entry in [`audit-allowlist.json`](../audit-allowlist.json).

When a high-severity audit finding appears:

1. Prefer updating or replacing the vulnerable dependency and commit the resulting lockfile change.
2. If a fix is not available yet and the risk has been reviewed, add a short-term allowlist entry using the ID printed by the audit gate:

```json
{
  "id": "npm:<package>:<advisory-source>",
  "expires": "YYYY-MM-DD",
  "reason": "Why this is accepted temporarily and how it will be removed"
}
```

3. Keep the expiry date short. Expired, malformed, or missing-expiry entries fail the gate automatically.
4. Remove the allowlist entry in the same change that fixes or removes the vulnerable dependency.

## Benchmark Baselines

Reproducible benchmark entry points live under `bench/`, covering the main high-load scenarios.

Commands:

```bash
npm run bench:single-room
npm run bench:redis-broadcast
npm run bench:reconnect-storm
npm run bench:ci-light
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
- `bench:ci-light`: CI-focused smoke baseline covering a small single-node playback run plus a small reconnect storm run

CI baseline behavior:

- `bench:ci-light` reads `bench/ci-light-baseline.json`, runs the lightweight scenarios, and writes `results.json`, `comparison.json`, and `summary.md`.
- The CI job fails only on obvious regressions: error rate above the configured limit or `P95` latency above the configured baseline multiplier.
- `.github/workflows/ci.yml` uploads the benchmark output as an artifact so PRs keep the raw numbers for inspection.

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

## Code Organization

The repository follows a "thin entrypoint + named modules" structure. For the runtime view — system parts, sync data flow, and controller responsibilities — see the [architecture overview](./architecture.md).

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

Regression coverage is intentionally aligned with those boundaries and includes store/controller/helper coverage, not only end-to-end behavior checks.

## Contribution Constraints

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
- reconnecting into an existing room requires the stored `joinToken`; the cached `memberToken` is sent along on automatic reconnect and is discarded only on explicit leave or an admin-initiated session teardown
- if you change protocol types or message validation, rebuild both `packages/protocol` and `server`
- the local server rejects extension connections unless `ALLOWED_ORIGINS` includes the current `chrome-extension://<extension-id>`
- you can find the unpacked extension ID on `chrome://extensions`

The extension version shown by Chrome comes from `extension/dist/manifest.json`.
During build, that manifest version is generated automatically from the root `package.json`.

## Runtime Behavior

- if the user clicks `Sync current page video` before joining a room, the extension prompts to create a room first
- if the room is already sharing a different video, the popup asks for confirmation before replacing it
- the background service worker only forwards playback updates from the currently recognized shared tab
- switching the server URL disconnects the current socket and reconnects using the new address if the extension still has an active room or pending room creation
- invalid persisted server URLs remain visible in extension state and block automatic reconnect until corrected
- supported playback pages depend on Bilibili DOM and URL patterns, so festival pages and watch-later pages may need future compatibility updates if Bilibili changes them

## State Persistence

The extension intentionally splits persistent state by lifetime:

- `chrome.storage.session`: `roomCode`, `joinToken`, `memberToken`, `memberId`, `roomState`
- `chrome.storage.local`: `displayName`, `serverUrl`

Practical consequences:

- browser restart does not restore the previous room automatically
- the custom server URL survives browser restart
- room session state and profile preferences are persisted independently, so a room-state write cannot leave `serverUrl` or `displayName` half-updated
- the popup can reconnect into the current room only while the browser session still holds both `roomCode` and `joinToken`
- `memberToken` is kept across automatic reconnects and presented on rejoin; it is cleared on explicit leave or an admin-initiated session teardown, after which the next join receives a fresh token
- if the persisted server URL becomes invalid, the extension keeps that value visible and stops auto reconnect until the URL is fixed
- closing the browser does not restore the previous room automatically on the next launch

## Troubleshooting

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

## Build a Release Package

Update the workspace version first:

```bash
npm run release:version -- 1.3.0
```

This command updates:

- the root `package.json`
- `packages/protocol/package.json`
- `packages/admin-ui/package.json`
- `server/package.json`
- `extension/package.json`
- `package-lock.json`

The rewritten JSON and manifest files may not match Prettier style, so run `npm run format:check` (and `npm run format` if needed) before committing the version bump.

Build the extension release packages:

```bash
npm run build:release          # Chrome/Edge + Firefox
npm run build:release:chrome   # Chrome/Edge zip only
npm run build:release:firefox  # Firefox zip + xpi only
```

Output:

```text
release/bili-syncplay-extension-v<version>-chrome.zip
release/bili-syncplay-extension-v<version>-firefox.zip
release/bili-syncplay-extension-v<version>-firefox.xpi
```

The `.xpi` is a byte-for-byte copy of the Firefox zip so Firefox users can install it by drag-and-drop.

## Automated GitHub Release

Two GitHub Actions workflows trigger on `v*` tags:

- `release.yml` builds both browser targets and creates a GitHub Release with the Chrome/Edge zip and the Firefox zip + xpi attached
- `docker-release.yml` builds the server container image and pushes it to GHCR (`ghcr.io/sky1wu/bili-syncplay-server`); it also pushes to Docker Hub when the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repository secrets are configured, and skips that push otherwise without failing the release

Example:

```bash
npm run release:version -- 1.3.0
git push origin main
git tag v1.3.0
git push origin v1.3.0
```
