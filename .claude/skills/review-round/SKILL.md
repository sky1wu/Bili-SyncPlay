---
name: review-round
description: 处理当前 PR 的一轮 Codex 评审反馈。从读取评审信号、逐条定位根因、修复、验证、回复线程到推送的完整单轮流程。当用户请求"处理评审意见"、"处理下一轮反馈"、"看看 Codex 说了什么"或类似单轮评审响应任务时触发。不负责合并。
---

# review-round — 处理一轮 Codex 评审反馈

处理**一轮**评审。任何一步失败都先修复再进下一步，**不要跳步**。

> Bash 工具**不保留 shell 状态**，变量不跨代码块存活。下面每个代码块都自带
> `PR=` / `REPO=` 两行，照抄时把 `PR=` 改成实际编号。

## 0. 切到该 PR 的 head 分支并校验（动任何文件之前）

技能可能从 `main` 或别的分支上被启动。后续步骤只读 `HEAD` 和你填的 PR 编号，**没有
任何一步保证当前分支就是这个 PR 的 head**——第 6 步那个无目标的 `git push` 于是会
把修复推到当前分支上，最坏情况直接推 `main`。

```bash
PR=<编号>; REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
HEAD_REF=$(gh pr view "$PR" --json headRefName --jq .headRefName)
CUR=$(git rev-parse --abbrev-ref HEAD)
echo "PR#$PR head=$HEAD_REF  当前分支=$CUR"

case "$HEAD_REF" in
  main | master) echo "拒绝：该 PR 的 head 是 $HEAD_REF"; exit 1 ;;
esac
[ "$CUR" = "$HEAD_REF" ] || git switch "$HEAD_REF"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$HEAD_REF" ] || { echo "切换失败"; exit 1; }
```

提交和推送前（第 6 步）再校验一次——中途可能因为别的操作切走了。

## 1. 读未解决的评审线程（权威信号）

**不要用 reaction 判断有没有意见。** 本仓库实测：意见最多的 PR221（11 条）和
PR222（14 条）**reaction 完全为空**；而 PR220、PR224 有 👍 但 reviews 和
comments 都是 0。两种信号各自都会漏判，必须以线程为准。

REST 的 `pulls/$PR/comments` 也不行：它不返回解决状态，第 2 轮会把上一轮已修好
并已 resolve 的意见重新摆上清单。用 GraphQL：

```bash
PR=<编号>; REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
read -r OWNER NAME <<<"${REPO%%/*} ${REPO##*/}"

CUR=null
while :; do
  RESP=$(gh api graphql -f query='
    query($owner:String!,$repo:String!,$pr:Int!,$after:String){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$pr){
          reviewThreads(first:100, after:$after){
            pageInfo{ hasNextPage endCursor }
            nodes{ id isResolved path line originalLine
                   comments(first:100){ totalCount
                     nodes{ author{login} body
                            pullRequestReview{ commit{oid} submittedAt } } } }
          }
        }
      }
    }' -F owner="$OWNER" -F repo="$NAME" -F pr="$PR" -F after="$CUR")

  echo "$RESP" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const t=JSON.parse(s).data.repository.pullRequest.reviewThreads;
      for(const n of t.nodes){
        if(n.isResolved) continue;
        console.log(`\n═══ ${n.path}:${n.line ?? n.originalLine}  id=${n.id}  评论数=${n.comments.totalCount}`);
        for(const c of n.comments.nodes){
          const sha=c.pullRequestReview?.commit?.oid?.slice(0,7) ?? "?";
          // 完整正文，只剥徽章图片，不截断
          console.log(`[${c.author.login} @${sha}] ${c.body.replace(/!\[[^\]]*\]\([^)]*\)/g,"")}`);
        }
        if(n.comments.totalCount > n.comments.nodes.length)
          console.log(`  ⚠ 该线程还有 ${n.comments.totalCount-n.comments.nodes.length} 条评论未取出，需翻页`);
      }
    });'

  NEXT=$(echo "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).data.repository.pullRequest.reviewThreads.pageInfo;process.stdout.write(p.hasNextPage?p.endCursor:"")})')
  [ -z "$NEXT" ] && break
  CUR="$NEXT"
done
```

这个查询里有四处都不能省：

