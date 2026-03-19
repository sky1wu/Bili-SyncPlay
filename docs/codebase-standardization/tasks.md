# Bili-SyncPlay 代码风格统一与冗余治理任务清单

## 1. 文档目的

本文将 [requirements.md](/D:/workspace/Bili-SyncPlay/docs/codebase-standardization/requirements.md) 和 [design.md](/D:/workspace/Bili-SyncPlay/docs/codebase-standardization/design.md) 拆解为可执行任务，供后续排期、实施和验收使用。

任务拆解原则如下：

- 先建立工程门禁，再推进结构重构
- 优先处理最大、最脆弱、最容易继续膨胀的模块
- 每一阶段都必须具备可验证产出
- 任务尽量围绕单一目标组织，避免“做一半工程化，一半重构”的混合提交

## 2. 里程碑

### M1：工程基线

目标：

- 建立统一 `lint` / `format` / CI 门禁
- 收敛基础代码风格

### M2：扩展端核心拆分

目标：

- 拆分 background 超大入口
- 拆分 content 超大入口
- 拆分 popup 混合式 UI 入口

### M3：共享能力收敛

目标：

- 收敛 URL helper
- 收敛服务端配置解析
- 收敛 protocol 类型与守卫

### M4：服务端结构整理与收尾

目标：

- 整理 server bootstrap
- 整理 admin router
- 补齐测试与开发文档

## 3. 任务清单

## 当前进度（2026-03-19）

- T01 已完成：已补充根级 `ESLint + Prettier` 配置、统一脚本入口与忽略规则，并完成依赖安装与根级命令验证。
- T02 已完成：已新增 CI 工作流，接入 `npm install`、`lint`、`format:check`、`build`、`test` 流程。
- T03 已完成：已执行首轮全仓格式化，修复当前 lint 阻塞项，并确认 `lint`、`format:check`、`build`、`test` 全部通过。
- T04 已完成：`background state store` 已落地，连接、房间会话、共享视频、时钟与诊断运行态均已收敛到统一 store，`index.ts` 不再依赖主要顶层状态变量作为核心状态来源。
- T05 已完成：`background socket controller` 已落地，WebSocket 建连、探测、事件监听与重连调度已从 `background/index.ts` 抽离到独立 controller，入口文件不再直接承载大段 socket 生命周期逻辑。
- T06 已完成：`background room/session controller` 已落地，create/join/leave 请求、房间服务端消息处理与房间上下文清理逻辑已从 `background/index.ts` 抽离到独立 controller，主入口只保留装配与分发。
- T07 已完成：`background popup-state/diagnostics/tab controller` 已落地，popup port、状态广播、诊断日志与共享 tab 控制已从 `background/index.ts` 分离，主入口进一步收敛为事件注册与 controller 装配。
- T11 已完成：popup 列表渲染与局部状态已收敛，日志/成员列表继续集中在 render 层，本地草稿、复制成功态、pending 态与 popup port 引用已统一接入 popup store，`popup/index.ts` 不再维护主要局部 `let` 状态。
- T12 已完成：共享 URL helper 已统一落地，扩展端不再各自包装 `normalizeBilibiliUrl()`，共享视频 URL 归一化与等值比较现已集中到 `extension/src/shared/url.ts`。
- T13 已完成：`packages/protocol` 已完成按主题拆分，协议类型已迁入 `types/*`，守卫已迁入 `guards/*`，`index.ts` 现主要承担统一导出职责，现有 server / extension 导入路径保持兼容。
- T14 已完成：服务端配置解析已从 `server/src/index.ts` 下沉到 `config/*`，安全配置、持久化配置、管理后台配置与通用 env helper 已收敛为单一来源，启动入口已退化为纯装配。
- T15 已完成：服务端 bootstrap 与 admin router 已完成拆分，`app.ts` 的装配与 HTTP fallback 已下沉到 `bootstrap/*`，`admin/router.ts` 已切换为组合式路由分发，顺序分支复杂度显著下降。

本轮实施备注：

