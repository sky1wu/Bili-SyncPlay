# 多节点全局管理面迁移说明

本文档说明如何把当前部署逐步迁移到“多 Room Node + 独立 Global Admin + 共享 Redis 控制面”的完整形态，并在出现问题时通过配置开关快速回退，而不是现场硬回滚代码。

## 目标拓扑

- `room-node-*`：承载 WebSocket 房间流量与探活
- `global-admin`：承载 `/admin` 与 `/api/admin/*`
- `redis`：承载共享持久化、运行时索引、事件流、房间事件总线与管理命令总线

同一集群中的所有进程必须：

- 使用同一个 `REDIS_URL`
- 设置唯一的 `INSTANCE_ID`

## 需要开启的共享 Provider

完整多节点模式建议统一开启：

- `ROOM_STORE_PROVIDER=redis`
- `ADMIN_SESSION_STORE_PROVIDER=redis`
- `ADMIN_EVENT_STORE_PROVIDER=redis`
- `ADMIN_AUDIT_STORE_PROVIDER=redis`
- `RUNTIME_STORE_PROVIDER=redis`
- `ROOM_EVENT_BUS_PROVIDER=redis`
- `ADMIN_COMMAND_BUS_PROVIDER=redis`
- `NODE_HEARTBEAT_ENABLED=true`

推荐职责分离：

- Room Node：`GLOBAL_ADMIN_ENABLED=false`
- Global Admin：`GLOBAL_ADMIN_ENABLED=true`

## Redis 依赖

当前会使用这些键族：

- `bsp:room:*`、`bsp:room-index`、`bsp:room-expiry`
- `bsp:runtime:*`
- `bsp:admin:session:*`
- `bsp:events`
- `bsp:audit-logs`
- `bsp:room-events`
- `bsp:admin-command:*`
- `bsp:admin-command-result:*`

上线前至少确认：

1. 每个节点都能连通 Redis。
2. Redis 持久化与淘汰策略符合你的保留预期。
3. 每个 `INSTANCE_ID` 唯一。

## 推荐上线顺序

### 阶段 1：共享控制面

开启：

- `ADMIN_SESSION_STORE_PROVIDER=redis`
- `ADMIN_EVENT_STORE_PROVIDER=redis`
- `ADMIN_AUDIT_STORE_PROVIDER=redis`

验证：

- 节点 A 登录，节点 B 可读
- 节点 B 注销，节点 A 失效
- 事件与审计可跨节点聚合

回退：

- 把以上三个 provider 切回 `memory`

### 阶段 2：共享运行时索引与心跳

开启：

- `RUNTIME_STORE_PROVIDER=redis`
- `NODE_HEARTBEAT_ENABLED=true`

建议：

- 首轮上线时即使已具备全局读视图，也先保留 sticky 路由作为兜底

验证：

- 全局概览中的房间数、成员数、连接数正确
- 节点状态能进入 `stale`、`offline`
- 残留 session 能从全局房间视图中被回收

回退：

- `RUNTIME_STORE_PROVIDER=memory`
- `NODE_HEARTBEAT_ENABLED=false`

### 阶段 3：跨节点房间广播

开启：

- `ROOM_EVENT_BUS_PROVIDER=redis`

验证：

- 跨节点加入后双方成员列表一致
- 共享视频和播放状态可跨节点同步
- 成员离房后全局视图收敛，不出现广播风暴

回退：

- `ROOM_EVENT_BUS_PROVIDER=none`
- 如需立即保正确性，临时恢复 sticky 路由

### 阶段 4：跨节点管理命令

开启：

- `ADMIN_COMMAND_BUS_PROVIDER=redis`

验证：

- `kick_member` 命中目标节点
- `disconnect_session` 命中目标节点
- 审计日志包含 `targetInstanceId`、`executorInstanceId` 和命令结果字段

回退：

- `ADMIN_COMMAND_BUS_PROVIDER=none`
- 暂停跨节点踢人/断连动作

### 阶段 5：切换独立 Global Admin

部署：

- `node server/dist/global-admin-index.js`

Room Node：

- `GLOBAL_ADMIN_ENABLED=false`

Global Admin：

- `GLOBAL_ADMIN_ENABLED=true`
- 如 UI 与 API 域名分离，可补 `GLOBAL_ADMIN_API_BASE_URL`

验证：

- 全局管理面能读取集群概览、房间、事件、审计
- 跨节点写动作仍然正常

回退：

- 暂时让运维和管理员重新访问节点本地 `/admin`
- 需要时可保留 Global Admin 只读观察

## 快速回退矩阵

| 现象                   | 第一回退动作                                                             | 说明                                                 |
| ---------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| 跨节点登录异常         | `ADMIN_SESSION_STORE_PROVIDER=memory`                                    | 管理会话回到节点本地                                 |
| 全局事件或审计查询异常 | `ADMIN_EVENT_STORE_PROVIDER=memory`、`ADMIN_AUDIT_STORE_PROVIDER=memory` | stdout 结构化日志不受影响                            |
| 全局房间/成员统计异常  | `RUNTIME_STORE_PROVIDER=memory`、`NODE_HEARTBEAT_ENABLED=false`          | 管理读视图退回节点本地                               |
| 跨节点房间同步异常     | `ROOM_EVENT_BUS_PROVIDER=none`                                           | 调查期间恢复 sticky                                  |
| 跨节点踢人/断连异常    | `ADMIN_COMMAND_BUS_PROVIDER=none`                                        | 保留只读全局管理面也可                               |
| Global Admin 切换异常  | 管理流量回切节点 `/admin`                                                | Room Node 可临时重新打开 `GLOBAL_ADMIN_ENABLED=true` |

## 运维检查清单

每阶段上线前：

1. 跑对应自动化测试。
2. 确认每个 Room Node 的 `GET /healthz` 与 `GET /readyz`。
3. 确认 Global Admin 的 `GET /api/admin/overview`。
4. 确认 Redis 延迟和错误率可接受。

每阶段上线后：

1. 观察 `room_event_publish_failed`、`room_event_consume_failed`、`admin_command_execution_failed`、`runtime_index_reaper_failed`。
2. 从 Global Admin 复核房间成员与连接数。
3. 对上线期间执行过的写动作抽查审计记录。

## 最终收口

宣布迁移完成前，执行：

```bash
npm run lint
npm run format:check
npm run typecheck
npm run build
npm test
```
