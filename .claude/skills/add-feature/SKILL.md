---
name: add-feature
description: 端到端的 GitHub feature 开发工作流。接受 feature 简述或 issue 编号，从澄清需求到建分支、设计、实现、测试、推送、开 PR、处理评审、合并的完整流程。当用户请求"新增功能 X"、"实现 feature Y"、"给我加一个 ..."等端到端特性开发任务时触发。
---

# add-feature — 端到端 Feature 开发流程

以 `$1` 作为 feature 简述或 issue 编号。严格按以下顺序执行，任何一步失败都先修复再进下一步，**不要跳步**。

开始前完整读取 `.claude/skills/shared/review-convergence.md`；后续的评审目标、收敛账本和
停止条件以它为唯一来源。

## 0. 解析 `$1`，确定并校验分支 slug

`$1` 可能是以下两种之一，**不要**把它直接拼进 git 命令：

### 0.1 分类

1. **纯数字**（`$1` 匹配 `^[0-9]+$`）：视为 issue 编号。
   - `ISSUE_NUM="$1"`
   - `BRANCH_SLUG="issue-$ISSUE_NUM"`

2. **其他任何形式**（自由文本、中文、含空格/特殊字符）：视为自由描述。
   - 由你（Claude）基于描述生成一个 **ASCII kebab-case slug** 候选：
     - 全小写，仅保留 `[a-z0-9-]`，空格与标点转成 `-`。
     - 中文先翻成对应英文概念再缩短，**不要**用拼音堆砌。
     - 长度 2-5 个单词（不超过约 40 字符），语义清晰。
   - 例：`"房间邀请链接支持过期时间"` → `room-invite-expiry`。
   - 把候选 slug 念给用户确认，允许用户给出替代值。
   - 得到最终值：`BRANCH_SLUG="<最终 slug>"`

### 0.2 强制校验（无论哪条分类，都必须跑一次）

在进入第 3 步之前，用以下 bash 校验 `BRANCH_SLUG`。**不满足条件必须停住**，让用户改，或你自己改写后重新走第 0.1 步：

```bash
BRANCH_SLUG=<第0.1步确认的实际slug>
# 规则：全小写、首尾是字母或数字、中间允许 [a-z0-9-]、总长 2-40、不含连续 '-'、不含 '..' 或 '/'
if ! printf '%s' "$BRANCH_SLUG" | grep -Eq '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'; then
  echo "rejected: slug must match ^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$ — got: $BRANCH_SLUG" >&2
  return 1 2>/dev/null || exit 1
fi
if printf '%s' "$BRANCH_SLUG" | grep -Eq -- '--|\.\.'; then
  echo "rejected: slug must not contain '--' or '..' — got: $BRANCH_SLUG" >&2
  return 1 2>/dev/null || exit 1
fi
```

若 `$1` 是纯数字分类，`BRANCH_SLUG="issue-$ISSUE_NUM"` 天然满足校验。

### 0.3 使用约束

最终分支名统一为 `feat/$BRANCH_SLUG`。后续命令一律使用**带双引号**的 `"feat/$BRANCH_SLUG"` 变量，**严禁**：

- 把 `$1` 原样拼进 `git switch -c` / `git push` / `gh pr create` 等命令。
- 绕过 0.2 的校验，即便"看起来是对的"也不行。
- 在校验失败后继续硬闯，而不是回到 0.1 重新取值。

## 1. 澄清需求与边界

- 如果 `$1` 是 issue 编号：用实际数字执行 `gh issue view <issue编号>`，读完正文和全部评论。
- 如果 `$1` 是自由文本描述：先复述你对需求的理解，把以下问题问清楚再动手：
  - **用户故事**：谁在什么场景下要用？替代的现状是什么？
  - **验收标准**：golden path 和边界情况各是什么？如何判定"完成"？
  - **跨包影响**：是否涉及 `packages/protocol/` 的类型、`extension/` 的消息或 `server/` 的路由？
  - **范围外**：有哪些相关但**本次不做**的事？
- 需求不清时**先向用户确认**，不要替用户拍板。

## 2. 设计轮廓（触及多文件或跨包时必做）

动笔前简要回答：

- 新增/修改的**数据契约**（`ClientMessage` / `ServerMessage` / 领域类型）在哪里落地？如果有新字段或新消息，必须先改 `packages/protocol/`，再被 `extension/` 和 `server/` 消费。
- 新增的**控制器/模块**归属：参照 CLAUDE.md 里 `background/` 各 controller 的职责划分，不要把"模板 + DOM + 业务规则 + 消息派发"塞进同一个文件。
- **状态机/生命周期**：新状态字段要同步考虑 reset/cleanup 路径，避免遗漏姊妹状态。
- **URL 规范化**：如果涉及共享视频 URL，继续走 `normalizeSharedVideoUrl`，不要在调用点各自处理。
- **服务端环境变量**：集中在 server config 层解析，不要散落。
- **决策与效果所有权**：把共享文件第 1 节应用到本设计的每个正确性决策。
- **变更预算**：列出预期涉及的包、架构层和新增状态。后续若评审修复超出该清单，先解释
  为什么原设计边界不成立，再扩范围。

复杂度高时先和用户同步设计再动手。

## 3. 创建 feature 分支（严禁在 main 上工作）

```bash
set -e
BRANCH_SLUG=<第0步确认的实际slug>
test -z "$(git status --porcelain=v1 -uall)" || {
  echo "工作树或索引不干净；停止切分支，在独立干净 worktree 中重新开始" >&2
  exit 1
}
git fetch origin main
git switch -c "feat/$BRANCH_SLUG" origin/main
```

