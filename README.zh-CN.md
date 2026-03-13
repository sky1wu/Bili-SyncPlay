# Bili-SyncPlay

[English](./README.md) | [简体中文](./README.zh-CN.md)

Bili-SyncPlay 是一个用于哔哩哔哩同步观影的 Chrome 扩展。用户可以创建或加入房间，分享当前视频，并在参与者之间同步播放、暂停、跳转和播放速率。

本仓库是一个 monorepo，包含：
- Chrome 扩展
- WebSocket 房间服务器
- 共享协议包

## 功能

- 创建房间并获取邀请串
- 使用 `roomCode:joinToken` 加入房间
- 在扩展弹窗中分享当前页面视频
- 同步播放、暂停、跳转和播放速率
- 房间成员自动打开当前共享的视频
- 在页面内显示房间提示，包括：
  - 成员加入和离开
  - 共享视频变更
  - 播放和暂停
  - 跳转
  - 播放速率变更
- 在仍处于房间内时，保持未共享页面为本地模式
  - 未共享页面不会把播放状态广播回房间
  - 在未共享页面上的手动播放仅在本地生效
- 支持多种 Bilibili 页面类型：
  - `https://www.bilibili.com/video/*`
  - `https://www.bilibili.com/bangumi/play/*`
  - `https://www.bilibili.com/festival/*`
  - `https://www.bilibili.com/list/watchlater*`，且页面 URL 中带有 `bvid`
  - `https://www.bilibili.com/medialist/play/watchlater*`，且页面 URL 中带有 `bvid`
- 支持分 P / 分集变体：
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

## 快速开始

### 加载扩展

1. 运行 `npm install`
2. 运行 `npm run build`
3. 打开 `chrome://extensions`
4. 开启开发者模式
5. 点击 `加载已解压的扩展程序`
6. 选择 `extension/dist`

### 启动本地服务器

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

默认服务器地址：

```text
ws://localhost:8787
```

### 基本使用

1. 打开扩展弹窗
2. 创建房间，或者使用邀请串加入已有房间
3. 打开受支持的 Bilibili 视频页面
4. 在弹窗中点击 `Sync current page video`
5. 其他房间成员会打开同一视频并进入同步模式
6. 如果成员在仍处于房间时浏览到其他未共享视频页面，该页面会保持本地模式，除非他们显式再次同步，否则不会影响房间

## 开发参考

### 本地开发

安装依赖：

```bash
npm install
```

构建全部内容：

```bash
npm run build
```

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
npm run test -w @bili-syncplay/extension
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
- 只有在浏览器会话中仍保留 `roomCode` 和 `joinToken` 时，弹窗才能重新进入当前房间
- `memberToken` 会在断开连接时被有意清除，并在重新加入成功后重新签发
- 如果持久化的服务器地址非法，扩展会保留原始值并停止自动重连，直到地址被修正
- 关闭浏览器后，下次启动不会自动恢复之前的房间

### 服务器部署

推荐环境：
- Node.js 20 或 22
- Nginx 反向代理
- 生产环境使用 `wss://` 服务器地址

扩展支持在弹窗中切换服务器地址，因此你可以从本地开发切换到已部署的服务器，例如：

```text
wss://sync.example.com
```

扩展的服务器地址只接受 `ws://` 和 `wss://`；空输入会回退到默认值 `ws://localhost:8787`。

本地开发时，`ALLOWED_ORIGINS` 必须包含当前 `chrome-extension://<extension-id>`，否则服务端会以 `origin_not_allowed` 拒绝 WebSocket 握手。

当前服务器实现：
- 仅监听 `PORT`，默认值为 `8787`
- 在同一个端口上同时提供 WebSocket 流量和简单健康检查
- 对 `GET /` 返回 `{"ok":true,"service":"bili-syncplay-server"}`
- 仅在内存中保存房间状态和 token
- 房间加入需要 `roomCode + joinToken`，房间消息需要 `memberToken`
- 支持 Origin 白名单、连接限流、消息限流和结构化安全日志

### 安全相关环境变量

服务器支持以下环境变量。虽然内置了安全默认值，但生产环境应显式设置：

- `ALLOWED_ORIGINS`：逗号分隔的 WebSocket `Origin` 白名单
- 如果 `ALLOWED_ORIGINS` 为空，服务器默认拒绝所有显式 `Origin`
- `ALLOW_MISSING_ORIGIN_IN_DEV`：设为 `true` 时允许缺失 `Origin` 头
- `TRUST_PROXY_HEADERS`：仅在设为 `true` 时，使用 `X-Forwarded-For` 做连接级 IP 限制
- `MAX_CONNECTIONS_PER_IP`：每个 IP 允许的最大并发 WebSocket 连接数
- `CONNECTION_ATTEMPTS_PER_MINUTE`：每个 IP 每分钟最大握手尝试次数
- `MAX_MEMBERS_PER_ROOM`：房间成员上限
- `MAX_MESSAGE_BYTES`：WebSocket 消息字节上限
- `INVALID_MESSAGE_CLOSE_THRESHOLD`：在断开连接前允许的无效消息次数
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
TRUST_PROXY_HEADERS=true \
MAX_CONNECTIONS_PER_IP=10 \
CONNECTION_ATTEMPTS_PER_MINUTE=20 \
MAX_MEMBERS_PER_ROOM=8 \
MAX_MESSAGE_BYTES=8192 \
node server/dist/index.js
```

### 1. 准备服务器

示例环境：
- Ubuntu 24.04 LTS
- 域名：`sync.example.com`
- 应用目录：`/opt/bili-syncplay`
- 服务用户：`bili-syncplay`
- 内部端口：`8787`

先安装 Node.js 20 或 22 以及 Nginx，然后克隆仓库：

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
PORT=8787 node server/dist/index.js
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
{"ok":true,"service":"bili-syncplay-server"}
```

