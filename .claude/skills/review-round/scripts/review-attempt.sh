#!/usr/bin/env bash
# 用法: review-attempt.sh <PR编号> <change-unit> [--record-second]
#
# PR 创建隐式占用第 1 次独立语义检视。本脚本用追加式 PR 评论记录第 2 次；没有覆盖式
# 账本，也不允许同一 Change Unit 出现两个 second-attempt marker。

source "$(dirname "$0")/lib.sh"

PR=${1:?用法: review-attempt.sh <PR编号> <change-unit> [--record-second]}
CHANGE_UNIT=${2:?缺少 change-unit}
MODE=${3:-}
[ "$#" -le 3 ] || die "参数多于 3 个"
case $PR in
'' | *[!0-9]*) die "PR 编号必须是纯数字：$PR" ;;
esac
if ! [[ $CHANGE_UNIT =~ ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$ ]] ||
  [[ $CHANGE_UNIT == *--* ]]; then
  die "change-unit 必须是 2-64 字符的 kebab-case：$CHANGE_UNIT"
fi
case $MODE in
'' | --record-second) ;;
*) die "未知模式：$MODE" ;;
esac

resolve_repo
MARKER_META=$(mktemp /tmp/review-attempt-meta.XXXXXX)
trap 'unlink "$MARKER_META"' EXIT

QUERY='
query($owner:String!,$repo:String!,$pr:Int!,$after:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      comments(first:100,after:$after){
        pageInfo{ hasNextPage endCursor }
        nodes{ body }
      }
    }
  }
}'

load_markers() {
  local cursor=null resp page next n
  MARKER_COUNT=0
  MARKER_HEADS=""
  while :; do
    resp=$(gql "$QUERY" -F owner="$OWNER" -F repo="$NAME" -F pr="$PR" -F after="$cursor")
    page=$(printf '%s' "$resp" | CHANGE_UNIT="$CHANGE_UNIT" node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const comments = JSON.parse(s).data.repository.pullRequest.comments;
        const unit = process.env.CHANGE_UNIT;
        const escaped = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const marker = new RegExp(
          `^\\[Review-Attempt: 2/2\\]\\n\\[Change-Unit: ${escaped}\\]\\n\\[Reviewed-Head: ([0-9a-f]{40})\\]$`,
        );
        const heads = [];
        for (const comment of comments.nodes) {
          const match = comment.body.trim().match(marker);
          if (match) heads.push(match[1]);
        }
        process.stdout.write(heads.join("\n"));
        process.stderr.write(
          `${heads.length} ${comments.pageInfo.hasNextPage ? comments.pageInfo.endCursor : "-"}\n`,
        );
      });
    ' 2>"$MARKER_META") || die "解析评审尝试 marker 失败"
    read -r n next <"$MARKER_META" || die "读取 marker 分页元信息失败"
    case $n in
    '' | *[!0-9]*)
      die "marker 分页计数无效：$n"
      ;;
    esac
    MARKER_COUNT=$((MARKER_COUNT + n))
    if [ -n "$page" ]; then
      MARKER_HEADS="${MARKER_HEADS}${MARKER_HEADS:+$'\n'}${page}"
    fi
    [ "$next" = "-" ] && break
    cursor=$next
  done
  [ "$MARKER_COUNT" -le 1 ] ||
    die "同一 Change Unit 存在 $MARKER_COUNT 个 second-attempt marker；历史不唯一，执行 STOP"
}

load_markers

if [ "$MODE" != "--record-second" ]; then
  if [ "$MARKER_COUNT" -eq 0 ]; then
    echo "attempts=1/2 change_unit=$CHANGE_UNIT（PR 创建隐式占用首轮）"
  else
    echo "attempts=2/2 change_unit=$CHANGE_UNIT reviewed_head=$MARKER_HEADS（预算已耗尽）"
  fi
  exit 0
fi

HEAD_OID=$(gh pr view "$PR" --json headRefOid --jq .headRefOid) ||
  die "无法读取 PR #$PR head"
case $HEAD_OID in
'' | *[!0-9a-f]*) die "PR head OID 无效：$HEAD_OID" ;;
esac
[ "${#HEAD_OID}" -eq 40 ] || die "PR head OID 长度无效：$HEAD_OID"

if [ "$MARKER_COUNT" -eq 1 ]; then
  [ "$MARKER_HEADS" = "$HEAD_OID" ] && {
    echo "attempts=2/2 change_unit=$CHANGE_UNIT reviewed_head=$HEAD_OID（marker 已存在）"
    exit 0
  }
  die "第二次检视已记录在 $MARKER_HEADS；当前 head=$HEAD_OID，预算已耗尽"
fi

BODY=$(printf '[Review-Attempt: 2/2]\n[Change-Unit: %s]\n[Reviewed-Head: %s]' \
  "$CHANGE_UNIT" "$HEAD_OID")
gh pr comment "$PR" --body "$BODY" >/dev/null || die "写入第二次检视 marker 失败"

load_markers
[ "$MARKER_COUNT" -eq 1 ] && [ "$MARKER_HEADS" = "$HEAD_OID" ] ||
  die "第二次检视 marker 写入后未能重读确认"
echo "attempts=2/2 change_unit=$CHANGE_UNIT reviewed_head=$HEAD_OID（已记录）"
