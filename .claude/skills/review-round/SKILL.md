---
name: review-round
description: 处理当前 PR 的一轮 Codex 评审反馈。从读取评审信号、逐条定位根因、修复、验证、回复线程到推送的完整单轮流程。当用户请求"处理评审意见"、"处理下一轮反馈"、"看看 Codex 说了什么"或类似单轮评审响应任务时触发。不负责合并。
---

# review-round — 处理一轮 Codex 评审反馈

处理**一轮**评审。任何一步失败都先修复再进下一步，**不要跳步**。

开始前完整读取 `.claude/skills/shared/review-convergence.md`。本 skill 只处理一个远端评审
轮次，不在内部再启动 `codex review`，也不另建轮次账本。

易错的多步操作都在 `scripts/` 下，**不要把它们抄成一次性命令**——脚本里带着错误处理、
翻页和判别力测试，散写在对话里的版本必然会丢掉其中某一项（这份技能的前三轮评审共
20 条意见，绝大多数正是这么来的）。

| 脚本                      | 作用                                                |
| ------------------------- | --------------------------------------------------- |
| `verify-branch.sh <PR>`   | 校验命名分支或明确 detached HEAD 与 PR head 一致    |
| `list-unresolved.sh <PR>` | 翻页列出全部未解决线程，正文不截断，标注所属 commit |
| `has-changes.sh`          | 判断本轮有无改动（含未跟踪文件）                    |
| `reply-resolve.sh`        | 重读线程 → 回复 → 确认 → resolve                    |
| `round-signal.sh <PR>`    | 无未解决线程时区分「通过」与「没触发」              |
| `selftest.sh [PR]`        | 对上述防护做判别力测试                              |

开始前，把**当前正在执行的** `review-round/SKILL.md` 所在目录的绝对路径记为任务上下文中的
`REVIEW_ROUND_HOME`。后续代码块里的 `<REVIEW_ROUND_HOME>` 都必须在调用工具前替换为这个
具体绝对路径；不得改为目标 PR checkout 里的相对路径。

同时把其同级 `shared/isolated-worktree.sh` 的绝对路径记为 `ISOLATED_WORKTREE_HELPER`。
下文的 `<ISOLATED_WORKTREE_HELPER>` 同样必须替换为这个具体路径。

改动这些脚本后必须跑 `<REVIEW_ROUND_HOME>/scripts/selftest.sh <PR编号>`。

## 0. 确定 PR 编号，切到它的 head 分支并校验

先在 shell 外确定 PR 编号并验证为纯数字。下列每个命令块里的 `PR=123` 都替换为这个实际
数字；Bash 工具不保留 shell 状态，不能依赖上一块的变量：

```bash
set -e
test -z "$(git status --porcelain=v1 -uall)" || {
  echo "工作树或索引不干净；在独立干净 worktree 中重新开始" >&2
  exit 1
}
PR=123 # 替换为已验证的实际数字

'<REVIEW_ROUND_HOME>/scripts/verify-branch.sh' "$PR" --switch
```

技能可能从 `main` 或别的分支启动。只比分支名不够：同名本地分支可能落后于远端，那样
你会基于旧代码处理反馈、把针对当前提交的意见误判成过时，直到 push 被非快进拒绝才
暴露。脚本同时校验 `headRefOid`，并拒绝 `main`/`master` 与 fork PR。

若当前 worktree 不干净，不要在其中 stash、切分支或强制重复检出 PR 分支。通过共享 helper
取回并校验精确 PR head、建立 detached worktree，再用当前 skill 的 verifier 校验：

```bash
set -e
PR=123 # 替换为已验证的实际数字
'<ISOLATED_WORKTREE_HELPER>' create-review "$PR" \
  '<REVIEW_ROUND_HOME>/scripts/verify-branch.sh'
```

