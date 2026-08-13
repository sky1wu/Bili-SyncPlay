---
name: review-round
description: 处理当前 PR 的一轮 Codex 评审反馈。从读取评审信号、逐条定位根因、修复、验证、回复线程到推送的完整单轮流程。当用户请求"处理评审意见"、"处理下一轮反馈"、"看看 Codex 说了什么"或类似单轮评审响应任务时触发。不负责合并。
---

# review-round — 处理一轮 Codex 评审反馈

处理**一轮**评审。任何一步失败都先修复再进下一步，**不要跳步**。

开始前完整读取 `.claude/skills/shared/review-convergence.md`，先执行其中的 Gate 0。`STOP`
或 `STOP_AND_SPLIT` 是本轮结果，不是待修错误：保留线程并向用户报告；普通的“继续”不授权
绕过停止状态。

易错的多步操作都在 `scripts/` 下，**不要把它们抄成一次性命令**——脚本里带着错误处理、
翻页和判别力测试，散写在对话里的版本必然会丢掉其中某一项（这份技能的前三轮评审共
20 条意见，绝大多数正是这么来的）。

| 脚本                      | 作用                                               |
| ------------------------- | -------------------------------------------------- |
| `verify-branch.sh <PR>`   | 校验本地分支名 **和** SHA 与 PR head 一致；拒 fork |
| `list-unresolved.sh <PR>` | 翻页列出未解决线程；`--history` 包含已解决历史     |
| `has-changes.sh`          | 判断本轮有无改动（含未跟踪文件）                   |
| `reply-resolve.sh`        | 重读线程 → 回复 → 确认 → resolve                   |
| `round-signal.sh <PR>`    | 无未解决线程时区分「通过」与「没触发」             |
| `selftest.sh [PR]`        | 对上述防护做判别力测试                             |

改动这些脚本后必须跑 `.claude/skills/review-round/scripts/selftest.sh <PR编号>`。

## 0. 确定 PR 编号，切到它的 head 分支并校验

后面每个代码块都用 `$PR`，**先把它定下来**（Bash 工具不保留 shell 状态，每次新开的
代码块都要重新赋值，或直接把编号写进命令）：

```bash
PR=<编号>                                    # 用户指定了就用指定的
PR=$(gh pr view --json number --jq .number)  # 否则取当前分支对应的 PR
[ -n "$PR" ] || { echo "无法确定 PR 编号"; exit 1; }

.claude/skills/review-round/scripts/verify-branch.sh "$PR" --switch
```

技能可能从 `main` 或别的分支启动。只比分支名不够：同名本地分支可能落后于远端，那样
你会基于旧代码处理反馈、把针对当前提交的意见误判成过时，直到 push 被非快进拒绝才
暴露。脚本同时校验 `headRefOid`，并拒绝 `main`/`master` 与 fork PR。

## 1. 先恢复历史，再读未解决线程

```bash
.claude/skills/review-round/scripts/list-unresolved.sh "$PR" --history
.claude/skills/review-round/scripts/list-unresolved.sh "$PR"
```

**不要用 reaction 判断有没有意见。** 本仓库实测：意见最多的 PR221（11 条）和 PR222
（14 条）reaction 完全为空；而 PR220、PR224 有 👍 但 reviews 和 comments 都是 0。
两种信号各自都会漏判，必须以线程为准。REST 的 `pulls/$PR/comments` 也不行——它不返回
解决状态，第 2 轮会把上一轮已 resolve 的意见重新摆上清单。

`--history` 输出 open/resolved 状态和已取回的回复，用其中的 `Change-Unit`、`Root-ID` 与
`Resolution` 恢复既往决策；不得只凭当前聊天记录判断是否同根。脚本会翻页取全 thread
并标注评论所属 commit；若警告单个 thread 仍有未取回评论，则历史不完整，执行 `STOP`。
API 或解析失败时以非零退出——**「没读到」绝不能被当成「没有」**。

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
- 分配稳定 `Root ID`，并和第 1 步历史中的同一 `Change Unit` 对比。
- 明确本轮状态：首次出现为 `first-fix`；第二次同根为唯一一次
  `structural-redesign`；重设计后同根复发或跨主要所有者时立即 `STOP` / `STOP_AND_SPLIT`。
- 然后才编辑。
- **每次 Edit/Write 之后立刻重读改动区域**，确认改动真的落地了，再动下一处。
  静默失败的字符串替换在本仓库发生过多次；拖到第 5 步才发现，意味着中间的审计全部
  建立在一处并不存在的改动上。

**宁要单一根因修复，不要层叠补丁。** 若修复需要在已有的抑制标志 / 冷却期 / 特例分支
之上再加一个，停下来重新推导根因——见 AGENTS.md 的 `## Debugging Sync Bugs`。

进入停止状态时不得记录基线、编辑、resolve 或启动新 reviewer；直接报告当前 Root ID、
既往 Resolution、越界的所有者和剩余风险。只有仍允许编辑时才继续以下步骤。

**编辑前必须先记一份工作树基线**，第 5 步要拿它判断本轮到底改了什么：

