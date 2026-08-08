# 自动化实机测试：实施任务

**状态：待实施。本文所有任务均未开始。**

**基线：`6cc0702`（2026-08-03）。** 任务中的拟议目录和命令只有在对应任务完成后才存在，不能把本文当作当前可运行的操作手册。

相关文档：

- [需求规格](./automated-real-browser-testing-requirements.zh-CN.md)
- [技术设计](./automated-real-browser-testing-design.zh-CN.md)

## 1. 执行原则

1. 按里程碑拆成小 PR；前一 PR 合并后再开始有重叠文件的下一块。
2. Phase 0 的高风险假设必须先用可执行 spike 证明，再建立长期框架。
3. 每个流程类产物必须从仓库根目录按真实使用顺序端到端执行，不能只验证单个 helper。
4. 每条产品回归测试必须证明缺少对应实现时会失败；用独立 worktree、临时提交或文件备份进行判别力验证，禁止用 `git restore`/`git checkout <file>` 覆盖用户修改。
5. 第一阶段不修改同步协议；若后续确需协议观测字段，必须另开设计和 PR，按协议版本清单执行。
6. 实机和真实站点能力未准备好时，不得降低确定性 Chromium 门禁的范围来迁就它们。

## 2. 里程碑和依赖

```text
M0 技术可行性
  └─ M1 E2E workspace 与基础设施
       └─ M2 P0 双客户端 smoke
            ├─ M3 操作与页面矩阵
            └─ M4 管理后台 E2E
M3 + M4
  └─ M5 CI 硬门禁
       └─ M6 Windows / Firefox / 真实站点
            └─ M7 状态模型与长期治理
```

M3 和 M4 可在 M2 合并后并行开发，但会同时修改 `packages/e2e` 公共 fixture 时应分支协调，避免一个大 PR 混入两套行为。M2 完成后可以先运行非 required smoke；M5 必须等 M3、M4 全部合并，不能让范围不完整的阶段性 smoke 冒充需求规格第 8 节定义的 PR 硬门禁。

## 3. 建议 PR 切分

| PR    | 范围                                                                         | 明确不包含                 |
| ----- | ---------------------------------------------------------------------------- | -------------------------- |
| PR 1  | Phase 0 spike 结果、依赖选型和已验证设计修订                                 | 全操作矩阵、Windows runner |
| PR 2  | `packages/e2e`、资源生命周期、操作覆盖基础设施、页面夹具、最小扩展启动测试   | 双客户端房间旅程           |
| PR 3  | P0 双客户端 create/join/share/play/seek/rate/pause/leave                     | 页面全矩阵、管理后台       |
| PR 4  | Popup 与五种页面/导航场景                                                    | 生命周期故障、管理后台     |
| PR 5  | 播放、缓冲、回声、并发、重连、所有权和 reaper 故障场景                       | CI required check          |
| PR 6  | 管理后台真实客户端治理 E2E                                                   | Windows/Firefox            |
| PR 7  | GitHub-hosted `browser-e2e`、artifact、追踪、完整套件 soak 与 required check | 真实 Bilibili              |
| PR 8  | 受保护 Windows runner、Chrome/Edge、WSL 跨时钟                               | Firefox、登录账号          |
| PR 9  | Firefox WebDriver/XPI smoke                                                  | 真实站点                   |
| PR 10 | 真实站点 canary、三态结果、告警和发布门禁                                    | 无界随机测试               |
| PR 11 | 有界状态模型、fixture 漂移和维护看板                                         | 新产品行为                 |

若某个 PR 同时需要大幅改动 extension 生产代码和 E2E 框架，应再次拆分：先让测试稳定地暴露问题，再单独提交产品修复。

## 4. M0：技术可行性 spike

### E2E-001：锁定工具版本和最小 workspace 草案

- **需求**：REQ-G02、REQ-F001、REQ-N001
- **工作**：评估并锁定 `@playwright/test`；记录 Node、Chromium、Playwright、`redis-server` 和 `redis-cli` 的版本兼容关系，以及 Linux/WSL 本地工具链与 CI service 镜像的取得方式。草拟 `@bili-syncplay/e2e` package 和 tsconfig，但暂不展开场景；为第 11 节分阶段预算建立统一的耗时、CPU、内存和 artifact 大小采样格式。
- **验收**：从仓库根目录可启动一个只打开空白 Chromium persistent context 的 spike；退出码、超时和浏览器关闭均被断言，并记录第一份资源样本。另记录受支持 Redis 版本的实际 `redis-server --version` / `redis-cli --version` 输出；若目标本地环境尚未安装，必须给出明确安装前置条件，不能把 managed 模式标成已验证。
- **估算**：0.5～1 天

### E2E-002：证明真实扩展可加载

- **依赖**：E2E-001
- **需求**：REQ-G02、REQ-F002、REQ-F003
- **工作**：构建 `extension/dist`，复制到本次 spike 独占且启动后不可变的临时目录，再加载到 persistent context，发现 MV3 service worker 和 extension ID；分别用扩展页 URL 和 `chrome.action.openPopup()` 打开 popup。完成初始断言后显式关闭 action popup，确认其文档和 runtime port 均已消失，再用选定的浏览器调试协议路径定位并终止该扩展的 worker target；随后创建全新 action popup，以其当前生产顺序中的首个 runtime port 连接触发 worker 恢复，状态查询只验证生产查询路径与合法 bootstrap 过渡态，不新增生产测试消息；content 与房间恢复闭环留给已建立页面夹具和双客户端房间的 E2E-004。
- **验收**：断言 manifest 版本与根 `package.json` 一致、service worker URL 属于发现的扩展 ID、popup 渲染连接状态和房间表单；action popup 打开前后的活动 tab 都是目标 Bilibili tab。终止步骤必须记录旧 popup 文档关闭、旧 port 断开、目标 ID 和终止确认，证明旧执行上下文已经失效；恢复步骤必须记录不同的新 popup 文档标识、port 连接、随后状态查询和新 worker target 创建时刻，证明实际首个 port 事件负责唤醒。查询若遇到 bootstrap pending 可以返回结构合法的过渡态，不能要求它立即反映持久化状态，也不能等待当前生产代码不会发送的 bootstrap 完成通知；本任务以新 worker target、port 应答和合法查询结果证明恢复，持久化房间状态的最终收敛由 E2E-004 在真实房间和服务端重连路径验收。扩展 ID、构建副本和连接目标保持不变。若生产顺序变化，spike 必须按观测更新适配器，不能复用旧 popup 或跳过 port 把查询伪装成首事件。若 Playwright 当前能力无法稳定完成，M0 必须调整适配器或范围，不能把 `terminateBackground()` 留作未验证假设。
- **判别力检查**：改用一个不存在的扩展目录时必须在启动阶段失败，不能退化为空浏览器仍报通过；改为不存在或其他扩展的 worker target 时终止验收必须失败，不能由刷新 popup、重载扩展或等待自动重试伪装成成功。
- **估算**：1 天

### E2E-003：证明 Bilibili route fixture 会注入 content script

