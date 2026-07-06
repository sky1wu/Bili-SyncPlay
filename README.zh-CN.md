# Bili-SyncPlay

[English](./README.md) | [简体中文](./README.zh-CN.md)

Bili-SyncPlay 是一个“浏览器扩展（Chrome / Edge / Firefox）+ WebSocket 服务端”的哔哩哔哩同步观影项目。用户可以创建或加入房间，分享当前视频，并在参与者之间同步播放、暂停、跳转和播放速率。

它覆盖了完整的本地使用链路：

- 在 Chrome / Edge / Firefox 121+ 中加载未打包扩展
- 启动本地同步服务
- 创建房间并复制邀请串
- 让多个成员保持同一共享视频的同步播放

本仓库是一个 monorepo：

- `extension/`：浏览器扩展（Chrome / Edge / Firefox）
- `server/`：WebSocket 房间服务与管理后台
- `packages/protocol/`：共享协议类型

## 一眼看懂

- 邀请格式：`roomCode:joinToken`
- 默认本地服务地址：`ws://localhost:8787`
- 本地开发浏览器：Chrome、Edge、Firefox 121+
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

**Chrome / Edge**（`npm run build` 产出 `extension/dist`）：

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 点击 `加载已解压的扩展程序`
4. 选择 `extension/dist`

**Firefox 121+**（先构建 Firefox 目标）：

```bash
npm run build:extension:firefox   # 产出 extension/dist-firefox
```

1. 打开 `about:debugging#/runtime/this-firefox`
2. 点击 `临时载入附加组件…`
3. 选择 `extension/dist-firefox/manifest.json`

Firefox 构建产出 event page 形态后台（`background.scripts`，因 Firefox 不支持 MV3 `background.service_worker`），并覆盖扩展 CSP，使明文 `ws://` 服务端不会被强制升级为 `wss://`。临时附加组件在 Firefox 关闭后移除，每次重启需重新载入。

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

**Firefox Origin 说明。** Firefox 给每个安装分配随机 `moz-extension://<uuid>`（重装会变、各用户不同），不像 Chrome 固定扩展 ID 那样有一个通用值：

- 自建 / 少数用户：从 `about:debugging`（扩展的 Internal UUID / 清单 URL）或服务端被拒握手日志读到该 UUID，把这个精确的 `moz-extension://<uuid>` 加入 `ALLOWED_ORIGINS`；重装扩展后需更新。
- 公共 / 共享服务端：设 `ALLOW_ANY_FIREFOX_EXTENSION_ORIGIN=true`，接受任意格式正确的 `moz-extension://<uuid>` 而无需逐一枚举。它仍拒绝网页 Origin，且不替代房间/成员 token 鉴权（见[安全相关环境变量参考](./docs/reference/security-env.zh-CN.md)）。

Firefox 把扩展后台视为安全上下文，非 localhost 服务端必须用 `wss://`；Firefox 构建已覆盖扩展 CSP，使本地开发时 `ws://localhost` 不被强制升级。

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
  extension/            浏览器扩展（Chrome/Edge/Firefox）
  server/               WebSocket 房间服务器
  packages/protocol/    共享协议类型
  scripts/              发布打包脚本
  docs/                 运维、迁移和政策文档
  .github/workflows/    GitHub Actions 工作流
```

## 文档入口

- [文档索引](./docs/README.md)
- [开发指南](./docs/development.zh-CN.md)——本地命令、测试、基准压测、代码组织、故障排查、发布打包
- [服务器部署指南](./docs/operations/deployment.zh-CN.md)——构建、systemd、Nginx、TLS、更新流程
- [多节点部署与全局管理面](./docs/operations/multi-node.zh-CN.md)
- [安全相关环境变量](./docs/reference/security-env.zh-CN.md)
- [管理面板与 API](./docs/reference/admin-api.zh-CN.md)
- [多节点运维 Runbook](./docs/runbook/multi-node-operations.zh-CN.md)
- [多节点全局管理面迁移说明](./docs/operations/multi-node-global-admin-migration.zh-CN.md)
- [隐私权政策](./docs/legal/privacy.zh-CN.md)

## 环境要求

### 版本矩阵

| 依赖          | 最低版本                  | 推荐版本    | 说明                                                                               |
| ------------- | ------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| Node.js       | 22.5                      | 22 LTS      | 参见 `.nvmrc`；Node 18/20 已 EOL，ESLint 10 需 ≥20.19，`npm run coverage` 需 ≥22.5 |
| npm           | 10                        | 10          | 随对应 Node.js 版本附带                                                            |
| Chrome / Edge | 当前稳定版                | 当前稳定版  | 用于加载未打包扩展                                                                 |
| Firefox       | 121                       | 当前稳定版  | 可选；使用 Firefox 构建（`dist-firefox`，event page 后台）                         |
| Redis         | 6.0                       | 7+          | 单机模式可选；**多节点部署和重启后持久化必须使用**                                 |
| 反向代理      | 任意支持 WebSocket 的代理 | Nginx 1.18+ | 生产环境中用于 TLS 终止和 `wss://`                                                 |