把 helper 输出的绝对路径和 PR head 记为任务上下文的具体值。从第 1 步起，**每次**工具调用
都把 `workdir` 显式设为记录的 `ISOLATED_WORKTREE`，不得依赖 shell 的 `cd` 或变量持久化。
detached worktree 内的提交仍用第 6 步的 `git push origin "HEAD:<PR head>"` 更新原 PR，不会
移动被其他 worktree 占用的本地分支引用。

结合当前任务记录和 PR 已有评审线程，判断这是该变更单元的第一次还是第二次独立语义检视。
Codex review、子代理代码审计和独立人工 reviewer 共享这两次预算；无法确认时按第二次处理，避免换一种
检视方式就误开第三轮。

## 1. 读未解决的评审线程（权威信号）

```bash
set -e
PR=123 # 替换为第0步已验证的实际数字
'<REVIEW_ROUND_HOME>/scripts/list-unresolved.sh' "$PR"
```

**不要用 reaction 判断有没有意见。** 本仓库实测：意见最多的 PR221（11 条）和 PR222
（14 条）reaction 完全为空；而 PR220、PR224 有 👍 但 reviews 和 comments 都是 0。
两种信号各自都会漏判，必须以线程为准。REST 的 `pulls/$PR/comments` 也不行——它不返回
解决状态，第 2 轮会把上一轮已 resolve 的意见重新摆上清单。

脚本已经处理掉这几件事，看输出即可：正文完整不截断（只剥 shields.io 徽章，保留评审者
贴的截图）、读完线程里每一条评论、按游标翻页取全、每条评论标注 `[作者 @sha]`。
API 或解析失败时脚本以非零退出——**「没读到」绝不能被当成「没有」**。

**有未解决线程 → 进第 2 步。一条都没有 → 进第 8 步。**

## 2. 核对每条线程对应的是当前 HEAD

```bash
git rev-parse --short HEAD
```

拿它和第 1 步输出里每条评论的 `@sha` 比。**要逐线程比，不能只看全局 review 列表**：
PR 上有多轮评审时列表里既有旧 SHA 也有当前 SHA，无从对应。本仓库 PR225 实测就同时
挂着 `2ab3b09` 和 `938c337` 两轮的线程。`@sha` 不是当前 HEAD 的，先确认那条是否仍成立。

## 3. 逐条陈述根因，再改

先把清单摆出来并标注严重级别（P1/P2），**不要边看边改**。对每一条：

- 用一句话陈述**根因**，而不是复述现象。
- 点名证明它的代码路径或日志行。
- 分配或沿用稳定 `Root ID`，说明它是首次还是同根重复，并核对共享规则中的范围预算。
- 然后才编辑。
- **每次 Edit/Write 之后立刻重读改动区域**，确认改动真的落地了，再动下一处。
  静默失败的字符串替换在本仓库发生过多次；拖到第 5 步才发现，意味着中间的审计全部
  建立在一处并不存在的改动上。

**宁要单一根因修复，不要层叠补丁。** 若修复需要在已有的抑制标志 / 冷却期 / 特例分支
之上再加一个，停下来重新推导根因——见 AGENTS.md 的 `## Debugging Sync Bugs`。

第二次仍是同根时，停止逐条补评论，通过普通修正提交撤回同根临时机制并做一次结构性
重设计，不改写已推送历史；重设计后仍是同根，或层数/状态数继续增长，就停止自动编辑并
向用户报告。不要为统计轮次增加 PR 评论标记、commit trailer、临时状态文件或辅助脚本。

**编辑前必须先记一份工作树基线**，第 5 步要拿它判断本轮到底改了什么：

```bash
'<REVIEW_ROUND_HOME>/scripts/has-changes.sh' --baseline /tmp/rr-baseline
```

## 4. 审计同类路径（不要只修被标的那一行）

被标出的往往只是同一类问题的一个实例。

