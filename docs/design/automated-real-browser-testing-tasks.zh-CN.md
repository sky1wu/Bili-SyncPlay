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
| PR 2  | `packages/e2e`、资源生命周期、页面夹具、最小扩展启动测试                     | 双客户端房间旅程           |
| PR 3  | P0 双客户端 create/join/share/play/seek/rate/pause/leave                     | 页面全矩阵、管理后台       |
| PR 4  | Popup 与五种页面/导航场景                                                    | 生命周期故障、管理后台     |
| PR 5  | 播放、缓冲、回声、并发、重连和所有权场景                                     | CI required check          |
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
- **工作**：评估并锁定 `@playwright/test`；记录 Node、Chromium 和 Playwright 版本兼容关系。草拟 `@bili-syncplay/e2e` package 和 tsconfig，但暂不展开场景。
- **验收**：从仓库根目录可启动一个只打开空白 Chromium persistent context 的 spike；退出码、超时和浏览器关闭均被断言。
- **估算**：0.5～1 天

### E2E-002：证明真实扩展可加载

- **依赖**：E2E-001
- **需求**：REQ-G02、REQ-F002、REQ-F003
- **工作**：构建 `extension/dist`，复制到本次 spike 独占且启动后不可变的临时目录，再加载到 persistent context，发现 MV3 service worker 和 extension ID；分别用扩展页 URL 和 `chrome.action.openPopup()` 打开 popup。
- **验收**：断言 manifest 版本与根 `package.json` 一致、service worker URL 属于发现的扩展 ID、popup 渲染连接状态和房间表单；action popup 打开前后的活动 tab 都是目标 Bilibili tab。
- **判别力检查**：改用一个不存在的扩展目录时必须在启动阶段失败，不能退化为空浏览器仍报通过。
- **估算**：1 天

### E2E-003：证明 Bilibili route fixture 会注入 content script

- **依赖**：E2E-002
- **需求**：REQ-F020、REQ-N002
- **工作**：对 `https://www.bilibili.com/video/<test-id>` fulfil 最小 HTML 和媒体，验证 manifest content script、page bridge、视频绑定和页内分享按钮。
- **验收**：不访问公网；地址栏保留 Bilibili URL；页面能返回当前视频身份；禁用扩展时同一断言失败。
- **决策点**：若 route fulfil 不稳定，实测并记录 HTTPS fixture server + `host-resolver-rules` 回退方案。
- **估算**：1～2 天

### E2E-004：证明双 profile、Origin 和服务端握手

- **依赖**：E2E-002
- **需求**：REQ-G03、REQ-F003、REQ-F004
- **工作**：先启动独占 bootstrap sink，并把测试构建默认服务端地址指向它；再同时启动 owner/member 两个临时 profile，发现各自扩展 Origin；用这些 Origin 创建随机端口同步服务端并通过 popup 切换连接。
- **验收**：两个 profile 的 storage、tab 和 background 不共享；启动阶段只命中 bootstrap sink，即使本机 `localhost:8787` 放置诱饵服务也收不到请求；同步服务端精确允许本次 Origin，第三个伪造网页 Origin 被拒绝。
- **估算**：1 天

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
- **验收**：技术设计第 11 节所有问题都有证据化答案；评审同意进入 M1。
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
- **验收**：产物默认地址只指向本次 sink；Chrome 目标误指向 Firefox manifest、缺文件、版本不一致、复用其他 runId 的产物或浏览器直接加载共享 `extension/dist*` 均快速失败。两个 run 并发构建并分别终止/恢复 background 时，扩展文件哈希和连接目标始终属于各自 run；构建锁异常退出后可恢复且不会遗留半份副本。
- **估算**：1 天

### E2E-104：实现 server runtime fixture

