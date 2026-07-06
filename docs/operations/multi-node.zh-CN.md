# 多节点部署与全局管理面

[English](./multi-node.md) | [简体中文](./multi-node.zh-CN.md)

现在服务端已经支持完整多节点拓扑，包括共享管理员会话、共享事件与审计流、共享运行时索引、跨节点房间状态广播、跨节点管理命令，以及独立的全局管理入口。

## 核心结论

- 普通用户始终连接单一公共地址，例如 `wss://sync.example.com`
- 入口层负责 TLS 终止、反向代理和连接分发
- Room Node 负责承载 WebSocket 长连接和健康检查
- Global Admin 负责 `/admin` 与 `/api/admin/*`
- Redis 负责共享持久化、运行时索引、事件总线和命令总线

推荐生产拓扑：

- 统一入口层：`Nginx`、`HAProxy`、`SLB/ALB` 等，负责 TLS 终止和 WebSocket 反向代理
- `room-node-a`：承载 WebSocket 房间流量和探活
- `room-node-b`：承载 WebSocket 房间流量和探活
- `global-admin`：承载 `/admin` 与 `/api/admin/*`
- `redis`：共享持久化、运行时索引、事件总线和命令总线

服务端不会在应用进程内实现 L4/L7 负载均衡；多节点部署需要依赖外部入口层，把用户连接统一接入后再转发到各个 Room Node。普通用户应始终连接单一公共地址，例如 `wss://sync.example.com`，而不是手动选择节点地址。

> 提示
> 如果你只是本地开发或单机部署，可以继续使用单节点模式。下面这部分主要面向生产多节点部署。

日常扩缩容、Redis 故障、管理员口令轮换和常见告警处理见
[多节点运维 Runbook](../runbook/multi-node-operations.zh-CN.md)。

## 最小必配项

完整多节点上线建议统一开启以下 provider：

- `ROOM_STORE_PROVIDER=redis`
- `ADMIN_SESSION_STORE_PROVIDER=redis`
- `ADMIN_EVENT_STORE_PROVIDER=redis`
- `ADMIN_AUDIT_STORE_PROVIDER=redis`
- `RUNTIME_STORE_PROVIDER=redis`
- `ROOM_EVENT_BUS_PROVIDER=redis`
- `ADMIN_COMMAND_BUS_PROVIDER=redis`
- `NODE_HEARTBEAT_ENABLED=true`

Room Node 示例：

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

独立 Global Admin 示例：

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

如果管理 UI 需要请求一个独立 API 域名，可设置 `GLOBAL_ADMIN_API_BASE_URL=https://admin.example.com`。

## 节点角色配置矩阵

| 角色           | 典型进程                            | 对外职责                               | 必须唯一                           | 必须保持一致                                    | 推荐值 / 说明                |
| -------------- | ----------------------------------- | -------------------------------------- | ---------------------------------- | ----------------------------------------------- | ---------------------------- |
| `room-node`    | `server/dist/index.js`              | WebSocket、`/`、`/healthz`、`/readyz`  | `INSTANCE_ID`、监听地址/端口       | `REDIS_URL`、各类 `*_PROVIDER`、安全与限流参数  | `GLOBAL_ADMIN_ENABLED=false` |
| `global-admin` | `server/dist/global-admin-index.js` | `/admin`、`/api/admin/*`               | `INSTANCE_ID`、`GLOBAL_ADMIN_PORT` | `REDIS_URL`、管理员认证参数、共享 provider 配置 | `GLOBAL_ADMIN_ENABLED=true`  |
| `edge`         | `nginx` / `haproxy` / 云 LB         | TLS 终止、统一入口、反向代理、连接分发 | 对外域名、证书、upstream 定义      | 指向的后端节点列表                              | 用户只连接统一入口地址       |
| `redis`        | `redis-server`                      | 共享持久化、运行时索引、总线           | 实例地址、密码、ACL                | 所有节点都要指向同一个 Redis                    | 生产建议仅内网开放           |

## 哪些配置必须一致，哪些必须不同

### 所有节点保持一致

所有 Room Node 与 Global Admin 都应保持一致的配置：

- `REDIS_URL`
- `ROOM_STORE_PROVIDER=redis`
- `ADMIN_SESSION_STORE_PROVIDER=redis`
- `ADMIN_EVENT_STORE_PROVIDER=redis`
- `ADMIN_AUDIT_STORE_PROVIDER=redis`
- `RUNTIME_STORE_PROVIDER=redis`
- `ROOM_EVENT_BUS_PROVIDER=redis`
- `ADMIN_COMMAND_BUS_PROVIDER=redis`
- `NODE_HEARTBEAT_ENABLED=true`
- 与业务正确性相关的限流、安全和房间容量参数，例如 `MAX_MEMBERS_PER_ROOM`、`MAX_MESSAGE_BYTES`、`ALLOWED_ORIGINS`
- 管理员认证配置，例如 `ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH`、`ADMIN_SESSION_SECRET`

### 每个节点保持唯一

每个节点必须不同或按角色区分的配置：

- `INSTANCE_ID`：每个进程都必须唯一，例如 `room-node-a`、`room-node-b`、`global-admin`
- `PORT`：Room Node 自己监听的 HTTP/WebSocket 端口
- `GLOBAL_ADMIN_PORT`：仅 `global-admin` 使用
- `GLOBAL_ADMIN_ENABLED`：Room Node 设为 `false`，独立管理面设为 `true`
- 监听地址、防火墙规则、systemd 服务名、日志路径

## 两机部署样例

如果当前只有两台服务器，推荐先按下面的方式部署：

- 服务器 1：`Nginx + Redis + room-node-a + global-admin`
- 服务器 2：`room-node-b`

### 端口规划

建议端口规划：

| 机器     | 角色           | 建议监听                    | 是否公网开放 | 说明                    |
| -------- | -------------- | --------------------------- | ------------ | ----------------------- |
| 服务器 1 | `nginx`        | `80/443`                    | 是           | 用户统一入口            |
| 服务器 1 | `room-node-a`  | `127.0.0.1:8787` 或内网地址 | 否           | 由入口层反代            |
| 服务器 1 | `global-admin` | `127.0.0.1:8788` 或内网地址 | 否           | 由入口层反代            |
| 服务器 1 | `redis`        | `127.0.0.1:6379` 或内网地址 | 否           | 只允许节点访问          |
| 服务器 2 | `room-node-b`  | `10.0.0.12:8787` 等内网地址 | 否           | 由服务器 1 的入口层反代 |

### 环境变量示意

服务器 1 的 Room Node 环境变量示意：

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

服务器 2 的 Room Node 环境变量示意：

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

服务器 1 的 Global Admin 环境变量示意：

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

### 权重建议

如果入口机同时承载 `room-node-a`、`global-admin` 和 `redis`，它通常会比其他节点承担更多网络和 CPU 压力。此时建议在入口层给远端 Room Node 更高权重，或者至少使用 `least_conn`，不要按 1:1 平均分配长连接。

多节点控制面当前使用的 Redis 键族：

- `bsp:room:*`、`bsp:room-index`、`bsp:room-expiry`：房间基础持久化
- `bsp:runtime:*`：共享 session、房间成员、被踢 token 与节点心跳
- `bsp:admin:session:*`：共享管理员 Bearer 会话
- `bsp:events`：运行事件流
- `bsp:audit-logs`：管理审计流
- `bsp:room-events`：房间事件总线频道
- `bsp:admin-command:*`、`bsp:admin-command-result:*`：管理命令频道
