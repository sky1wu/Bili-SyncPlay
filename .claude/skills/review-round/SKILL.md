---
name: review-round
description: 处理当前 PR 的一轮 Codex 评审反馈。从读取评审信号、逐条定位根因、修复、验证、回复线程到推送的完整单轮流程。当用户请求"处理评审意见"、"处理下一轮反馈"、"看看 Codex 说了什么"或类似单轮评审响应任务时触发。不负责合并。
---

# review-round — 处理一轮 Codex 评审反馈

处理**一轮**评审。以 `$1` 作为 PR 编号；省略时用当前分支对应的 PR。
任何一步失败都先修复再进下一步，**不要跳步**。

## 1. 读取评审信号（reaction 才是完成信号）

**Codex 用 PR 的 reaction 表态，不是用 review 或 comment。** 只查 `gh pr view --comments`
会漏判：通过时 reviews 接口是空的，你会误以为「还没反馈」而空等。

```bash
PR="${1:-$(gh pr view --json number --jq .number)}"
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

# 完成信号：reaction
gh api "repos/$REPO/issues/$PR/reactions" --jq '.[] | "\(.content) by \(.user.login)"'
```

| reaction          | 含义                                   | 该做什么                          |
| ----------------- | -------------------------------------- | --------------------------------- |
| （空）            | **没触发**，不是「没问题」             | 别空等，评论 `@codex review` 触发 |
| 👀 `eyes`         | 正在评审                               | 等                                |
| 👍 `+1`           | 已评审、**无意见**                     | 本轮结束，跳到第 7 步             |
| 有 comment/review | 有问题（此时通常也会有对应的评审内容） | 进入第 2 步                       |

## 2. 核对评审针对的是当前 HEAD

评审可能是上一次 push 的产物。对着旧提交的意见照着改会白改甚至改错。

```bash
git rev-parse HEAD
gh api "repos/$REPO/pulls/$PR/reviews" --jq '.[] | "\(.user.login) \(.state) commit=\(.commit_id)"'
```

`commit_id` 与当前 HEAD 不一致 → 这轮意见是旧的，先确认哪些仍然成立，别机械照做。

## 3. 列出全部未解决意见

```bash
gh pr view "$PR" --comments
gh api "repos/$REPO/pulls/$PR/comments" --jq '.[] | "\(.path):\(.line) \(.body[0:200])"'
```

逐条列出，标注严重级别（P1/P2）。**先把清单摆出来再动手改**，不要边看边改。

## 4. 逐条陈述根因，再改

对每一条意见：

- 用一句话陈述**根因**，而不是复述现象。
- 点名证明它的代码路径或日志行。
- 然后才编辑。

**宁要单一根因修复，不要层叠补丁。** 若修复需要在已有的抑制标志 / 冷却期 / 特例分支
之上再加一个，停下来重新推导根因——见 AGENTS.md 的 `## Debugging Sync Bugs`。

## 5. 审计同类路径（不要只修被标的那一行）

被标出的往往只是同一类问题的一个实例。

- grep 出被改签名的**全部调用点**，含 `server/src/app.ts` 与各 `index.ts` 适配层。
  TypeScript 接受声明了**更少**参数的函数，所以「适配层忘记转发末位参数」**不会**报错。
- 状态清理 / reset 函数：grep 每一处相关状态，逐一确认。
- 异步 Redis / 锁操作：确认都 `await` 且包了 `try/catch`。
- 协议相关改动：走 AGENTS.md 的 `## Protocol Changes` 清单（版本号有
  `PROTOCOL_VERSION` 和 `CURRENT_PROTOCOL_VERSION` **两个**常量要同步提升）。

逐个列出「已处理 / 不适用及原因」，再进下一步。

## 6. 验证（宣称改好之前）

- 每个编辑过的区域**重读确认改动确实落地**——静默失败的字符串替换在本仓库发生过多次。
- 新增的回归测试必须在**修复前的代码上失败**：把修复 stash 掉（或从事先的副本还原）
  跑一遍，确认变红。一直是绿的测试什么也没守住。
- 跑完整预提交序列，**逐项断言退出码**：

```bash
for step in format:check lint typecheck build test audit; do
  npm run "$step" > "/tmp/$step.log" 2>&1
  code=$?
  echo "$step exit=$code"
  [ $code -ne 0 ] && { tail -40 "/tmp/$step.log"; break; }
done
```

**严禁 `npm run typecheck | tail`** 这类写法：管道让退出码变成 `tail` 的，失败会被吞成绿。

## 7. 提交、推送、回复线程

```bash
git add <具体文件>          # 严禁 git add -A / git add .
git commit -m "fix: ..."
git push
```

推送后逐条回复评审线程说明如何处理的，已解决的用 GraphQL 标记 resolved：

```bash
gh api graphql -f query='
  query($owner:String!,$repo:String!,$pr:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$pr){
        reviewThreads(first:50){nodes{id isResolved path line}}
      }
    }
  }' -F owner=<owner> -F repo=<repo> -F pr="$PR"

gh api graphql -f query='
  mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){thread{isResolved}} }
' -F id=<threadId>
```

## 8. 本轮结束——**不要合并**

- push 之后 Codex **不必然**自动重审。再查一次 reactions；仍为空就评论 `@codex review` 触发。
- 通过标志是 👍 reaction，**不要把沉默当通过**。
- 合并需要用户**针对这个 PR** 的明确授权。关于发版的含糊表述不是合并授权。

## 硬性规则

- **严禁**在没有用户明确指令的情况下 `gh pr merge`。
- **严禁**只修被标的那一行而不审计同类路径。
- **严禁**把检查命令管道给 `tail`/`head` 后据此判断成败。
- **严禁** `git add -A` / `git add .`。
- **严禁**用 `git checkout <file>` / `git restore <file>` 回退探针——会连同该文件其它
  未提交改动一起冲掉。先 `cp` 备份或用 `git stash`。
- 未真正跑过的检查，**不得**声称已验证。