- **依赖**：E2E-101、E2E-102
- **需求**：REQ-F004、REQ-F006、REQ-N010
- **工作**：在浏览器启动前暴露 bootstrap sink 生命周期；Origin 发现后再导入 `createSyncServer`，使用随机端口、精确 Origin、内存 provider 和结构化日志；暴露 `wsUrl`、`httpUrl`、`close`。
- **验收**：sink 与同步服务端使用不同随机端口；真实 WebSocket 握手成功；非允许 Origin 失败；close 等待完整 shutdown；两个端口均可在结束后重新绑定。
- **估算**：1～2 天

### E2E-105：实现 Chromium browser client fixture

- **依赖**：E2E-102～E2E-104
- **需求**：REQ-F003、REQ-F005、REQ-N011
- **工作**：启动 persistent context、发现 service worker/ID、创建活动 Bilibili tab、打开 popup、捕获 page/worker console 和错误。
- **验收**：两个 client 并行启动且隔离；启动至 popup 切换成功前只连接 bootstrap sink；重复创建/关闭 20 轮无孤儿 Chromium 进程和 profile 锁。
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
- **验收**：人为制造断言失败后安全 artifact 齐全且可打开；runtime 根删除后 artifact 仍存在。P0 建房/入房失败时不得生成 trace/HAR，但必须保留不含邀请串的步骤、console、播放器采样、遮罩截图和服务端事件。分别把 bearer token、cookie、管理员密码和邀请串注入普通日志、合成 trace.zip、HAR 和 WebDriver 日志，扫描必须阻止上传并让 job 失败；把同类探针放入待截图的敏感区域，截图必须按遮罩清单覆盖该区域且视觉快照不得泄露原文。清除探针后产物通过，且不能靠损坏归档或删除全部诊断伪装成功。
- **估算**：3～4 天

### E2E-109：定义根命令并替换空计划

- **依赖**：E2E-101～E2E-108
- **需求**：REQ-F001
- **工作**：新增 `test:e2e:browser:smoke`、`test:e2e:browser`；在可执行 smoke 完成后删除或改造只打印 JSON 的 `test:e2e:smoke:plan`，避免两个入口都叫 E2E。
- **验收**：从干净 checkout 的仓库根执行命令，能完成构建、测试、artifact 和清理；任一步失败时根命令返回非零。
- **估算**：1 天

## 6. M2：P0 双客户端 smoke

### E2E-201：实现 room oracle

- **依赖**：M1
- **需求**：REQ-F011～REQ-F014、REQ-F030、REQ-O001
- **工作**：从两端 popup、导航和公开 admin API 聚合成员、共享视频和房间观察。
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

## 7. M3：操作、页面、生命周期矩阵

### E2E-301：Popup 全操作场景

- **依赖**：M2
- **需求**：REQ-F010～REQ-F017
- **工作**：覆盖合法/非法服务器地址、Enter join、确认取消、替换分享、打开共享视频、复制、设置持久化、pending 和服务端错误。
- **验收**：需求追踪表中 REQ-F010～F017 均有正向和拒绝/错误场景。
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
- **工作**：覆盖 service worker terminate、offline/online、服务端重启、tab reload/close、显式离房和浏览器完全退出。
- **验收**：自动重连与显式离房的 token/成员语义可从用户结果区分；浏览器退出后不错误声称恢复 session。
- **估算**：4～5 天

### E2E-306：并发、陈旧快照和分享所有者

- **依赖**：E2E-303、E2E-305
- **需求**：REQ-F034、REQ-F035
- **工作**：覆盖不同 actor 近同时 seek/play、打开 tab await 期间新状态超越旧状态、所有者离开/回连和成员增减。
- **验收**：能抓住不同 actor 的旧状态回放、增量后所有者陈旧和断线后错误抢占三类回归。
- **估算**：4～6 天

### E2E-307：页内 UI smoke

- **依赖**：E2E-302
- **需求**：REQ-F028
- **工作**：验证 toast、分享按钮拖动、popover toggle、全屏挂载/退出；精细坐标仍留给现有组件测试。
- **验收**：浏览器级用例只断言关键可见性、可操作性和设置结果，不建立大面积脆弱截图基线。
- **估算**：2～3 天