- grep 出被改签名的**全部调用点**，含 `server/src/app.ts` 与各 `index.ts` 适配层。
  编译器的边界见 AGENTS.md 的 `## Protocol Changes` 第 2 条。
- 状态清理 / reset 函数：grep 每一处相关状态，逐一确认。
- 效果问题：检查全部入口/出口、状态读写、失败路径，以及事件缺失、重复、乱序和
  timer/`await` ABA。
- 异步 Redis / 锁操作：确认都 `await` 且包了 `try/catch`。
- 协议相关改动：走 AGENTS.md 的 `## Protocol Changes` 清单。

逐个列出「已处理 / 不适用及原因」，再进下一步。

主代理执行上述有界清单属于实现工作，不占用独立检视预算。若委托子代理以 reviewer 身份审计，则占用一次；
若已无预算，由主代理按同一清单完成复核，不再委托或跟进子代理形成新一轮。

## 5. 验证

```bash
'<REVIEW_ROUND_HOME>/scripts/has-changes.sh' /tmp/rr-baseline || echo "本轮无改动，跳到第 7 步"
```

判断的是**相对第 3 步基线的新增**，两个方向都得防住：

- 用 `git status --porcelain` 而非 `git diff --quiet`——后者看不到未跟踪文件，只新增
  测试或文档的一轮会被误判成无改动，跳过验证和提交却仍去 resolve，改动就此丢失。

有改动时：

- 对全部改动做提交前复核，确认没有被后续编辑覆盖掉。
- 新增的回归测试必须在**修复前的代码上失败**。回退修复时**只回退源文件**：

  ```bash
  cp <源文件> /tmp/fix.bak    # 事前备份
  # …验证…
  cp /tmp/fix.bak <源文件>    # 还原
  ```

  **不要整仓 `git stash`**：新测试若追加在已跟踪的测试文件里会被一起 stash 走，测试
  因「找不到用例」而退出非零，看着是红的，其实什么都没验证。确认失败原因是**断言
  失败**，不是用例不存在。

- 跑完整预提交序列，逐项断言退出码：

  ```bash
  fail=""
  for step in format:check lint typecheck build test audit; do
    npm run "$step" > "/tmp/rr-$step.log" 2>&1
    code=$?
    echo "$step exit=$code  log=/tmp/rr-$step.log"
    if [ $code -ne 0 ]; then
      echo "===== $step 完整输出 ====="; cat "/tmp/rr-$step.log"
      fail="$step"; break
    fi
  done
  if [ -n "$fail" ]; then echo "FAILED: $fail"; exit 1; fi
  echo "ALL-GREEN"
  ```

  失败必须 `exit 1`，否则依赖退出状态的执行者会带着未通过的检查继续提交。
  `[ $code -ne 0 ] && { …; break; }` 那种写法的循环退出码是**反的**（全绿返回 1、
  失败返回 0）。失败时 `cat` 完整日志而非 `tail -40`——AGENTS.md 要求报告真实输出。
  **严禁 `npm run typecheck | tail`**：管道让退出码变成 `tail` 的。

## 6. 提交、推送

```bash
set -e
PR=123 # 替换为第0步已验证的实际数字
git add <本轮实际改动的具体文件>   # 严禁 git add -A / git add .
git diff --cached                  # 核对暂存内容
git commit -m "fix: ..."
npm run format:check && npm run lint && npm run typecheck && npm run build && npm test && npm run audit
```

若本轮已经是第二次有意见的独立语义检视，此时由主代理按既定清单审计 base 到 HEAD 的最终产品，再继续。随后在
独立命令中复验并推送：