### 非目标

- **无 Redis 时不做多节点一致性保证。** 当 `ROOM_STORE_PROVIDER=memory` 时，每个服务实例各自维护房间状态。连接到不同节点的成员会看到不同的房间。
- **不内置负载均衡。** 多节点部署依赖外部入口层（Nginx、HAProxy、云 SLB/ALB）分发 WebSocket 连接，服务端本身不实现 L4/L7 负载均衡。
- **不恢复浏览器会话。** 房间成员状态（`roomCode`、`joinToken`、`memberToken`）存储在 `chrome.storage.session`，浏览器关闭后即清除。用户需在下次打开浏览器后重新加入房间。
- **不提供终端用户账号系统。** 房间访问仅通过 `roomCode:joinToken` 邀请串控制，没有面向观众的注册或登录机制。
- **不支持移动端浏览器或 Safari。** 扩展为 Manifest V3：Chrome/Edge（service worker 后台）与 Firefox 121+（event page 后台）；Safari 与移动端浏览器不在范围内。

## 本地默认值

- 默认服务器地址：`ws://localhost:8787`
- 服务器地址输入为空时，会回退到构建时默认值
- 仅接受 `ws://` 和 `wss://`
- 本地未打包扩展开发要求 `ALLOWED_ORIGINS=chrome-extension://<extension-id>`（Chrome/Edge）或当前 `moz-extension://<uuid>` / `ALLOW_ANY_FIREFOX_EXTENSION_ORIGIN=true`（Firefox；见“启动本地服务器”）

如需在本地或生产环境打开管理控制面板，见[管理面板与 API](./docs/reference/admin-api.zh-CN.md)。

## Docker 部署

服务端在每个 `v*` release tag 上同步发布容器镜像：

- `ghcr.io/sky1wu/bili-syncplay-server`（[GHCR package 页面](https://github.com/sky1wu/Bili-SyncPlay/pkgs/container/bili-syncplay-server)）
- `docker.io/sky1wu/bili-syncplay-server`（[Docker Hub 页面](https://hub.docker.com/r/sky1wu/bili-syncplay-server)，镜像仓库）

以上是 `docker pull` 用的镜像引用，不是网页地址——浏览器访问请用括号里的链接。

镜像 tag 包括 `latest`、`<major>.<minor>` 和完整版本号（如 `1.2.2`），支持 `linux/amd64` 与 `linux/arm64` 双架构。

直接运行：

```bash
docker run -d --name bili-syncplay-server \
  -p 8787:8787 \
  -e ALLOWED_ORIGINS=chrome-extension://lbmckljnginagfabglpfdepofoglfdkj \
  ghcr.io/sky1wu/bili-syncplay-server:latest
```

也可以使用仓库内的 [`docker-compose.yml`](./docker-compose.yml)，其中附带可选的 Redis 服务，用于多节点或需要重启后保留状态的部署。

说明：

- 容器监听 `8787`（可用 `PORT` 覆盖），提供 `/healthz` 与 `/readyz`，并内置 Docker `HEALTHCHECK`。
- 配置完全通过环境变量完成，与裸机部署一致：`ALLOWED_ORIGINS`（扩展连接必填）、Redis 持久化（需同时设置 `ROOM_STORE_PROVIDER=redis` 与 `REDIS_URL`，只设 `REDIS_URL` 仍是内存存储）、管理面板变量（`ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` / `ADMIN_SESSION_SECRET`）等——参见[安全相关环境变量参考](./docs/reference/security-env.zh-CN.md)和[多节点运维手册](./docs/runbook/multi-node-operations.zh-CN.md)。
- 生产环境应在前置反向代理终结 TLS，让扩展通过 `wss://` 连接（见版本矩阵）。
- 从源码构建：在仓库根目录执行 `docker build -t bili-syncplay-server .`（镜像只包含服务端，扩展另行分发）。

维护者说明：`Docker Release` workflow 使用内置 `GITHUB_TOKEN` 自动推送 GHCR；如需同步发布 Docker Hub，配置仓库 secrets `DOCKERHUB_USERNAME` 与 `DOCKERHUB_TOKEN`，缺省时会跳过 Docker Hub 推送而不影响发布。

## License

本项目基于 GNU General Public License v3.0 授权。详见 [LICENSE](./LICENSE)。