```bash
.claude/skills/review-round/scripts/has-changes.sh --baseline /tmp/rr-baseline
```

## 4. 审计同类路径（不要只修被标的那一行）

被标出的往往只是同一类问题的一个实例。

- grep 出被改签名的**全部调用点**，含 `server/src/app.ts` 与各 `index.ts` 适配层。
  编译器的边界见 AGENTS.md 的 `## Protocol Changes` 第 2 条。
- 状态清理 / reset 函数：grep 每一处相关状态，逐一确认。
- 异步 Redis / 锁操作：确认都 `await` 且包了 `try/catch`。
- 协议相关改动：走 AGENTS.md 的 `## Protocol Changes` 清单。

逐个列出「已处理 / 不适用及原因」，再进下一步。

## 5. 验证

```bash
.claude/skills/review-round/scripts/has-changes.sh /tmp/rr-baseline || echo "本轮无改动，跳到第 7 步"
```

判断的是**相对第 3 步基线的新增**，两个方向都得防住：

- 用 `git status --porcelain` 而非 `git diff --quiet`——后者看不到未跟踪文件，只新增
  测试或文档的一轮会被误判成无改动，跳过验证和提交却仍去 resolve，改动就此丢失。
- 但也不能直接看工作树是否非空——技能启动前就存在的无关未提交文件，会让「本轮只需
  解释或拒绝意见」的轮次误判成有改动，卡在无内容可提交的 `git commit` 上，永远到不了
  第 7 步。

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
git add <本轮实际改动的具体文件>   # 严禁 git add -A / git add .
git diff --cached                  # 核对暂存内容
git commit -m "fix: ..."
# 推送前复验（中途可能被切走）。--allow-ahead 是必须的：刚 commit 完本地一定
# 领先远端 headRefOid，严格相等会让每个有提交的轮次都在 push 前中止。
.claude/skills/review-round/scripts/verify-branch.sh "$PR" --allow-ahead
git push origin "HEAD:$(gh pr view "$PR" --json headRefName --jq .headRefName)"
```

对第 3 步基线里**本来就脏**的文件，用 `git add -p` 按 hunk 只暂存本轮补丁——显式写
文件名并不足以隔离改动，用户在技能启动前的未提交修改会被一起提交。

## 7. 回复并 resolve 线程

```bash
BODY=$(cat <<'EOF'
[Change-Unit: <kebab-case>]
[Root-ID: <kebab-case>]
[Resolution: first-fix|structural-redesign|rejected]
<改在哪里、如何验证；不采纳则说明理由>
EOF
)
.claude/skills/review-round/scripts/reply-resolve.sh <线程id> "$BODY" <第1步看到的评论数>
```

脚本会先重读线程：若评论数与第 1 步不一致，说明扫描之后评审者又补了内容，此时**拒绝
resolve** 并打出最新一条，让你先把它纳入根因分析。确认回复拿到 comment id 之后才
resolve；它也会拒绝缺少三行决策元数据的回复，确保下一轮能恢复 Root ID。只跑
`resolveReviewThread` 会把线程静默关掉，评审者看不到改在哪。

收尾用 `.claude/skills/review-round/scripts/list-unresolved.sh "$PR" --count` 确认归零。

## 8. 本轮结束——**不要合并**

```bash
.claude/skills/review-round/scripts/round-signal.sh "$PR"
```

只有该 `Change Unit` 仍有独立语义检视预算时才运行；第二次检视结束后跳过，不得换 reviewer
或换一种工具开启第三轮。

输出 `PASSED` / `REVIEWING` / `NOT-TRIGGERED`。

reaction 长期留存且不带 commit 引用，所以脚本用「当前 HEAD 触发的最早一次 workflow
run 的 `created_at`」作为推送时刻基准，并且只认 Codex 机器人的 reaction。该 SHA 尚无
run 时直接判 `NOT-TRIGGERED`——此时若拿空字符串当阈值，`created_at > ""` 会选中所有
历史 reaction，旧的 👍 就成了「本轮通过」。

`NOT-TRIGGERED` **不等于没问题**：评论 `@codex review` 触发，别空等。
合并需要用户**针对这个 PR** 的明确授权，关于发版的含糊表述不是合并授权。

## 硬性规则

- **严禁**在没有用户明确指令的情况下 `gh pr merge`。
- **严禁**只凭 reaction 判断有没有意见——以未解决线程为准。
- **严禁**把脚本抄成一次性命令。要改行为就改脚本，并跑 `selftest.sh`。
- **严禁**只修被标的那一行而不审计同类路径。
- **严禁**在 `STOP` / `STOP_AND_SPLIT` 后继续编辑、resolve 或触发评审。
- **严禁**把检查命令管道给 `tail`/`head` 后据此判断成败。
- **严禁** `git add -A` / `git add .`。
- **严禁**用 `git checkout <file>` / `git restore <file>` 回退探针——会连同该文件其它
  未提交改动一起冲掉。先 `cp` 备份或 `git stash push -- <仅源文件路径>`。
- 未真正跑过的检查，**不得**声称已验证。
