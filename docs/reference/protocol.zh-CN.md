# 协议参考

[English](./protocol.md) | [简体中文](./protocol.zh-CN.md)

`@bili-syncplay/protocol`（`packages/protocol/`）是扩展与服务端之间线上协议的单一可信来源：消息类型、领域类型、类型守卫和 Bilibili URL 归一化。请始终通过包根导入；内部文件布局不属于公开接口。变更流程（版本号、兼容窗口、测试清单）见 [CONTRIBUTING.md](../../CONTRIBUTING.md)。

## 版本管理

| 常量                       | 位置                                    | 当前值 | 含义                                              |
| -------------------------- | --------------------------------------- | ------ | ------------------------------------------------- |
| `PROTOCOL_VERSION`         | `packages/protocol/src/types/common.ts` | `3`    | 扩展在 `room:create` / `room:join` 中携带的版本号 |
| `CURRENT_PROTOCOL_VERSION` | `server/src/messages.ts`                | `3`    | 服务端当前使用的版本                              |
| `MIN_PROTOCOL_VERSION`     | `server/src/messages.ts`                | `1`    | 服务端仍接受的最老客户端版本                      |

客户端在 `room:create` / `room:join` 的 payload 中携带 `protocolVersion`；低于 `MIN_PROTOCOL_VERSION` 的客户端会被以 `unsupported_protocol_version` 错误码拒绝。未携带 `protocolVersion` 的旧客户端按 `server/src/messages.ts` 中的兼容策略处理。

## 领域类型

### `SharedVideo`

| 字段                  | 类型      | 说明               |
| --------------------- | --------- | ------------------ |
| `videoId`             | `string`  | 归一化后的视频标识 |
| `url`                 | `string`  | 归一化后的视频 URL |
| `title`               | `string`  | 展示标题           |
| `sharedByMemberId`    | `string?` | 分享者成员 ID      |
| `sharedByDisplayName` | `string?` | 分享者昵称         |

### `PlaybackState`

| 字段            | 类型                                        | 说明                                                                                               |
| --------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `url`           | `string`                                    | 该状态对应的归一化 URL                                                                             |
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

| 类型                 | Payload                                                                  | 用途                                                                                  |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `room:created`       | `{ roomCode, memberId, joinToken, memberToken, serverProtocolVersion? }` | 房间已创建，携带邀请与会话 token                                                      |
| `room:joined`        | `{ roomCode, memberId, memberToken, serverProtocolVersion? }`            | 加入成功，返回本次会话的 `memberToken`（重连携带仍有效的旧 token 时复用，否则新签发） |
| `room:state`         | `RoomState`                                                              | 房间完整快照（加入后、按请求、状态变化时）                                            |
| `room:member-joined` | `{ roomCode, member: RoomMember }`                                       | 成员加入                                                                              |
| `room:member-left`   | `{ roomCode, member: RoomMember }`                                       | 成员离开                                                                              |
| `error`              | `{ code: ErrorCode, message }`                                           | 请求失败                                                                              |
| `sync:pong`          | `{ clientSendTime, serverReceiveTime, serverSendTime }`                  | 时钟偏移探测响应                                                                      |

### 时钟同步

`sync:ping` / `sync:pong` 实现 NTP 式往返：客户端比较 `clientSendTime`、`serverReceiveTime`、`serverSendTime` 与自身接收时间，估算应用 `PlaybackState.serverTime` 时使用的时钟偏移。扩展端由 `clock-controller.ts` 维护该偏移。

## 错误码（`ErrorCode`）

`origin_not_allowed`、`room_not_found`、`join_token_invalid`、`member_token_invalid`、`not_in_room`、`rate_limited`、`invalid_message`、`payload_too_large`、`room_full`、`unsupported_protocol_version`、`internal_error`

常见错误码对应的开发者侧现象见[故障排查](../development.zh-CN.md#故障排查)。

## URL 归一化

`parseBilibiliVideoRef(url)` 把受支持的 Bilibili 页面 URL 解析为 `{ videoId, normalizedUrl }`；`normalizeBilibiliUrl(url)` 只返回归一化 URL（无法解析时返回 `null`）。仅接受 `www.bilibili.com`，支持以下路径形态：

- `/video/<id>`（多 P 通过 `?p=` 区分）
- `/bangumi/play/<id>`
- `/festival/<id>`（通过 query 中的 `bvid` + `cid` 确定身份）
- `/list/watchlater` 与 `/medialist/play/watchlater`（要求 query 中带 `bvid`）

扩展与服务端的所有视频身份比较都必须经过这些 helper，不允许各自手写 URL 字符串处理。

## 类型守卫

每种线上结构都有从包根导出的运行时守卫，服务端用于校验入站消息，扩展用于校验服务端帧：

- `isClientMessage(value)` / `isServerMessage(value)`——顶层分发守卫
- 结构级守卫，如 `isSharedVideo`、`isPlaybackState`、`isRoomState`、`isRoomMember`、`isErrorMessage`、`isClientHelloPayload`
- 原语守卫，如 `isRoomCode`、`isToken`、`isVideoId`、`isBilibiliUrl`、`isPlaybackPlayState`

新增或修改消息时，必须在同一变更中更新对应守卫及其接受/拒绝用例测试（见 [CONTRIBUTING.md](../../CONTRIBUTING.md) 的清单）。