### 3. 创建 systemd 服务

创建独立用户：

```bash
sudo useradd --system --home /opt/bili-syncplay --shell /usr/sbin/nologin bili-syncplay
sudo chown -R bili-syncplay:bili-syncplay /opt/bili-syncplay
```

创建 `/etc/systemd/system/bili-syncplay.service`：

```ini
[Unit]
Description=Bili-SyncPlay WebSocket server
After=network.target

[Service]
Type=simple
User=bili-syncplay
Group=bili-syncplay
WorkingDirectory=/opt/bili-syncplay
Environment=PORT=8787
Environment=ALLOWED_ORIGINS=chrome-extension://<extension-id>,https://sync.example.com
ExecStart=/usr/bin/node /opt/bili-syncplay/server/dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bili-syncplay
sudo systemctl status bili-syncplay
```

查看日志：

```bash
sudo journalctl -u bili-syncplay -f
```

### 4. 在 WebSocket 服务器前配置 Nginx

创建 `/etc/nginx/sites-available/bili-syncplay.conf`：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

limit_conn_zone $binary_remote_addr zone=conn_per_ip:10m;
limit_req_zone $binary_remote_addr zone=req_per_ip:10m rate=20r/m;

server {
    listen 80;
    server_name sync.example.com;

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

当你更新服务器代码时：

```bash
cd /opt/bili-syncplay
git pull
npm install
npm run build -w @bili-syncplay/server
sudo systemctl restart bili-syncplay
```

如果共享协议包也发生变化，则改为同时构建两个包：

```bash
npm run build -w @bili-syncplay/protocol
npm run build -w @bili-syncplay/server
```

### 8. 运维说明

- 服务器没有数据库；进程重启后所有房间都会被清空。
- 最后一个成员离开后，房间会立即删除。
- 加入房间需要同时提供 `roomCode` 和 `joinToken`；发送房间消息需要有效的 `memberToken`。
- `memberToken` 绑定到会话，并会在重连后重新签发。
- 握手阶段的 Origin 检查默认拒绝，除非你在开发环境中显式允许缺失 `Origin`。
- 只有在 `TRUST_PROXY_HEADERS=true` 时才会读取 `X-Forwarded-For`。
- 健康检查为 `GET /`；目前没有单独的 `/healthz` 路由。
- 如果你使用云防火墙，请放行入站 `80` 和 `443`，并将 `8787` 仅暴露给 localhost。
- 如果你不想使用 Nginx，也可以直接暴露 Node 服务，但浏览器和扩展仍应通过带有效 TLS 证书的 `wss://` 连接。
- 房间状态只存在于单个 Node.js 进程内。如果在负载均衡后运行多个服务器实例，房间会被拆分，除非你补充共享状态和路由亲和性。
- 目前依然没有持久化。当前服务器应被视为一个小型、单实例部署，带有最基础的内建认证和限流能力。

### 故障排查

常见的开发侧失败场景：
- `Cannot connect to sync server.`：扩展无法访问配置的服务器地址，或由该地址推导出的 HTTP 健康检查失败。
- 服务端日志反复出现 `origin_not_allowed`：`ALLOWED_ORIGINS` 没有包含当前 `chrome-extension://<extension-id>`
- `Room not found.`：请求的房间号在当前服务器实例上不存在。
- `Join token is invalid.`：邀请串错误、已失效，或来自其他房间。
- `Member token is invalid.`：当前会话丢失了房间绑定，需要重新加入。
- `Too many requests.`：某个房间操作或同步消息触发了配置的限流。
- 握手阶段返回 `403`：请求的 `Origin` 不在 `ALLOWED_ORIGINS` 中，或者在 `ALLOW_MISSING_ORIGIN_IN_DEV` 关闭时缺少 `Origin`。
- 连接级 IP 限制看起来未生效：检查你是否真的想启用 `TRUST_PROXY_HEADERS`；默认情况下服务器只使用真实 socket 地址。
- `Please open a Bilibili video page first.`：当前活动标签页 URL 不匹配扩展内容脚本的目标页面。
- `Current page does not have a playable video.`：内容脚本已加载，但页面没有暴露可用的视频载荷。
- `Cannot access the current page.`：Chrome 无法把消息传给内容脚本，通常是因为加载未打包扩展后没有刷新页面，或当前标签页 URL 不受支持。

常用检查：

```bash
# 服务器健康检查
curl http://127.0.0.1:8787/

# 服务器测试
npm run test -w @bili-syncplay/server

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
npm run release:version -- 0.5.4
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
npm run release:version -- 0.5.4
git push origin main
git tag v0.5.4
git push origin v0.5.4
```

## License

本项目基于 GNU General Public License v3.0 授权。详见 [LICENSE](/d:/workspace/Bili-SyncPlay/LICENSE)。