- **依赖**：E2E-002
- **需求**：REQ-F020、REQ-N002
- **工作**：对 `https://www.bilibili.com/video/<test-id>` fulfil 最小 HTML 和媒体，验证 manifest content script、page bridge、视频绑定和页内分享按钮。
- **验收**：不访问公网；地址栏保留 Bilibili URL；页面能返回当前视频身份；禁用扩展时同一断言失败。
- **决策点**：若 route fulfil 不稳定，实测并记录 HTTPS fixture server + `host-resolver-rules` 回退方案。
- **估算**：1～2 天

### E2E-004：证明双 profile、Origin、服务端握手和房间内 worker 恢复

- **依赖**：E2E-003
- **需求**：REQ-G03、REQ-F003、REQ-F004、REQ-F010、REQ-F032
- **工作**：先生成 run-scoped 临时 CA、SAN 只包含 `wssUrl` 实际回环主机名/IP 的叶证书和仅供隔离 profile 使用的信任描述，再启动独占 bootstrap sink，并把测试构建默认服务端地址指向它；随后同时启动 owner/member 两个临时 profile，发现各自扩展 Origin，用这些 Origin 创建随机端口同步服务端和 HTTPS/WSS facade。popup 保存 `wss://` 后继续点击创建房间，以真实用户入口触发连接；member 加入同一房间后，owner 通过真实 action popup 分享当前 fixture 视频，并确认 member 已导航、绑定同一规范化共享 URL。关闭分享用 popup 并确认其文档及 port 消失后，用 E2E-002 已证明的调试协议路径执行两个独立终止周期：第一次在目标消失后创建全新 action popup，由真实入口先建立 runtime port、再查询状态，最终通过后续 port 更新和服务端收敛验证房间恢复；待重连稳定后关闭该 popup、再次确认文档及 port 消失，再终止 worker 并确认目标仍不存在，随后重载 owner 的共享视频 tab，由新注入的生产 content script 按当前顺序先发送页内分享按钮设置 hydration 以唤醒 worker，再执行房间 hydration；待新 worker 完成 bootstrap 与重连后，由 owner 在同一视频执行真实播放操作并验证跨端同步。
- **验收**：两个 profile 的 storage、tab 和 background 不共享；启动阶段只命中 bootstrap sink，即使本机 `localhost:8787` 放置诱饵服务也收不到请求；同步服务端精确允许本次 Origin，第三个伪造网页 Origin 被拒绝。保存 `wss://` 本身先验证持久化，随后创建/加入/分享必须让扩展 background 依次完成 HTTPS `/api/connection-check`、`/` 预检以及真实 TLS、WebSocket 和同步协议握手，且分享前后直接从双方 popup、member 播放器和本 spike 服务端的只读 admin API 响应逐项证明房间已有同一共享视频；M0 不依赖 E2E-201 才实现的可复用 room oracle。两个终止周期都必须记录各自目标 ID、旧执行上下文失效、实际首个生产事件和新 target 创建时刻：popup 周期必须证明旧 popup 文档及 port 已消失、新 popup 文档标识不同，并如实记录新 port 连接先于状态查询；bootstrap pending 时首次查询允许返回结构合法的过渡态，不能把它当成恢复结论，新 worker 最终必须以相同扩展 ID、服务端地址、房间代码和成员 token 重连，后续 port 状态恢复已加入且服务端在稳定窗口内不存在重复成员。content 周期必须如实记录 tab 重载后的首个 `content:get-page-share-button-settings` 先于 `content:get-room-state`，在页面重载动作前不得出现新 worker target 或 popup、alarm、自动重试等其他唤醒源，设置消息发出后必须创建新 worker，随后的房间 hydration 经生产重试路径完成，真实播放更新再从已恢复的 owner background 到达 member 播放器并稳定收敛。若生产顺序变化，必须更新首事件断言并保留后续闭环，不能复用旧 popup 或绕开先行消息让查询/房间 hydration 冒充唤醒源。若只终止一次、跳过建房或分享、只恢复未入房 popup，或通过重载扩展/测试后门恢复，REQ-F032 验收必须失败。临时信任不修改系统信任库，SAN 不匹配、错误 CA、非本 run 证书和公网回退均失败，profile 删除后无证书状态残留。
- **估算**：1～2 天

### E2E-005：校准媒体事件和时间策略

- **依赖**：E2E-003、E2E-004
- **需求**：REQ-F021～REQ-F023、REQ-O002、REQ-O006
- **工作**：在 headless/headed Chromium 中采样 play、pause、seek、rate、waiting、canplay、ended；结合 `playback-reconcile.ts` 当前阈值测 paused/playing 收敛分布和消息数量。
- **验收**：形成包含样本量、P50/P95/P99、建议容差、等待上限和消息上限的 JSON/Markdown 结果；结果能区分真实失败和调度噪声。
- **估算**：1～2 天

### E2E-006：验证稳定版浏览器和 Firefox 的加载路径

- **依赖**：E2E-001
- **需求**：REQ-F050、REQ-F051
- **工作**：在目标 Windows 机器验证当前稳定版 Chrome/Edge 能否加载当前 commit 产物；用 Selenium/geckodriver 临时安装 Firefox XPI，发现内部 UUID 并打开 popup。为 Firefox 实测仅作用于临时 profile 的代理或 DNS 映射、临时 CA 和回环 HTTPS fixture，使 `www.bilibili.com` / `api.bilibili.com` 请求保持目标 Origin 且不访问公网。
- **验收**：每个浏览器记录“源码构建可测”或“只能验证签名发布产物”，附实际命令、版本和限制；Firefox 还须证明 content script/page bridge 注入、所有目标请求命中本地 fixture、profile 删除后不残留 hosts/证书/代理变更。不能验证的能力必须从设计矩阵中降级，不得保留假设。
- **估算**：3～4 天

### E2E-007：关闭 Phase 0 开放问题

- **依赖**：E2E-001～E2E-006
- **工作**：把 spike 结论、选定路径、容差和限制回写技术设计；删除仅用于试验且不会进入长期框架的代码。
- **验收**：技术设计第 11 节第 1～7、9～12 项都有证据化答案；第 8 项已有统一采样格式、Phase 0 代表性资源样本和 5/10 分钟预算可行性结论，并明确把真实 P0、完整单轮和 100 轮实测分别交给 E2E-207、E2E-501、E2E-504。不得因尚不存在完整套件而阻塞 M1，也不得把 Phase 0 估算标成最终实测；评审同意进入 M1。
- **估算**：0.5～1 天

## 5. M1：E2E workspace 与基础设施

### E2E-101：创建 `@bili-syncplay/e2e` workspace

- **依赖**：E2E-007
- **需求**：REQ-F001、REQ-N003
- **工作**：创建 package、Playwright 配置和包含 `src/**`、`test/**` 的 tsconfig；把 workspace typecheck 接入根 `npm run typecheck`。
- **验收**：故意破坏一个 test fixture 类型时根 typecheck 失败；恢复后通过。不得用 `as never` 或双重断言绕开 fixture 类型。
- **估算**：1 天

### E2E-102：实现 run coordinator 和安全临时目录

