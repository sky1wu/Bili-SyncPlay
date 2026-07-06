# Server Deployment Guide

[English](./deployment.md) | [简体中文](./deployment.zh-CN.md)

Production deployment for the Bili-SyncPlay server: build, systemd services, Nginx reverse proxy, TLS, update flow, and operational notes. Related references: [Multi-Node Deployment and Global Admin](./multi-node.md), [Security Environment Variables](../reference/security-env.md), [Admin Panel and API](../reference/admin-api.md), and [Troubleshooting](../development.md#troubleshooting).

## Recommended Setup and Server Configuration

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

## 1. Prepare the server

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

## 2. Run the Node.js server

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

## 3. Create systemd services

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

## 4. Put Nginx in front of the WebSocket server

The following section starts with a single-node example, then shows a multi-node upstream example. Use the single-node example for local development or one-node production. Use the multi-node example once you enable the full shared Redis-backed topology.

> Recommendation
> WebSocket traffic is long-lived. For multi-node entrypoints, prefer `least_conn` first and plain round-robin second. Keep sticky only as an operational fallback during rollout, not as a correctness requirement.

### Single-node example

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

### Multi-node upstream example

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

## 5. Enable TLS

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

## 6. Update the extension server URL

The extension supports switching server address from the popup, so for production you can point clients at:

```text
wss://sync.example.com
```

For local testing, switch back to:

```text
ws://localhost:8787
```

Room invites are now shared as `roomCode:joinToken`. The popup copy action copies that invite string, and the join field accepts the same format.

## 7. Deploy updates

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

## 8. Operational notes

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
