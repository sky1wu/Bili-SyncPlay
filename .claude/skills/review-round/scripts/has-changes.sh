#!/usr/bin/env bash
# 用法:
#   has-changes.sh --baseline <文件>    # 第 3 步开始编辑前，记录基线
#   has-changes.sh <基线文件>           # 第 5 步，判断本轮相对基线是否产生改动
#
# 有本轮改动退出 0，无则退出 1。

source "$(dirname "$0")/lib.sh"

if [ "${1:-}" = "--baseline" ]; then
  OUT=${2:?用法: has-changes.sh --baseline <文件>}
  git status --porcelain >"$OUT"
  echo "基线已记录到 $OUT（$(wc -l <"$OUT") 条既有条目）"
  exit 0
fi

BASE=${1:?用法: has-changes.sh <基线文件>（先用 --baseline 生成）}
[ -f "$BASE" ] || die "基线文件不存在：$BASE。第 3 步开始编辑前必须先跑 --baseline。"

# 必须用 git status --porcelain：git diff --quiet 和 git diff --cached --quiet 都
# 忽略未跟踪文件，只新增测试/文档的一轮会被误判成「无改动」而跳过验证与提交。
CURRENT=$(git status --porcelain)

# 但也不能直接看工作树是否非空：技能启动前就存在的无关未提交文件会让「本轮只需
# 解释或拒绝意见」的轮次误判成有改动，进而卡在无内容可提交的 git commit 上，
# 永远到不了回复线程那一步。所以要跟基线比。
NEW=$(comm -13 <(sort "$BASE") <(printf '%s\n' "$CURRENT" | sort) | sed '/^$/d')

if [ -z "$NEW" ]; then
  echo "NO-CHANGES（相对基线无本轮改动，跳过验证与提交，直接回复线程）"
  PRE=$(sed '/^$/d' "$BASE" | wc -l)
  [ "$PRE" -gt 0 ] && echo "（工作树里有 $PRE 条基线中就存在的既有改动，与本轮无关）"
  exit 1
fi

echo "HAS-CHANGES（相对基线新增）:"
printf '%s\n' "$NEW"

UNTRACKED=$(printf '%s\n' "$NEW" | grep -c '^??' || true)
[ "$UNTRACKED" -gt 0 ] && echo "（其中 $UNTRACKED 个未跟踪条目——git diff 看不到它们）"

if [ -s "$BASE" ]; then
  echo
  echo "⚠ 基线中已有既有改动，提交时对这些文件用 git add -p 按 hunk 只暂存本轮补丁："
  sed '/^$/d' "$BASE"
fi

echo
echo "提交前用 git diff --cached 核对暂存内容里没有混入基线中的既有改动。"
exit 0
