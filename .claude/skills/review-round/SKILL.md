---
name: review-round
description: 处理当前 PR 的一轮 Codex 评审反馈。从读取评审信号、逐条定位根因、修复、验证、回复线程到推送的完整单轮流程。当用户请求"处理评审意见"、"处理下一轮反馈"、"看看 Codex 说了什么"或类似单轮评审响应任务时触发。不负责合并。
---

# review-round — 处理一轮 Codex 评审反馈

处理**一轮**评审。任何一步失败都先修复再进下一步，**不要跳步**。

开始前完整读取 `.claude/skills/shared/review-convergence.md`。根因格式、轮次记录和停止条件
只以该文件为准。

| 脚本                      | 作用                                                |
| ------------------------- | --------------------------------------------------- |
| `verify-branch.sh <PR>`   | 校验本地分支名 **和** SHA 与 PR head 一致；拒 fork  |
| `list-unresolved.sh <PR>` | 翻页列出全部未解决线程，正文不截断，标注所属 commit |
| `has-changes.sh`          | 判断本轮有无改动（含未跟踪文件）                    |
| `reply-resolve.sh`        | 重读线程 → 回复 → 确认 → resolve                    |
| `round-signal.sh <PR>`    | 无未解决线程时区分「通过」与「没触发」              |
| `selftest.sh [PR]`        | 对上述防护做判别力测试                              |

不要把脚本抄成一次性命令。改动这些脚本后必须跑
`.claude/skills/review-round/scripts/selftest.sh <PR编号>`。

## 0. 在切分支前拒绝脏工作树，再定位 PR

```bash
set -e
test -z "$(git status --porcelain=v1 -uall)" || {
  echo "工作树或索引不干净；停止切分支，在独立干净 worktree 中重新开始" >&2
  exit 1
}

PR=<已从用户输入或当前分支确认的实际数字>
[ -n "$PR" ] || { echo "无法确定 PR 编号"; exit 1; }
.claude/skills/review-round/scripts/verify-branch.sh "$PR" --switch
```

不要原样执行尖括号占位符；每个后续命令块都重新写入这个实际数字，不依赖上一 shell 的变量。

检查必须发生在 `verify-branch --switch` 之前；Git 会把不冲突的脏改动带过分支，切完再查
已经晚了。若被拒绝，不 stash、不替用户提交，改在目标 SHA 的独立干净 worktree 中执行。

按共享文件第 2 节读取全部带标记的收敛评论。若一条都没有，为旧 PR 追加一次
`Mode: legacy` / `Result: unknown` 说明；该行不参与轮次计算。追加前必须重新读取，避免
重复写入。

## 1. 读取全部未解决线程

```bash
PR=<第0步确认的实际数字>
.claude/skills/review-round/scripts/list-unresolved.sh "$PR"
```

以线程为权威信号，不用 reaction 或 REST review comments 代替：reaction 会漏意见，REST
接口没有 resolved 状态。脚本会读完分页、完整正文、线程内全部评论，并标注 `[作者 @sha]`；
API 或解析失败必须停止，不能把“没读到”当成“没有”。

有线程进第 2 步；没有线程直接进第 8 步。

## 2. 核对线程对应的 reviewed head

```bash
git rev-parse --short HEAD
```

逐线程比较评论的 `@sha`。旧 SHA 的意见先在当前产品上确认是否仍成立，不能按全局 review
列表猜测。按线程首条评审评论的 commit/head 分组（短 SHA 用 `git rev-parse` 还原）；一个
reviewed head 生成一条收敛评论，不把多个 SHA 塞进同一条 `Head` 记录。来源不能确认时停止
记账并重新读取上下文。

## 3. 先归因和记账，再编辑

先列出全部 P1/P2 意见，不边看边改。每个问题按共享文件第 1 节完成可证伪的根因记录，
沿用或分配稳定 `Root ID`，再根据历史标记评论归类 `same-root` / `new`。

基于每个 reviewed head 相对 merge base 的**最终产品**分别计算 `Layers`、`New states` 和
`Uncovered exits`。编辑前重新读取标记评论，然后每组追加一条：

```markdown
<!-- review-convergence:v1 -->

Head: <reviewed-full-sha>
Mode: auto
Result: findings
Signal: threads:<排序后的 thread-id@当前评论总数，以逗号分隔>

| Root ID | Class  | Layers | New states | Uncovered exits | Decision |
| ------- | ------ | -----: | ---------: | --------------: | -------- |
| <实值>  | <实值> | <实值> |     <实值> |          <实值> | <实值>   |
```

用 `gh pr comment "$PR" --body "..."` 追加，不修改 PR body；一个独立根因一行，禁止提交
占位符。拒绝意见或无需代码的意见也要记录，因为它仍是完成的评审轮次。

执行共享文件的收敛闸门：连续第二轮同根就停止逐行编辑并重画所有权/生命周期/全部出口；
第三轮同根或层数、状态数继续增长，就撤销未发布机制后重设计。不要以线程数下降冒充收敛。

记录编辑前基线：

```bash
.claude/skills/review-round/scripts/has-changes.sh --baseline /tmp/rr-baseline
```

