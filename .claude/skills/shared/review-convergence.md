# 评审收敛契约

`add-feature`、`fix-issue` 和 `review-round` 在编辑前完整读取本文件。这里仅定义决策规则；
不要在处理评审时顺手发明 worktree、依赖安装、提交状态机或其他基础设施。

## Gate 0：先决定能否编辑

用稳定的 `Problem ID` 标识必须解决的用户问题；它跨 PR、跨设计尝试保留。每个 PR 只承载
一个 `Design Attempt`，并用 `Change Unit` 锁定一个行为目标、一个主要所有者、一组失败与
清理出口，以及一套验收证据。替代 PR 必须沿用 `Problem ID`、链接 `Parent PR`，并读取父
PR 的 Root 历史；换 PR 不会清零失败记录。

为每个缺陷或评审意见分配稳定的 `Root ID`，并回答：

1. 错误事实第一次在哪里产生，而不是最后在哪里显现？
2. 被破坏的不变量是什么？
3. 哪条调用链、日志或最小复现证明这个判断？
4. 正确决策需要什么信息，哪一层拥有它？
5. 什么最小实验能推翻当前假设？

纯新功能用 `Decision ID` 代替 `Root ID`，说明用户结果、边界、非目标、所有者和验收证据。
这些问题没有答案时只调查，不编辑。不同文件或脚本不自动等于不同所有者；按谁拥有正确
决策和生命周期判断边界。

## 从 PR 历史恢复身份与根因

创建 PR 后立即运行 `review-cycle.sh --initialize`，追加唯一、不可改名的身份 marker：

```text
[Review-Unit: pr-<PR编号>]
[Problem-ID: <kebab-case>]
[Change-Unit: <kebab-case>]
[Parent-PR: none|<PR编号>]
```

处理评审前运行 `review-cycle.sh <PR编号>`，从 marker 恢复身份及完整祖先链；不要让新会话
重新输入 Change Unit。marker 缺失、重复、改名、祖先 Problem ID 不一致、形成环或历史不
连续时执行 `STOP`。同时读取当前 PR 和每个祖先 PR 的全部 review threads（含 resolved）。
替代设计的分支名必须从 Parent PR 派生，不能复用仍由失败 PR 占用的原分支名。

线程回复必须以三行元数据开头，使下一次会话能恢复根因决策：

```text
[Change-Unit: <kebab-case>]
[Root-ID: <kebab-case>] 或 [Decision-ID: <kebab-case>]
[Resolution: first-fix|structural-redesign|rejected|follow-up]
```

已被外部 resolve 的线程只有在同一条决策回复已经存在时才能当作成功；否则执行 `STOP`，
不得让 resolved 状态抹掉根因历史。不要用评论数量、diff 大小或“测试全绿”代替该历史。

## 修复批次，而不是评审次数

预算限制同一 Design Attempt 的**代码修复批次**；流程只为初始 head、C1 head 和 C2 head
各安排一次结果，不对同一 head 更换 reviewer 反复检视：

```text
初始实现 → R0 → 修复批次 C1 → R1 → 最后批次 C2 → 终局评审 R2
```

每次修复提交推送后立即运行 `review-cycle.sh <PR编号> --record-repair`，追加并重读确认：

```text
[Review-Repair: 1/2 或 2/2]
[Review-Unit: pr-<PR编号>]
[Reviewed-Head: <40-char SHA>]
```

同一 head 重跑保持幂等；重复 marker、同一 head 被记成两批或第三个新 head 都执行 `STOP`。
skill 行为前向测试和主代理按既定出口清单做实现核对不产生 repair；只有推送新的修复实现才
消耗批次。

## 继续、重做和停止

- `first-fix`：Root ID 第一次出现，只在错误事实首次产生且信息完备的所有者中修复，并审计
  同一生命周期的全部入口、出口、reset、cleanup、失败和乱序路径。
- `structural-redesign`：同一 Root ID 在 R1 再次出现，C2 中只允许一次所有权或生命周期重做，
  不增加同生命周期的 suppression flag、cooldown 或局部特例。
- `follow-up`：终局评审发现真实但不属于当前验收范围、且不影响正确性、安全性或数据完整性
  的问题；登记独立 issue 后可回复并 resolve，不修改当前 PR。
- `rejected`：有可复核证据证明意见不成立；回复证据并 resolve，不修改代码。
- `STOP_FAILED`：R2 后仍有范围内的真实阻塞问题，或结构性重做后同根复发。停止当前 PR 的
  代码修改且不得合并，但保持 Problem 开放；把反例固化为测试/不变量，从干净基线启动具有
  新根因假设的替代 Design Attempt，并沿用 Problem ID、Parent PR 和 Root 历史。
- `STOP_AND_SPLIT`：一个评审批次证明存在多个真正的决策/生命周期所有者。保留当前线程，
  将它们拆为独立 Change Unit；父 Problem 在所有阻塞单元完成前保持开放。

普通的“继续”不能覆盖停止状态；恢复实现需要用户明确批准新的设计假设或拆分范围。轮次
上限是升级到重新设计的阈值，不是放弃 Problem 的阈值。

## 验证边界

- 流程或脚本先写前置条件、成功后置条件，以及每项已取得资源的失败回滚；按真实 cwd、脏净
  状态和提交前后状态端到端运行。
- 回归测试必须在只移除被守护行为时因目标断言失败；反向对照仍应通过。源码 `grep` 只能
  辅助定位，不能作为行为正确性的主要证据。
- 每次 commit 和 push 前分别运行仓库规定的完整门禁。只复审已提交、工作树干净且完整门禁
  通过的结果。
- 评审发现仓库缺少通用基础设施时，记录为独立 Change Unit；不要在当前修复中临时扩建。
