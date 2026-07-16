# 管理面板与 API

[English](./admin-api.md) | [简体中文](./admin-api.zh-CN.md)

## 打开管理控制面板

如果你要在本地使用后台页面，需要先带上管理认证配置启动服务端，然后访问：

```text
http://localhost:8787/admin
```

这对应的是单进程本地开发模式，也就是管理面和 WebSocket 服务共用同一个 `npm run dev:server` 进程。

如果你使用的是独立 Global Admin 进程，则入口通常会变成下面两种之一：

```text
http://localhost:8788/admin
https://admin.example.com/admin
```

其中：

- `http://localhost:8787/admin`：单进程开发或未拆分管理面的场景
- `http://localhost:8788/admin`：本机直接启动 `server/dist/global-admin-index.js`
- `https://admin.example.com/admin`：生产环境经反向代理后的统一管理面地址

PowerShell 示例：

```powershell
$env:ADMIN_USERNAME="admin"
$env:ADMIN_PASSWORD_HASH="sha256:<hex-password-hash>"
$env:ADMIN_SESSION_SECRET="<random-secret>"
$env:ADMIN_ROLE="admin"
npm run dev:server
```

本地生成 `sha256:<hex>` 密码哈希：

PowerShell：

```powershell
$password = "secret-123"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($password)
$hash = [System.BitConverter]::ToString(
  [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
).Replace("-", "").ToLower()
"sha256:$hash"
```

Node.js：

```bash
node -e "const { createHash } = require('node:crypto'); const password = 'secret-123'; console.log('sha256:' + createHash('sha256').update(password).digest('hex'));"
```

当前后台页面已经覆盖：

- 概览
- 房间列表和房间详情
- 运行事件
- 审计日志
- 配置摘要
- 关房、过期、清空共享视频、踢人、断开会话等现有管理动作
- 被踢成员会被临时阻止使用旧 `memberToken` 立即自动重连

## 管理后台 API

服务端内置管理后台，管理接口与 WebSocket 服务复用同一个 HTTP 端口。

管理控制面板入口：

- 打开 `http://localhost:8787/admin`
- 使用 `ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH`、`ADMIN_SESSION_SECRET`、`ADMIN_ROLE` 配置的账号登录
- 页面已覆盖登录、概览、房间列表、房间详情、运行事件、审计日志、配置摘要，以及现有管理动作

角色模型：

- `viewer`：只读访问概览、房间、事件、审计日志、配置摘要
- `operator`：在 `viewer` 基础上可执行房间和会话管理动作
- `admin`：当前能力与 `operator` 基本一致，为后续更高权限治理能力预留扩展位

动作语义说明：

- `踢出成员` 会断开当前成员会话，并临时阻止客户端拿旧 `memberToken` 立即自动重连
- `断开会话` 只关闭指定 socket；如果客户端仍持有有效房间上下文，后续仍可正常重新加入

当前已实现接口：

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

所有 `/api/admin/*` 接口都支持 `GET`、`POST`、`OPTIONS` 的 CORS 预检，并允许 `authorization` 与 `content-type` 请求头。管理 UI 会访问的 `/healthz` 与 `/readyz` 使用相同的来源策略，并支持 `GET` 和 `OPTIONS`。只有请求 Origin 与 API 同源或被显式列入 `ALLOWED_ORIGINS` 时，服务端才会原样返回该 Origin，不使用通配符。`GLOBAL_ADMIN_API_BASE_URL` 指向独立 API 域名时，需把管理 UI 的 Origin 加入该白名单。

`GET /metrics` 默认在主服务端口上提供，也可以通过 `METRICS_PORT` 挪到独立端口；设置 `METRICS_TOKEN` 后抓取请求还需携带 `Authorization: Bearer <token>`（见[安全相关环境变量](./security-env.zh-CN.md)）。

鉴权方式：

- 管理接口使用 `Authorization: Bearer <token>`
- 登录成功后返回服务端签发的 session token
- `ADMIN_ROLE` 用于控制当前唯一后台账号的角色，可选 `viewer`、`operator`、`admin`
- `INSTANCE_ID` 用于标识当前服务实例，并会出现在 overview、room detail 和 audit log 中
- 写操作要求 `operator` 及以上权限
- 如果未配置管理后台环境变量，管理认证接口会返回 unavailable / unauthorized
