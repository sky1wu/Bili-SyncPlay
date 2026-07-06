# 开发指南

[English](./development.md) | [简体中文](./development.zh-CN.md)

Bili-SyncPlay 开发者参考：本地命令、依赖审计门禁、基准压测、代码组织约定、贡献约束、运行时行为、状态持久化、故障排查与发布打包。项目概览与快速开始见 [README](../README.zh-CN.md)。

## 本地开发

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
- `npm test`：执行 audit gate 测试，以及 protocol、server、extension 的全仓测试
- `npm run audit`：执行依赖审计门禁；未进入白名单的 `high` 或 `critical` 漏洞会导致失败
- `npm run test:audit-gate`：执行依赖审计门禁的单元测试
- `npm run test:server:redis`：显式执行 server 的 Redis 持久化回归测试

开发约定：

- 保持入口文件轻量化，并且让共享规则维持单一来源。
- 本地检查前先执行 `npm install` 安装依赖；CI 中统一先执行 `npm ci`，再跑同一套校验流程。
- 提交前执行 `npm run lint`、`npm run format:check`、`npm run typecheck`、`npm run build`、`npm test`。
- 完整贡献约束见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 依赖审计门禁

CI 会在 `npm ci` 后执行 `npm run audit`。该门禁会运行 `npm audit --json --audit-level=high`，只要发现未被 [`audit-allowlist.json`](../audit-allowlist.json) 中有效条目覆盖的 `high` 或 `critical` 漏洞，就会失败。

当出现 high 级别审计结果时：

1. 优先升级或替换存在漏洞的依赖，并提交对应 lockfile 变更。
2. 如果暂时没有可用修复且风险已经评估，可以使用 audit gate 输出的 ID 添加短期白名单条目：

```json
{
  "id": "npm:<package>:<advisory-source>",
  "expires": "YYYY-MM-DD",
  "reason": "为什么可以短期接受，以及后续如何移除"
}
```

3. 过期时间应尽量短。过期、格式错误或缺少过期时间的条目都会自动让门禁失败。
4. 修复或移除漏洞依赖时，应在同一变更中删除对应白名单条目。

## 基准压测

`bench/` 下提供了可复现的基准脚本，覆盖三类主要高负载场景。

命令：

```bash
npm run bench:single-room
npm run bench:redis-broadcast
npm run bench:reconnect-storm
npm run bench:ci-light
```

每个脚本都会把标准化 JSON 打到 stdout，也可以用 `--output <path>` 落盘。

示例：

```bash
npm run bench:single-room -- --output .tmp/bench-single.json
npm run bench:redis-broadcast -- --duration-seconds 30 --sample-watchers 12
npm run bench:reconnect-storm -- --members 500 --output .tmp/bench-reconnect.json
```

默认场景：

- `bench:single-room`：单节点、单房间、100 成员，`playback:update` 以 10 Hz 连续发送 60 秒
- `bench:redis-broadcast`：两台 room node 通过 Redis 互联，负载与上面一致，owner 固定在节点 A，其余成员固定在节点 B
- `bench:reconnect-storm`：同一房间 500 成员先断线，再同时带旧 `memberToken` 回连
- `bench:ci-light`：面向 CI 的轻量烟雾基线，覆盖一个小规模单节点广播场景和一个小规模重连风暴场景

CI 基线行为：

- `bench:ci-light` 会读取 `bench/ci-light-baseline.json`，运行轻量场景，并输出 `results.json`、`comparison.json` 和 `summary.md`。
- CI 只在“明显退化”时失败：错误率超过配置上限，或 `P95` 延迟超过基线倍数阈值。
- `.github/workflows/ci.yml` 会把这些结果作为 artifact 上传，方便在 PR 里回看原始数据。

Redis 行为：

- `bench:redis-broadcast` 在设置了 `REDIS_URL` 时会直接复用该实例。
- 如果没有设置 `REDIS_URL`，且 `PATH` 中存在 `redis-server`，脚本会自动拉起一个临时本地 Redis。
- 结果 JSON 结构固定、便于 diff：配置、吞吐、延迟百分位（`P50` / `P95` / `P99`）和错误率都会按同一 schema 输出。

结果结构：

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

说明：

- 广播延迟默认只从可配置数量的 watcher socket 采样，避免压测器自己在每次广播上串行等待全量客户端确认。
- 重连延迟统计的是从 socket 打开到回房后收到第一条 `room:state` 的完整耗时。

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

## 代码组织约定

仓库遵循“薄入口 + 具名模块”的组织方式。运行时视角——系统组成、同步数据流与 controller 职责——见[架构概览](./architecture.zh-CN.md)。

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

回归测试按这些边界组织，不只覆盖“功能能不能跑通”，也覆盖 store/controller/helper 的关键行为。

## 贡献约束

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
- 重新进入已有房间需要保存的 `joinToken`；断开连接后，旧的 `memberToken` 会被丢弃
- 如果你修改了协议类型或消息校验，需要重新构建 `packages/protocol` 和 `server`
- 本地服务器默认会拒绝扩展连接，除非 `ALLOWED_ORIGINS` 包含当前 `chrome-extension://<extension-id>`
- 你可以在 `chrome://extensions` 中查看未打包扩展的 ID

Chrome 显示的扩展版本来自 `extension/dist/manifest.json`。
构建过程中，该 manifest 版本会根据根目录 `package.json` 自动生成。

## 运行时行为

- 如果用户在加入房间前点击 `Sync current page video`，扩展会先提示创建房间
- 如果房间当前已经共享了另一个视频，弹窗会在替换前请求确认
- background service worker 只会转发当前识别为共享标签页的播放更新
- 切换服务器地址会断开当前 socket；如果扩展仍有活动房间或待创建房间，会使用新地址重新连接
- 如果持久化的服务器地址非法，扩展会保留该值并阻止自动重连，直到用户修正地址
- 支持的播放页面依赖 Bilibili 的 DOM 和 URL 模式，因此如果 Bilibili 后续改版，festival 页面和稍后再看页面可能需要兼容性更新

## 状态持久化

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

## 故障排查

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

## 构建发布包

先更新 workspace 版本：

```bash
npm run release:version -- 1.3.0
```

该命令会更新：

- 根目录 `package.json`
- `packages/protocol/package.json`
- `server/package.json`
- `extension/package.json`
- `package-lock.json`

脚本重写的 JSON 与 manifest 文件可能不符合 Prettier 风格，提交版本号变更前先执行 `npm run format:check`（必要时 `npm run format`）。

构建扩展发布包：

```bash
npm run build:release          # Chrome/Edge + Firefox
npm run build:release:chrome   # 仅 Chrome/Edge zip
npm run build:release:firefox  # 仅 Firefox zip + xpi
```

输出：

```text
release/bili-syncplay-extension-v<version>-chrome.zip
release/bili-syncplay-extension-v<version>-firefox.zip
release/bili-syncplay-extension-v<version>-firefox.xpi
```

`.xpi` 与 Firefox zip 字节一致，Firefox 用户可直接拖入浏览器安装。

## 自动化 GitHub Release

`v*` 标签会触发两个 GitHub Actions 工作流：

- `release.yml` 构建双浏览器目标，并创建 GitHub Release，附带 Chrome/Edge zip 与 Firefox zip + xpi
- `docker-release.yml` 构建服务端容器镜像并推送 GHCR（`ghcr.io/sky1wu/bili-syncplay-server`）；配置了 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` 仓库 secrets 时同步推送 Docker Hub，未配置时跳过且不影响发布

示例：

```bash
npm run release:version -- 1.3.0
git push origin main
git tag v1.3.0
git push origin v1.3.0
```
