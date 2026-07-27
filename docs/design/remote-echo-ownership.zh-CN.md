# 设计：远端播放态归属标记取代固定回声窗

状态：Phase 1 已实现，Phase 2/3 待做。

本文记录扩展端回声抑制从「固定时间窗」改为「归属标记」的设计取舍。它是
[#220](https://github.com/sky1wu/Bili-SyncPlay/pull/220) 的后续：#220 修的是服务端放大器，
本文修的是根因。

## 1. 背景：一次卡死在暂停的自动连播

分享者自动连播换片后，新视频停在记忆进度（49s）且尚未起播，房间态天然是 `paused`。
观众跨视频 hard-seek 到该位置时，缓冲耗时超过扩展端 700ms 的回声抑制窗，把**刚应用的
远端 `paused` 当作本地状态**泄漏回房间，连发两帧。服务端把它记成 pause authority，
随后分享者起播发出的 7 次 `playing` 全部以 `authority-window-follow` 被丢弃。

结果：房间卡死在暂停，而没有任何人执行过暂停。

## 2. 现状：三层固定时间窗

| 机制                                                    | 常量                                     | 职责                                         | 失效条件     |
| ------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- | ------------ |
| `programmaticApplyUntil` + `programmaticApplySignature` | `PROGRAMMATIC_APPLY_WINDOW_MS = 700`     | 抑制 apply **写入 DOM 时同步产生**的事件     | 700ms 后到期 |
| `suppressedRemotePlayback`                              | `REMOTE_ECHO_SUPPRESSION_MS = 700`       | 抑制「本地状态与刚收到的远端状态一致」的广播 | 700ms 后到期 |
| `recentRemotePlayingIntent`                             | `REMOTE_PLAY_TRANSITION_GUARD_MS = 1800` | 抑制远端 playing 引发的本地 play 过渡        | 到期         |
| `remoteFollowPlayingUntil`                              | `REMOTE_FOLLOW_PLAYING_WINDOW_MS = 3000` | 标记「正在跟随远端播放」                     | 到期         |
| `pauseHoldUntil`                                        | `PAUSE_HOLD_MS = 1200`                   | 应用远端 paused 后短暂压制本地 play          | 到期         |

三层都按墙钟到期，与 DOM 事件是否真的到达无关。任何让 transport 事件迟到超过窗口的
因素都会让回声泄漏：跨视频 hard-seek 的缓冲、弱网、后台标签页的定时器节流、
Bilibili 播放器在缓冲恢复时重建 `<video>` 元素。

**调大常量不是解法。** 窗口每延长 1ms，用户在 apply 之后那段时间里的真实操作就多 1ms
被吞的风险，而被吞的用户操作是静默失败，比回声泄漏更难排查。700ms 是在两种错误之间
硬凑的折中值，往哪边挪都错。

## 3. 设计：归属标记

apply 一个远端播放态时，记录这份状态**归属于远端**：

```ts
interface RemoteAppliedPlayback {
  url: string; // 归属的视频（normalized）
  playState: "paused" | "buffering"; // 只记停止态，理由见下
  currentTime: number;
  playbackRate: number;
  actorId: string;
  seq: number;
  appliedAtLocal: number; // 本地单调时刻，只与本地时刻相比，不与 serverTime 混用
}
```

判定规则：一个本地事件报告的 `(playState, currentTime, playbackRate)` 若与归属值一致
（容差内），它就是回声，抑制广播——**无论过去了多久**。

标记不按时间到期，只由下列事件清除：

| 编号 | 清除条件                                                              | 理由                                     |
| ---- | --------------------------------------------------------------------- | ---------------------------------------- |
| C1   | player 内真实 gesture（`lastUserGestureInPlayerAt > appliedAtLocal`） | 用户接管，之后的一切都是本地意图         |
| C2   | 本地状态偏离归属值且偏离无法由远端解释                                | 播放器自己动了（起播、跳变），不再是回声 |
| C3   | 新的远端状态到达                                                      | 直接替换                                 |
| C4   | 共享视频切换 / 房间重置 / `<video>` 重绑                              | 上下文没了                               |

**C1 必须最先判定**，否则用户操作会被吞。它读的是 `lastUserGestureInPlayerAt`
（player 内手势）而非文档级 `lastUserGestureAt`，避免页面空白处的误点清除归属。

### 关键区分：paused/buffering 与 playing 必须不同处理

这是整套模型能否成立的关键，不能一视同仁。

**paused / buffering 的归属可以持久。**
暂停态下本地不产生周期性心跳广播，标记长期存在无害；而它正是泄漏危害最大的方向——
泄漏出去的 `paused` 会被服务端记成 authority，把别人的起播挡掉。

**`playing` 根本不记归属。**
playing 状态下 `onTimeUpdate` 每 2 秒触发一次广播
（`playback-binding-controller.ts`：`nowOf() - getLastBroadcastAt() > 2000 && !video.paused`）。
任何活过 `playing` 到达时刻的归属都会把这些心跳静音，房间将彻底失去漂移校正。与其再用
一个时间窗去限制它——那正是本设计要取代的构造——`rememberRemoteAppliedPlayback` 直接
拒绝为非停止态记归属；而本地播放器进入 `playing` 会释放已有归属（C2，`left-state`）。

这个不对称正是全部诀窍所在：可以无限期归属的方向，恰好是没有心跳可丢的方向，也正是
泄漏会造成危害的方向。

### 重复上报保持抑制

归属刻意不在第一个匹配事件处终止。事故中泄漏了**两帧**——`seeked` 和 `canplay` 各报
一次同一个 paused@49——正是第二帧把服务端否决窗口续到足以吞掉分享者的起播。所以匹配
只抑制、不清除归属，只有 C1–C4 才放行。

位置或速率不匹配则既不抑制、也**不**释放：播放器可能仍在向目标收敛，在第一个中间采样
上就释放会把泄漏放回来。

### 兜底上限

paused 归属另设一个很长的兜底上限（`REMOTE_OWNERSHIP_MAX_AGE_MS = 30_000`）。
正常路径不该依赖它——C1–C4 才是设计上的清除条件；它纯粹防御未枚举到的污染源，
避免归属在某条没想到的路径上永久生效。触发时记 warn 日志，因为它意味着设计有漏洞。

## 4. 污染源枚举与归属划分

改这类状态机必须先枚举全部「产生本地事件但非用户意图」的来源，逐一确认新模型不会
踩坏它们：

| #   | 污染源                                                          | 现有门槛                                     | 新模型下归谁                                     |
| --- | --------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------ |
| 1   | apply 写入 DOM 时同步产生的事件                                 | `programmaticApplyUntil` (700ms) + signature | 保持不变。这一层是同步的，700ms 足够，不是失效点 |
| 2   | apply 之后迟到的 transport 事件（`seeked`/`canplay`/`waiting`） | `suppressedRemotePlayback` (700ms)           | **本次替换目标** → `RemoteAppliedPlayback`       |
| 3   | forced pause（非共享视频自动播放拦截）                          | `lastForcedPauseAt`                          | 不变。它不是远端 apply，不进归属模型             |
| 4   | soft-apply 的 rate 写回与取消                                   | `programmaticApplyScope = "ratechange"`      | 不变。作用域机制已正确区分                       |
| 5   | `<video>` 元素重建（缓冲恢复）                                  | `lastVideoElementBoundAt`                    | 新增 C4 清除路径（旧元素的归属对新元素无意义）   |
| 6   | 自然结束 / autoplay-next 交接                                   | `sharerEndedSuppression*` / `holdNonSharer*` | 不变                                             |
| 7   | SPA 导航期 stale page bridge                                    | `postNavigationAnchor*`                      | 不变                                             |
| 8   | 非共享页                                                        | `non-shared-page` 分支                       | 不变，且在归属判定之前                           |

只有 #2 被替换，#5 新增一条清除路径。其余六类维持现有门槛不动。

## 5. 分阶段实施

**Phase 1（已实现）—— 并行兜底**
新增 `RemoteAppliedPlayback`，只在旧的 700ms 窗**已判定不抑制**时补位。所有及时路径上
行为与改动前逐字节一致，因此行为增量恰好等于「堵住泄漏」。归属只覆盖停止态，`playing`
方向完全交给原有时间窗。抑制时记 `Suppressed leaked echo by ownership`，每次释放也记
原因，使修复效果与潜在的过度抑制都能在用户可回传的日志里看到。污染源 #5 的清除路径
同期落地。

**Phase 2 —— 归属成为主判定**
`shouldSuppressLocalEcho` 改为先查归属，`suppressedRemotePlayback` 退化为 `playing`
方向的时间上界——该方向归属仍然不覆盖。

**Phase 3 —— 清理**
删除 `REMOTE_ECHO_SUPPRESSION_MS` 与 `suppressedRemotePlayback`。

Phase 1 已经能消除事故场景，2/3 是收敛技术债，可以缓做。

## 6. 风险

**最大风险：归属未被正确清除 → 用户真实操作被静默吞掉。**
这比原 bug 更糟：原 bug 表现为「卡在暂停」，用户能看见；被吞的操作是静默的，
用户只觉得「有时按了没反应」。

缓解措施：

1. C1（gesture 清除）在判定链最前面，且用 player 内手势，避免误清除的同时保证真实
   操作必然清除。
2. 抑制时打印归属来源（`actorId` / `seq` / 距 `appliedAtLocal` 多久），使「被吞」在
   日志里可见。
3. Phase 1 的并行兜底模式让新逻辑先只做增量，线上观察后再切主判定。
4. 30s 兜底上限作为最后防线，触发即记 warn。

## 7. 相关

- [PR #220](https://github.com/sky1wu/Bili-SyncPlay/pull/220) —— 服务端侧：steady tick
  不再刷新播放否决窗口
- `AGENTS.md` 的「Playback timing invariants」——本设计中的 `appliedAtLocal` 是本地
  单调时刻，只与本地时刻相减，不与 `serverTime` 混用
