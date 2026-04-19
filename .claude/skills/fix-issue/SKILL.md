---
name: fix-issue
description: 端到端的 GitHub issue 修复工作流。接受 issue 编号作为参数，从查看 issue 到建分支、实现修复、推送、开 PR、处理评审、合并的完整流程。当用户请求"修复 issue #N"、"处理 issue N"或类似端到端 issue 解决任务时触发。
---

# fix-issue — 端到端 GitHub Issue 修复流程

以 `$1` 作为 issue 编号，严格按以下顺序执行。任何一步失败都先修复再进下一步，**不要跳步**。

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

## 2. 创建 feature 分支（严禁在 main 上工作）

```bash
git switch main && git pull --ff-only
git switch -c "fix/issue-$ISSUE_NUM"
```

- 开工前确认当前分支。如在 `main`/`master`，**立即**切到 feature 分支再开始改动。
- 分支命名：`fix/issue-$ISSUE_NUM`；若 issue 其实是新功能需求，改用 `add-feature` 技能。
- 创建后 `git rev-parse --abbrev-ref HEAD` 再确认一次。

## 3. 实现修复 + 测试

- 先读相关代码路径，**枚举所有受影响的调用点和姊妹路径**（状态清理、错误处理、异步 await 等）。
- 状态类 bug：grep 所有相关字段和每个 reset/cleanup 点，逐一确认。
- 校验类 bug：列出每个入口点。
- 异步 Redis/锁操作：务必 `await` 并包裹 `try/catch`。
- 新增或修改单元测试覆盖修复面。

## 4. 提交前的预提交检查（强制）

```bash
npm run format:check && npm run lint && npm run typecheck && npm run build && npm test
```

任一项失败就先修复，**不要跳过**。CLAUDE.md 的 Git 工作流已明确要求这一步。

## 5. 提交、推送、开 PR

```bash
git add <具体文件>
git commit -m "fix: <简明的'为什么'，而不是'做了什么'> (#$ISSUE_NUM)"
git push -u origin "fix/issue-$ISSUE_NUM"
PR_BODY=$(printf '## Summary\n- 变更点 1\n- 变更点 2\n\nFixes #%s\n\n## Test plan\n- [ ] 单元测试\n- [ ] 手动验证（如适用）\n' "$ISSUE_NUM")
gh pr create --title "fix: ..." --body "$PR_BODY"
```

- 使用 Conventional Commits：`fix:`、`feat:`、`refactor:` 等。
- 一个可评审单元一次提交。
- 严禁 `git add -A` / `git add .`，避免误带入敏感文件或临时产物。

## 6. 等 Codex 评审，处理**所有**相关路径

- 收到评审反馈后：**不要只修被标的那一行**，对整类 bug 审视所有相关代码路径。
- 自审一轮：`grep` 代码库里与被标关注点相关的调用点和姊妹函数，逐一列出确认。
- 处理完再次跑第 4 步的完整预提交序列。
- 修复后再推一次，等下一轮评审直至通过。

## 7. 合并并清理

```bash
gh pr merge --squash --delete-branch
git switch main && git pull --ff-only
```

- 只有在 CI 绿且评审通过后才合并。
- 合并后本地分支一并清理。

## 硬性规则

- **严禁直接推 main/master**。
- **严禁跳过** `format:check` / `lint` / `typecheck` / `test`。
- **严禁** `--no-verify` 或 `--no-gpg-sign` 绕过钩子。
- **严禁** `git add -A` / `git add .`。
- 除非用户明确授权，否则 `gh pr merge` 前先向用户确认。
