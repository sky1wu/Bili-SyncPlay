# Admin Panel and API

[English](./admin-api.md) | [简体中文](./admin-api.zh-CN.md)

## Open the Admin Control Panel

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

## Admin API

The server includes a built-in admin backend served on the same HTTP port as the WebSocket service.

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

`GET /metrics` is served on the main service port by default and can be moved to a dedicated port with `METRICS_PORT`; setting `METRICS_TOKEN` additionally requires scrapes to send `Authorization: Bearer <token>` (see [Security Environment Variables](./security-env.md)).

Authentication model:

- management APIs use `Authorization: Bearer <token>`
- login returns a server-issued session token
- `ADMIN_ROLE` controls the single configured admin account role: `viewer`, `operator`, or `admin`
- `INSTANCE_ID` controls the current server instance identifier, used by overview, room detail, and audit logs
- write actions require `operator` or higher
- if admin environment variables are not configured, admin auth endpoints return unavailable / unauthorized responses
