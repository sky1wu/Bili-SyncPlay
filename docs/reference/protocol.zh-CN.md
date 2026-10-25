# 协议参考

[English](./protocol.md) | [简体中文](./protocol.zh-CN.md)

`@bili-syncplay/protocol`（`packages/protocol/`）是扩展与服务端之间线上协议的单一可信来源：消息类型、领域类型、类型守卫和 Bilibili URL 归一化。请始终通过包根导入；内部文件布局不属于公开接口。变更流程（版本号、兼容窗口、测试清单）见 [CONTRIBUTING.md](../../CONTRIBUTING.md)。

## 版本管理

| 常量                       | 位置                                    | 当前值 | 含义                                              |
| -------------------------- | --------------------------------------- | ------ | ------------------------------------------------- |
| `PROTOCOL_VERSION`         | `packages/protocol/src/types/common.ts` | `4`    | 扩展在 `room:create` / `room:join` 中携带的版本号 |
| `CURRENT_PROTOCOL_VERSION` | `server/src/messages.ts`                | `5`    | 服务端当前使用的版本                              |
| `MIN_PROTOCOL_VERSION`     | `server/src/messages.ts`                | `1`    | 服务端仍接受的最老客户端版本                      |

#325 分阶段落地期间，`PROTOCOL_VERSION` 有意落后一个版本：服务端已实现版本 5（`server:announcement`），但扩展在能处理公告之前仍上报 4，这样服务端不会给已发布的扩展发送它会忽略的消息。

客户端在 `room:create` / `room:join` 的 payload 中携带 `protocolVersion`；低于 `MIN_PROTOCOL_VERSION` 的客户端会被以 `unsupported_protocol_version` 错误码拒绝。未携带 `protocolVersion` 的旧客户端按 `server/src/messages.ts` 中的兼容策略处理。

## 领域类型

### `SharedVideo`

| 字段                  | 类型      | 说明                                                                                                               |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `videoId`             | `string`  | 归一化后的视频标识                                                                                                 |
| `url`                 | `string`  | 分享方发送的分享 URL——可被归一化 helper 接受，但不保证已归一化（festival 分享保留原始页面 URL）；比较前必须归一化  |
| `title`               | `string`  | 展示标题                                                                                                           |
| `sharedByMemberId`    | `string?` | 当前持有共享归属的成员 ID。`room:state` 中的该字段会对照在线成员列表求解，因此只有原分享者仍在房间时才指向他——见下 |
| `sharedByDisplayName` | `string?` | 该成员的昵称；随 `sharedByMemberId` 一同变化                                                                       |

成员 ID 只在该成员占据席位期间存在，因此 `video:share` 时写入的 ID 会在分享者离开、
或其 `memberToken` 过期后失效。于是每一次 `room:state` 都会重新求解：存储的成员在线
时原样返回，否则由在线成员中入房最久者继承（同时入房则按成员 ID 定序）。存储值本身
永不改写，因此只是掉线的分享者重连后会重新拿回归属。

归属由服务端告知，客户端不得自行推导。任何改变归属的成员变更都会额外补发一次完整
`room:state`——因为 `room:member-joined` / `room:member-left` 只会修改接收方的成员
列表，不会触碰其缓存的 `sharedVideo`。

### `PlaybackState`

| 字段            | 类型                                        | 说明                                                                                               |
| --------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `url`           | `string`                                    | 该状态对应的 URL；与 `SharedVideo.url` 一样，比较前必须归一化                                      |
| `currentTime`   | `number`                                    | 播放位置（秒）                                                                                     |
| `playState`     | `"playing" \| "paused" \| "buffering"`      | `PlaybackPlayState`                                                                                |
| `syncIntent`    | `"explicit-seek" \| "explicit-ratechange"?` | 标记由显式 seek / 倍速操作产生的状态（`PlaybackSyncIntent`）                                       |
| `userInitiated` | `boolean?`                                  | 提示该状态变化来自显式用户手势，而非缓冲卡顿或远端状态回放；接收方可跳过防闪烁防抖。可选、向后兼容 |
| `naturalEnd`    | `boolean?`                                  | 提示该 paused 状态来自共享视频自然播完；接收方应用状态但不弹出误导性的"已暂停"提示。可选、向后兼容 |
| `playbackRate`  | `number`                                    | 播放速率                                                                                           |
| `updatedAt`     | `number`                                    | 发送方时间戳（毫秒）                                                                               |
| `serverTime`    | `number`                                    | 服务端转发时盖的时间戳（毫秒）                                                                     |
| `actorId`       | `string`                                    | 产生该状态的成员                                                                                   |
| `seq`           | `number`                                    | 用于排序的单调递增序号                                                                             |

### `RoomState` 与 `RoomMember`

- `RoomMember`：`{ id: string; name: string }`
- `RoomState`：`{ roomCode: RoomCode; sharedVideo: SharedVideo | null; playback: PlaybackState | null; members: RoomMember[] }`

