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
- 重连携带仍有效的旧 `memberToken` 时复用，否则重新签发
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

项目支持 Redis 6.0 及以上版本。开启 Redis ACL 时，仅能连通还不够：Room Node 与
Global Admin 使用的身份还要能读写房间 body/索引，以及两把孤儿清理交接键。默认命名空间
下，除 `bsp:room:*` 外还要授权 `bsp:rooms-by-expiry` 与
`bsp:room-index-orphans*`。即便是单节点部署，漏掉交接键 ACL 也会使启动对账、房间列表或
过期回收失败。

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

首次重启使用房间孤儿清理交接机制的版本前：

1. 给两个服务身份授予 `bsp:room-index-orphans` 与
   `bsp:room-index-orphans-queue` 的读写 ACL（设置了 `REDIS_NAMESPACE` 时替换
   `bsp`）。
2. 在同一份 Redis 备份中同时包含两把键。哈希保存带 token 的未完成清理 claim，
   sorted set 是其有界轮转投递索引。
3. 监控 `HLEN bsp:room-index-orphans`。queue 初始化后，
   `ZCARD bsp:room-index-orphans-queue` 通常应等于前者加一个保留序列成员；持续增长或
   长期不一致说明清理、ACL 或键类型需要排查。

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

例外：首次上线孤儿清理交接机制时，不能混跑新旧 room-store 持有者。旧版 Room Node 或
Global Admin 仍可能剪掉孤儿却不创建 claim。因此本次必须先排空流量并停止全部旧版 Room
Node 与 Global Admin，再启动任一新版本进程。以后两个版本都已实现交接机制时，才可使用
上面的滚动顺序。

如果必须回滚到旧版本，不要把某一次瞬时 `HLEN=0` 当成排空屏障：关服流程先停 Room
Reaper、后停索引 Reconciler，进程退出途中仍可能出现新 claim。先排空房间流量并停止全部
本版本 Room Node 与 Global Admin；只有所有进程退出后看到的零才稳定。若仍有 claim，启动
一台不接流量的本版本 Room Node，等待成功 reaper sweep 直至哈希归零，再将它完整停止并于
退出后复查；复查仍非零就重复或中止回滚。备份中要保留两把交接键；旧版本虽会忽略它们，
删除却会丢失待完成的运行时清理。若回滚目标仍使用旧式双索引 room store，还必须按
[多节点部署文档](./multi-node.zh-CN.md)执行重建流程。

### 优雅退出

两个入口（`server/dist/index.js` 与 `server/dist/global-admin-index.js`）都监听 `SIGTERM` 与 `SIGINT`：收到信号后先停止接受新连接，再依次关闭 WebSocket 连接、等待会话清理、冲刷未发出的房间事件，最后释放 Redis 上的运行时状态与连接。

超时分三层，不要混淆：

1. **每个关闭步骤各自的上限**：多数 5s，会话清理与房间事件冲刷各 30s，最坏累计约 135s。空闲节点通常 1s 内就走完。
2. **进程看门狗 150s**：只兜底 `close()` 本身卡死的情况，取值高于上面的合法预算，不会裁剪正常关闭。触发时以退出码 `1` 退出。
3. **编排器宽限期**：决定实际给多少时间。它是上限而非固定等待，正常关闭不会因为设得大而变慢。

对应到部署方式：

- systemd：默认 `TimeoutStopSec=90s`，`systemctl restart` / `stop` 通常秒级完成；如果希望忙节点也能走完全部清理，把该值调到 160s。
- Docker：默认宽限期只有 10s，会在清理中途 SIGKILL（表现为退出码 `137`）。仓库内的 `docker-compose.yml` 已设 `stop_grace_period: 160s`；用 `docker run` 启动时对应 `docker stop -t 160 <容器名>`。愿意牺牲尾部清理的话可以调小，代价是 Redis 上的运行时状态要等 reaper 过期回收。
- 启动期间（例如仍在连接 Redis）收到信号：进程会记录并等启动完成后再走完整关闭；如果启动 5s 内仍未完成，直接以退出码 `1` 退出，不会挂着等编排器 SIGKILL。
- 有关闭步骤抛出异常时，进程以退出码 `1` 退出。仅仅是跑光了预算的步骤属于降级而非失败：这些预算之所以存在，正是因为对应步骤在等本进程无法取消的 I/O，放弃等待本就是设计中的结局，因此进程仍以 `0` 退出。两种情况都会以 error 级别记录 `server_shutdown_step_failed` 事件——区分它们要看事件的 `result` 字段（`"error"` 还是 `"timeout"`），退出码区分不了。
- 客户端会收到正常的 close frame：`1001 going away`，reason 为 `server_shutting_down`；不再是断开 TCP 导致的 `1006`（与崩溃、断网无法区分）。2s 内没回应 close 握手的连接才会被强制断开。两种情况扩展都会自动重连。
- 在清理过程中再次收到信号（例如连按两次 Ctrl+C）会立即退出，放弃剩余清理步骤。

## 8. 运维说明

- 当 `ROOM_STORE_PROVIDER=memory` 时，进程重启后房间仍会全部丢失。
- 当 `ROOM_STORE_PROVIDER=redis` 时，房间基础状态会在重启后保留，直到过期或被删除。
- 最后一名成员离开后，房间不会立刻删除；服务端会写入 `expiresAt`，并在 `EMPTY_ROOM_TTL_MS` 到期后清理。
- 加入房间需要同时提供 `roomCode` 和 `joinToken`；发送房间消息需要有效的 `memberToken`。
- `memberToken` 是会话态；重连携带仍有效的旧 token 时复用，否则重新签发。扩展在自动重连时保留缓存的 token，只有显式离开或管理端终止会话时才清除。
- 握手阶段的 Origin 检查默认拒绝，除非你在开发环境中显式允许缺失 `Origin`。
- 只有当 socket 对端命中 `TRUSTED_PROXY_ADDRESSES` 时才会读取 `X-Forwarded-For`。
- 健康检查同时提供 `GET /` 与 `GET /healthz`；就绪检查为 `GET /readyz`。
- 如果你使用云防火墙，请放行入站 `80` 和 `443`，并将 `8787` 仅暴露给 localhost。
- 如果你不想使用 Nginx，也可以直接暴露 Node 服务，但浏览器和扩展仍应通过带有效 TLS 证书的 `wss://` 连接。
- 当 Redis 相关 provider 全部开启后，房间基础状态、管理员会话、运行时索引、房间状态广播与管理命令路由都可在多个服务实例之间共享。
- 生产环境推荐把 `/admin` 与 `/api/admin/*` 收敛到独立 Global Admin 进程。
- Room Node 可以设置 `GLOBAL_ADMIN_ENABLED=false`，只保留 WebSocket 流量与 `/`、`/healthz`、`/readyz`。
- 当所有 Redis 共享能力都已开启时，多实例部署不再依赖 sticky 路由来保证房间状态正确性。
