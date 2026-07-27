#!/usr/bin/env bash
# 用法: round-signal.sh <PR编号>
#
# 在没有未解决线程时，区分「本轮通过」与「根本没触发」。
# 输出 PASSED / REVIEWING / NOT-TRIGGERED，并以对应退出码结束（0/0/1）。

source "$(dirname "$0")/lib.sh"

PR=${1:?用法: round-signal.sh <PR编号>}
BOT="chatgpt-codex-connector[bot]"

resolve_repo

SHA=$(git rev-parse HEAD)

# 基准必须是「当前 HEAD 被推上去的时刻」，不能用 git log 的提交创建时间：
# 提交先在本地生成、上一轮的旧 reaction 随后到达、再 push 这个提交时，
# 旧 reaction 仍晚于提交时间而被误判为本轮信号。
PUSHED=$(gh api "repos/$REPO/actions/runs?head_sha=$SHA" \
  --jq '[.workflow_runs[].created_at] | sort | .[0]' 2>/dev/null || true)

# 第三轮第 3 条：run 尚未创建或 Actions 被禁用时 PUSHED 为空，而 jq 里
# `.created_at > ""` 对任何非空字符串都为真，会把该 PR 上所有历史 reaction
# 全部选中——旧的 👍 于是被当成当前 HEAD 已通过。必须显式分支。
if [ -z "$PUSHED" ] || [ "$PUSHED" = "null" ]; then
  echo "NOT-TRIGGERED（${SHA:0:7} 尚无 workflow run，无法确定推送时刻，按未触发处理）"
  exit 1
fi

echo "head=${SHA:0:7} pushed≈$PUSHED"

FRESH=$(gh api "repos/$REPO/issues/$PR/reactions" \
  --jq "[.[] | select(.user.login==\"$BOT\") | select(.created_at > \"$PUSHED\")] | map(.content) | join(\",\")") ||
  die "读取 reaction 失败"

case "$FRESH" in
*"+1"*)
  echo "PASSED（本轮 Codex 👍，无意见）"
  exit 0
  ;;
*eyes*)
  echo "REVIEWING（Codex 👀 评审中，等）"
  exit 0
  ;;
*)
  echo "NOT-TRIGGERED（本轮无 Codex reaction——不等于没问题，评论 @codex review 触发）"
  exit 1
  ;;
esac
