#!/usr/bin/env bash
# 用法:
#   has-changes.sh --baseline <文件>    # 第 3 步开始编辑前，记录基线快照
#   has-changes.sh <基线文件>           # 第 5 步，判断本轮相对基线是否产生改动
#
# 有本轮改动退出 0，无则退出 1。

source "$(dirname "$0")/lib.sh"

# 快照必须包含**内容**，不能只有 porcelain 的状态行。
#
# 只比状态行时：待修文件在基线里已经是 ` M path`（或落在基线已有的 `?? dir/` 下），
# 本轮继续修改它并不会改变那一行，比对结果为空 → 判 NO-CHANGES → 跳过验证、提交和
# 推送，却仍去回复并 resolve——修复就只留在工作树里，永远没提交。
#
# 三类都要覆盖：已跟踪文件的内容变更、未跟踪文件的新增与内容变更、以及删除。
snapshot() {
  echo "---STATUS---"
  git status --porcelain
  echo "---TRACKED-DIFF---"
  git diff HEAD # 已暂存 + 未暂存的内容变更
  echo "---UNTRACKED---"
  git ls-files --others --exclude-standard -z |
    sort -z |
    while IFS= read -r -d '' f; do
      printf '%s  %s\n' "$(sha1sum "$f" | cut -d' ' -f1)" "$f"
    done
}

baseline_status() {
  sed -n '/^---STATUS---$/,/^---TRACKED-DIFF---$/p' "$1" | sed '1d;$d;/^$/d'
}

if [ "${1:-}" = "--baseline" ]; then
  OUT=${2:?用法: has-changes.sh --baseline <文件>}
  snapshot >"$OUT"
  echo "基线快照已记录到 $OUT（工作树已有 $(baseline_status "$OUT" | wc -l) 条既有条目）"
  exit 0
fi

BASE=${1:?用法: has-changes.sh <基线文件>（先用 --baseline 生成）}
[ -f "$BASE" ] || die "基线文件不存在：$BASE。第 3 步开始编辑前必须先跑 --baseline。"

CUR="/tmp/rr-snapshot.$$"
trap 'rm -f "$CUR"' EXIT
snapshot >"$CUR"

if diff -q "$BASE" "$CUR" >/dev/null 2>&1; then
  echo "NO-CHANGES（内容与基线完全一致，跳过验证与提交，直接回复线程）"
  PRE=$(baseline_status "$BASE" | wc -l)
  [ "$PRE" -gt 0 ] && echo "（工作树里有 $PRE 条基线中就存在的既有改动，与本轮无关）"
  exit 1
fi

echo "HAS-CHANGES（相对基线的内容差异，前 40 行）:"
# diff 在文件不同时返回 1，set -e + pipefail 会就地终止脚本——「有改动」反而以
# 退出码 1 报出，与「无改动」撞在一起，语义完全颠倒。必须显式吞掉这个退出码。
diff "$BASE" "$CUR" | head -40 || true

echo
echo "当前工作树状态："
git status --porcelain

BASE_STATUS=$(baseline_status "$BASE")
if [ -n "$BASE_STATUS" ]; then
  echo
  echo "⚠ 下列条目在基线中就已存在，提交时对它们用 git add -p 按 hunk 只暂存本轮补丁："
  printf '%s\n' "$BASE_STATUS"
fi

echo
echo "提交前用 git diff --cached 核对暂存内容里没有混入基线中的既有改动。"
exit 0