- **依赖**：E2E-101
- **需求**：REQ-F002、REQ-F006、REQ-N013、REQ-N024
- **工作**：实现 run ID、相互独立的 runtime 根与 artifact 暂存根、bootstrap sink、LIFO disposer、逐资源 timeout、退出结果合并和路径校验。根命令清理 runtime 根，但只定稿并返回 artifact 根。
- **验收**：单测覆盖启动中途失败、多个 disposer 失败、超时、重复 close、拒绝删除任一已验证根之外路径，以及 runtime 清理后 artifact 仍可供后续上传。
- **估算**：1～2 天

### E2E-103：实现 extension build fixture

- **依赖**：E2E-101、E2E-102
- **需求**：REQ-G02、REQ-F001
- **工作**：定位构建目录，以本次 bootstrap sink URL 设置 `BILI_SYNCPLAY_DEFAULT_SERVER_URL`；在跨进程构建锁内完成“清理共享 dist、生产构建、校验、原子复制到 run-scoped 目录”，释放锁后只返回不可变副本的只读元数据。
- **验收**：产物默认地址只指向本次 sink；Chrome 目标误指向 Firefox manifest、缺文件、版本不一致、复用其他 runId 的产物或浏览器直接加载共享 `extension/dist*` 均快速失败。两个 run 并发构建时，扩展文件哈希和连接目标始终属于各自 run；构建锁异常退出后可恢复且不会遗留半份副本。
- **估算**：1 天

### E2E-104：实现 server runtime fixture

- **依赖**：E2E-101、E2E-102
- **需求**：REQ-F004、REQ-F006、REQ-F010、REQ-N010
- **工作**：实现两阶段 fixture，并让它成为 bootstrap sink 的唯一所有者：`prepare()` 在浏览器启动前建立 sink、可选 run-scoped 临时 CA、SAN 只包含 `wssUrl` 实际回环主机名/IP 的叶证书和 profile 信任描述；Origin 发现后，`start(allowedOrigins)` 再导入 `createSyncServer`，使用随机端口、精确 Origin、内存 provider 和结构化日志。按需启动只转发到该实例的受管 TLS facade；普通请求代理 `/api/connection-check` 和 `/` 并保留 Origin/CORS，upgrade 代理到同一 WebSocket 后端。暴露 `wsUrl`、`wssUrl`、`httpUrl`、只关闭 sink 的幂等 `closeBootstrapSink()`，以及兜底关闭所有仍存活资源的幂等 `close()`。
- **验收**：sink、同步服务端和 TLS facade 使用不同随机端口；真实 WS 与 WSS 均完成 HTTP(S) 预检、WebSocket 及同步协议握手；WSS 不修改系统信任库、不关闭全局证书校验且不访问公网，SAN 不匹配、错误 CA、缺失 HTTPS 普通请求代理和非允许 Origin 都失败。握手后调用 `closeBootstrapSink()`，其端口可立即重新绑定，而既有同步连接、后端和 facade 继续可用；重复调用不报错。`close()` 在 `prepare()` 后失败、`start()` 中途失败、sink 已单独关闭和正常结束四种状态下都等待其余资源完整 shutdown、汇总关闭错误并使所有端口可重新绑定，临时证书和 profile 信任无残留。
- **估算**：2～3 天

### E2E-105：实现 Chromium browser client fixture

- **依赖**：E2E-102～E2E-104
- **需求**：REQ-F003、REQ-F005、REQ-N011
- **工作**：接收 E2E-104 `prepare()` 返回的可选 profile 信任描述后启动 persistent context，发现 service worker/ID、创建活动 Bilibili tab、打开 popup、捕获 page/worker console 和错误；把发现的 Origin 交回 server fixture 的 `start()`。
- **验收**：两个 client 并行启动且隔离；启动至 popup 切换成功前只连接 bootstrap sink；两个并发 run 分别终止/恢复 background 后，连接目标、扩展文件和证书信任仍属于各自 run；重复创建/关闭 20 轮无孤儿 Chromium 进程、profile 锁或信任状态残留。
- **估算**：2 天

### E2E-106：实现 Bilibili fixture contracts

- **依赖**：E2E-003、E2E-101
- **需求**：REQ-F020、REQ-F024～REQ-F028、REQ-N004
- **工作**：实现普通视频、多 P、番剧、festival、两种稍后再看页面；提供 SPA、自动连播、metadata 延迟、buffering 和 video 重建控制。
- **验收**：每个 contract 有独立单测/浏览器 smoke；ID/标题互不相同；运行期间无意外公网请求。
- **估算**：3～5 天

### E2E-107：实现 page models

- **依赖**：E2E-105、E2E-106
- **需求**：REQ-F005、REQ-O001
- **工作**：实现 `PopupPage`、`BilibiliPage` 和共享等待 helper；区分 action popup 与普通扩展页，并优先使用 role/name/label 等语义 locator。
- **验收**：page model 不导出内部 store 写方法；活动-tab-dependent 操作在普通扩展页实例上会拒绝执行；locator 失败时错误包含页面、操作和当前可见状态。
- **估算**：2～3 天

### E2E-108：实现 artifact 和元数据收集

- **依赖**：E2E-102、E2E-105
- **需求**：REQ-G06、REQ-N010～REQ-N014、REQ-N022
- **工作**：把 metadata、summary、无凭据上下文的 Playwright trace、遮罩截图、console、worker 和 server 日志写入独立 artifact 暂存根；在场景启动前按敏感能力 tag 选择采集模式，凡会处理邀请串、token、密码或 cookie 的上下文都不启动原始 trace/HAR/网络正文，并输出步骤日志等价脱敏诊断。采集阶段使用字段 allowlist；实现 archive-aware 扫描器，按本次运行登记的秘密和通用 header/cookie 模式解包检查待上传文件。Firefox 等非 Playwright lane 由各 adapter 追加经过同一策略批准的驱动诊断。
- **验收**：用合成的无凭据失败和带邀请串/管理员凭据的敏感失败验证安全 artifact 齐全且可打开；runtime 根删除后 artifact 仍存在。敏感模式不得生成 trace/HAR，但必须保留不含秘密的步骤、console、播放器采样、遮罩截图和服务端事件。分别把 bearer token、cookie、管理员密码和邀请串注入普通日志、合成 trace.zip、HAR 和 WebDriver 日志，扫描必须阻止上传并让 job 失败；把同类探针放入待截图的敏感区域，截图必须按遮罩清单覆盖该区域且视觉快照不得泄露原文。清除探针后产物通过，且不能靠损坏归档或删除全部诊断伪装成功；真实 P0 失败的集成验收由 E2E-503 完成。
- **估算**：3～4 天

### E2E-109：实现场景 runner 与空集合保护

- **依赖**：E2E-101～E2E-108、E2E-110、E2E-111
- **需求**：REQ-F001
- **工作**：在 e2e workspace 内实现统一场景选择、fixture 编排、退出结果合并和 coverage 汇总入口；本任务只接入基础设施自测，不发布会被误认作完整浏览器 E2E 的根命令。
- **验收**：基础设施自测从干净 checkout 端到端完成 build fixture、浏览器启动、server/Redis 启停、artifact 定稿与清理；零场景、全 skip、Redis 不可用、浏览器启动失败或清理失败均返回非零。不能在 M2 场景尚未实现时用空测试替换 `test:e2e:smoke:plan` 后报绿。
- **估算**：1 天