- 新增根级脚本：`lint`、`lint:fix`、`format`、`format:check`
- 新增根级配置：`eslint.config.mjs`、`.prettierrc.json`、`.prettierignore`
- 新增 CI：`.github/workflows/ci.yml`
- 已完成首轮仓库统一格式化，当前代码风格基线已收敛，可继续推进 T04 及后续结构拆分任务
- T04 第一阶段已落地：新增 `extension/src/background/state-store.ts` 与对应测试，并让 runtime snapshot/persist 不再手动回填临时 structured 对象
- T04 第二阶段已落地：`share`、`clock`、`diagnostics` 切片已开始直接挂接到 store，相关 tab 绑定、待确认分享、时钟同步和日志状态不再依赖对应的顶层 `let`
- T04 第三阶段已落地：`connection` 切片已直接挂接到 store，socket、连接错误、重连计时与 server URL 更新逻辑不再依赖对应的顶层 `let`
- T04 第四阶段已落地：`room` 切片已直接挂接到 store，房间会话、待加入状态、待发送共享视频与 popup/content 消息读写均已改为经由 store 访问
- T05 已落地：新增 `extension/src/background/socket-controller.ts`，将 socket 建连探测、`open/message/close/error` 监听、断线重连与重试倒计时统一收敛到 controller，`background/index.ts` 仅保留装配与业务调用入口
- T06 已落地：新增 `extension/src/background/room-session-controller.ts`，将 `room:created`、`room:joined`、`room:state`、`error` 处理以及 popup `create/join/leave` 请求收敛到独立 controller，`background/index.ts` 进一步退化为薄装配层
- T07 已落地：新增 `extension/src/background/popup-state-controller.ts`、`extension/src/background/diagnostics-controller.ts`、`extension/src/background/tab-controller.ts`，popup port 管理、状态广播、日志节流与共享页 tab 复用/打开逻辑已独立承载
- T08 第一阶段已落地：新增 `extension/src/content/content-store.ts` 与对应测试，并将 `content/index.ts` 的 runtime state 接到统一 store，为后续抽离 sync/room-state controller 提供单一状态入口
- T08 第二阶段已落地：新增 `extension/src/content/sync-controller.ts`，将 `broadcastPlayback`、`applyRoomState`、`hydrateRoomState` 与同步相关的回声抑制/本地意图守卫主流程从 `content/index.ts` 抽离，content 主入口开始退化为装配层
- T08 第三阶段已落地：新增 `extension/src/content/room-state-controller.ts`，将 `background:sync-status` 的房间切换处理、共享页判断与 toast 协调从 `content/index.ts` 抽离，入口文件进一步收敛到事件绑定与页面协同
- T08 第四阶段已落地：新增 `extension/src/content/share-controller.ts`，将当前页面共享视频识别、festival 快照刷新与分享载荷解析从 `content/index.ts` 抽离，content 主入口只保留绑定与导航层协同逻辑
- T09 第一阶段已落地：新增 `extension/src/content/navigation-controller.ts`，将页面 URL 轮询、房间内导航后的初始状态重置、自动暂停守卫与重试 hydration 触发从 `content/index.ts` 抽离，主入口继续收敛为 controller 装配与消息绑定层
- T09 第二阶段已落地：新增 `extension/src/content/playback-binding-controller.ts`，将视频元素轮询绑定、本地播放事件广播触发、非共享页保护与初始 hydration 等待守卫从 `content/index.ts` 抽离，入口文件不再直接承载大段视频事件副作用
- T09 第三阶段已落地：`content/index.ts` 已移除对同步主流程的中转包装函数，房间同步、播放广播、hydration 重试与导航/房间 controller 现已直接装配 `sync-controller` 与 `room-state-controller` 能力，主入口已基本退化为初始化与依赖装配层
- T10 第一阶段已落地：新增 `extension/src/popup/popup-template.ts` 与 `extension/src/popup/popup-view.ts`，将 popup 首屏 HTML 模板与 DOM refs 收集从 `popup/index.ts` 抽离，主入口已不再直接承载大段模板字符串与节点查询逻辑
- T10 第二阶段已落地：新增 `extension/src/popup/popup-render.ts`，将 popup 状态驱动渲染、成员列表渲染、日志列表渲染与房间动作按钮状态更新从 `popup/index.ts` 抽离，主入口开始退化为数据流装配与事件绑定层
- T10 第三阶段已落地：新增 `extension/src/popup/popup-actions.ts`，将创建/加入/离开房间、复制房间号、复制日志、分享当前视频、打开共享页与 server URL 保存等动作绑定从 `popup/index.ts` 抽离，popup 主入口进一步收敛为初始化、状态同步与装配层
- T10 第四阶段已落地：新增 `extension/src/popup/popup-port.ts`，将 popup 首次状态查询与 background port 同步连接从 `popup/index.ts` 抽离；至此 popup 主入口已基本只剩初始化、局部状态装配与状态收敛入口，T10 目标完成
- T11 已落地：新增 `extension/src/popup/popup-store.ts` 与对应测试，将 room action pending、最近房间上下文、房间邀请码草稿、复制成功态、本地状态提示与 popup port 引用统一收敛到 store；`popup/index.ts` 已不再维护主要局部 `let` UI 状态，render/actions 全部改为经由 store 访问
- T12 已落地：新增 `extension/src/shared/url.ts` 与对应测试，将共享视频 URL 归一化与等值比较统一为 `normalizeSharedVideoUrl` / `areSharedVideoUrlsEqual`，`background/index.ts`、`content/index.ts` 与 `popup` 动作层已不再各自维护本地包装实现
- T13 已落地：新增 `packages/protocol/src/types/*` 与 `packages/protocol/src/guards/*`，将协议核心类型、client/server message 类型与基础守卫拆分为主题模块，并补充 `server-message` 守卫测试；`packages/protocol/src/index.ts` 已收敛为统一导出层
- T14 已落地：新增 `server/src/config/env.ts`、`server/src/config/security-config.ts`、`server/src/config/persistence-config.ts`、`server/src/config/admin-config.ts`，将环境变量解析与默认值组装从 `server/src/index.ts` 下沉，并补充 `server/test/config-env.test.ts` 覆盖解析与报错语义
- T15 已落地：新增 `server/src/bootstrap/admin-services.ts`、`server/src/bootstrap/http-handler.ts` 与 `server/src/admin/routes/*`，将 admin 服务装配、HTTP fallback / connection-check 处理和各类 admin route 分发拆到独立模块；`server/src/app.ts` 已显著瘦身，`server/src/admin/router.ts` 现主要承载鉴权辅助、错误边界与 route composition

