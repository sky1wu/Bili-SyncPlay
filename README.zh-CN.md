# Bili-SyncPlay

[English](./README.md) | [简体中文](./README.zh-CN.md)

Bili-SyncPlay 是一个“Chrome 扩展 + WebSocket 服务端”的哔哩哔哩同步观影项目。用户可以创建或加入房间，分享当前视频，并在参与者之间同步播放、暂停、跳转和播放速率。

它覆盖了完整的本地使用链路：

- 在 Chrome / Edge 中加载未打包扩展
- 启动本地同步服务
- 创建房间并复制邀请串
- 让多个成员保持同一共享视频的同步播放

本仓库是一个 monorepo：

- `extension/`：Chrome 扩展
- `server/`：WebSocket 房间服务与管理后台
- `packages/protocol/`：共享协议类型

## 一眼看懂

- 邀请格式：`roomCode:joinToken`
- 默认本地服务地址：`ws://localhost:8787`
- 本地开发浏览器：Chrome、Edge
- 生产环境建议地址：`wss://<你的域名>`

## 快速开始

如果你想直接使用已发布版本，可以直接从以下已上架商店安装：

- [Chrome 应用商店中的 Bili-SyncPlay](https://chromewebstore.google.com/detail/bili-syncplay/lbmckljnginagfabglpfdepofoglfdkj)
- [Microsoft Edge 扩展商店中的 Bili-SyncPlay](https://microsoftedge.microsoft.com/addons/detail/bili-syncplay/cpgcalajpoihfgfeidmnijcdimnjniam)

### 1. 安装并构建

```bash
npm install
npm run build
```

### 2. 加载扩展

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 点击 `加载已解压的扩展程序`
4. 选择 `extension/dist`

### 3. 启动本地服务器

在未打包扩展连接本地服务器之前，需要先把当前扩展 Origin 加入 `ALLOWED_ORIGINS`。

PowerShell：

```powershell
$env:ALLOWED_ORIGINS="chrome-extension://<extension-id>"
npm run dev:server
```

Bash：

```bash
ALLOWED_ORIGINS=chrome-extension://<extension-id> \
npm run dev:server
```

### 4. 开始使用

1. 打开扩展弹窗
2. 创建房间，或者使用 `roomCode:joinToken` 加入已有房间
3. 打开受支持的 Bilibili 视频页面
4. 在弹窗中点击 `同步当前页视频`
5. 其他房间成员会打开同一视频并进入同步模式

如果成员在仍处于房间时浏览到其他未共享视频页面，该页面会保持本地模式，除非他们显式再次同步，否则不会影响房间。

## 功能

- 房间能力
  - 创建房间并获取邀请串
  - 使用 `roomCode:joinToken` 加入房间
  - 直接在弹窗中复制并分享邀请串
- 同步能力
  - 在扩展弹窗中分享当前页面视频
  - 同步播放、暂停、跳转和播放速率
  - 房间成员自动打开当前共享的视频
- 页面内反馈
  - 成员加入和离开提示
  - 共享视频变更提示
  - 播放、暂停、跳转、倍速变化提示
- 房间内的本地浏览隔离
  - 未共享页面不会把播放状态广播回房间
  - 在未共享页面上的手动播放仅在本地生效

## 支持的页面

- `https://www.bilibili.com/video/*`
- `https://www.bilibili.com/bangumi/play/*`
- `https://www.bilibili.com/festival/*`
- `https://www.bilibili.com/list/watchlater*`，且页面 URL 中带有 `bvid`
- `https://www.bilibili.com/medialist/play/watchlater*`，且页面 URL 中带有 `bvid`

视频变体识别：

- 多 P 视频通过 `?p=` 识别
- festival 页面通过 `bvid + cid` 识别

## 项目结构

```text
Bili-SyncPlay/
  extension/            Chrome 扩展
  server/               WebSocket 房间服务器
  packages/protocol/    共享协议类型
  scripts/              发布打包脚本
  .github/workflows/    GitHub Actions 工作流
```

## 环境要求

- Node.js 18+
- npm 8+
- Chrome 或 Edge，用于加载未打包扩展

## 本地默认值

- 默认服务器地址：`ws://localhost:8787`
- 服务器地址输入为空时，会回退到构建时默认值
- 仅接受 `ws://` 和 `wss://`
- 本地未打包扩展开发要求 `ALLOWED_ORIGINS=chrome-extension://<extension-id>`

### 打开管理控制面板

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

如果你只是在本地或非生产环境下预览后台演示数据，需要显式开启：

```powershell
$env:ADMIN_UI_DEMO_ENABLED="true"
npm run dev:server
```

未开启这个变量时，后台页面上的 `?demo=1` 会被忽略。

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

## 开发参考

### 本地开发

安装依赖：

```bash
npm install
```

在本地运行仓库级检查前，请先执行 `npm install` 安装依赖；CI 中则统一使用 `npm ci` 基于锁文件做干净安装，然后再执行同一套检查。

推荐直接使用根工作区命令：

```bash
npm run lint
npm run format:check
npm run typecheck
npm run build
npm test
```

常用命令说明：

- `npm run lint`：执行全仓 ESLint 检查
- `npm run lint:fix`：执行可安全应用的 ESLint 自动修复
- `npm run format`：用 Prettier 重写格式
- `npm run format:check`：只检查格式，不改文件
- `npm run typecheck`：执行 protocol、server、extension 源码的 TypeScript 语义检查
- `npm run build`：按依赖顺序构建 `protocol`、`server`、`extension`
- `npm test`：执行 protocol、server、extension 的全仓测试
- `npm run test:server:redis`：显式执行 server 的 Redis 持久化回归测试

开发约定：

- 保持入口文件轻量化，并且让共享规则维持单一来源。
- 本地检查前先执行 `npm install` 安装依赖；CI 中统一先执行 `npm ci`，再跑同一套校验流程。
- 提交前执行 `npm run lint`、`npm run format:check`、`npm run typecheck`、`npm run build`、`npm test`。
- 完整贡献约束见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

构建全部内容：

```bash
npm run build
```

使用固定的 Chrome 扩展 ID 构建扩展：

```powershell
$env:BILI_SYNCPLAY_EXTENSION_KEY="<chrome-web-store-public-key>"
npm run build -w @bili-syncplay/extension
```

如果设置了 `BILI_SYNCPLAY_EXTENSION_KEY`，构建会把它写入 `extension/dist/manifest.json` 的 `manifest.key`。这里应使用与你在 Chrome Web Store 发布项对应的同一个公钥，这样本地加载的扩展才能和已发布版本保持相同的扩展 ID。

运行自动化测试：

```bash
npm test
```

当前仓库中的测试覆盖包括：

- protocol 客户端消息校验
- server WebSocket 校验、认证、Origin 过滤和限流检查
- background 房间状态竞态处理

也可以使用 workspace 级测试命令：

```bash
npm run test -w @bili-syncplay/protocol
npm run test -w @bili-syncplay/server
npm run test:redis -w @bili-syncplay/server
npm run test -w @bili-syncplay/extension
```

Redis 集成测试说明：

- `npm run test -w @bili-syncplay/server` 会保留 Redis 专项测试为可选项；未配置 `REDIS_URL` 时可能跳过
- `npm run test:redis -w @bili-syncplay/server` 是显式的 Redis 回归测试入口
- 在仓库根目录也可以运行 `npm run test:server:redis`
- 这些显式 Redis 测试命令要求设置 `REDIS_URL`，缺失时会直接失败

### 代码组织约定

仓库现在遵循“薄入口 + 具名模块”的组织方式。

- `extension/src/background`
  - `index.ts` 只负责装配
  - 运行态统一收敛在 `state-store.ts`
  - socket、room session、popup state、diagnostics、tab 协调分别由独立 controller 承载
- `extension/src/content`
  - `index.ts` 只负责装配
  - 运行态统一收敛在 `content-store.ts`
  - 播放同步、room-state hydration、导航、视频绑定、分享识别由独立 controller 承载
- `extension/src/popup`
  - `index.ts` 只负责装配
  - 本地 UI 状态统一收敛在 `popup-store.ts`
  - template、refs、render、actions、background port 同步各自独立
- `extension/src/shared`
  - 扩展端共享 helper 必须沉淀在这里，例如共享视频 URL 归一化，不要回到各入口文件各写一份
- `packages/protocol/src`
  - 协议类型位于 `types/*`
  - 类型守卫位于 `guards/*`
  - `index.ts` 保持兼容导出面
- `server/src`
  - `app.ts` 只负责运行时装配
  - 环境变量解析位于 `config/*`
  - bootstrap 拼装位于 `bootstrap/*`
  - admin 路由分发位于 `admin/routes/*`

当前回归测试已经开始按这些边界补齐，不再只覆盖“功能能不能跑通”，也覆盖重构后 store/controller/helper 的关键行为。

### 贡献约束

后续继续改仓库时，默认遵守以下约束：

- 优先把新行为放进已有具名模块，而不是继续拉长 `index.ts`
- 入口文件只保留初始化、依赖装配和监听注册
- 共享规则只能有一个可信来源；不要重新引入本地 `normalizeUrl()` 包装或重复 parser
- 新增状态优先进入对应 store，不再随手增加新的顶层可变变量
- 如果一个文件同时开始混入状态、IO 和业务决策，应在它再次膨胀前拆分
- 修改 store、controller、helper、protocol guard、server config/router 边界时，必须同步补或改对应测试

建议提交前自检：

```bash
npm run lint
npm run format:check
npm run typecheck
npm run build
npm test
```

启动本地服务器：

```bash
npm run dev:server
```

默认服务器地址：

```text
ws://localhost:8787
```

开发说明：

- `@bili-syncplay/server` 依赖 `@bili-syncplay/protocol` 的构建产物
- 对于全新本地环境，优先使用 `npm run build`，而不是单独构建 `server`
- 扩展默认不会永久保持 socket 连接；只有在会话状态中已存在房间，或用户创建 / 加入房间时才会建立连接
- 重新进入已有房间现在需要保存的 `joinToken`；断开连接后，旧的 `memberToken` 会被丢弃
- 如果你修改了协议类型或消息校验，需要重新构建 `packages/protocol` 和 `server`
- 本地服务器默认会拒绝扩展连接，除非 `ALLOWED_ORIGINS` 包含当前 `chrome-extension://<extension-id>`
- 你可以在 `chrome://extensions` 中查看未打包扩展的 ID

Chrome 显示的扩展版本来自 `extension/dist/manifest.json`。
构建过程中，该 manifest 版本会根据根目录 `package.json` 自动生成。

### 运行时行为

- 如果用户在加入房间前点击 `Sync current page video`，扩展会先提示创建房间
- 如果房间当前已经共享了另一个视频，弹窗会在替换前请求确认
- background service worker 只会转发当前识别为共享标签页的播放更新
- 切换服务器地址会断开当前 socket；如果扩展仍有活动房间或待创建房间，会使用新地址重新连接
- 如果持久化的服务器地址非法，扩展会保留该值并阻止自动重连，直到用户修正地址
- 支持的播放页面依赖 Bilibili 的 DOM 和 URL 模式，因此如果 Bilibili 后续改版，festival 页面和稍后再看页面可能需要兼容性更新

### 状态持久化

扩展有意按生命周期拆分持久化状态：

- `chrome.storage.session`: `roomCode`, `joinToken`, `memberToken`, `memberId`, `roomState`
- `chrome.storage.local`: `displayName`, `serverUrl`

实际影响：

- 浏览器重启后不会自动恢复之前的房间
- 自定义服务器地址会在浏览器重启后保留
- 房间会话态与用户偏好会分别持久化，房间状态写入失败不会把 `serverUrl` 或 `displayName` 留在半更新状态
- 只有在浏览器会话中仍保留 `roomCode` 和 `joinToken` 时，弹窗才能重新进入当前房间
- `memberToken` 会在断开连接时被有意清除，并在重新加入成功后重新签发
- 如果持久化的服务器地址非法，扩展会保留原始值并停止自动重连，直到地址被修正
- 关闭浏览器后，下次启动不会自动恢复之前的房间

### 服务器部署

推荐环境：

- Node.js 20 或 22
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

服务端现在也支持可选的 JSON 配置文件。加载优先级为：

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

### 多节点部署与全局管理面

现在服务端已经支持完整多节点拓扑，包括共享管理员会话、共享事件与审计流、共享运行时索引、跨节点房间状态广播、跨节点管理命令，以及独立的全局管理入口。

#### 核心结论

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

#### 最小必配项

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

#### 节点角色配置矩阵

| 角色           | 典型进程                            | 对外职责                               | 必须唯一                           | 必须保持一致                                    | 推荐值 / 说明                |
| -------------- | ----------------------------------- | -------------------------------------- | ---------------------------------- | ----------------------------------------------- | ---------------------------- |
| `room-node`    | `server/dist/index.js`              | WebSocket、`/`、`/healthz`、`/readyz`  | `INSTANCE_ID`、监听地址/端口       | `REDIS_URL`、各类 `*_PROVIDER`、安全与限流参数  | `GLOBAL_ADMIN_ENABLED=false` |
| `global-admin` | `server/dist/global-admin-index.js` | `/admin`、`/api/admin/*`               | `INSTANCE_ID`、`GLOBAL_ADMIN_PORT` | `REDIS_URL`、管理员认证参数、共享 provider 配置 | `GLOBAL_ADMIN_ENABLED=true`  |
| `edge`         | `nginx` / `haproxy` / 云 LB         | TLS 终止、统一入口、反向代理、连接分发 | 对外域名、证书、upstream 定义      | 指向的后端节点列表                              | 用户只连接统一入口地址       |
| `redis`        | `redis-server`                      | 共享持久化、运行时索引、总线           | 实例地址、密码、ACL                | 所有节点都要指向同一个 Redis                    | 生产建议仅内网开放           |

#### 哪些配置必须一致，哪些必须不同

##### 所有节点保持一致

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

##### 每个节点保持唯一

每个节点必须不同或按角色区分的配置：

- `INSTANCE_ID`：每个进程都必须唯一，例如 `room-node-a`、`room-node-b`、`global-admin`
- `PORT`：Room Node 自己监听的 HTTP/WebSocket 端口
- `GLOBAL_ADMIN_PORT`：仅 `global-admin` 使用
- `GLOBAL_ADMIN_ENABLED`：Room Node 设为 `false`，独立管理面设为 `true`
- 监听地址、防火墙规则、systemd 服务名、日志路径

#### 两机部署样例

如果当前只有两台服务器，推荐先按下面的方式部署：

- 服务器 1：`Nginx + Redis + room-node-a + global-admin`
- 服务器 2：`room-node-b`

##### 端口规划

建议端口规划：

| 机器     | 角色           | 建议监听                    | 是否公网开放 | 说明                    |
| -------- | -------------- | --------------------------- | ------------ | ----------------------- |
| 服务器 1 | `nginx`        | `80/443`                    | 是           | 用户统一入口            |
| 服务器 1 | `room-node-a`  | `127.0.0.1:8787` 或内网地址 | 否           | 由入口层反代            |
| 服务器 1 | `global-admin` | `127.0.0.1:8788` 或内网地址 | 否           | 由入口层反代            |
| 服务器 1 | `redis`        | `127.0.0.1:6379` 或内网地址 | 否           | 只允许节点访问          |
| 服务器 2 | `room-node-b`  | `10.0.0.12:8787` 等内网地址 | 否           | 由服务器 1 的入口层反代 |

##### 环境变量示意

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

##### 权重建议

如果入口机同时承载 `room-node-a`、`global-admin` 和 `redis`，它通常会比其他节点承担更多网络和 CPU 压力。此时建议在入口层给远端 Room Node 更高权重，或者至少使用 `least_conn`，不要按 1:1 平均分配长连接。

多节点控制面当前使用的 Redis 键族：

- `bsp:room:*`、`bsp:room-index`、`bsp:room-expiry`：房间基础持久化
- `bsp:runtime:*`：共享 session、房间成员、被踢 token 与节点心跳
- `bsp:admin:session:*`：共享管理员 Bearer 会话
- `bsp:events`：运行事件流
- `bsp:audit-logs`：管理审计流
- `bsp:room-events`：房间事件总线频道
- `bsp:admin-command:*`、`bsp:admin-command-result:*`：管理命令频道

### 安全相关环境变量

服务器支持以下环境变量。虽然内置了安全默认值，但生产环境应显式设置：

- `BILI_SYNCPLAY_CONFIG`：可选的 JSON 配置文件路径；未设置时会优先查找当前工作目录下的 `server.config.json`
- `ALLOWED_ORIGINS`：逗号分隔的 WebSocket `Origin` 白名单
- 如果 `ALLOWED_ORIGINS` 为空，服务器默认拒绝所有显式 `Origin`
- `ALLOW_MISSING_ORIGIN_IN_DEV`：设为 `true` 时允许缺失 `Origin` 头
- `TRUSTED_PROXY_ADDRESSES`：逗号分隔的受信代理 socket IP 列表；只有来自这些代理的请求才会使用 `X-Forwarded-For`
- `MAX_CONNECTIONS_PER_IP`：每个 IP 允许的最大并发 WebSocket 连接数
- `CONNECTION_ATTEMPTS_PER_MINUTE`：每个 IP 每分钟最大握手尝试次数
- `MAX_MEMBERS_PER_ROOM`：房间成员上限
- `MAX_MESSAGE_BYTES`：WebSocket 消息字节上限
- `INVALID_MESSAGE_CLOSE_THRESHOLD`：在断开连接前允许的无效消息次数
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

### 管理后台 API

服务端现在已经内置 P0 管理后台，只读接口与主服务复用同一个 HTTP 端口。

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

鉴权方式：

- 管理接口使用 `Authorization: Bearer <token>`
- 登录成功后返回服务端签发的 session token
- `ADMIN_ROLE` 用于控制当前唯一后台账号的角色，可选 `viewer`、`operator`、`admin`
- `INSTANCE_ID` 用于标识当前服务实例，并会出现在 overview、room detail 和 audit log 中
- 写操作要求 `operator` 及以上权限
- 如果未配置管理后台环境变量，管理认证接口会返回 unavailable / unauthorized

### 1. 准备服务器

示例环境：

- Ubuntu 24.04 LTS
- 域名：`sync.example.com`
- 应用目录：`/opt/bili-syncplay`
- 服务用户：`bili-syncplay`
- 内部端口：`8787`

先安装 Node.js 20 或 22、Redis 和 Nginx，然后克隆仓库：

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

### 2. 运行 Node.js 服务器

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

### 3. 创建 systemd 服务

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

### 4. 在 WebSocket 服务器前配置 Nginx

下面先给出单机部署示例，再给出多节点 upstream 示例。单机示例适合本地或单节点生产；如果你已经启用完整多节点拓扑，应优先使用多节点示例。

> 建议
> WebSocket 是长连接场景。多节点入口优先考虑 `least_conn`，其次再考虑默认轮询；只有在上线初期需要运维兜底时再额外保留 sticky。

#### 单机 / 单节点示例

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

#### 多节点 upstream 示例

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

### 5. 启用 TLS

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

### 6. 更新扩展服务器地址

扩展支持在弹窗中切换服务器地址，因此在生产环境中你可以将客户端指向：

```text
wss://sync.example.com
```

本地测试时，切回：

```text
ws://localhost:8787
```

房间邀请现在以 `roomCode:joinToken` 的形式分享。弹窗复制操作会复制这个邀请串，加入输入框也接受同样格式。

### 7. 部署更新

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

单机 / 单进程部署重启方式：

```bash
sudo systemctl restart bili-syncplay
```

多节点部署重启方式：

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

### 8. 运维说明

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

### 故障排查

常见的开发侧失败场景：

- `无法连接到同步服务器。`：扩展无法访问配置的服务器地址，或由该地址推导出的 HTTP 健康检查失败。
- 服务端日志反复出现 `origin_not_allowed`：`ALLOWED_ORIGINS` 没有包含当前 `chrome-extension://<extension-id>`
- `房间不存在。`：请求的房间号在当前服务器实例上不存在。
- 服务重启后如果看到 `房间不存在。`，也可能表示该房间已经超过空房保留期并被清理。
- `加入码无效。`：邀请串错误、已失效，或来自其他房间。
- `成员令牌无效。`：当前会话丢失了房间绑定、服务端已经重启，或客户端需要重新加入以获取新 token。
- `请求过于频繁。`：某个房间操作或同步消息触发了配置的限流。
- 握手阶段返回 `403`：请求的 `Origin` 不在 `ALLOWED_ORIGINS` 中，或者在 `ALLOW_MISSING_ORIGIN_IN_DEV` 关闭时缺少 `Origin`。
- 连接级 IP 限制看起来未生效：检查反向代理的 socket IP 是否已加入 `TRUSTED_PROXY_ADDRESSES`；默认情况下服务器只使用真实 socket 地址。
- `请先打开一个哔哩哔哩视频页面。`：当前活动标签页 URL 不匹配扩展内容脚本的目标页面。
- `当前页面没有可播放的视频。`：内容脚本已加载，但页面没有暴露可用的视频载荷。
- `无法访问当前页面。`：Chrome 无法把消息传给内容脚本，通常是因为加载未打包扩展后没有刷新页面，或当前标签页 URL 不受支持。

常用检查：

```bash
# 服务器健康检查
curl http://127.0.0.1:8787/

# 服务器测试
npm run test -w @bili-syncplay/server

# Redis 集成回归
REDIS_URL=redis://127.0.0.1:6379 npm run test:redis -w @bili-syncplay/server

# 完整多节点回归
REDIS_URL=redis://127.0.0.1:6379 npx tsx --test server/test/multi-node-*.test.ts

# 协议测试
npm run test -w @bili-syncplay/protocol

# 扩展测试
npm run test -w @bili-syncplay/extension
```

Chrome 侧调试建议：

- 在 `chrome://extensions` 查看扩展 service worker 日志
- 从 `chrome://extensions` 复制未打包扩展 ID，并加入 `ALLOWED_ORIGINS`
- 重新构建 `extension/dist` 后，重新加载未打包扩展
- 扩展重新加载后，刷新已打开的 Bilibili 标签页，以便重新注入内容脚本

### 构建发布包

先更新 workspace 版本：

```bash
npm run release:version -- 0.9.0
```

该命令会更新：

- 根目录 `package.json`
- `packages/protocol/package.json`
- `server/package.json`
- `extension/package.json`
- `package-lock.json`

构建扩展发布 zip：

```bash
npm run build:release
```

输出：

```text
release/bili-syncplay-extension-v<version>.zip
```

### 自动化 GitHub Release

仓库已经包含一个 GitHub Actions 工作流，用于：

- 在 `v*` 标签上触发
- 构建扩展
- 创建 GitHub Release
- 上传 zip 产物

示例：

```bash
npm run release:version -- 0.9.0
git push origin main
git tag v0.9.0
git push origin v0.9.0
```

## License

本项目基于 GNU General Public License v3.0 授权。详见 [LICENSE](./LICENSE)。
