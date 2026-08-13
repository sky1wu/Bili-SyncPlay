---
name: fix-issue
description: 端到端的 GitHub issue 修复工作流。接受 issue 编号作为参数，从查看 issue 到建分支、实现修复、推送、开 PR、处理评审、合并的完整流程。当用户请求"修复 issue #N"、"处理 issue N"或类似端到端 issue 解决任务时触发。
---

# fix-issue — 端到端 GitHub Issue 修复流程

以 `$1` 作为 issue 编号，严格按以下顺序执行。任何一步失败都先修复再进下一步，**不要跳步**。

开始前完整读取 `.claude/skills/shared/review-convergence.md`。在第 1 步用稳定的
`Change Unit` 和 `Root ID` 锁定一个错误事实、主要所有者、允许文件、非目标、全部失败/
清理出口和验收证据。后续发现跨出该所有权边界的工作时执行 `STOP_AND_SPLIT`，不要顺手
扩进当前 PR。

## 0. 校验 `$1` 为纯数字

`$1` 必须匹配 `^[0-9]+$`。若不是，停止执行并提示用户改用 `add-feature` 或先给出 issue 编号。

```bash
ISSUE_NUM="$1"   # 后续命令一律使用此变量，不要直接拼 $1
```

## 1. 了解 issue

```bash
gh issue view "$ISSUE_NUM"
```

- 通读正文、评论、关联 PR、标签。
- 明确问题边界：是 bug、feature 还是重构？涉及哪些模块？
- 如果描述不清，先向用户确认范围再动手。

把问题谱系和本次设计边界固定为后续脚本使用的值；替代失败 PR 时填写父 PR，但不更换
`PROBLEM_ID`：

```bash
PROBLEM_ID="issue-$ISSUE_NUM"
CHANGE_UNIT="<本次单一所有权边界的 kebab-case>"
PARENT_PR=none # 替代 PR 改为父 PR 编号
if [ "$PARENT_PR" = "none" ]; then
  BRANCH_NAME="fix/issue-$ISSUE_NUM"
else
  BRANCH_NAME="fix/issue-$ISSUE_NUM-after-pr-$PARENT_PR"
fi
```

## 2. 创建 feature 分支（严禁在 main 上工作）

```bash
git switch main && git pull --ff-only
git switch -c "$BRANCH_NAME"
```

- 开工前确认当前分支。如在 `main`/`master`，**立即**切到 feature 分支再开始改动。
- 初始分支使用 `fix/issue-$ISSUE_NUM`；替代失败设计时使用
  `fix/issue-$ISSUE_NUM-after-pr-$PARENT_PR`，避免与仍保留的父 PR 分支冲突。若 issue 其实是
  新功能需求，改用 `add-feature` 技能。
- 创建后 `git rev-parse --abbrev-ref HEAD` 再确认一次。

## 3. 实现修复 + 测试

- 先读相关代码路径，**枚举所有受影响的调用点和姊妹路径**（状态清理、错误处理、异步 await 等）。
- 状态类 bug：grep 所有相关字段和每个 reset/cleanup 点，逐一确认。
- 校验类 bug：列出每个入口点。
- 异步 Redis/锁操作：务必 `await` 并包裹 `try/catch`。
- 新增或修改单元测试覆盖修复面。

## 4. 提交前的预提交检查（强制）

```bash
npm run format:check && npm run lint && npm run typecheck && npm run build && npm test && npm run audit
```

任一项失败就先修复，**不要跳过**。CLAUDE.md 的 Git 工作流已明确要求这一步。

`npm run audit` 不被 `npm test` 覆盖，是 CI `verify` job 的同一道依赖闸门，且会在
本地毫无改动的情况下因新公告而变红——所以要在推送前跑，而不是等 CI 红了再补。不
适用于本仓库的条目写进 `audit-allowlist.json`，附理由和**必填的过期日期**。

## 5. 提交、推送、开 PR

```bash
git add <具体文件>
git commit -m "fix: <简明的'为什么'，而不是'做了什么'> (#$ISSUE_NUM)"
npm run format:check && npm run lint && npm run typecheck && npm run build && npm test && npm run audit
git push -u origin "$BRANCH_NAME"
PR_BODY=$(printf '## Summary\n- 变更点 1\n- 变更点 2\n\nFixes #%s\n\n## Test plan\n- [ ] 单元测试\n- [ ] 手动验证（如适用）\n' "$ISSUE_NUM")
PR_URL=$(gh pr create --title "fix: ..." --body "$PR_BODY")
PR=$(gh pr view "$PR_URL" --json number --jq .number)
.claude/skills/review-round/scripts/review-cycle.sh "$PR" --initialize \
  "$PROBLEM_ID" "$CHANGE_UNIT" "$PARENT_PR"
```

- 使用 Conventional Commits：`fix:`、`feat:`、`refactor:` 等。
- 一个可评审单元一次提交。
- 严禁 `git add -A` / `git add .`，避免误带入敏感文件或临时产物。

## 6. 按收敛契约处理评审

- 每轮反馈交给 `review-round`，先从 Review Unit、父 PR 和全部历史线程恢复 `Root ID`，再决定
  首次修正、结构性重做或停止；不要按评论逐条叠补丁。
- 同一 Design Attempt 最多两批代码修复。终局评审仍有阻塞问题时执行 `STOP_FAILED`：停止
  当前 PR，但保持 Problem 开放，并只在新根因假设获批后建立替代设计。
- 只对仍在锁定范围内的修正重跑第 4 步并推送。不得以“等到通过”为理由开启无上限循环。

## 7. 合并并清理

```bash
gh pr merge --squash --delete-branch
git switch main && git pull --ff-only
```

- 只有在 CI 绿且评审通过后才合并。
- 合并后本地分支一并清理。

## 硬性规则

- **严禁直接推 main/master**。
- **严禁跳过** `format:check` / `lint` / `typecheck` / `build` / `test` / `audit`。
- **严禁** `--no-verify` 或 `--no-gpg-sign` 绕过钩子。
- **严禁** `git add -A` / `git add .`。
- 除非用户明确授权，否则 `gh pr merge` 前先向用户确认。