- 开工前确认当前分支；如在 `main`/`master`，**立即**切到 feature 分支。
- 分支名一律使用第 0 步确认过的 `$BRANCH_SLUG`，绑定 issue 时形如 `feat/issue-123`，自由文本时形如 `feat/room-invite-expiry`。
- 创建后 `git rev-parse --abbrev-ref HEAD` 再确认一次。

## 4. 实现 + 测试

- **协议先行**：先在 `packages/protocol/` 增/改类型与类型守卫，导出走包根。
- 再改消费方（`extension/` / `server/`），保持分层清晰。
- 同步新增或修改：
  - 类型守卫与运行时校验（消息边界 + payload）。
  - 单元测试覆盖 golden path 和边界情况。
  - 如涉及重构刷新的公共领域，回归测试。
- **状态新增**：为每个新字段同步列出 reset/cleanup 点并验证。
- **异步 Redis/锁操作**：务必 `await` 并包裹 `try/catch`。
- **前端改动**：按 CLAUDE.md 要求，启动 dev server 在浏览器里手测 golden path 和边界，观察其它功能是否回归；类型检查和测试只验证代码正确性，不验证功能正确性。

## 5. 提交前的预提交检查（强制）

```bash
npm run format:check && npm run lint && npm run typecheck && npm run build && npm test && npm run audit
```

任一项失败就先修复，**不要跳过**。

`npm run audit` 不被 `npm test` 覆盖，是 CI `verify` job 的同一道依赖闸门，且会在
本地毫无改动的情况下因新公告而变红——所以要在推送前跑，而不是等 CI 红了再补。不
适用于本仓库的条目写进 `audit-allowlist.json`，附理由和**必填的过期日期**。

## 6. 提交、推送、开 PR

```bash
set -e
git add <具体文件>
# 最终消息：绑定 issue 时直接写 "(#NNN)"，自由文本时不带编号
git commit -m "<第0～2步确定的最终提交消息>"
npm run format:check && npm run lint && npm run typecheck && npm run build && npm test && npm run audit
```

门禁通过后，在独立命令中复审实际提交：

```bash
set -e
git fetch origin main
test -z "$(git status --porcelain=v1 -uall)" || exit 1
BASE_COMMIT=$(git merge-base HEAD origin/main)
codex review --base "$BASE_COMMIT"
```

完整读取复审输出。命令失败或输出含任何 finding 时停止，记录为 pre-push 意见并回到
第 2～5 步；不要执行下面的 push。只有明确无意见后，才另开命令执行：

```bash
set -e
BRANCH_SLUG=<第0步确认的实际slug>
test -z "$(git status --porcelain=v1 -uall)" || exit 1
git push -u origin "feat/$BRANCH_SLUG"
gh pr create --title "feat: ..." --body "$(cat <<'EOF'
## Summary
- 新增/变更点 1
- 新增/变更点 2

## Design boundary
- 正确性决策及拥有所需信息的层：...
- 新增状态及 reset/cleanup 生命周期：...
- 范围外：...

<!-- 如绑定 issue：Closes #NNN -->

## Test plan
- [ ] 单元测试
- [ ] 手动验证（golden path）
- [ ] 手动验证（边界情况）
EOF
)"
```

本地 `codex review` 有意见时只进入 pre-push 路径，不创建 `Mode: auto` 记录。Codex 明确
额度耗尽时，手工复审
`git diff "$(git merge-base HEAD origin/main)" HEAD` 的同一对象，并记录没有自动结果。

PR 创建后，按共享文件第 2 节重新读取已有标记评论，追加一条 `Mode: pre-push` 记录，
写入真实 `Head`、本地复审发现过的 `Root ID` 和最终三项指标。即使本地复审一次通过也要
记录 `Result: passed`；这条记录不算远端评审轮次。

- Conventional Commits：新能力用 `feat:`；行为不变的结构改动用 `refactor:`，不要藏在 `feat:` 里。
- 一个可评审单元一次提交；大特性拆成多个逻辑提交。最后一次本地复审覆盖 HEAD 上整个
  PR 产品，而不是只看最后一个 commit。
- 大特性的每个中间 commit 也必须先重复第 5 步完整门禁；只有最后一个 commit 继续执行
  上面的 push 前门禁、最终产品复审、push 和开 PR。
- 严禁 `git add -A` / `git add .`。

## 7. 等 Codex 评审，处理**所有**相关路径

- 不只是修被标的那一行，对整类问题审视所有相关代码路径。
- 自审一轮：`grep` 被标关注点相关的调用点和姊妹函数，逐一确认修复已应用或显式不需要。
- 后续远端评审使用 `review-round`，完整执行共享文件第 1～3 节。
- 处理完再跑第 5 步完整预提交序列。
- 修复后再推，等下一轮评审至通过。

## 8. 合并并清理

```bash
set -e
gh pr merge --squash --delete-branch
git switch main && git pull --ff-only
```

- 只有 CI 绿且评审通过后才合并。
- 如绑定 issue，合并会经由 `Closes #NNN` 自动关闭。
- 除非用户明确授权，否则 `gh pr merge` 前先向用户确认。

## 硬性规则

- **严禁直接推 main/master**。
- **严禁跳过** `format:check` / `lint` / `typecheck` / `build` / `test` / `audit`。
- **严禁** `--no-verify` / `--no-gpg-sign` 绕过钩子或签名。
- **严禁** `git add -A` / `git add .`。
- **不要越界**：不要搭建"未来可能用到"的抽象；三行相似代码胜过过早抽象。
- **不要越权**：没明确要求就不要重构、清理无关代码、改 CI/CD 或依赖版本。
