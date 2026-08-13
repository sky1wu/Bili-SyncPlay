---
name: fix-issue
description: 端到端的 GitHub issue 修复工作流。接受 issue 编号作为参数，从查看 issue 到建分支、实现修复、推送、开 PR、处理评审、合并的完整流程。当用户请求"修复 issue #N"、"处理 issue N"或类似端到端 issue 解决任务时触发。
---

# fix-issue — 端到端 GitHub Issue 修复流程

以 `$1` 作为 issue 编号，严格按以下顺序执行。任何一步失败都先修复再进下一步，**不要跳步**。

开始前完整读取 `.claude/skills/shared/review-convergence.md`。根因、范围和复审停止条件
以它为唯一来源。

## 0. 校验 `$1` 为纯数字

先在 shell 外确认 `$1` 匹配 `^[0-9]+$`；若不是，停止执行并提示用户改用 `add-feature`
或先给出 issue 编号。只有通过后才把实际数字写入命令：

```bash
ISSUE_NUM=123 # 替换为已验证的实际数字；不要直接拼原始 $1
```

## 1. 了解 issue

```bash
set -e
ISSUE_NUM=123 # 替换为第0步已验证的实际数字
gh issue view "$ISSUE_NUM"
```

- 通读正文、评论、关联 PR、标签。
- 明确问题边界：是 bug、feature 还是重构？涉及哪些模块？
- 如果描述不清，先向用户确认范围再动手。

## 2. 创建 feature 分支（严禁在 main 上工作）

```bash
set -e
ISSUE_NUM=123 # 替换为第0步已验证的实际数字
test -z "$(git status --porcelain=v1 -uall)" || {
  echo "工作树或索引不干净；在独立干净 worktree 中重新开始" >&2
  exit 1
}
git switch main && git pull --ff-only
git switch -c "fix/issue-$ISSUE_NUM"
```

- 开工前确认当前分支。如在 `main`/`master`，**立即**切到 feature 分支再开始改动。
- 分支命名：`fix/issue-$ISSUE_NUM`；若 issue 其实是新功能需求，改用 `add-feature` 技能。
- 创建后 `git rev-parse --abbrev-ref HEAD` 再确认一次。

## 2.5 根因与修复边界（写代码前强制）

按共享规则写出可证伪根因和稳定 `Root ID`，并列出允许修改的文件/包、架构层、新增状态
及全部效果出口。缺少根因证据时继续调查，不写修复；扩范围前先证明原边界为什么错误。

## 3. 实现修复 + 测试

- 先读相关代码路径，**枚举所有受影响的调用点和姊妹路径**（状态清理、错误处理、异步 await 等）。
- 状态类 bug：grep 所有相关字段和每个 reset/cleanup 点，逐一确认。
- 校验类 bug：列出每个入口点。
- 异步 Redis/锁操作：务必 `await` 并包裹 `try/catch`。
- 先写能在修复前失败的回归，并保留反向对照；只回退核心实现时，目标断言必须因该缺陷
  失败，对照仍通过。

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
set -e
ISSUE_NUM=123 # 替换为第0步已验证的实际数字
git add <具体文件>
git commit -m "fix: <简明的'为什么'，而不是'做了什么'> (#$ISSUE_NUM)"
npm run format:check && npm run lint && npm run typecheck && npm run build && npm test && npm run audit
test -z "$(git status --porcelain=v1 -uall)" || exit 1
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
- 后续远端评审使用 `review-round`。同一变更单元最多两次独立语义检视；第二次仍有
  意见时按共享规则停止自动循环，由主代理按既定清单做有界最终产品审计并报告剩余风险。
- 处理完再次跑第 4 步的完整预提交序列。
- 修复后再推；只在共享规则的复审预算内触发下一轮。

## 7. 合并并清理

```bash
set -e
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