- **`line` 常为 `null`**（意见挂在已变动的行上），必须回退到 `originalLine`。
- **正文不截断。** 只剥掉开头的徽章图片。评审者常把适用条件、反例、纠正写在后半段，
  按固定字数切片会静默丢掉它们，然后你照着半条意见改完就 resolve 了。
- **读完线程里的每一条评论。** 评审者会在同一线程追加条件或推翻原意见；你自己在第 7
  步的回复也会进该线程，所以第 2 轮起线程普遍是多条。单线程评论超过 100 条时上面会
  打出告警，此时需要对 `comments` 再翻页。
- **必须翻页。** 线程超过 100 条时 `first:100` 只返回第一页，剩下的未解决意见完全不
  可见——命令会输出「零条未解决」，于是你把还有反馈的一轮当成通过或没触发。

## 2. 核对每条线程对应的是当前 HEAD

评审可能是上一次 push 的产物。对着旧提交的意见照改会白改甚至改错。

**判定要按线程逐条做，不能只看全局 review 列表。** PR 上同时存在多轮评审时，全局列表
里既有旧 SHA 也有当前 SHA，而线程本身若不带 commit 信息就无从对应——本仓库 PR225 实测
就同时挂着 `2ab3b09` 和 `938c337` 两轮的线程。第 1 步的输出已经把每条评论标成
`[作者 @sha]`，直接拿它和当前 HEAD 比：

```bash
git rev-parse --short HEAD
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

## 6. 提交、推送（可能整步跳过）

**这一步不是无条件的。** 若本轮所有意见都已过时、不成立、或只需解释而无需改文件，
此时 `git commit` 会以 "nothing to commit" 失败——而技能开头要求任一步失败就停，
于是永远走不到第 7 步去回复和 resolve，线程就那么挂着。先判断有没有改动：

```bash
if git diff --quiet && git diff --cached --quiet; then
  echo "本轮无代码改动，跳过第 5-6 步，直接进第 7 步回复线程"
else
  # …第 5 步验证…然后提交
  git add <本轮实际改动的具体文件>   # 严禁 git add -A / git add .
  git commit -m "fix: ..."
  HEAD_REF=$(gh pr view "$PR" --json headRefName --jq .headRefName)
  [ "$(git rev-parse --abbrev-ref HEAD)" = "$HEAD_REF" ] || { echo "分支不对，拒绝推送"; exit 1; }
  git push origin "HEAD:$HEAD_REF"
fi
```

**推送前必须复验分支**（第 0 步之后可能被切走），且显式写出 `origin "HEAD:$HEAD_REF"`
而不是裸 `git push`。

**动手前先审计工作树。** 显式列出文件名并不足以隔离改动：如果用户在技能启动前就对同
一个文件有未提交的修改，`git add <文件>` 会把那些改动和本轮修复一起提交。所以在第 3
步开始编辑之前先记录：

```bash
git status --short          # 记下哪些文件本来就是脏的
git stash list
```

对本来就脏的文件，提交前用 `git add -p` 按 hunk 只暂存本轮的补丁，并用
`git diff --cached` 逐项确认暂存内容里没有别人的改动。

## 7. 回复并 resolve 线程

**先回复，确认回复成功，再 resolve。** 只跑 `resolveReviewThread` 会把线程静默关掉，
评审者看不到改在哪、验证结果如何、或哪条为什么不采纳。回复用
`addPullRequestReviewThreadReply`：

```bash
THREAD_ID=<第 1 步输出的 id>
BODY="已修。<改在哪、怎么验证的；不采纳则写明理由>"

# 1) 先发回复，并确认拿到了 id（失败就不要往下走）
REPLY=$(gh api graphql -f query='
  mutation($id:ID!,$body:String!){
    addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id, body:$body}){
      comment{ id }
    }
  }' -F id="$THREAD_ID" -F body="$BODY" --jq '.data.addPullRequestReviewThreadReply.comment.id')
[ -n "$REPLY" ] || { echo "回复失败，不 resolve"; exit 1; }

# 2) 回复成功后才 resolve
gh api graphql -f query='
  mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){thread{isResolved}} }
' -F id="$THREAD_ID" --jq '.data.resolveReviewThread.thread.isResolved'
```

收尾再查一次未解决线程数应为 0，确认回复确实进了线程（该线程 `totalCount` 应 +1）。

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