## 8. M4：管理后台 E2E

### E2E-401：实现 admin server 和 AdminPage fixture

- **依赖**：M2
- **需求**：REQ-F040、REQ-F041
- **工作**：生成内存管理员配置，打开真实构建后的 admin UI；实现登录、导航、筛选和详情 page model。
- **验收**：密码仅存在测试进程内存；登录成功、失败、过期、退出和页面错误重试可观察。
- **估算**：2～3 天

### E2E-402：实现治理动作场景

- **依赖**：E2E-401
- **需求**：REQ-F042、REQ-F043
- **工作**：由真实 owner/member 扩展创建房间，再从 admin UI 关闭、过期、清视频、踢人、断开会话和批量治理。
- **验收**：每个动作既验证后台结果，也验证扩展客户端的状态/断连/错误；断开会话必须验证当前房间上下文被清除、停止自动重连并显示专用错误；覆盖批量部分失败。
- **估算**：3～5 天

### E2E-403：实现角色授权矩阵

- **依赖**：E2E-401
- **需求**：REQ-F044
- **工作**：参数化 viewer/operator/admin 的 UI 可见性和服务端拒绝。
- **验收**：隐藏按钮和直接 API 越权两层均有断言。
- **估算**：1～2 天

## 9. M5：GitHub-hosted CI 硬门禁

### E2E-501：新增 `browser-e2e` workflow job

- **依赖**：M3、M4
- **需求**：REQ-G01、REQ-N001、REQ-N002
- **工作**：在 Ubuntu runner 安装锁定 Chromium，先 smoke 后运行完整 P0/P1 分域矩阵和 admin-ui 真实客户端场景；与现有 verify 并行。M2 阶段若先接入 CI，只能使用独立且非 required 的 `browser-e2e-smoke` 检查名；最终完整门禁使用 `browser-e2e`，两者不得复用检查上下文。
- **验收**：干净 CI 环境从 `npm ci` 开始可运行；权威优先级表中的场景和 admin-ui E2E 任一缺失或失败时 job 非零；smoke 失败时长矩阵跳过但安全 artifact 仍上传；job 总 timeout 明确。
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
- **验收**：先证明 runtime 根已删除且已扫描 artifact 仍能上传；断言失败、浏览器崩溃、清理失败、artifact 生成失败、秘密扫描失败和上传失败六种情况都能得到非零 job 及无敏感信息的可读摘要。向压缩 trace/HAR 注入测试 bearer/cookie 时上传步骤必须拒绝该文件，不能因测试命令先行清理或扫描器 fail-open 而通过。
- **估算**：1～2 天

### E2E-504：执行 100 轮稳定性 soak

- **依赖**：E2E-501～E2E-503
- **需求**：REQ-O004、需求规格 3.2.1
- **工作**：在与 CI 同等环境连续运行拟设为 required 的完整 `browser-e2e` 命令 100 次，覆盖全部 P0/P1 分域场景和 admin-ui 真实客户端场景；按场景域记录产品失败、harness 失败、耗时和 artifact 大小。
- **验收**：100 次完整套件运行中 harness failure 不超过 1 次，且每个失败有根因；不能用只跑 P0 smoke 的结果代替。未达标时先修基础设施，不启用 required check。
- **估算**：2～4 天，取决于完整套件耗时和失败轮次

### E2E-505：建立需求—场景追踪表

- **依赖**：M3、M4
- **需求**：REQ-G04、需求规格第 5.1、8、9 节
- **工作**：为每个场景声明 requirement IDs、priority、browser/page tags；让共享断言 helper 在运行时输出 requirement ID、断言类别（发起端用户可见、接收端/服务端跨端结果、稳定窗口）、结果和时间，并由覆盖检查把本次测试报告中的执行证据与权威清单合并生成摘要。required-check 配置读取同一份清单和执行证据。
- **验收**：遗漏需求规格第 5.1 节任一 P0/P1 操作、admin-ui E2E、所需用户可见/跨端断言类别或断言未实际执行时 CI 失败；空测试、跳过断言和只写 tag/ID 均不能贡献覆盖。阶段性 smoke 与完整门禁使用不同 check 名称，不能以范围较小的成功结果满足 branch protection。
- **估算**：1～2 天