### E2E-110：实现 Redis runtime fixture

- **依赖**：E2E-102
- **需求**：REQ-F001、REQ-F006、REQ-F037、REQ-N013
- **工作**：实现 managed/external 两种模式。managed 模式校验受支持的 `redis-server` 版本，生成关闭持久化、仅绑定回环地址且使用随机端口/临时目录的配置，启动后立即登记 LIFO disposer，并等待 `redis-cli ping`；external 模式接收显式 `REDIS_URL`，只做健康检查而不接管进程。两种模式都生成唯一 key 前缀并在结束时清理、确认。
- **验收**：fixture 自测在未设置 `REDIS_URL` 时启动 managed Redis、完成 ping 和前缀写入/清理，结束后子进程退出、端口可重绑且无 key/临时目录残留；缺失或版本不兼容的 `redis-server` 在场景启动前给出安装要求并失败。外部 URL 不可达或健康检查失败时快速失败；使用外部实例时只清理本 run 前缀且绝不终止外部进程。两个并发 run 的端口和前缀互不串扰，启动中断和清理超时均使入口非零；E2E-308 在 M3 完成后负责真实浏览器/双节点集成验收。
- **估算**：2～3 天

### E2E-111：实现操作目录、断言证据与覆盖检查基础设施

- **依赖**：E2E-101
- **需求**：REQ-G04、REQ-O003、需求规格第 5.1、9 节
- **工作**：把需求规格第 5.1 节的操作键和权威断言策略展开为机器可读 operation catalog；每项包含唯一 `operationKey`、所属 requirement ID、priority、独立 `assertionPolicy`、非空 `requiredAssertionKeys`、断言键到类别的固定映射和 `requiredAssertionCategories`。实现共享断言 helper 和本地 coverage check，对权威策略、catalog 必需二元组、必要类别与本次实际通过证据做精确集合差；每条证据同时记录 `runId`、`scenarioId`、`attemptId` 和本次尝试内唯一的 `evidenceId`。后续 M2～M4 场景从首个用例起直接产出该证据，不在 M5 返工补 tag。
- **验收**：任一展开键没有或重复匹配策略、catalog 漏键、多键、重复声明键、空 `requiredAssertionKeys`、策略/类别错配，或与第 5.1 节 priority/requirement/policy 映射漂移时检查失败。表驱动判别力测试分别删除 `playback.user.seek`、`background.terminate.recover-popup` 的旧 popup/port 关闭证据或新文档 port 首事件断言、`background.terminate.recover-message` 的实际 content 设置首事件断言或 `peer-result`、`page-ui.settings-popover.{close,quick-disable}`、`admin.page.events.filter.include-system`、`admin.page.rooms.sort.created-at.desc`、`admin.page.overview.{load,refresh,error-retry,auto-refresh.enable,auto-refresh.disable}` 各自的 readyz 查询断言、`admin.page.rooms.{load,refresh,error-retry,auto-refresh.enable,auto-refresh.disable}` 各自的房间详情查询断言、两个 auto-refresh disable 的 `stability-window`、`admin.governance.disconnect-session.success`、`admin.authorization.operator.server-success`、任一必要 `assertionKey`、`playback.user.seek` 的 `peer-result` 和 `stability-window` 证据、`browser.exit.no-session-recovery` 的重启后 `initiator-visible` 证据，把 `ownership.owner-leave` 从 `peer-sync` 误标成 `local-visible`，并尝试用同操作的 `server-result` 补 `peer-result` 缺口；这些对照都必须失败。同需求兄弟操作（包括 popover open/close/quick-disable、不同管理筛选字段、排序字段/方向、auto-refresh enable/disable 和 operator/admin 的授权成功）、未知键、花括号/通配键、只写 tag/requirement ID、空测试、skip、未执行断言或同一次尝试内重复 `evidenceId` 均不能补缺。另有正向聚合测试让 P0 smoke、分域场景和一次诊断重试分别提交同一 `(operationKey, assertionKey)`：证据按 `scenarioId` / `attemptId` 保留、coverage 求并集且检查通过；若首次尝试或任一场景失败/skip，完整 job 仍失败。
- **估算**：2～3 天

## 6. M2：P0 双客户端 smoke

### E2E-201：实现 room oracle

- **依赖**：M1
- **需求**：REQ-F011～REQ-F014、REQ-F030、REQ-O001
- **工作**：从两端 popup、导航和经 fixture 内存管理员认证的只读 admin API 聚合成员、共享视频和房间观察，不读取内部 store。
- **验收**：能发现“服务端有状态但接收端 UI 未更新”和“成员增量更新但分享所有者仍陈旧”两类差异。
- **估算**：1～2 天

### E2E-202：实现 playback oracle

- **依赖**：E2E-005、M1
- **需求**：REQ-F021～REQ-F023、REQ-O002、REQ-O006
- **工作**：实现近同时采样、连续稳定窗口和统一 timing policy；所有 elapsed 使用本地 monotonic 值。
- **验收**：暂停、动态播放和倍速分别有正负对照；人为让 member 不应用 seek 时确定失败。
- **估算**：2～3 天

### E2E-203：实现 stability oracle

- **依赖**：E2E-104、E2E-202
- **需求**：REQ-F022、REQ-O003
- **工作**：统计操作窗口内更新数量、actor/seq、状态翻转和未处理错误。
- **验收**：注入一个重复上报探针时，最终播放器即使看似一致也必须因消息风暴失败。
- **估算**：1～2 天

### E2E-204：实现 P0 完整旅程

- **依赖**：E2E-201～E2E-203
- **需求**：REQ-G03、REQ-F010～REQ-F014、REQ-F021、REQ-F023、REQ-F031
- **工作**：owner 打开页面、保存 server、建房、复制邀请；member 入房；owner 分享、play、seek、rate、pause；member 离房。
- **验收**：每一步验证发起端、接收端和稳定窗口；单次运行 5 分钟内；连续本地运行 20 次无 harness failure。
- **估算**：2～3 天

### E2E-205：验证 smoke 的判别力

- **依赖**：E2E-204
- **需求**：REQ-O005
- **工作**：分别临时禁用分享转发、pause 应用、seek 应用和 leave 通知，运行 smoke 并记录失败步骤。
- **验收**：四个对照均因预期断言失败；恢复源码后工作树只保留本任务的预期改动。
- **估算**：1 天

### E2E-206：验证播放中晚加入和快照补龄

- **依赖**：E2E-201、E2E-202、E2E-204
- **需求**：REQ-F030
- **工作**：owner 以非 1 倍速分享并开始播放，在可控延迟后才让 member 加入；同时记录服务端发送前快照、`playbackAgeMs`、`playbackRate` 和两端本地 monotonic 采样。
- **验收**：member 收到当前共享视频，并收敛到 `snapshot.currentTime + ((playbackAgeMs + localElapsedMs) / 1000) * playbackRate`，而不是停在原始陈旧位置；分别临时让接收端忽略 `playbackAgeMs` 和忽略倍速乘数时，用例都必须因位置偏差失败。
- **估算**：1～2 天