## T01 建立统一 lint/format 工具链

目标：

- 为整个 monorepo 建立统一的代码风格与静态检查入口

涉及范围：

- 根目录 `package.json`
- 根目录 ESLint / Prettier 配置
- 必要的忽略文件

任务项：

1. 选择并接入 `ESLint + Prettier`。
2. 新增根级 `lint`、`lint:fix`、`format`、`format:check` 脚本。
3. 配置 TypeScript 工作区共用规则。
4. 配置格式化覆盖 `.ts`、`.js`、`.json`、`.md`、`.css`。
5. 增加必要忽略规则，避免 `dist`、`release`、`node_modules` 等目录进入检查。

完成标准：

1. 从仓库根目录可直接执行 `lint` 和 `format:check`。
2. 所有工作区共享同一套基础规则。
3. 不会误扫构建产物目录。

## T02 接入 CI 工程门禁

目标：

- 让风格、构建和测试成为自动阻断项

涉及范围：

- `.github/workflows/`
- 根目录脚本

任务项：

1. 在 CI 中接入 `npm install`。
2. 接入根级 `lint`。
3. 接入根级 `build`。
4. 接入根级 `test`。
5. 确保失败状态能阻断合并。

完成标准：

1. CI 能稳定执行风格、构建和测试。
2. 风格问题不再只能靠人工 review 发现。

## T03 整理并修复首轮风格违规

目标：

- 在不改变业务行为的前提下，把仓库收敛到统一风格基线

涉及范围：

- `extension/`
- `server/`
- `packages/protocol/`
- 文档和配置文件

任务项：

1. 执行自动格式化。
2. 修复基础 lint 问题，如未使用变量、import 排序、`prefer-const`。
3. 对自动修复无法覆盖的问题逐个人工修复。
4. 保证风格修复提交不混入功能改动。

完成标准：

1. `lint` 和 `format:check` 通过。
2. 构建和测试结果不倒退。

## T04 建立 background state store