```bash
set -e
PR=123 # 替换为第0步已验证的实际数字
test -z "$(git status --porcelain=v1 -uall)" || exit 1
# 推送前复验（中途可能被切走）。--allow-ahead 是必须的：刚 commit 完本地一定
# 领先远端 headRefOid，严格相等会让每个有提交的轮次都在 push 前中止。
if git symbolic-ref --quiet --short HEAD >/dev/null; then
  '<REVIEW_ROUND_HOME>/scripts/verify-branch.sh' "$PR" --allow-ahead
else
  '<REVIEW_ROUND_HOME>/scripts/verify-branch.sh' "$PR" --detached --allow-ahead
fi
git push origin "HEAD:$(gh pr view "$PR" --json headRefName --jq .headRefName)"
```

## 7. 回复并 resolve 线程

```bash
set -e
PR=123 # 替换为第0步已验证的实际数字
'<REVIEW_ROUND_HOME>/scripts/reply-resolve.sh' <线程id> "已修。<改在哪、怎么验证的；不采纳则写明理由>" <第1步看到的评论数>
'<REVIEW_ROUND_HOME>/scripts/list-unresolved.sh' "$PR" --count
```

脚本会先重读线程：若评论数与第 1 步不一致，说明扫描之后评审者又补了内容，此时**拒绝
resolve** 并打出最新一条，让你先把它纳入根因分析。确认回复拿到 comment id 之后才
resolve——只跑 `resolveReviewThread` 会把线程静默关掉，评审者看不到改在哪。

最后一行必须输出 `0` 才算归零。

## 8. 本轮结束——**不要合并**

### 8.1 检查下一轮信号（仅第一次独立检视）

保持工具 `workdir` 在刚推送的 PR worktree；`round-signal.sh` 会从该目录读取 HEAD。只有第一次有意见的
独立语义检视才运行：

```bash
set -e
PR=123 # 替换为第0步已验证的实际数字
'<REVIEW_ROUND_HOME>/scripts/round-signal.sh' "$PR"
```

输出 `PASSED` / `REVIEWING` / `NOT-TRIGGERED`。

若本轮已经是第二次有意见的独立语义检视，**只跳过 8.1**，不触发第三次；完成第 6 步的主代理
最终产品审计后明确报告没有第三次独立验证。无论轮次如何，都继续执行 8.2。

reaction 长期留存且不带 commit 引用，所以脚本用「当前 HEAD 触发的最早一次 workflow
run 的 `created_at`」作为推送时刻基准，并且只认 Codex 机器人的 reaction。该 SHA 尚无
run 时直接判 `NOT-TRIGGERED`——此时若拿空字符串当阈值，`created_at > ""` 会选中所有
历史 reaction，旧的 👍 就成了「本轮通过」。

`NOT-TRIGGERED` **不等于没问题**：评论 `@codex review` 触发，别空等。
合并需要用户**针对这个 PR** 的明确授权，关于发版的含糊表述不是合并授权。

### 8.2 清理隔离 worktree（所有轮次）

若第 0 步创建了隔离 worktree，确认修正已推送、线程已处理、8.1 已运行或按第二轮规则跳过，且隔离
工作树干净；然后把工具 `workdir` 设为任务上下文中的 `ORIGINAL_WORKTREE`，替换具体绝对路径后运行：

```bash
set -e
'<ISOLATED_WORKTREE_HELPER>' cleanup '<ISOLATED_WORKTREE>'
```

不切换、stash、提交或覆盖原脏 worktree。

## 硬性规则

- **严禁**在没有用户明确指令的情况下 `gh pr merge`。
- **严禁**只凭 reaction 判断有没有意见——以未解决线程为准。
- **严禁**把脚本抄成一次性命令。要改行为就改脚本，并跑 `selftest.sh`。
- **严禁**只修被标的那一行而不审计同类路径。
- **严禁**把检查命令管道给 `tail`/`head` 后据此判断成败。
- **严禁** `git add -A` / `git add .`。
- **严禁**用 `git checkout <file>` / `git restore <file>` 回退探针——会连同该文件其它
  未提交改动一起冲掉。先 `cp` 备份或 `git stash push -- <仅源文件路径>`。
- 未真正跑过的检查，**不得**声称已验证。
