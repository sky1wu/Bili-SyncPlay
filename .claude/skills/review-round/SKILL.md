---
name: review-round
description: 处理当前 PR 的一轮 Codex 评审反馈。从读取评审信号、逐条定位根因、修复、验证、回复线程到推送的完整单轮流程。当用户请求"处理评审意见"、"处理下一轮反馈"、"看看 Codex 说了什么"或类似单轮评审响应任务时触发。不负责合并。
---

# review-round — 处理一轮 Codex 评审反馈

处理**一轮**评审。任何一步失败都先修复再进下一步，**不要跳步**。

> Bash 工具**不保留 shell 状态**，变量不跨代码块存活。下面每个代码块都自带
> `PR=` / `REPO=` 两行，照抄时把 `PR=` 改成实际编号。

## 1. 读未解决的评审线程（权威信号）

**不要用 reaction 判断有没有意见。** 本仓库实测：意见最多的 PR221（11 条）和
PR222（14 条）**reaction 完全为空**；而 PR220、PR224 有 👍 但 reviews 和
comments 都是 0。两种信号各自都会漏判，必须以线程为准。

REST 的 `pulls/$PR/comments` 也不行：它不返回解决状态，第 2 轮会把上一轮已修好
并已 resolve 的意见重新摆上清单。用 GraphQL：

```bash
PR=<编号>; REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
read -r OWNER NAME <<<"${REPO%%/*} ${REPO##*/}"

gh api graphql -f query='
  query($owner:String!,$repo:String!,$pr:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$pr){
        reviewThreads(first:100){
          nodes{ id isResolved path line originalLine
                 comments(first:50){ totalCount
                   nodes{author{login} body} } }
        }
      }
    }
  }' -F owner="$OWNER" -F repo="$NAME" -F pr="$PR" \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[]
        | select(.isResolved==false)
        | "\n=== \(.path):\(.line // .originalLine)  id=\(.id)  评论数=\(.comments.totalCount)",
          (.comments.nodes[] | "  [\(.author.login)] \(.body
            | gsub("!\\[[^]]*\\]\\([^)]*\\)";"") | gsub("\n";" ") | .[0:400])")'
```

`line` 常为 `null`（意见挂在已变动的行上），必须回退到 `originalLine`；Codex 的
正文以徽章图片开头，不剥掉会吃掉大半个截断窗口。

**必须读完线程里的每一条评论，不能只取第一条。** 评审者会在同一线程里追加条件、
纠正原意见或回答你的提问；只看首条会照着已被推翻的说法改，然后 resolve 掉。你自己
在第 7 步的回复也会进入该线程，所以第 2 轮起线程普遍是多条。若 `totalCount > 50`
需翻页取全。

**有未解决线程 → 进第 2 步。一条都没有 → 进第 8 步判断是通过还是没触发。**

## 2. 核对评审针对的是当前 HEAD

评审可能是上一次 push 的产物。对着旧提交的意见照改会白改甚至改错。

```bash
PR=<编号>; REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
git rev-parse HEAD
gh api "repos/$REPO/pulls/$PR/reviews" --jq '.[] | "\(.user.login) \(.state) commit=\(.commit_id)"'
```

`commit_id` 与当前 HEAD 不一致 → 这轮意见是旧的，先确认哪些仍然成立。

## 3. 逐条陈述根因，再改

先把第 1 步的清单摆出来并标注严重级别（P1/P2），**不要边看边改**。对每一条：

- 用一句话陈述**根因**，而不是复述现象。
- 点名证明它的代码路径或日志行。
- 然后才编辑。
- **每次 Edit/Write 之后立刻重读改动区域**，确认改动真的落地了，再动下一处。
  字符串替换静默失败在本仓库发生过多次；拖到第 5 步才发现，意味着中间的同类路径
  审计全部建立在一处并不存在的改动上，还可能整条意见被漏改。

**宁要单一根因修复，不要层叠补丁。** 若修复需要在已有的抑制标志 / 冷却期 / 特例
分支之上再加一个，停下来重新推导根因——见 AGENTS.md 的 `## Debugging Sync Bugs`。

## 4. 审计同类路径（不要只修被标的那一行）

被标出的往往只是同一类问题的一个实例。

- grep 出被改签名的**全部调用点**，含 `server/src/app.ts` 与各 `index.ts` 适配层。
  注意 TypeScript 的边界：把少声明参数的函数**赋值**给回调类型不报错（多出的末位
  参数被静默忽略），但适配层若仍调用下游函数而少传参，`TS2554` 会报出来。真正无
  声的是前者——新参数压根没被接住、也没往下传。
- 状态清理 / reset 函数：grep 每一处相关状态，逐一确认。
- 异步 Redis / 锁操作：确认都 `await` 且包了 `try/catch`。
- 协议相关改动：走 AGENTS.md 的 `## Protocol Changes` 清单。

逐个列出「已处理 / 不适用及原因」，再进下一步。

## 5. 验证（宣称改好之前）

- 第 3 步已要求每次编辑后立刻重读；这里再对全部改动做一次提交前复核，确认没有
  被后续编辑覆盖掉。