### E2E-207：接通可执行 smoke 根命令和阶段性 CI

- **依赖**：E2E-109、E2E-204～E2E-206
- **需求**：REQ-F001、REQ-N001
- **工作**：新增根命令 `test:e2e:browser:smoke` 并接入实际 P0 旅程；在它端到端可执行后删除或改造只打印 JSON 的 `test:e2e:smoke:plan`，避免计划输出继续冒充 E2E。同时在 GitHub-hosted Ubuntu runner 新增独立且非 required 的 `browser-e2e-smoke` job，执行该命令并上传经过安全检查的 artifact。完整 `test:e2e:browser` 与 non-required 的 `browser-e2e` 留给 E2E-501 在 M3/M4 全部完成后接通，提升为 required 则留给 E2E-506。
- **验收**：从具备已声明工具链的干净 checkout 执行 smoke，完成构建、真实浏览器/扩展、服务端、artifact 和清理；任一步失败、零场景或 skip 都返回非零。`browser-e2e-smoke` 从 `npm ci` 开始安装已声明工具链并实际运行同一根命令，记录真实 P0 命令在本机和 GitHub-hosted runner 上的耗时、CPU、内存及 artifact 大小，验证 5 分钟目标或更新有依据的预算；不得继续引用 Phase 0 代表性估算。该 job 保持独立且非 required，不能声称已覆盖完整 P0/P1 catalog，也不能与未来 `browser-e2e` 复用检查上下文。
- **估算**：1 天

## 7. M3：操作、页面、生命周期矩阵

### E2E-301：Popup 全操作场景

- **依赖**：M2
- **需求**：REQ-F010～REQ-F017
- **工作**：覆盖合法/非法服务器地址、Enter join、确认取消、替换分享、打开共享视频、复制、设置持久化、pending 和服务端错误。`save-ws`、`save-wss` 分别在保存后通过 create/join 触发真实握手；`reconnect-after-change` 在已入房时切换独立端点并验证重连，不用同一连接证据同时代替三个操作键。
- **验收**：使用 E2E-111 的 coverage check 证明需求规格第 5.1 节为 REQ-F010～F017 展开的每个操作键均有本次实际通过的必要断言及类别证据；删除 `room.join-enter`、任一确认/取消分支或任一错误键时检查失败，不能由同需求下的兄弟操作代替。
- **估算**：3～4 天

### E2E-302：五种页面和身份场景

- **依赖**：M2、E2E-106
- **需求**：REQ-F020、REQ-F024、REQ-F027
- **工作**：参数化五种 manifest route、多 P、festival `bvid + cid`、标题和规范 URL。
- **验收**：删除任一专用 bridge/snapshot 适配时对应页面场景失败，其他页面保持可诊断。
- **估算**：3～5 天

### E2E-303：播放和缓冲场景

- **依赖**：M2
- **需求**：REQ-F021～REQ-F023
- **工作**：覆盖 play/pause/seek/rate、waiting/stalled/canplay、soft apply、hard seek、ended 和 video 重建。
- **验收**：每类信号既验证最终结果，也验证没有反向回声污染；固定窗口等待不进入用例。
- **估算**：4～6 天

### E2E-304：导航和本地浏览隔离

- **依赖**：E2E-302、E2E-303
- **需求**：REQ-F025～REQ-F028
- **工作**：覆盖自动连播、非共享页加载即暂停后手动本地播放、前进后退、快速 A→B→C→D 和共享视频被远端替换。
- **验收**：房间共享源、活动页面、播放器状态和消息数量全部收敛；非共享本地播放不改变房间。
- **估算**：4～6 天

### E2E-305：连接和 background 生命周期

- **依赖**：M2
- **需求**：REQ-F031～REQ-F033、REQ-F036
- **工作**：覆盖 service worker terminate、offline/online、服务端重启、tab reload/close、显式离房和浏览器完全退出。worker 恢复必须在双客户端已加入同一房间且通过真实 action popup 分享 fixture 视频后，使用 E2E-002 已验证的调试路径执行两个独立终止周期：先关闭分享用 popup 并确认旧文档/port 消失，终止 worker 后创建全新 action popup，由实际首个新 port 连接唤醒；初始查询允许处于 bootstrap 过渡态，最终用后续 port 和服务端收敛验证恢复。再关闭该 popup 并确认文档/port 消失，重新终止 worker 并重载共享视频 tab，由实际首个 content 设置 hydration 消息唤醒，随后等待房间 hydration，并以真实播放操作验证跨端同步。
- **验收**：每个终止周期都记录本周期目标 ID、旧执行上下文失效、目标消失、实际首个生产事件和新 target 创建时刻，且不得复用同一次终止或恢复证据。popup 周期必须证明旧 popup 文档/port 已消失、新文档标识不同且其 port 连接先于状态查询；首次查询的合法过渡态不算恢复失败，后续 port 与服务端必须收敛到已入房。content 周期必须证明 `content:get-page-share-button-settings` 先于 `content:get-room-state`；若生产顺序改变则按实测更新断言，不能复用旧 popup 或跳过先行事件。`background.terminate.recover-popup`、`background.terminate.recover-room` 分别具备发起端和服务端恢复证据；`background.terminate.recover-message` 还必须具备 member 播放器的 `peer-result` 和稳定窗口证据，不能用 owner 本地 UI 或 server result 代替。两个触发动作前都不得由 popup、alarm、自动重试等其他来源预先唤醒。自动重连与显式离房的 token/成员语义可从用户结果区分；浏览器完全退出并重启同一隔离 profile 后，popup 明确处于未加入房间状态，服务端已移除旧会话，且稳定窗口内该会话不会重新出现。删除任一旧文档/port 关闭证据、实际首事件、最终 UI、服务端、peer-result 或稳定窗口断言都必须让 coverage check 失败。
- **估算**：4～5 天

### E2E-306：并发、陈旧快照和分享所有者

- **依赖**：E2E-303、E2E-305
- **需求**：REQ-F034、REQ-F035
- **工作**：覆盖不同 actor 近同时 seek/play、打开 tab await 期间新状态超越旧状态、所有者离开/回连和成员增减；对离开和重新加入造成的归属转移注入一次“首次 `room_state_updated` 被事件总线拒收”，随后保持房间空闲并等待 `pending-resync-queue` 重试。
- **验收**：能抓住不同 actor 的旧状态回放、增量后所有者陈旧和断线后错误抢占三类回归；首次归属重同步发布失败后，不执行后续 share/playback/profile/成员操作且不刷新页面，客户端仍最终收到重试产生的完整房间态并与服务端所有者一致。临时禁用该重试轨迹时，此负向场景必须因所有者持续陈旧而失败。
- **估算**：4～6 天

### E2E-307：页内 UI smoke