目标：

- 取代 `extension/src/background/index.ts` 中横向扩散的顶层状态变量

涉及文件：

- `extension/src/background/index.ts`
- `extension/src/background/runtime-state.ts`
- 新增 `extension/src/background/state-store.ts`

任务项：

1. 基于现有 `runtime-state.ts` 定义 store 初始状态。
2. 实现 `getState`、`patch`、`replace`、必要的 reset 能力。
3. 将 `index.ts` 中的连接、房间、共享视频、时钟、诊断状态迁移到 store。
4. 消除主要顶层 `let` 状态依赖。

完成标准：

1. background 核心状态不再主要依赖入口文件顶层变量。
2. 状态读取与更新具备统一入口。

## T05 抽离 background socket controller

目标：

- 收敛 WebSocket 建连、探测、断线和重连逻辑

涉及文件：

- `extension/src/background/index.ts`
- `extension/src/background/socket-manager.ts`
- 新增 `extension/src/background/socket-controller.ts`

任务项：

1. 提取 `connect`、`openSocketWithProbe`、重连调度、探测相关逻辑。
2. 将 socket 事件监听统一收敛到 controller。
3. 让 controller 通过 store 更新连接状态，而不是直接写散落变量。
4. 保持现有服务端地址校验和重连行为不变。

完成标准：

1. `index.ts` 不再直接承载大段 socket 生命周期逻辑。
2. 重连、探测、错误处理行为与当前实现兼容。

## T06 抽离 background room/session controller

目标：

- 收敛 create/join/leave/sync 请求与房间状态流转

涉及文件：

- `extension/src/background/index.ts`
- 新增 `extension/src/background/room-session-controller.ts`

任务项：

1. 抽离房间创建、加入、离开相关消息发送逻辑。
2. 抽离 `room:created`、`room:joined`、`room:state`、`error` 处理流程。
3. 保持现有 `room-state.ts` 决策函数为纯逻辑模块。
4. 统一调用持久化和 popup 状态广播。

完成标准：

1. 房间会话流程不再混杂在 background 主入口中。
2. 待确认分享与房间状态处理边界更清晰。

## T07 抽离 background popup-state/diagnostics/tab controller

目标：

- 把 popup 通信、诊断日志和 tab 控制从主入口剥离

涉及文件：

- `extension/src/background/index.ts`
- 新增：
  - `popup-state-controller.ts`
  - `diagnostics-controller.ts`
  - `tab-controller.ts`

任务项：

1. 抽离 popup port 建立、断开和状态广播逻辑。
2. 抽离日志追加、日志节流和错误提示逻辑。
3. 抽离共享视频页面查找、打开和共享 tab 绑定逻辑。
4. 校验 popup 和 content 的通知路径未被破坏。

完成标准：

1. background `index.ts` 只剩装配与事件注册。
2. popup 状态广播、日志、tab 控制有独立模块承载。

## T08 建立 content store 与 sync controller

目标：

- 收敛 `extension/src/content/index.ts` 中的运行态和同步主流程

涉及文件：

- `extension/src/content/index.ts`
- `extension/src/content/runtime-state.ts`
- 新增：
  - `content-store.ts`
  - `sync-controller.ts`
  - `room-state-controller.ts`

任务项：

1. 基于现有 runtime state 建立 content store。
2. 提取 room state 接收、hydration 和共享页判断逻辑。
3. 让同步主流程通过 controller 协调 `playback-apply.ts`、`sync-guards.ts` 等纯逻辑模块。
4. 减少入口文件中的定时器和消息分支堆叠。

完成标准：

1. content 主入口不再承担大段同步决策逻辑。
2. 纯决策模块保持可单测状态。

## T09 抽离 content 事件绑定与广播 controller

目标：

- 收敛视频绑定、导航监听、播放广播和 toast 协调

涉及文件：

- `extension/src/content/index.ts`
- 新增：
  - `playback-binding-controller.ts`
  - `navigation-controller.ts`
  - `broadcast-controller.ts`
  - `toast-controller.ts`

任务项：

1. 抽离视频元素绑定和解绑逻辑。
2. 抽离导航变化检测与处理逻辑。
3. 抽离本地播放广播流程。
4. 抽离 toast 协调与展示调用。