## 4. 审计同类路径

- grep 被改签名的全部调用点，含 `server/src/app.ts` 与各 `index.ts` 适配层。
- 状态问题检查所有写入、读取、reset 和 cleanup。
- 效果问题检查全部出口；事件/异步问题覆盖缺失、重复、乱序和 timer/`await` ABA。
- 异步 Redis / 锁操作确认都 `await` 且包 `try/catch`。
- 协议改动执行 AGENTS.md 的完整协议清单。

逐项列出“已处理 / 不适用及原因”。每次 Edit/Write 后立刻重读改动区域。

## 5. 验证

```bash
.claude/skills/review-round/scripts/has-changes.sh /tmp/rr-baseline || echo "本轮无代码改动，跳到第 7 步"
```

有代码改动时：

- 回归测试必须在只回退核心实现时因目标断言失败，反向对照仍通过；确认不是“找不到用例”。
- 按风险覆盖缺失、重复、乱序和 ABA；计时问题优先断言何时发生，不只统计次数。
- 不用 `git checkout` / `git restore` 回退探针；事前 `cp` 源文件，测试后复制回来。
- 重读全部改动，随后运行完整门禁：

```bash
npm run format:check && npm run lint && npm run typecheck && npm run build && npm test && npm run audit
```

不得把检查管道给 `tail` / `head` 后据此判断成功；失败时报告完整输出。

## 6. 提交、本地最终产品复审、推送

```bash
set -e
git add <本轮实际改动的具体文件>   # 严禁 git add -A / git add .
git diff --cached
git commit -m "fix: ..."
npm run format:check && npm run lint && npm run typecheck && npm run build && npm test && npm run audit
```

门禁通过后，在独立命令中复审实际提交。每个命令块都重新解析自己的变量：

```bash
set -e
PR=<第0步确认的实际数字>
BASE_REF=$(gh pr view "$PR" --json baseRefName --jq .baseRefName)
git fetch origin "$BASE_REF"
test -z "$(git status --porcelain=v1 -uall)" || exit 1
BASE_COMMIT=$(git merge-base HEAD "origin/$BASE_REF")
codex review --base "$BASE_COMMIT"
```

完整读取复审输出。命令失败或输出含任何 finding 时停止，只记入任务的 pre-push 意见，
回到根因/设计步骤；不要发布 `Mode: auto` 记录，也不要执行下面的 push。只有明确无意见后，
才另开命令执行：

```bash
set -e
PR=<第0步确认的实际数字>
.claude/skills/review-round/scripts/verify-branch.sh "$PR" --allow-ahead
git push origin "HEAD:$(gh pr view "$PR" --json headRefName --jq .headRefName)"
```

本地复审审查 HEAD 上完整 PR 产品。有意见就新建正常修正提交并重跑门禁/复审，不改写
已发布历史；最终通过并 push 后，将任务记录中的本地根因写成一条 `Mode: pre-push` 评论。
Codex 明确额度耗尽时，记录没有自动结果并手工复审同一最终产品。

## 7. 回复并 resolve

```bash
set -e
PR=<第0步确认的实际数字>
.claude/skills/review-round/scripts/reply-resolve.sh \
  <线程id> "已修。<改在哪、怎么验证；不采纳则写理由>" <第1步看到的评论数>
.claude/skills/review-round/scripts/list-unresolved.sh "$PR" --count
```

脚本会先重读线程；扫描后新增评论时拒绝 resolve。最后一行必须输出 `0` 才算归零。

## 8. 识别完成信号并记录通过轮次

```bash
signal_code=0
PR=<第0步确认的实际数字>
SIGNAL=$(.claude/skills/review-round/scripts/round-signal.sh "$PR") || signal_code=$?
printf '%s\n' "$SIGNAL"
if [ "$signal_code" -ne 0 ]; then
  exit "$signal_code"
fi
```

- `PASSED`：使用输出中的 reaction 时间作为 `Signal`，重新读取标记评论；若同一
  `(Head, Mode: auto, Signal)` 尚不存在，且同一 Head 没有任意完成的 manual 记录，
  追加一条无根因行的通过评论，然后成功结束。
- `REVIEWING`：不写完成评论，继续等待。
- `NOT-TRIGGERED`：不算轮次、不写评论，评论 `@codex review` 触发后再检查，并保留非零状态。
- Codex 明确不可用：对同一 HEAD 完成手工最终产品复审，按结果追加一次
  `Mode: manual` / `Result: passed|findings`；同一结果不得重复记成自动轮。

每次写评论前都按共享文件第 2 节重读全部标记评论并检查重复。无未解决线程本身不等于
评审通过。此 skill 不负责合并；没有用户针对当前 PR 的明确授权，严禁 `gh pr merge`。

## 硬性规则

- 严禁在脏工作树上切分支或开始本轮。
- 严禁只修被标的一行而不审计同类路径。
- 严禁 `git add -A` / `git add .`、`--no-verify`、`--no-gpg-sign`。
- 严禁用 reaction 代替线程读取，或把 `NOT-TRIGGERED` 当通过。
- 未真正跑过的检查不得声称已验证。
