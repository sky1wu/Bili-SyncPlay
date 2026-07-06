# 服务器部署指南

[English](./deployment.md) | [简体中文](./deployment.zh-CN.md)

Bili-SyncPlay 服务端的生产部署流程：构建、systemd 服务、Nginx 反向代理、TLS、更新流程与运维说明。相关参考：[多节点部署与全局管理面](./multi-node.zh-CN.md)、[安全相关环境变量](../reference/security-env.zh-CN.md)、[管理面板与 API](../reference/admin-api.zh-CN.md)、[故障排查](../development.zh-CN.md#故障排查)。

## 推荐环境与服务端配置

推荐环境：

- Node.js 22（见 `.nvmrc`）
- Redis
- Nginx 反向代理
- 生产环境使用 `wss://` 服务器地址

扩展支持在弹窗中切换服务器地址，因此你可以从本地开发切换到已部署的服务器，例如：

```text
wss://sync.example.com
```

扩展的服务器地址只接受 `ws://` 和 `wss://`；空输入会回退到当前构建内置的默认值。未设置 `BILI_SYNCPLAY_DEFAULT_SERVER_URL` 时，该默认值是 `ws://localhost:8787`。

如果你希望 Chrome 应用商店提交包内置公共服务器地址、而 GitHub 源码继续保持 `ws://localhost:8787`，构建扩展时设置环境变量 `BILI_SYNCPLAY_DEFAULT_SERVER_URL` 即可，例如在 PowerShell 中：

```powershell
$env:BILI_SYNCPLAY_DEFAULT_SERVER_URL="wss://sync.example.com"
npm run build:release
```

不设置该环境变量时，构建产物仍然使用 `ws://localhost:8787`；设置后，用户在弹窗里清空服务器地址并保存，也会回退到这个构建时注入的地址。

本地开发时，`ALLOWED_ORIGINS` 必须包含当前 `chrome-extension://<extension-id>`，否则服务端会以 `origin_not_allowed` 拒绝 WebSocket 握手。

服务端支持可选的 JSON 配置文件。加载优先级为：

- 内置默认值
- 当前工作目录下的 `server.config.json`，或 `BILI_SYNCPLAY_CONFIG` 指定的文件
- 环境变量

这样可以在保持现有纯环境变量启动方式完全兼容的前提下，把生产环境里稳定的非敏感配置收敛到文件中。

`server.config.json` 示例：

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

以下管理后台敏感字段仍然只支持环境变量：

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_SESSION_SECRET`

当前服务器实现：

- 监听 `PORT` 或 `server.config.json` 中的 `port`，默认值为 `8787`
- 在同一个端口上同时提供 WebSocket 流量和简单健康检查
- 对 `GET /` 返回 `{"ok":true,"service":"bili-syncplay-server"}`
- 在同一个端口上暴露管理控制面板和后台接口：`/admin`、`/healthz`、`/readyz`、`/api/admin/*`
- 支持 `memory` 和 `redis` 两种房间存储实现
- 当 `ROOM_STORE_PROVIDER=redis` 时会持久化房间基础状态
- 房间加入需要 `roomCode + joinToken`，房间消息需要 `memberToken`
- 服务重连或服务端重启后会重新签发 `memberToken`
- 最后一名成员离开后，房间不会立即删除，而是保留到 `EMPTY_ROOM_TTL_MS` 到期
- 支持 Origin 白名单、连接限流、消息限流和结构化安全日志

## 1. 准备服务器

示例环境：

- Ubuntu 24.04 LTS
- 域名：`sync.example.com`
- 应用目录：`/opt/bili-syncplay`
- 服务用户：`bili-syncplay`
- 内部端口：`8787`

先安装 Node.js 22（见 `.nvmrc`）、Redis 和 Nginx，然后克隆仓库：

```bash
sudo mkdir -p /opt/bili-syncplay
sudo chown "$USER":"$USER" /opt/bili-syncplay
git clone https://github.com/<your-org>/Bili-SyncPlay.git /opt/bili-syncplay
cd /opt/bili-syncplay
npm install
npm run build
```

为什么首轮部署推荐使用 `npm run build`：

- 它会构建 `packages/protocol`，而这是服务器运行时所必需的
- 它可以避免只构建部分 workspace，导致 `server` 指向缺失的 protocol 产物

如果你只想构建服务器包：

```bash
npm run build -w @bili-syncplay/server
```

仅当 `packages/protocol` 已经构建且未变化时再使用这个命令。

## 2. 运行 Node.js 服务器

生产环境入口文件为：

```text
server/dist/index.js
```

你可以先手动启动它以验证构建结果：

```bash
cd /opt/bili-syncplay
PORT=8787 ROOM_STORE_PROVIDER=memory node server/dist/index.js
```

如果你准备使用 Redis 持久化房间状态，建议先验证 Redis 连通性：

```bash
redis-cli -u redis://127.0.0.1:6379 ping
```

预期响应：

```text
PONG
```

预期启动日志：

```text
Bili-SyncPlay server listening on http://localhost:8787
```

在另一个 shell 中验证本地健康检查：

```bash
curl http://127.0.0.1:8787/
```

预期响应：

```json
{ "ok": true, "service": "bili-syncplay-server" }
```

## 3. 创建 systemd 服务

创建独立用户：

```bash
sudo useradd --system --home /opt/bili-syncplay --shell /usr/sbin/nologin bili-syncplay
sudo chown -R bili-syncplay:bili-syncplay /opt/bili-syncplay
```

创建 `/etc/systemd/system/bili-syncplay-room-node-a.service`：

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

创建 `/etc/systemd/system/bili-syncplay-global-admin.service`：

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

把公共的非敏感配置写入 `/etc/bili-syncplay/server.config.json`：

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

启用并启动它们：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bili-syncplay-room-node-a
sudo systemctl enable --now bili-syncplay-global-admin
sudo systemctl status bili-syncplay-room-node-a
sudo systemctl status bili-syncplay-global-admin
```

查看日志：

```bash
sudo journalctl -u bili-syncplay-room-node-a -f
sudo journalctl -u bili-syncplay-global-admin -f
```

## 4. 在 WebSocket 服务器前配置 Nginx

下面先给出单机部署示例，再给出多节点 upstream 示例。单机示例适合本地或单节点生产；如果你已经启用完整多节点拓扑，应优先使用多节点示例。

> 建议
> WebSocket 是长连接场景。多节点入口优先考虑 `least_conn`，其次再考虑默认轮询；只有在上线初期需要运维兜底时再额外保留 sticky。

### 单机 / 单节点示例

创建 `/etc/nginx/sites-available/bili-syncplay.conf`：

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

建议把更严格的请求频率限制保留在默认的 WebSocket 入口上，不要直接复用到 `/admin` 和 `/api/admin/*`。管理后台在首屏加载和执行操作时会并发请求多个接口，而服务端本身已经对认证和房间相关操作做了限流控制。

### 多节点 upstream 示例

如果入口机需要把 WebSocket 连接分发到多个 Room Node，可改成 upstream。下面示例使用 `least_conn`，对长连接场景通常比默认轮询更稳妥：

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

在这个拓扑里：

- 普通用户只连接 `wss://sync.example.com`
- 入口层负责把新建 WebSocket 连接分发到某个 Room Node
- 现有长连接一旦建立，就固定驻留在被选中的节点上
- 全局管理面建议继续收敛到独立的 `global-admin` 进程
- 当所有 Redis 共享能力都已开启时，正确性上不再依赖 sticky 路由；但上线初期仍可保留 sticky 作为运维兜底开关

启用站点并校验配置：

```bash
sudo ln -s /etc/nginx/sites-available/bili-syncplay.conf /etc/nginx/sites-enabled/bili-syncplay.conf
sudo nginx -t
sudo systemctl reload nginx
```

## 5. 启用 TLS

生产环境中的扩展 WebSocket 服务应使用 `wss://`。常见做法是将 Certbot 与 Nginx 配合使用：

```bash
sudo certbot --nginx -d sync.example.com
```

证书签发后，验证：

```bash
curl https://sync.example.com/
```

此时扩展应使用：

```text
wss://sync.example.com
```

## 6. 更新扩展服务器地址

扩展支持在弹窗中切换服务器地址，因此在生产环境中你可以将客户端指向：

```text
wss://sync.example.com
```

本地测试时，切回：

```text
ws://localhost:8787
```

房间邀请以 `roomCode:joinToken` 的形式分享。弹窗复制操作会复制这个邀请串，加入输入框也接受同样格式。

## 7. 部署更新

当你更新服务器代码时，先在应用目录里拉取并重新构建：

```bash
cd /opt/bili-syncplay
git pull
npm install
npm run build
```

如果你确认只有 `server/` 发生变化，且 `packages/protocol` 没有变化，也可以只构建服务端：

```bash
npm run build -w @bili-syncplay/server
```

单机部署重启方式（即第 3 步创建的两个单元）：

```bash
sudo systemctl restart bili-syncplay-room-node-a
sudo systemctl restart bili-syncplay-global-admin
```

多节点部署重启方式（每条命令在承载对应单元的机器上执行；按两机部署样例，`room-node-b` 在服务器 2 上）：

```bash
sudo systemctl restart bili-syncplay-room-node-a
sudo systemctl restart bili-syncplay-room-node-b
sudo systemctl restart bili-syncplay-global-admin
```

如果有多台 Room Node，建议滚动重启，而不是一次性全部重启：

1. 先重启一个 Room Node
2. 观察 `GET /readyz`、日志和全局管理面是否恢复正常
3. 再继续重启下一个 Room Node
4. 最后重启 `global-admin`

## 8. 运维说明

- 当 `ROOM_STORE_PROVIDER=memory` 时，进程重启后房间仍会全部丢失。
- 当 `ROOM_STORE_PROVIDER=redis` 时，房间基础状态会在重启后保留，直到过期或被删除。
- 最后一名成员离开后，房间不会立刻删除；服务端会写入 `expiresAt`，并在 `EMPTY_ROOM_TTL_MS` 到期后清理。
- 加入房间需要同时提供 `roomCode` 和 `joinToken`；发送房间消息需要有效的 `memberToken`。
- `memberToken` 是会话态，不会从持久层恢复；重连或重启后都需要重新加入并重新签发。
- 握手阶段的 Origin 检查默认拒绝，除非你在开发环境中显式允许缺失 `Origin`。
- 只有当 socket 对端命中 `TRUSTED_PROXY_ADDRESSES` 时才会读取 `X-Forwarded-For`。
- 健康检查同时提供 `GET /` 与 `GET /healthz`；就绪检查为 `GET /readyz`。
- 如果你使用云防火墙，请放行入站 `80` 和 `443`，并将 `8787` 仅暴露给 localhost。
- 如果你不想使用 Nginx，也可以直接暴露 Node 服务，但浏览器和扩展仍应通过带有效 TLS 证书的 `wss://` 连接。
- 当 Redis 相关 provider 全部开启后，房间基础状态、管理员会话、运行时索引、房间状态广播与管理命令路由都可在多个服务实例之间共享。
- 生产环境推荐把 `/admin` 与 `/api/admin/*` 收敛到独立 Global Admin 进程。
- Room Node 可以设置 `GLOBAL_ADMIN_ENABLED=false`，只保留 WebSocket 流量与 `/`、`/healthz`、`/readyz`。
- 当所有 Redis 共享能力都已开启时，多实例部署不再依赖 sticky 路由来保证房间状态正确性。