完成标准：

1. content `index.ts` 只保留初始化和装配。
2. 事件监听、副作用和 UI 提示被清晰拆开。

## T10 拆分 popup 模板、渲染与动作

目标：

- 把 `extension/src/popup/index.ts` 从“模板 + DOM 查询 + 状态更新 + 动作处理”混合结构拆开

涉及文件：

- `extension/src/popup/index.ts`
- 新增：
  - `popup-store.ts`
  - `popup-template.ts`
  - `popup-view.ts`
  - `popup-render.ts`
  - `popup-actions.ts`
  - `popup-port.ts`

任务项：

1. 将首屏 HTML 模板迁移到 `popup-template.ts`。
2. 将 refs 收集迁移到 `popup-view.ts`。
3. 将状态驱动的 DOM 更新迁移到 `popup-render.ts`。
4. 将按钮、输入框和消息发送逻辑迁移到 `popup-actions.ts`。
5. 将 popup 与 background 的 port 通信迁移到 `popup-port.ts`。

完成标准：

1. popup `index.ts` 只保留初始化、装配和首次渲染。
2. 模板、渲染和动作不再混写在同一文件。

## T11 收敛 popup 列表渲染与局部状态

目标：

- 减少 popup 中散落的 `innerHTML` 重绘和本地 UI 状态变量

涉及文件：

- `extension/src/popup/index.ts`
- 新增或更新 popup 相关模块

任务项：

1. 将日志列表和成员列表渲染集中到 render 层。
2. 建立 popup store 管理本地草稿状态、复制成功态和 pending 态。
3. 移除主要顶层局部 `let` 变量。
4. 保持现有交互和 i18n 文案不变。

完成标准：

1. `innerHTML` 不再散落在动作逻辑中。
2. popup 本地状态具备统一管理入口。

## T12 收敛共享 URL helper

目标：

- 消除扩展端重复包装 `normalizeUrl()` 的实现

涉及文件：

- `extension/src/background/index.ts`
- `extension/src/content/index.ts`
- `extension/src/popup/index.ts`
- 新增 `extension/src/shared/url.ts`

任务项：

1. 新增共享 URL helper。
2. 提供 `normalizeSharedVideoUrl` 和必要的等值比较辅助函数。
3. 替换 background、content、popup 中的重复包装函数。
4. 保持对 `normalizeBilibiliUrl()` 的内部复用。

完成标准：

1. 扩展端只保留一份 URL 归一化辅助实现。
2. 各调用方不再各自定义同名包装函数。

## T13 拆分 protocol 类型与守卫

目标：

- 让 `packages/protocol` 从“大而全入口文件”转为“主题拆分 + 统一导出”

涉及文件：

- `packages/protocol/src/index.ts`
- 新增：
  - `types/*`
  - `guards/*`

任务项：

1. 将协议类型按主题拆分到 `types/`。
2. 将基础守卫拆分到 `guards/primitives.ts`。
3. 将消息守卫按主题拆分到 `guards/`。
4. 保留 `index.ts` 统一导出，兼容现有导入路径。
5. 保证现有 server 和 extension 调用不需要同步大改。

完成标准：

1. `packages/protocol/src/index.ts` 主要承担导出职责。
2. 类型定义与守卫不再长时间堆叠在一个文件里。

## T14 抽离服务端配置解析模块

目标：

- 让 `server/src/index.ts` 退化为启动入口，环境变量解析下沉

涉及文件：

- `server/src/index.ts`
- 新增：
  - `server/src/config/env.ts`
  - `server/src/config/security-config.ts`
  - `server/src/config/persistence-config.ts`
  - `server/src/config/admin-config.ts`

任务项：

1. 提取通用 env 解析 helper。
2. 拆分安全配置、持久化配置和管理后台配置组装。
3. 替换 `index.ts` 中的内联解析函数。
4. 保持当前环境变量名、默认值和报错语义兼容。

完成标准：

1. `server/src/index.ts` 不再堆叠环境变量解析细节。
2. 配置解析具备单一来源。

## T15 整理服务端 bootstrap 与 admin router

目标：

- 收敛 `app.ts` 装配职责，减少 `admin/router.ts` 的顺序分支复杂度