- **依赖**：E2E-302
- **需求**：REQ-F028
- **工作**：验证 toast、分享按钮拖动、popover 打开、经 pointerleave 或 focusout 正常关闭、popover 内快捷停用分享按钮、全屏挂载/退出；精细坐标仍留给现有组件测试。
- **验收**：浏览器级用例只断言关键可见性、可操作性和设置结果，不建立大面积脆弱截图基线；`page-ui.settings-popover.{open,close,quick-disable}` 分别提交独立 operation evidence，close 必须让浮层在按钮仍挂载时消失，快捷停用还须证明真实 content→background 设置消息已生效，三个兄弟操作不能互相补缺。
- **估算**：2～3 天

### E2E-308：runtime index reaper 一次性通告重试

- **依赖**：E2E-110、E2E-305、E2E-306
- **需求**：REQ-F037
- **工作**：增加使用唯一 Redis key 前缀的双节点 server/runtime store fixture；让存活浏览器客户端与离线节点成员进入同一房间，通过可控租约触发 reaper 清理，并令事件总线只拒收首次清理通告。随后保持房间空闲，触发下一次 sweep，验证它在“没有离线节点”提前返回前重试保留记录。
- **验收**：首次通告失败、后续扫描已无法重新发现该房间且没有 share/playback/profile/成员操作或页面刷新时，存活客户端仍最终移除幽灵成员并获得完整房间态中的正确所有者；临时停用保留记录重试后，用例必须因成员或所有者持续陈旧而失败。Redis、端口、租约时钟和进程均按 run 隔离并在失败时留存诊断。
- **估算**：2～4 天

## 8. M4：管理后台 E2E

### E2E-401：实现 admin server 和 AdminPage fixture

- **依赖**：M2
- **需求**：REQ-F040、REQ-F041
- **工作**：生成内存管理员配置，打开真实构建后的 admin UI；实现登录和导航 page model。rooms 分别实现 keyword、status、include-expired 筛选，created-at/last-active-at 排序及升降序、分页/页大小和详情抽屉；events 分别实现 event、room-code、session-id、remote-address、origin、result、time-range、include-system 筛选，分页/页大小和事件详情；audit 分别实现 actor、action、target-id、target-type、result、time-range 筛选，分页/页大小和请求 JSON 详情。overview、config、rooms、events、audit 分别覆盖 load、manual refresh 和 error-retry；overview、rooms、events、audit 另覆盖 auto-refresh enable/disable，其中 overview 同时观测 overview 与 readyz 查询，rooms 保持详情抽屉打开并同时观测房间列表与详情查询。
- **验收**：密码仅存在测试进程内存；登录成功、失败、过期和退出可观察。REQ-F041 每个展开键都提交独立 operation evidence，rooms 的排序值分别断言真实 `sortBy`/`sortOrder`，各筛选值分别断言对应查询参数。每个 load、manual refresh、error-retry、auto-refresh operation 的 `requiredAssertionKeys` 逐条绑定其驱动的全部查询：除 disable 外都必须观察后续请求，disable 则在一个完整刷新周期加容差内证明无请求；overview 不可遗漏 readyz，rooms 在详情打开时不可遗漏 detail。删除 config 的任一基础操作、任一筛选、排序方向、详情、分页、任一 fanout 查询证据或 disable 稳定窗口时 coverage check 必须失败。
- **估算**：2～3 天

### E2E-402：实现治理动作场景

- **依赖**：E2E-401
- **需求**：REQ-F042、REQ-F043
- **工作**：为每种治理动作创建独立房间夹具。从 admin UI 对在线房间执行关闭、清视频、踢人和断开会话；提前过期前先让客户端离线并等待服务端移除会话，使房间满足“无在线成员”前置条件，过期后再让原隔离 profile 恢复连接并观察房间不存在。批量关闭与批量过期分别建夹具，后者同时包含可过期空闲房间和应拒绝的在线房间。
- **验收**：每个动作既验证后台结果，也验证扩展客户端的状态/断连/错误；断开会话必须验证当前房间上下文被清除、停止自动重连并显示专用错误；单个与批量过期的客户端证据必须来自恢复连接后的 popup 房间清理/错误，不能伪造向在线房间广播不存在的“过期成功”。批量关闭与批量过期分别覆盖成功及部分失败。
- **估算**：3～5 天

### E2E-403：实现角色授权矩阵

- **依赖**：E2E-401
- **需求**：REQ-F044
- **工作**：参数化 viewer/operator/admin 的 UI 可见性；验证 viewer 直接调用治理 API 被服务端拒绝，并验证 operator、admin 的同一治理调用获授权。
- **验收**：viewer 的隐藏按钮和直接 API 越权两层均有断言；`admin.authorization.operator.server-success` 与 `admin.authorization.admin.server-success` 分别具备发起端可见和服务端成功证据，不能复用一个角色的请求补另一个角色，不构造当前权限模型中不存在的 operator 拒绝。
- **估算**：1～2 天

## 9. M5：GitHub-hosted CI 硬门禁

### E2E-501：新增 `browser-e2e` workflow job

- **依赖**：M3、M4
- **需求**：REQ-G01、REQ-N001、REQ-N002
- **工作**：新增根命令 `test:e2e:browser`，并在 Ubuntu runner 安装锁定 Chromium；`browser-e2e` 在同一 job 配置锁定版本的 Redis service、`redis-cli ping` 健康检查和 job-scoped `REDIS_URL`，由 run coordinator 为 `E2E-308` 创建并清理唯一 key 前缀，不得依赖并行 `redis-integration` job 的 service。命令先跑 smoke，再运行完整 P0/P1 分域矩阵和 admin-ui 真实客户端场景；与现有 verify 并行。该完整 job 初次接通时保持 non-required，并与 E2E-207 的 `browser-e2e-smoke` 并存、使用不同检查上下文；smoke 无需启动 Redis。只有 E2E-504 soak 与 E2E-505 追踪完成后，E2E-506 才把 `browser-e2e` 提升为 required 并移除阶段性 smoke。
- **验收**：干净 CI 环境从 `npm ci` 开始能启动并通过 Redis 健康检查、注入连接地址、执行 `E2E-308` 并清理登记的 key 前缀；Redis 启动、健康检查、连接或清理失败时 job 非零。权威优先级表展开后的任一 P0/P1 操作键、断言策略、必要断言键、必要断言类别或 admin-ui E2E 缺失/失败时 job 非零；smoke 失败时长矩阵跳过但安全 artifact 仍上传；job 总 timeout 明确，并记录完整 GitHub 检查从开始到结束的耗时、CPU、内存和 artifact 大小，验证 `REQ-N001` 当前 10 分钟目标。若不达标，先优化；若需调整目标，必须基于实测修改需求规格并取得评审同意，不能仅记录慢值后继续。E2E-504、E2E-505 完成前 `browser-e2e` 必须保持 non-required，`browser-e2e-smoke` 也必须继续存在。
- **估算**：1～2 天

### E2E-502：实现变更分类

