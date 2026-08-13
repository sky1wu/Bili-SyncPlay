# 结构性修复与评审收敛（共享规则）

`fix-issue`、`add-feature` 和 `review-round` 共同使用本文件。根因格式、轮次判定和停止条件
只在这里定义；各 skill 不得复制后自行修改。

## 1. 写代码前：可证伪的根因

为每个因果问题分配稳定的 `Root ID`，并写清：

1. 错误事实首次产生的位置，而不是最终显现的位置。
2. 被破坏的不变量。
3. 证明判断的调用链、日志或最小复现。
4. 正确决策需要的信息，以及真正拥有这些信息的层。
5. 能推翻当前假设的最小实验和预期失败方式。

修复默认落在错误事实首次产生且信息完备的层。本地状态或分类错误若要扩到协议、服务端、
持久化或接收端，必须先证明原层信息不足。谁执行效果，谁就在同一同步边界记录效果身份；
排队、timer 或 `await` 前的预测标记不能代替效果所有权。

以下任一项出现时立即停止编辑并重画所有权、生命周期和全部出口：

- 在已有 suppression flag、cooldown 或特例上再加一个同生命周期机制。
- 一个局部 bug 扩到三个及以上架构层，却没有原层信息不足的证据。
- 发送端、接收端和持久化层分别补偿同一成因。

## 2. 持久收敛记录

收敛记录使用带 `<!-- review-convergence:v1 -->` 标记的**追加式 PR 评论**，不覆写 PR body，
避免覆盖并发编辑。读取时按 GitHub 评论时间排序：

```bash
PR=<编号>
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
gh api --paginate --slurp "repos/$REPO/issues/$PR/comments" \
  --jq 'flatten | map(select(.body | contains("<!-- review-convergence:v1 -->")))
        | sort_by(.created_at)[] | [.created_at, .body] | @tsv'
```

一次完成的评审产生一条评论；评论头记录 `Head`、`Mode: pre-push|auto|manual|legacy`、
`Result: findings|passed|unknown` 和唯一 `Signal`，随后每个独立根因一行：

| Root ID | Class | Layers | New states | Uncovered exits | Decision |
| ------- | ----- | -----: | ---------: | --------------: | -------- |
| `<id>`  | new   |  `<n>` |      `<n>` |           `<n>` | proceed  |

- `Class` 是 `new` 或 `same-root`；同一因果问题始终沿用同一 `Root ID`。
- 三项数字均针对 PR merge base 到该 `Head` 的最终产品；`Uncovered exits` 目标为 `0`。
- `Signal` 对 findings 使用本轮线程 id 的排序集合，对 passed 使用 `round-signal.sh` 输出的
  reaction 时间，manual 使用 `manual:<Head>`，pre-push 使用 `pre-push:<Head>`。写入前发现
  同一 `(Head, Mode, Signal)` 已存在就跳过，避免重跑 skill 重复计轮。
- 旧 PR 无历史时追加一条 `Mode: legacy`、`Result: unknown`、`Signal: unknown` 的说明评论；它没有根因行，
  不参与连续轮次计算，不能伪造历史数据。
- `NOT-TRIGGERED`、仍在进行的评审和 API 读取失败不算一轮，也不写完成评论。
- 同一 Head 的自动评审以新 Signal 重新完成一次，算新一轮；自动评审明确不可用时，对
  同一 Head 完成一次手工复审并记 `Mode: manual`，也只算一轮，之后同一 Head 的自动通过
  信号不得再重复计轮。
- 本地 push 前复审不是远端轮次；其根因先记在当前任务工作记录中，PR 建立后在首条评论
  的 `Pre-push findings` 段回填，且同样受下面的停止条件约束。

发布评论前先重新读取现有标记评论，再用 `gh pr comment "$PR" --body "..."` 追加；禁止
用 `gh pr edit --body` 维护账本。

连续第二个完成轮次出现同一 `Root ID` 时，停止逐行修补，重新画完整职责、状态/效果
所有权、全部出口和生命周期。连续第三轮仍是同根，或 `Layers` / `New states` 继续增长，
撤销未发布的未收敛机制，从所有权重新设计；已推送历史只用普通新提交纠正。只有验收标准
允许或用户明确确认时才能缩小产品范围。

## 3. 只评审实际提交

任何切分支、checkout 或编辑前先运行：

```bash
test -z "$(git status --porcelain=v1 -uall)" || {
  echo "工作树或索引不干净；在从目标 SHA 创建的独立干净 worktree 中执行本任务" >&2
  exit 1
}
```

不得先切分支再检查，也不得携带、stash、提交或覆盖用户已有改动。需要独立 worktree 时，
任务分支只在新 worktree 中创建；后续所有命令都在那里执行。

本地复审只针对已经 commit、完整门禁通过且工作树干净的实际 HEAD。用精确 merge base
排除 base 分支后来前进的提交，同时覆盖 HEAD 上整个 PR 产品，而不是只看最后一笔补丁：

```bash
BASE_REF=origin/<base>
git fetch origin <base>
test -z "$(git status --porcelain=v1 -uall)" || exit 1
BASE_COMMIT=$(git merge-base HEAD "$BASE_REF")
codex review --base "$BASE_COMMIT"
```

复审有意见就禁止 push，按第 1～2 节重新分析；修正后重新 commit、跑完整门禁并复审。
Codex 明确额度耗尽或不可用时，记录没有自动结果，并人工检查
`git diff "$BASE_COMMIT" HEAD` 的同一最终产品。“没有未解决线程”不能替代复审通过。