## 客户端消息（`ClientMessage`）

| 类型              | Payload                                                                 | 鉴权          | 用途                                    |
| ----------------- | ----------------------------------------------------------------------- | ------------- | --------------------------------------- |
| `room:create`     | `{ displayName?, protocolVersion? }?`                                   | —             | 创建房间                                |
| `room:join`       | `{ roomCode, joinToken, memberToken?, displayName?, protocolVersion? }` | `joinToken`   | 加入房间（带旧 `memberToken` 时为重连） |
| `profile:update`  | `{ memberToken, displayName }`                                          | `memberToken` | 修改昵称                                |
| `room:leave`      | `{ memberToken? }?`                                                     | `memberToken` | 离开当前房间                            |
| `video:share`     | `{ memberToken, video: SharedVideo, playback?: PlaybackState }`         | `memberToken` | 分享 / 替换房间共享视频                 |
| `playback:update` | `{ memberToken, playback: PlaybackState }`                              | `memberToken` | 广播播放状态变化                        |
| `sync:request`    | `{ memberToken }`                                                       | `memberToken` | 请求当前房间状态                        |
| `sync:ping`       | `{ clientSendTime }`                                                    | —             | 时钟偏移探测                            |

## 服务端消息（`ServerMessage`）

| 类型                  | Payload                                                                  | 用途                                                                                  |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `room:created`        | `{ roomCode, memberId, joinToken, memberToken, serverProtocolVersion? }` | 房间已创建，携带邀请与会话 token                                                      |
| `room:joined`         | `{ roomCode, memberId, memberToken, serverProtocolVersion? }`            | 加入成功，返回本次会话的 `memberToken`（重连携带仍有效的旧 token 时复用，否则新签发） |
| `room:state`          | `RoomState & { playbackAgeMs? }`                                         | 房间完整快照（加入后、按请求、共享视频/播放状态变化时）                               |
| `room:member-joined`  | `{ roomCode, member: RoomMember }`                                       | 成员加入（增量消息，发给 `protocolVersion >= 2` 客户端）                              |
| `room:member-left`    | `{ roomCode, member: RoomMember }`                                       | 成员离开（增量消息，发给 `protocolVersion >= 2` 客户端）                              |
| `error`               | `{ code: ErrorCode, message }`                                           | 请求失败                                                                              |
| `sync:pong`           | `{ clientSendTime, serverReceiveTime, serverSendTime }`                  | 时钟偏移探测响应                                                                      |
| `server:announcement` | `{ announcement: Announcement \| null }`                                 | 当前生效的运营公告，`null` 表示没有（发给 `protocolVersion >= 5` 客户端）             |

### 成员增量消息

成员变更按协议版本分流（`server/src/room-event-consumer.ts` 中 `MEMBER_DELTA_PROTOCOL_VERSION = 2`）：`protocolVersion >= 2` 的客户端收到 `room:member-joined` / `room:member-left` 增量，必须据此维护成员列表——成员变更不会重新广播 `room:state`；旧客户端（v1 或未携带版本号）则收到完整 `room:state`。

### 播放快照年龄

`room:state` 在房间状态之外附带可选的 `playbackAgeMs`：服务端在**发送那一刻**用自己的两个时刻相减，得出 `playback.serverTime` 至今过了多久。它让中途加入正在播放房间的客户端从房间的实际位置起播，而不是从最后一次广播的位置起播——后者最坏已旧了一个广播周期（约 2.1s）。

两条规则保证它成立，且都不受类型系统约束：

- **每次下发都重新计算，绝不存储。** 年龄只在发送那一刻为真，存下来的年龄就是伪装成时长的时刻。因此它挂在 `room:state` payload（`RoomStatePayload`）上，而不是放进 `PlaybackState`——后者会被服务端持久化，也会由客户端在 `playback:update` 中回传。
- **只传时长，不传时刻。** 时长跨两个不一致的钟是安全的：接收端只是把它加到自己的锚上。时刻则不然，接收端必须拿服务端时刻减本地时刻，量到的是钟差而非流逝时间（见[运行时不变量](./invariants.zh-CN.md)的「播放计时不变量」一节）。

接收端把它从该消息的本地到达时刻里减去，得到位置外推所用的锚（`extension/src/background/clock-sync.ts`）；缺失（旧服务端）、为负或大得不合理的值一律忽略。缺失即"视为最新"，也就是 #212 之前的行为。

### 公告

`server:announcement`（协议版本 5，#325）携带运营公告，例如"今晚 04:30 维护，预计中断 5 分钟"：

```ts
type Announcement = {
  id: string; // 每次发布唯一，[A-Za-z0-9_-]{1,64}；接收方按它记住"已关闭"
  level: "info" | "warning";
  message: string; // 非空白，最多 500 字符
  scheduledAt?: number; // 所公告事件的 epoch 毫秒，仅供显示
  expiresInMs: number; // > 0：发送那一刻的剩余有效期
};
```

