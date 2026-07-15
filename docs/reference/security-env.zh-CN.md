# 安全相关环境变量

[English](./security-env.md) | [简体中文](./security-env.zh-CN.md)

服务器支持以下环境变量。虽然内置了安全默认值，但生产环境应显式设置。非敏感配置也可以写入 `server.config.json`；环境变量始终优先（见[部署指南](../operations/deployment.zh-CN.md)）。

## 基础服务

- `BILI_SYNCPLAY_CONFIG`：可选的 JSON 配置文件路径；未设置时会优先查找当前工作目录下的 `server.config.json`
- `PORT`：Room Node 的 HTTP/WebSocket 监听端口；默认 `8787`
- `METRICS_PORT`：可选的 `GET /metrics` 独立端口；未设置时 metrics 在主服务端口上提供；不能与 `PORT` 或 `GLOBAL_ADMIN_PORT` 冲突
- `METRICS_TOKEN`：可选的 `GET /metrics` 静态 Bearer token（主端口路由和 `METRICS_PORT` 独立端口都会校验）；设置后抓取请求必须携带 `Authorization: Bearer <token>`，否则返回 `401`；未设置时端点保持开放；`/healthz` 与 `/readyz` 不受影响。Prometheus 侧通过 `authorization.credentials_file` 配置
- `LOG_LEVEL`：日志级别，可选 `debug`、`info`、`warn`、`error`；默认 `info`
- `INSTANCE_ID`：当前服务进程的标识（如 `room-node-a`），会出现在后台概览、房间详情和审计日志中；多节点部署时每个进程必须唯一；默认 `instance-1`

## Origin 与连接安全

- `ALLOWED_ORIGINS`：逗号分隔的 `Origin` 白名单，用于 WebSocket 连接和跨域管理 API 请求；为空时服务器默认拒绝所有显式跨域 Origin
- `ALLOW_MISSING_ORIGIN_IN_DEV`：设为 `true` 时允许缺失 `Origin` 头；默认 `false`
- `ALLOW_ANY_FIREFOX_EXTENSION_ORIGIN`：设为 `true` 时接受任意格式正确的 `moz-extension://<uuid>` Origin；Firefox 每个安装随机分配 UUID，公共/共享服务端无法逐一枚举进 `ALLOWED_ORIGINS`。仍会拒绝网页 Origin（网页永远无法呈现 `moz-extension://` Origin），且不替代房间/成员 token 鉴权；默认 `false`
- `TRUSTED_PROXY_ADDRESSES`：逗号分隔的受信代理 socket IP 列表；只有来自这些代理的请求才会使用 `X-Forwarded-For`；默认为空
- `MAX_CONNECTIONS_PER_IP`：每个 IP 允许的最大并发 WebSocket 连接数；默认 `10`
- `CONNECTION_ATTEMPTS_PER_MINUTE`：每个 IP 每分钟最大握手尝试次数；默认 `20`
- `MAX_MEMBERS_PER_ROOM`：房间成员上限；默认 `8`
- `MAX_MESSAGE_BYTES`：WebSocket 消息字节上限；默认 `8192`
- `INVALID_MESSAGE_CLOSE_THRESHOLD`：在断开连接前允许的无效消息次数；默认 `3`
- `WS_HEARTBEAT_ENABLED`：是否开启服务端 WebSocket ping/pong 存活检测，用于清理半开死连接（幽灵成员）；默认 `true`
- `WS_HEARTBEAT_INTERVAL_MS`：WebSocket 心跳 ping 间隔（毫秒），连续 2 次未收到 pong 即断开；默认 `30000`

## 消息限流

房间与同步消息限流按连接（成员会话）计；后台登录限流按 IP 或用户名计。

- `RATE_LIMIT_ROOM_CREATE_PER_MINUTE`：每分钟最大建房次数；默认 `3`
- `RATE_LIMIT_ROOM_JOIN_PER_MINUTE`：每分钟最大加入房间尝试次数；默认 `10`
- `RATE_LIMIT_VIDEO_SHARE_PER_10_SECONDS`：每 10 秒最大共享视频更新次数；默认 `3`
- `RATE_LIMIT_PLAYBACK_UPDATE_PER_SECOND`：每秒持续播放状态更新速率；默认 `8`
- `RATE_LIMIT_PLAYBACK_UPDATE_BURST`：播放状态更新的短时突发额度（令牌桶容量）；默认 `12`
- `RATE_LIMIT_SYNC_REQUEST_PER_10_SECONDS`：每 10 秒最大同步请求次数；默认 `6`
- `RATE_LIMIT_SYNC_PING_PER_SECOND`：每秒持续时钟同步 ping 速率；默认 `1`
- `RATE_LIMIT_SYNC_PING_BURST`：时钟同步 ping 的短时突发额度（令牌桶容量）；默认 `2`
- `RATE_LIMIT_ADMIN_LOGIN_FAILURES_PER_IP_PER_MINUTE`：每个 IP 每分钟允许的后台登录失败次数，超过后拒绝后续尝试；默认 `10`
- `RATE_LIMIT_ADMIN_LOGIN_FAILURES_PER_USERNAME_PER_MINUTE`：每个用户名每分钟允许的后台登录失败次数；默认 `5`

