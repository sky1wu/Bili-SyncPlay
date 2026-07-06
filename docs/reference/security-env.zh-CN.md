# 安全相关环境变量

[English](./security-env.md) | [简体中文](./security-env.zh-CN.md)

服务器支持以下环境变量。虽然内置了安全默认值，但生产环境应显式设置：

- `BILI_SYNCPLAY_CONFIG`：可选的 JSON 配置文件路径；未设置时会优先查找当前工作目录下的 `server.config.json`
- `ALLOWED_ORIGINS`：逗号分隔的 WebSocket `Origin` 白名单
- 如果 `ALLOWED_ORIGINS` 为空，服务器默认拒绝所有显式 `Origin`
- `ALLOW_MISSING_ORIGIN_IN_DEV`：设为 `true` 时允许缺失 `Origin` 头
- `ALLOW_ANY_FIREFOX_EXTENSION_ORIGIN`：设为 `true` 时接受任意格式正确的 `moz-extension://<uuid>` Origin；Firefox 每个安装随机分配 UUID，公共/共享服务端无法逐一枚举进 `ALLOWED_ORIGINS`。仍会拒绝网页 Origin（网页永远无法呈现 `moz-extension://` Origin），且不替代房间/成员 token 鉴权；默认 `false`
- `TRUSTED_PROXY_ADDRESSES`：逗号分隔的受信代理 socket IP 列表；只有来自这些代理的请求才会使用 `X-Forwarded-For`
- `MAX_CONNECTIONS_PER_IP`：每个 IP 允许的最大并发 WebSocket 连接数
- `CONNECTION_ATTEMPTS_PER_MINUTE`：每个 IP 每分钟最大握手尝试次数
- `MAX_MEMBERS_PER_ROOM`：房间成员上限
- `MAX_MESSAGE_BYTES`：WebSocket 消息字节上限
- `INVALID_MESSAGE_CLOSE_THRESHOLD`：在断开连接前允许的无效消息次数
- `WS_HEARTBEAT_ENABLED`：是否开启服务端 WebSocket ping/pong 存活检测，用于清理半开死连接（幽灵成员）；默认 `true`
- `WS_HEARTBEAT_INTERVAL_MS`：WebSocket 心跳 ping 间隔（毫秒），连续 2 次未收到 pong 即断开；默认 `30000`
- `ROOM_STORE_PROVIDER`：`memory` 或 `redis`
- `EMPTY_ROOM_TTL_MS`：空房保留时长，超时后删除
- `ROOM_CLEANUP_INTERVAL_MS`：服务端扫描并清理过期房间的周期
- `REDIS_URL`：当 `ROOM_STORE_PROVIDER=redis` 时使用的 Redis 连接地址
- `ADMIN_USERNAME`：管理后台登录用户名
- `ADMIN_PASSWORD_HASH`：管理后台密码哈希，当前支持 `sha256:<hex>` 或 `scrypt:<salt>:<base64url>`
- `ADMIN_SESSION_SECRET`：用于绑定后台 Bearer Token 与服务端会话的 secret
- `ADMIN_SESSION_TTL_MS`：后台会话有效期，单位毫秒
- `ADMIN_ROLE`：后台角色，可选 `viewer`、`operator`、`admin`
- `ADMIN_UI_DEMO_ENABLED`：是否开启后台内置 demo 模式，适用于本地 / 非生产预览，默认 `false`
- `ADMIN_SESSION_STORE_PROVIDER`：`memory` 或 `redis`
- `ADMIN_EVENT_STORE_PROVIDER`：`memory` 或 `redis`
- `ADMIN_AUDIT_STORE_PROVIDER`：`memory` 或 `redis`
- `RUNTIME_STORE_PROVIDER`：`memory` 或 `redis`
- `ROOM_EVENT_BUS_PROVIDER`：`none`、`memory` 或 `redis`
- `ADMIN_COMMAND_BUS_PROVIDER`：`none`、`memory` 或 `redis`
- `GLOBAL_ADMIN_ENABLED`：设为 `false` 时，Room Node 保留 `/`、`/healthz`、`/readyz`，但关闭 `/admin` 与 `/api/admin/*`
- `GLOBAL_ADMIN_API_BASE_URL`：可选的管理 UI API 基址覆盖项
- `GLOBAL_ADMIN_PORT`：`server/dist/global-admin-index.js` 使用的 HTTP 端口
- `NODE_HEARTBEAT_ENABLED`：是否开启节点心跳
- `NODE_HEARTBEAT_INTERVAL_MS`：节点心跳间隔，单位毫秒
- `NODE_HEARTBEAT_TTL_MS`：节点心跳 TTL，单位毫秒
- `RATE_LIMIT_ROOM_CREATE_PER_MINUTE`
- `RATE_LIMIT_ROOM_JOIN_PER_MINUTE`
- `RATE_LIMIT_VIDEO_SHARE_PER_10_SECONDS`
- `RATE_LIMIT_PLAYBACK_UPDATE_PER_SECOND`
- `RATE_LIMIT_PLAYBACK_UPDATE_BURST`
- `RATE_LIMIT_SYNC_REQUEST_PER_10_SECONDS`
- `RATE_LIMIT_SYNC_PING_PER_SECOND`
- `RATE_LIMIT_SYNC_PING_BURST`

示例：

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