- **依赖**：E2E-501
- **需求**：需求规格第 8 节
- **工作**：runtime、e2e、构建和 workflow 改动运行浏览器 E2E；纯文档/翻译可跳过。分类逻辑放在可测试脚本，不散写多份 YAML 表达式。
- **验收**：表驱动测试覆盖每个 workspace、根配置、lockfile、workflow、fixture 和 docs；未知路径默认运行而非跳过。
- **估算**：1～2 天

### E2E-503：接入 artifact 和失败摘要

- **依赖**：E2E-108、E2E-501
- **需求**：REQ-G06、REQ-N010～REQ-N014、REQ-N022
- **工作**：只从 artifact collector 生成的 allowlisted 上传清单中上传摘要和失败 trace/等价驱动诊断；上传前重新执行 archive-aware 扫描，在 job summary 展示场景、分类、浏览器版本、第一失败步骤和被拒绝产物原因；上传完成后以 `always()` 独立清理该 runId 的 artifact 根。
- **验收**：先证明 runtime 根已删除且已扫描 artifact 仍能上传；断言失败、浏览器崩溃、清理失败、artifact 生成失败、秘密扫描失败和上传失败六种情况都能得到非零 job 及无敏感信息的可读摘要。真实 P0 建房/入房失败时不得生成 trace/HAR，但须保留不含邀请串的步骤、console、播放器采样、遮罩截图和服务端事件。向压缩 trace/HAR 注入测试 bearer/cookie 时上传步骤必须拒绝该文件，不能因测试命令先行清理或扫描器 fail-open 而通过。
- **估算**：1～2 天

### E2E-504：执行 100 轮稳定性 soak

- **依赖**：E2E-501～E2E-503
- **需求**：REQ-N001、REQ-O004、需求规格 3.2.1
- **工作**：在实际 GitHub-hosted Ubuntu runner 上，以独立且非 required 的 soak workflow 复用 E2E-501 `browser-e2e` 的相同 runner image、安装步骤、完整命令和 Redis service 配置，触发 100 次拟设为 required 的完整检查；每轮覆盖权威清单展开后的全部 P0/P1 操作键（包括执行 `E2E-308`）及其断言策略、必要断言键、必要断言类别和 admin-ui 真实客户端场景，并按场景域记录产品失败、harness 失败、完整检查耗时、CPU、内存和 artifact 大小。
- **验收**：附上 100 个实际 GitHub Actions run/job ID 与链接；100 次完整套件运行中 harness failure 不超过 1 次，且每个失败有根因。每轮 operation coverage 的操作键、断言策略、必要断言键和必要类别集合差均为空，并包含 `reaper.failed-first-announcement.retry-converge` 的实际 `peer-result` 及稳定窗口证据；逐轮记录从检查开始到结束的 GitHub-hosted 总耗时并验证当前已批准的 `REQ-N001` 目标，预算结论未通过时不得进入 E2E-506。结束后无 run 前缀残留。不能用本地或 self-hosted 机器、只跑 P0 smoke、跳过 Redis 场景或与 E2E-501 不同的 runner/安装/service 配置代替。稳定性或预算未达标时先修基础设施，不启用 required check。
- **估算**：2～4 天，取决于完整套件耗时和失败轮次

### E2E-505：完成需求—场景追踪汇总

- **依赖**：E2E-111、M3、M4
- **需求**：REQ-G04、需求规格第 5.1、8、9 节
- **工作**：复用 E2E-111 的 catalog、断言 helper 和 coverage check，汇总 M2～M4 场景的精确 operation keys、断言策略、browser/page tags 及运行证据，生成需求—操作—策略—断言—场景双向追踪摘要；required-check 配置读取同一 catalog 和执行证据，不复制另一套覆盖规则。
- **验收**：每个 P0/P1 展开操作键、断言策略、必要断言键和必要类别都能反查至少一个实际场景及最近结果，且每个场景都能反查需求；阶段性 smoke 与完整门禁使用不同 check 名称，不能以范围较小的成功结果满足 branch protection。E2E-111 的全部判别力与策略测试作为该任务的前置门禁持续运行。
- **估算**：1～2 天

### E2E-506：启用 branch protection 门禁

- **依赖**：E2E-504、E2E-505
- **需求**：REQ-G01、REQ-N001
- **工作**：在 E2E-504 的 100 轮完整套件 soak、当前已批准的 `REQ-N001` 总耗时预算均达标且 E2E-505 追踪闭环后，把 `browser-e2e` 设为 required check，再移除阶段性的 `browser-e2e-smoke`；记录维护者如何处理 GitHub 平台故障而不是靠重跑隐藏失败。
- **验收**：任一 P0/P1 展开操作键、断言策略、必要断言键、必要断言类别或 admin-ui 追踪缺口会让 coverage check 失败；一个故意删除单个 operation evidence 的测试 PR 无法合并，恢复后 check 通过。启用前必须附 E2E-501 单轮和 E2E-504 分布对当前已批准总耗时预算的通过结论；只有记录数据而没有预算判定时不得提升。移除 `browser-e2e-smoke` 前必须证明 branch protection 已要求 `browser-e2e` 且该检查在目标分支实际通过，切换过程不能出现无浏览器门禁的空窗；阶段性 smoke 不能用同名成功状态绕过完整门禁。
- **估算**：0.5 天

### E2E-507：更新开发文档和删除旧入口歧义

- **依赖**：E2E-501
- **工作**：同步更新 `docs/development.md`、`docs/development.zh-CN.md` 和需要的 README；说明 Node server E2E 与浏览器 E2E 区别，并记录受支持的 `redis-server`/`redis-cli` 本地前置版本、managed 默认模式、external `REDIS_URL` 模式和 CI service 的责任边界。
- **验收**：所有文档命令从仓库根分别以 managed Redis 和显式 external Redis 实际执行一遍；旧 `test:e2e:smoke:plan` 不再冒充可执行测试。文档不得暗示并行 `redis-integration` job、维护者日常 Redis 或被跳过的 `REQ-F037` 可以满足完整矩阵。
- **估算**：1 天

## 10. M6：Windows、Firefox 与真实站点

### E2E-601：准备受保护 Windows runner

- **依赖**：M5
- **需求**：REQ-N020～REQ-N024
- **工作**：创建专用低权限用户、runner group/label、工作目录、浏览器和凭据边界；限制为可信 workflow/SHA。
- **验收**：外部 fork PR 无法调度该 runner；job 后无残留浏览器/profile/token；安全边界有运维文档。
- **估算**：1～2 天

### E2E-602：实现 Windows 编排器

- **依赖**：E2E-601
- **需求**：REQ-F002、REQ-F006、REQ-F050
- **工作**：用非交互 PowerShell/Node 入口构建当前 SHA、创建 profiles、启动浏览器、运行 smoke、打包 artifact 和清理。
- **验收**：从 runner 默认 cwd 完整执行；已存在旧 profile、端口占用和浏览器崩溃都能安全失败并清理本次资源。
- **估算**：2～4 天

### E2E-603：Chrome/Edge 稳定版 smoke