涉及文件：

- `server/src/app.ts`
- `server/src/admin/router.ts`
- 新增：
  - `server/src/bootstrap/*`
  - `server/src/admin/routes/*`

任务项：

1. 将服务装配拆到 bootstrap 模块。
2. 将 admin 路由按资源域拆分为处理模块。
3. 在 router 中引入路由注册和统一错误处理结构。
4. 保持现有 HTTP 接口和鉴权行为兼容。

完成标准：

1. `app.ts` 和 `admin/router.ts` 的职责更单一。
2. 新接口接入不再需要继续拉长单个文件。

## T16 为新 store/controller/helper 补充测试

目标：

- 为本轮结构拆分建立回归保护

涉及范围：

- extension 新增 store/controller/helper
- protocol guards
- server config parser / router

任务项：

1. 为 background store 和关键 controller 增加单元测试。
2. 为 content 同步 controller 增加决策与状态测试。
3. 为 popup render/store 增加最小可行测试。
4. 为共享 URL helper 增加测试。
5. 为 server env parser 增加测试。
6. 为 protocol guards 补充拆分后的回归测试。

完成标准：

1. 结构重构具备对应测试保护。
2. 新模块不再只能依赖人工点点点验证。

## T17 更新开发文档与代码组织说明

目标：

- 让后续开发者理解新的工程边界和规范

涉及文件：

- `README.md`
- `README.zh-CN.md`
- `docs/` 相关文档

任务项：

1. 更新根文档中的开发命令说明。
2. 增加 `lint` / `format` / `test` 使用说明。
3. 简述新的目录组织和模块职责。
4. 补充贡献时的基本约束，例如入口文件保持薄、共享规则统一来源等。

完成标准：

1. 新成员能根据文档理解新的工程结构。
2. 代码规范不只存在于工具，也存在于说明文档。

## 4. 推荐执行顺序

建议按以下顺序推进：

1. T01 建立统一 lint/format 工具链
2. T02 接入 CI 工程门禁
3. T03 整理并修复首轮风格违规
4. T04 建立 background state store
5. T05 抽离 background socket controller
6. T06 抽离 background room/session controller
7. T07 抽离 background popup-state/diagnostics/tab controller
8. T08 建立 content store 与 sync controller
9. T09 抽离 content 事件绑定与广播 controller
10. T10 拆分 popup 模板、渲染与动作
11. T11 收敛 popup 列表渲染与局部状态
12. T12 收敛共享 URL helper
13. T13 拆分 protocol 类型与守卫
14. T14 抽离服务端配置解析模块
15. T15 整理服务端 bootstrap 与 admin router
16. T16 为新 store/controller/helper 补充测试
17. T17 更新开发文档与代码组织说明

## 5. 任务依赖关系

1. T01 是全部后续任务的前置条件。
2. T02 依赖 T01。
3. T03 依赖 T01，建议在 T04 之前完成。
4. T04 是 T05、T06、T07 的基础。
5. T08 是 T09 的基础。
6. T10 是 T11 的基础。
7. T13、T14、T15 可以在扩展端拆分基本完成后并行推进。
8. T16 贯穿全程，但应在各模块初步稳定后集中补齐。
9. T17 放在最后统一收口。

## 6. 每项任务建议产出

### T01-T03

1. 工具链配置
2. 根工作区脚本
3. 风格修复提交

### T04-T12

1. 重构后的模块代码
2. 入口文件瘦身结果
3. 对应最小回归测试

### T13-T15

1. 拆分后的共享/服务端模块
2. 兼容性验证结果
3. 必要的迁移说明

### T16-T17

1. 补充测试
2. 文档更新
3. 最终验收说明

## 7. 完成定义

当以下条件满足时，本轮任务可视为完成：

1. 根目录统一 `lint`、`format`、`build`、`test` 全部可执行。
2. CI 已将风格、构建和测试作为阻断项。
3. `extension` 三个核心入口文件已显著瘦身并完成职责拆分。
4. URL helper、protocol guards、server config parser 已收敛为单一来源。
5. `server` 启动入口和 admin router 已完成结构整理。
6. 关键新模块具备自动化测试。
7. README 与 `docs` 已同步更新。
