# 评审收敛契约

`add-feature`、`fix-issue` 和 `review-round` 在编辑前完整读取本文件。这里仅定义决策规则；
不要在处理评审时顺手发明 worktree、依赖安装、提交状态机或其他基础设施。

## Gate 0：先决定能否编辑

为本次改动写下一个稳定的 `Change Unit`：一个行为目标、一个主要所有者、一组失败与清理
出口，以及一套验收证据。同时列出允许修改的文件或模块和明确非目标。

为每个缺陷或评审意见分配稳定的 `Root ID`，并回答：

1. 错误事实第一次在哪里产生，而不是最后在哪里显现？
2. 被破坏的不变量是什么？
3. 哪条调用链、日志或最小复现证明这个判断？
4. 正确决策需要什么信息，哪一层拥有它？
5. 什么最小实验能推翻当前假设？

纯新功能用 `Decision ID` 代替 `Root ID`，说明用户结果、边界、非目标、所有者和验收证据。
这些问题没有答案时只调查，不编辑。

## 从 PR 历史恢复根因

处理评审前读取当前 PR 的全部 review threads，包括已解决线程，并读取该 Change Unit 的
评审尝试状态。若读取工具警告历史不完整，执行 `STOP`。

PR 创建隐式占用第一次独立语义检视；无 finding 的首轮也因此可恢复。启动任何后续独立
检视前，必须用 `review-attempt.sh` 追加一条第二次尝试 marker；marker 已存在就表示预算耗尽，
不得启动第三次：

```text
[Review-Attempt: 2/2]
[Change-Unit: <kebab-case>]
[Reviewed-Head: <40-char SHA>]
```

追加式 PR 评论是评审预算的唯一持久记录，不维护可覆盖的 PR body 账本。线程回复必须以
三行元数据开头，使下一次会话能把 finding 归回同一 Change Unit：

```text
[Change-Unit: <kebab-case>]
[Root-ID: <kebab-case>] 或 [Decision-ID: <kebab-case>]
[Resolution: first-fix|structural-redesign|rejected]
```

不要用评论数量、diff 大小或“测试全绿”代替根因历史。无法判断轮次或根因是否重复时，按
更保守的状态处理。

## 继续、重做和停止

- `first-fix`：某个 Root ID 第一次出现，只在错误事实首次产生且信息完备的所有者中修复，
  并审计同一生命周期的全部入口、出口、reset、cleanup、失败和乱序路径。
- `structural-redesign`：第二次出现同一 Root ID，停止逐条补评论；只允许一次所有权或生命周期
  重做，不增加同生命周期的 suppression flag、cooldown 或局部特例。
- `STOP`：结构性重做后同一 Root ID 再次出现；修复需要跨出 Change Unit；或新增机制、状态、
  资源种类仍在增长。此时不编辑、不 resolve、不触发新复审，报告已验证事实和剩余风险，
  由用户明确决定放弃、拆分或扩大范围。
- `STOP_AND_SPLIT`：一轮反馈暴露出多个主要所有者。不要把它们塞进同一 PR；保留当前线程，
  提议拆成独立 Change Unit。

普通的“继续”只继续当前允许的步骤，不能覆盖 `STOP` 或 `STOP_AND_SPLIT`。恢复编辑需要用户
明确选择新的范围或处置方式。

同一 Change Unit 最多进行两次独立语义检视。Codex review、reviewer 子代理和独立人工复核
共享预算；skill 行为前向测试和主代理按既定出口清单做实现核对不算产品语义检视。第二次
marker 必须在 reviewer 启动前写入；预算用尽后不换 reviewer 开第三轮。

## 验证边界

- 流程或脚本先写前置条件、成功后置条件，以及每项已取得资源的失败回滚；按真实 cwd、脏净
  状态和提交前后状态端到端运行。
- 回归测试必须在只移除被守护行为时因目标断言失败；反向对照仍应通过。源码 `grep` 只能
  辅助定位，不能作为行为正确性的主要证据。
- 完成前运行仓库规定的完整门禁。只复审已提交、工作树干净且完整门禁通过的结果。
- 评审发现仓库缺少通用基础设施时，记录为独立 Change Unit；不要在当前修复中临时扩建。