- **依赖**：E2E-006、E2E-602
- **需求**：REQ-F050
- **工作**：按 Phase 0 结论测试当前 commit 构建或签名发布产物；运行 create/join/share/play/pause/seek/永久倍速。
- **验收**：报告明确包含浏览器版本和被测扩展 artifact SHA；Chrome 与 Edge 都分别证明两个播放器对 play、pause、seek 和非 1 倍永久倍速稳定收敛，不把 Playwright Chromium 结果重标为 Chrome/Edge，也不能用其中一个稳定版浏览器的结果替代另一个。
- **估算**：2～4 天

### E2E-604：WSL/Windows 跨时钟场景

- **依赖**：E2E-602、E2E-603
- **需求**：REQ-F054、REQ-O006
- **工作**：由 Windows runner 通过 E2E-only WSL launcher 导入当前构建的生产 bootstrap，并利用现有 `ServerBootstrapDependencies.now` 注入服务端逻辑墙钟；Windows 浏览器跑双客户端。先施加至少 `max(5_000ms, 4 × playing 动态位置容差)` 的正偏移，播放进入稳定窗口后跳到等幅负偏移，同时采集 `sync:ping` 原始 out/in 分量、计划/实测偏移和播放器收敛；不得调整 Windows 或 WSL 系统时钟。
- **验收**：测试 oracle 不使用跨钟 timestamp 差；诊断先证明偏移幅度和跳变量达到计划值，正确实现随后仍在两个阶段各自收敛。用文件备份临时把补偿逻辑恢复为 `serverTime - localNow` 后，同一场景必须因播放器持续超出动态位置容差而失败；还原后重跑通过。若负向对照因 launcher、采样缺失或环境失败而红，不能算有判别力。
- **估算**：3～4 天

### E2E-605：Firefox WebDriver/XPI adapter

- **依赖**：E2E-006、E2E-602
- **需求**：REQ-F051
- **工作**：构建 Firefox 目标，在两个隔离 profile 中临时安装 XPI、发现 UUID、配置 Origin；复用 E2E-006 选定的 profile 级代理或 DNS、临时 CA 和回环 HTTPS fixture，打开真实 Bilibili Origin 夹具与 popup，并运行包含 create/join/share/play/pause/seek/永久倍速的双客户端核心同步；采集 geckodriver/Marionette、WebDriver 命令/事件、console、event page、截图和可用的 BiDi 网络事件。
- **验收**：断言实际是 `background.scripts` event page 构建；`ws://localhost` 可连接；content script/page bridge、分享及 play、pause、seek、非 1 倍永久倍速同步全程只访问本地 fixture，两个播放器都在稳定窗口内收敛；失败 artifact 不依赖或伪造 Playwright `trace.zip`；公网回退、证书绕过或错误 Chrome manifest 均必须失败，结束后系统 hosts/信任库保持不变。
- **估算**：3～5 天

### E2E-606：真实站点公开页面 canary

- **依赖**：E2E-603；Firefox 可后接
- **需求**：REQ-F052、REQ-F053
- **工作**：选择稳定公开普通视频、番剧和 festival 页面；验证注入、身份、分享和最小播放动作。
- **验收**：请求低频串行；页面前置失败能区分 `external-blocked`；测试不处理验证码、不绕风控。
- **估算**：2～4 天

### E2E-607：可选登录场景

- **依赖**：E2E-601、E2E-606
- **需求**：REQ-F052、REQ-N022、REQ-N023
- **工作**：建立专用测试账号和临时登录 profile 注入流程，覆盖两种稍后再看页面和昵称上报。
- **验收**：无凭据时明确跳为受控未配置，而非通过；凭据不进入日志/artifact；验证码出现时标外部阻塞。
- **估算**：2～3 天，不含账号外部审批

### E2E-608：定时、告警和发布门禁

- **依赖**：E2E-603～E2E-607
- **需求**：REQ-G05、REQ-G07、需求规格第 8 节
- **工作**：配置每日 stable browser、每日 live canary、tag 前全矩阵；实现 `passed/product-failed/external-blocked` 摘要和连续失败告警。
- **验收**：runner 离线、产品失败和 Bilibili 阻塞产生不同告警；发布流程不会把 `external-blocked` 自动当通过。
- **估算**：2～3 天

## 11. M7：状态模型与长期治理

### E2E-701：实现有界状态模型

- **依赖**：M3、M5
- **需求**：REQ-G04、需求规格第 9 节
- **工作**：实现状态、操作前置条件、后置条件、最大步数和 seed 重放。
- **验收**：同 seed 重放同一操作序列；非法操作不生成；失败摘要完整展示最短已知复现序列。
- **估算**：4～6 天

### E2E-703：建立 fixture 漂移流程

- **依赖**：E2E-606
- **工作**：真实站点失败时先分类 DOM 漂移、产品回归或外部阻塞；最小化更新 fixture contract，并为新信号补单元/E2E。
- **验收**：有 runbook、owner 和响应目标；fixture 更新不能只改 selector 让测试变绿，必须解释对应线上变化。
- **估算**：1 天

### E2E-704：建立稳定性和耗时预算

- **依赖**：E2E-504、E2E-608
- **需求**：REQ-N001
- **工作**：按周汇总时长、harness flake、product failure、external block、artifact 大小和 runner 可用性。
- **验收**：超过预算会告警并创建可追踪事项；不得通过无限增加 retry 或 timeout 消除指标。
- **估算**：1～2 天

## 12. 每个实现 PR 的完成定义

每个 PR 至少满足：

- 任务条目的代码、测试、文档和需求追踪均更新。
- 修改后的文件已逐段重读，确认实际写入。
- 新测试在正确实现上通过，在安全移除其守护行为后因预期原因失败。
- 从仓库根执行新增/修改的完整流程命令；记录 cwd、输入、退出码和 artifact。
- 不遗留浏览器进程、临时 profile、监听端口和测试服务端。
- 先执行最小相关验证，再在 commit 前按仓库要求完整执行：

```bash
npm run format:check && npm run lint && npm run typecheck && npm run build && npm test && npm run audit
```

- 涉及浏览器 E2E 的 PR 额外执行已经实现的对应命令，例如：

```bash
npm run test:e2e:browser:smoke
npm run test:e2e:browser
```

smoke 命令在 E2E-207 完成前不存在，完整命令在 E2E-501 完成前不存在；对应任务未完成时不得在交付说明中声称已经运行。

## 13. 总体估算

| 范围                               |       估算 |
| ---------------------------------- | ---------: |
| M0～M2：可执行 P0 双客户端 smoke   |  2～3 人周 |
| M3～M5：操作矩阵、后台和 CI 硬门禁 |  2～4 人周 |
| M6：Windows、Firefox、真实站点     |  2～4 人周 |
| M7：状态模型与治理                 |  1～2 人周 |
| 合计                               | 7～13 人周 |

该估算按一名熟悉仓库的工程师计算，不含 Bilibili 测试账号审批、购买/准备专用 Windows 机器、浏览器厂商行为变化造成的额外适配。M2 完成后可先把 smoke 作为本地或非 required CI 信号投入使用；PR 硬门禁仍必须等待 M3～M5 的范围与稳定性条件全部满足。
