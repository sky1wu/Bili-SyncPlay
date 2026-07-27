#!/usr/bin/env bash
# 用法: has-changes.sh
#
# 判断本轮有没有产生实际改动。有则退出 0，无则退出 1。
# 顺带打出工作树里本来就存在的脏文件，供第 6 步按 hunk 暂存时对照。

source "$(dirname "$0")/lib.sh"

# 第三轮第 2 条：git diff --quiet 和 git diff --cached --quiet 都忽略未跟踪文件。
# 评审响应若只新增测试 / 文档 / 辅助文件，会被误判成「无代码改动」而跳过验证、
# 提交和推送，却仍继续回复并 resolve——改动就此丢失。
# git status --porcelain 覆盖已修改、已暂存和未跟踪（?? 前缀）三类。
STATUS=$(git status --porcelain)

if [ -z "$STATUS" ]; then
  echo "NO-CHANGES（本轮无需改文件，跳过验证与提交，直接回复线程）"
  exit 1
fi

echo "HAS-CHANGES:"
printf '%s\n' "$STATUS"

UNTRACKED=$(printf '%s\n' "$STATUS" | grep -c '^??' || true)
[ "$UNTRACKED" -gt 0 ] && echo "（其中 $UNTRACKED 个未跟踪文件——git diff 看不到它们）"

echo
echo "提交前用 git add <具体文件> 或 git add -p 只暂存本轮补丁，"
echo "再用 git diff --cached 核对暂存内容里没有混入既有的无关改动。"
exit 0