- 新增的回归测试必须在**修复前的代码上失败**。回退修复时**只回退源文件**：

  ```bash
  cp <源文件> /tmp/fix.bak          # 事前备份
  # …验证…
  cp /tmp/fix.bak <源文件>          # 还原
  ```

  **不要整仓 `git stash`**：新测试若追加在已跟踪的测试文件里会被一起 stash 走，
  测试因「找不到用例」而退出非零，看着是红的，其实什么都没验证。确认失败原因是
  **断言失败**，不是用例不存在。

- 跑完整预提交序列，逐项断言退出码：

  ```bash
  fail=""
  for step in format:check lint typecheck build test audit; do
    npm run "$step" > "/tmp/rr-$step.log" 2>&1
    code=$?
    echo "$step exit=$code  log=/tmp/rr-$step.log"
    if [ $code -ne 0 ]; then
      echo "===== $step 完整输出 ====="
      cat "/tmp/rr-$step.log"        # 完整输出，不截断
      fail="$step"
      break
    fi
  done
  if [ -n "$fail" ]; then
    echo "FAILED: $fail"
    exit 1                           # 必须以非零退出码结束
  fi
  echo "ALL-GREEN"
  ```

  两处都不能省：

  - **失败必须 `exit 1`。** 只打印 `FAILED` 而让代码块以 0 结束，依赖工具退出状态
    的执行者会带着未通过的检查继续提交推送。反过来，`[ $code -ne 0 ] && { …; }`
    这种写法的退出码是**反的**（全绿返回 1、失败返回 0），照它判会得出相反结论。
  - **失败时 `cat` 完整日志，不要 `tail -40`。** AGENTS.md 要求报告真实命令输出而
    非摘要；截断会藏掉更早的失败上下文和警告。成功时输出量太大不便全贴，但日志路径
    已经打出来了——需要核对时直接读那个文件，不要凭 `exit=0` 一句话下结论。

- **严禁 `npm run typecheck | tail`** 这类写法：管道让退出码变成 `tail` 的，失败被吞成绿。

## 6. 提交、推送

```bash
git add <具体文件>          # 严禁 git add -A / git add .
git commit -m "fix: ..."
git push
```

## 7. 回复并 resolve 线程

逐条回复说明如何处理的，再用第 1 步取到的线程 `id` 标记已解决：

```bash
THREAD_ID=<第 1 步输出的 id>
gh api graphql -f query='
  mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){thread{isResolved}} }
' -F id="$THREAD_ID"
```

## 8. 本轮结束——**不要合并**

判断「通过」还是「没触发」，两者都表现为没有未解决线程：

```bash
PR=<编号>; REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
BOT=chatgpt-codex-connector[bot]
SHA=$(git rev-parse HEAD)

# 基准 = 当前 HEAD 被 push 上去的时刻（该 SHA 触发的最早一次 workflow run）
PUSHED=$(gh api "repos/$REPO/actions/runs?head_sha=$SHA" \
  --jq '[.workflow_runs[].created_at] | sort | .[0]')
echo "head=$SHA pushed≈$PUSHED"

# 注意：gh api 不支持 --arg（那是 jq 自己的 flag，--jq 不透传），
# 且本机没有可用于管道的独立 jq，所以变量用 shell 插值进 jq 表达式。
gh api "repos/$REPO/issues/$PR/reactions" \
  --jq "[.[] | select(.user.login==\"$BOT\") | select(.created_at > \"$PUSHED\")]
        | if length==0 then \"（本轮无 Codex reaction）\"
          else (.[]|\"\(.content) \(.created_at)\") end"
```

两个过滤条件缺一不可：

- **必须按机器人账号过滤。** 该接口返回所有人的 reaction；维护者或其他自动化在当前
  提交之后点一个 👍，会被误读成「Codex 通过」而提前结束本轮。
- **新鲜度基准要用 push 时刻，不能用 `git log -1 --format=%cI`。** 后者是提交的
  _创建_ 时间：提交先在本地生成、上一轮的旧 reaction 随后到达、再 push 这个提交，
  旧 reaction 仍晚于提交时间，会被当成本轮信号。reaction 不带 commit 引用且长期
  留存，所以只能用一个真正代表「这次远端更新」的边界。若该 SHA 尚无 workflow run
  （CI 还没起来），说明本轮结果根本还没到，直接按「没触发」处理。

判定：

- 👀 = 评审中，等；👍（本轮、来自机器人）= 通过、无意见。
- 没有任何本轮信号 = **没触发**，不等于没问题。评论 `@codex review` 触发，别空等。
- 合并需要用户**针对这个 PR** 的明确授权。关于发版的含糊表述不是合并授权。

## 硬性规则

- **严禁**在没有用户明确指令的情况下 `gh pr merge`。
- **严禁**只凭 reaction 判断有没有意见——以未解决线程为准。
- **严禁**只修被标的那一行而不审计同类路径。
- **严禁**把检查命令管道给 `tail`/`head` 后据此判断成败。
- **严禁** `git add -A` / `git add .`。
- **严禁**用 `git checkout <file>` / `git restore <file>` 回退探针——会连同该文件
  其它未提交改动一起冲掉。先 `cp` 备份或 `git stash push -- <仅源文件路径>`。
- 未真正跑过的检查，**不得**声称已验证。