### E2E-506：启用 branch protection 门禁

- **依赖**：E2E-504、E2E-505
- **需求**：REQ-G01
- **工作**：把 `browser-e2e` 设为 required check；记录维护者如何处理 GitHub 平台故障而不是靠重跑隐藏失败。
- **验收**：P0/P1 或 admin-ui 追踪缺口会让 coverage check 失败；一个故意失败的测试 PR 无法合并；恢复后 check 通过。M2 阶段性 smoke 不能使用 required check 的同名成功状态绕过该门禁。
- **估算**：0.5 天

### E2E-507：更新开发文档和删除旧入口歧义

- **依赖**：E2E-501
- **工作**：同步更新 `docs/development.md`、`docs/development.zh-CN.md` 和需要的 README；说明 Node server E2E 与浏览器 E2E 区别。
- **验收**：所有文档命令从仓库根实际执行一遍；旧 `test:e2e:smoke:plan` 不再冒充可执行测试。
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
- **工作**：按 Phase 0 结论测试当前 commit 构建或签名发布产物；运行 create/join/share/play/pause/seek。
- **验收**：报告明确包含浏览器版本和被测扩展 artifact SHA；不把 Playwright Chromium 结果重标为 Chrome/Edge。
- **估算**：2～4 天

### E2E-604：WSL/Windows 跨时钟场景

- **依赖**：E2E-602、E2E-603
- **需求**：REQ-F054、REQ-O006
- **工作**：由 Windows runner 在 WSL 启动服务端，Windows 浏览器跑双客户端；采集 `sync:ping` 原始 out/in 分量和播放器收敛。
- **验收**：测试 oracle 不使用跨钟 timestamp 差；场景能在现有 WSL/宿主钟偏跳变下稳定完成或给出诊断。
- **估算**：2～3 天

### E2E-605：Firefox WebDriver/XPI adapter

- **依赖**：E2E-006、E2E-602
- **需求**：REQ-F051
- **工作**：构建 Firefox 目标，在两个隔离 profile 中临时安装 XPI、发现 UUID、配置 Origin；复用 E2E-006 选定的 profile 级代理或 DNS、临时 CA 和回环 HTTPS fixture，打开真实 Bilibili Origin 夹具与 popup 并运行双客户端核心同步；采集 geckodriver/Marionette、WebDriver 命令/事件、console、event page、截图和可用的 BiDi 网络事件。
- **验收**：断言实际是 `background.scripts` event page 构建；`ws://localhost` 可连接；content script/page bridge、分享及播放同步全程只访问本地 fixture；失败 artifact 不依赖或伪造 Playwright `trace.zip`；公网回退、证书绕过或错误 Chrome manifest 均必须失败，结束后系统 hosts/信任库保持不变。
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

上述两个浏览器命令在 E2E-109 完成前不存在；任务未完成时不得在交付说明中声称已经运行。

## 13. 总体估算

| 范围                               |       估算 |
| ---------------------------------- | ---------: |
| M0～M2：可执行 P0 双客户端 smoke   |  2～3 人周 |
| M3～M5：操作矩阵、后台和 CI 硬门禁 |  2～4 人周 |
| M6：Windows、Firefox、真实站点     |  2～4 人周 |
| M7：状态模型与治理                 |  1～2 人周 |
| 合计                               | 7～13 人周 |

该估算按一名熟悉仓库的工程师计算，不含 Bilibili 测试账号审批、购买/准备专用 Windows 机器、浏览器厂商行为变化造成的额外适配。M2 完成后可先把 smoke 作为本地或非 required CI 信号投入使用；PR 硬门禁仍必须等待 M3～M5 的范围与稳定性条件全部满足。