## 房间持久化与 Redis

- `ROOM_STORE_PROVIDER`：房间存储实现，`memory` 或 `redis`；默认 `memory`
- `EMPTY_ROOM_TTL_MS`：空房保留时长，超时后删除；默认 `900000`（15 分钟）
- `ROOM_CLEANUP_INTERVAL_MS`：服务端扫描并清理过期房间的周期；默认 `60000`
- `REDIS_URL`：所有 Redis 后端 provider 使用的 Redis 连接地址；默认 `redis://localhost:6379`
- `REDIS_NAMESPACE`：所有 Redis 键的前缀；默认 `bsp`；多套部署共用同一个 Redis 实例时可用不同前缀隔离

## 管理后台认证

`ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH`、`ADMIN_SESSION_SECRET` 三者必须同时设置，否则管理认证接口保持不可用。

- `ADMIN_USERNAME`：管理后台登录用户名
- `ADMIN_PASSWORD_HASH`：管理后台密码哈希，当前支持 `sha256:<hex>` 或 `scrypt:<salt>:<base64url>`
- `ADMIN_SESSION_SECRET`：用于绑定后台 Bearer Token 与服务端会话的 secret
- `ADMIN_SESSION_TTL_MS`：后台会话有效期，单位毫秒；默认 `43200000`（12 小时）
- `ADMIN_ROLE`：当前唯一后台账号的角色，可选 `viewer`、`operator`、`admin`；默认 `admin`
- `ADMIN_UI_DEMO_ENABLED`：是否开启后台内置 demo 模式，适用于本地 / 非生产预览；默认 `false`

## 多节点 provider 与全局管理面

- `ADMIN_SESSION_STORE_PROVIDER`：管理员会话存储，`memory` 或 `redis`；默认 `memory`
- `ADMIN_EVENT_STORE_PROVIDER`：运行事件存储，`memory` 或 `redis`；默认 `memory`
- `ADMIN_AUDIT_STORE_PROVIDER`：审计日志存储，`memory` 或 `redis`；默认 `memory`
- `RUNTIME_STORE_PROVIDER`：共享运行时索引存储（会话、房间成员、被踢 token、节点心跳），`memory` 或 `redis`；当 `ROOM_STORE_PROVIDER=redis` 时默认跟随 `redis`，否则默认 `memory`
- `ROOM_EVENT_BUS_PROVIDER`：跨节点房间事件广播，`none`、`memory` 或 `redis`；当 `RUNTIME_STORE_PROVIDER=redis` 时默认跟随 `redis`，否则默认 `memory`
- `ADMIN_COMMAND_BUS_PROVIDER`：跨节点管理命令路由，`none`、`memory` 或 `redis`；当 `RUNTIME_STORE_PROVIDER=redis` 时默认跟随 `redis`，否则默认 `memory`
- `GLOBAL_ADMIN_ENABLED`：设为 `false` 时，Room Node 保留 `/`、`/healthz`、`/readyz`，但关闭 `/admin` 与 `/api/admin/*`；默认 `true`
- `GLOBAL_ADMIN_API_BASE_URL`：可选的管理 UI API 基址覆盖项，用于管理 UI 与管理 API 分属不同域名的场景；使用该模式时需把 UI 的 Origin 加入 `ALLOWED_ORIGINS`
- `GLOBAL_ADMIN_PORT`：`server/dist/global-admin-index.js` 使用的 HTTP 端口；默认取 `PORT`，`PORT` 也未设置时为 `8788`
- `NODE_HEARTBEAT_ENABLED`：是否向共享运行时存储上报节点心跳；默认 `false`
- `NODE_HEARTBEAT_INTERVAL_MS`：节点心跳间隔，单位毫秒；默认 `15000`
- `NODE_HEARTBEAT_TTL_MS`：节点心跳 TTL，单位毫秒；心跳过期后节点视为离线；默认 `45000`

## 示例

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

快速生成后台密码哈希：

```bash
node -e "const { createHash } = require('node:crypto'); console.log('sha256:' + createHash('sha256').update('secret-123').digest('hex'));"
```