- **是状态，不是事件。** payload 是**此刻**生效的公告；`null` 表示没有（已撤回或已过期）。重复发送无害，所以服务端不需要投递记录：在 `room:created` / `room:joined` 之后（这是第一个能知道客户端协议版本的时刻）给每个支持的会话发一次当前状态，公告变化时再广播。
- **投递。** 运营人员通过管理后台接口（`/api/admin/announcement`）发布和撤回。每个节点每 15 秒重读一次存储中的公告（`server/src/announcement-broadcaster.ts`），`id` 变化时广播，所以发布或撤回会在一个周期内送达；错过变化的节点（重启、Redis 抖动）在下一次读取时自动补齐。读取失败时保留上一次已知的公告，而不是当作撤回。
- **有效期按时长传。** `expiresInMs` 与 `playbackAgeMs` 一样，跨两台时钟不一致的机器也安全；存储层把它保存为 Redis TTL，用 `PTTL` 读出，任何进程都不拿存储的时间戳和自己的时钟比较。`scheduledAt` 只给人看，从不与本地时钟比较。
- **按版本下发。** 只有上报 `protocolVersion >= 5`（`ANNOUNCEMENT_PROTOCOL_VERSION`）的会话才会收到。旧客户端本来也会丢弃未知类型，按版本下发只是不给它们的日志添噪音。

### 时钟同步

`sync:ping` / `sync:pong` 实现 NTP 式往返：客户端比较 `clientSendTime`、`serverReceiveTime`、`serverSendTime` 与自身接收时间估算时钟偏移，扩展端由 `clock-controller.ts` 维护该偏移。自 #210 起该偏移只是弹窗里展示的诊断值，不再参与播放：位置改由本地单调锚点外推，`PlaybackState.serverTime` 仅作为快照的服务端版本标签使用。

## 错误码（`ErrorCode`）

`origin_not_allowed`、`room_not_found`、`join_token_invalid`、`member_token_invalid`、`not_in_room`、`rate_limited`、`invalid_message`、`payload_too_large`、`room_full`、`unsupported_protocol_version`、`internal_error`

当一次请求读到已过期的房间快照、而其守卫删除尚未确认房间是被删除还是被恢复时，返回
`internal_error`——与所有答不出来的受界存储命令一致。这个状态**刻意不设专用错误码**：那要付出
一次协议版本和一道面向所有旧客户端的兼容门槛，换来的只是一个下次尝试就会自行化解的窗口。它
**绝不能**被报成 `room_not_found`——已发布的控制器把该码当作终态处理，无论待加入还是已存房间
上下文都会被清空，于是一个根本无法证明房间不存在的结果，会顺手带走用户的会话。

常见错误码对应的开发者侧现象见[故障排查](../development.zh-CN.md#故障排查)。

## URL 归一化

`parseBilibiliVideoRef(url)` 把受支持的 Bilibili 页面 URL 解析为 `{ videoId, normalizedUrl }`；`normalizeBilibiliUrl(url)` 只返回归一化 URL（无法解析时返回 `null`）。仅接受 `www.bilibili.com`，支持以下路径形态：

- `/video/<id>`（多 P 通过 `?p=` 区分）
- `/bangumi/play/<id>`
- `/festival/<id>`（通过 query 中的 `bvid` + `cid` 确定身份）
- 列表播放页 `/list/<segment>` 与 `/medialist/play/<segment>`，其中 `<segment>` 为 `watchlater`、收藏夹 `ml<收藏夹 id>` 或 UP 主的纯数字 mid（都要求 query 中带 `bvid`）

扩展与服务端的所有视频身份比较都必须经过这些 helper，不允许各自手写 URL 字符串处理。

## 类型守卫

运行时守卫从包根导出。线上校验请使用顶层守卫：

- `isClientMessage(value)`——服务端用它校验入站客户端帧
- `isServerMessage(value)`——扩展用它校验服务端帧；单独的房间快照用 `isRoomState(value)`

其余导出的守卫（`isSharedVideo`、`isPlaybackState`、`isClientHelloPayload`、`isRoomMember`、`isErrorMessage`，以及 `isRoomCode`、`isToken`、`isVideoId`、`isBilibiliUrl`、`isPlaybackPlayState` 等原语守卫）用于组合与测试上述消息守卫。注意：导出的 `isSharedVideo` 与 `isPlaybackState` 来自客户端消息守卫集，带有客户端 payload 限制——例如 `isSharedVideo` 把 `sharedByMemberId` 上限设为 32 字符，而服务端签发的成员 ID 是 36 字符 UUID——因此服务端填充的 `room:state.sharedVideo` 可能被它们合法地拒绝。不要用客户端 payload 守卫校验服务端帧；`isServerMessage` / `isRoomState` 内部使用更宽松的服务端结构。

新增或修改消息时，必须在同一变更中更新对应守卫及其接受/拒绝用例测试（见 [CONTRIBUTING.md](../../CONTRIBUTING.md) 的清单）。
