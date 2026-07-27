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
# 请求失败必须保持非零，绝不能和「查询成功但没有 run」混为一谈：
# 把网络故障、权限不足、服务错误降级成 NOT-TRIGGERED，会让执行者反复发
# @codex review，而不是停下来修访问问题。
set +e
RUNS=$(gh api "repos/$REPO/actions/runs?head_sha=$SHA" 2>&1)
RC=$?
set -e
[ $RC -eq 0 ] || die "读取 Actions runs 失败（exit=$RC），这不是「未触发」，请先排查访问问题：$RUNS"

PUSHED=$(printf '%s' "$RUNS" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const runs = JSON.parse(s).workflow_runs || [];
    const times = runs.map(r=>r.created_at).sort();
    process.stdout.write(times[0] ?? "");
  });') || die "解析 Actions runs 响应失败"

# 查询成功但确实没有 run（尚未创建或 Actions 被禁用）：此时无法确定推送时刻。
# 不能拿空字符串当阈值——jq 里 `.created_at > ""` 对任何非空字符串都为真，会把
# 该 PR 上所有历史 reaction 全部选中，旧的 👍 于是被当成当前 HEAD 已通过。
if [ -z "$PUSHED" ]; then
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
