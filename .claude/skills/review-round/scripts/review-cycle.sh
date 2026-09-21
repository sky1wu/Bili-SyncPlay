#!/usr/bin/env bash
# 用法:
#   review-cycle.sh <PR编号>
#   review-cycle.sh <PR编号> --initialize <problem-id> <change-unit> [parent-pr|none]
#   review-cycle.sh <PR编号> --record-repair
#
# 一个 PR 是一个 Design Attempt。初始化 marker 固定身份；后续只从 PR 历史恢复它。
# 修复预算按已推送的 repair batch 计数，而不是按自动或人工 review 的次数计数。

source "$(dirname "$0")/lib.sh"

PR=${1:?用法: review-cycle.sh <PR编号> [--initialize <problem-id> <change-unit> [parent-pr|none] | --record-repair]}
MODE=${2:-}
case $PR in
'' | *[!0-9]*) die "PR 编号必须是纯数字：$PR" ;;
esac
case $MODE in
'') [ "$#" -eq 1 ] || die "状态查询只接受 PR 编号" ;;
--initialize)
  [ "$#" -ge 4 ] && [ "$#" -le 5 ] ||
    die "用法: review-cycle.sh <PR编号> --initialize <problem-id> <change-unit> [parent-pr|none]"
  PROBLEM_ID=$3
  REQUESTED_CHANGE_UNIT=$4
  REQUESTED_PARENT=${5:-none}
  ;;
--record-repair) [ "$#" -eq 2 ] || die "--record-repair 不接受额外参数" ;;
*) die "未知模式：$MODE" ;;
esac

validate_slug() {
  local label=$1 value=$2
  if ! [[ $value =~ ^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$ ]] || [[ $value == *--* ]]; then
    die "$label 必须是 2-64 字符的 kebab-case：$value"
  fi
}

if [ "$MODE" = "--initialize" ]; then
  validate_slug problem-id "$PROBLEM_ID"
  validate_slug change-unit "$REQUESTED_CHANGE_UNIT"
  if [ "$REQUESTED_PARENT" != "none" ]; then
    case $REQUESTED_PARENT in
    '' | *[!0-9]* | 0*) die "parent-pr 必须是 none 或正整数：$REQUESTED_PARENT" ;;
    esac
  fi
fi

resolve_repo
MARKER_META=$(mktemp /tmp/review-cycle-meta.XXXXXX)
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
  local target_pr=${1:-$PR} cursor=null resp page next n kind a b c d
  UNIT_COUNT=0
  UNIT_NAME=""
  UNIT_PROBLEM=""
  UNIT_CHANGE=""
  UNIT_PARENT=""
  REPAIR_ONE_COUNT=0
  REPAIR_ONE_UNIT=""
  REPAIR_ONE_HEAD=""
  REPAIR_TWO_COUNT=0
  REPAIR_TWO_UNIT=""
  REPAIR_TWO_HEAD=""

  while :; do
    resp=$(gql "$QUERY" -F owner="$OWNER" -F repo="$NAME" -F pr="$target_pr" -F after="$cursor")
    page=$(printf '%s' "$resp" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const comments = JSON.parse(s).data.repository.pullRequest.comments;
        const records = [];
        const unit = /^\[Review-Unit: (pr-[1-9][0-9]*)\]\n\[Problem-ID: ([a-z0-9][a-z0-9-]{0,62}[a-z0-9])\]\n\[Change-Unit: ([a-z0-9][a-z0-9-]{0,62}[a-z0-9])\]\n\[Parent-PR: (none|[1-9][0-9]*)\]$/;
        const repair = /^\[Review-Repair: ([12])\/2\]\n\[Review-Unit: (pr-[1-9][0-9]*)\]\n\[Reviewed-Head: ([0-9a-f]{40})\]$/;
        for (const comment of comments.nodes) {
          const body = comment.body.trim();
          let match = body.match(unit);
          if (match) records.push(["U", ...match.slice(1)].join("\t"));
          match = body.match(repair);
          if (match) records.push(["R", ...match.slice(1)].join("\t"));
        }
        process.stdout.write(records.join("\n"));
        process.stderr.write(
          `${records.length} ${comments.pageInfo.hasNextPage ? comments.pageInfo.endCursor : "-"}\n`,
        );
      });
    ' 2>"$MARKER_META") || die "解析 review cycle marker 失败"
    read -r n next <"$MARKER_META" || die "读取 marker 分页元信息失败"
    case $n in
    '' | *[!0-9]*) die "marker 分页计数无效：$n" ;;
    esac
    while IFS=$'\t' read -r kind a b c d; do
      [ -n "$kind" ] || continue
      case $kind in
      U)
        UNIT_COUNT=$((UNIT_COUNT + 1))
        UNIT_NAME=$a
        UNIT_PROBLEM=$b
        UNIT_CHANGE=$c
        UNIT_PARENT=$d
        ;;
      R)
        case $a in
        1)
          REPAIR_ONE_COUNT=$((REPAIR_ONE_COUNT + 1))
          REPAIR_ONE_UNIT=$b
          REPAIR_ONE_HEAD=$c
          ;;
        2)
          REPAIR_TWO_COUNT=$((REPAIR_TWO_COUNT + 1))
          REPAIR_TWO_UNIT=$b
          REPAIR_TWO_HEAD=$c
          ;;
        esac
        ;;
      esac
    done <<<"$page"
    [ "$next" = "-" ] && break
    cursor=$next
  done

  [ "$UNIT_COUNT" -le 1 ] ||
    die "PR #$target_pr 存在 $UNIT_COUNT 个 Review Unit marker；身份不唯一，执行 STOP"
  [ "$REPAIR_ONE_COUNT" -le 1 ] && [ "$REPAIR_TWO_COUNT" -le 1 ] ||
    die "PR #$target_pr 存在重复 repair marker；历史不唯一，执行 STOP"
  [ "$REPAIR_TWO_COUNT" -eq 0 ] || [ "$REPAIR_ONE_COUNT" -eq 1 ] ||
    die "repair 2 缺少 repair 1；历史不连续，执行 STOP"
}

require_unit() {
  local target_pr=${1:-$PR}
  [ "$UNIT_COUNT" -eq 1 ] ||
    die "PR #$target_pr 尚未初始化 Review Unit；先由创建工作流补记，执行 STOP"
  [ "$UNIT_NAME" = "pr-$target_pr" ] ||
    die "Review Unit $UNIT_NAME 与 PR #$target_pr 不匹配，执行 STOP"
  validate_slug problem-id "$UNIT_PROBLEM"
  validate_slug change-unit "$UNIT_CHANGE"
  [ "$REPAIR_ONE_COUNT" -eq 0 ] || [ "$REPAIR_ONE_UNIT" = "$UNIT_NAME" ] ||
    die "repair 1 属于 $REPAIR_ONE_UNIT，不属于 $UNIT_NAME，执行 STOP"
  [ "$REPAIR_TWO_COUNT" -eq 0 ] || [ "$REPAIR_TWO_UNIT" = "$UNIT_NAME" ] ||
    die "repair 2 属于 $REPAIR_TWO_UNIT，不属于 $UNIT_NAME，执行 STOP"
  if [ "$REPAIR_ONE_COUNT" -eq 1 ] && [ "$REPAIR_TWO_COUNT" -eq 1 ] &&
    [ "$REPAIR_ONE_HEAD" = "$REPAIR_TWO_HEAD" ]; then
    die "两批 repair 指向同一 head；没有新的实现，执行 STOP"
  fi
}

validate_ancestry() {
  local expected_problem=$1 next_parent=$2 seen=",$PR," parent_problem
  ANCESTORS=""
  while [ "$next_parent" != "none" ]; do
    case $seen in
    *",$next_parent,"*) die "Parent PR 谱系在 #$next_parent 形成环，执行 STOP" ;;
    esac
    seen="$seen$next_parent,"
    ANCESTORS="${ANCESTORS}${ANCESTORS:+,}${next_parent}"
    load_markers "$next_parent"
    require_unit "$next_parent"
    parent_problem=$UNIT_PROBLEM
    [ "$parent_problem" = "$expected_problem" ] ||
      die "祖先 PR #$next_parent 的 Problem ID 是 $parent_problem，当前 Problem 是 $expected_problem；问题谱系不一致，执行 STOP"
    next_parent=$UNIT_PARENT
  done
}

require_parent_chain() {
  local child_problem=$UNIT_PROBLEM child_parent=$UNIT_PARENT
  validate_ancestry "$child_problem" "$child_parent"
  load_markers "$PR"
  require_unit "$PR"
}

print_status() {
  local repairs=$((REPAIR_ONE_COUNT + REPAIR_TWO_COUNT)) suffix="" ancestry=${ANCESTORS:-none}
  [ "$repairs" -lt 2 ] || suffix=" terminal_review_only=true"
  echo "review_unit=$UNIT_NAME problem_id=$UNIT_PROBLEM change_unit=$UNIT_CHANGE parent_pr=$UNIT_PARENT ancestors=$ancestry repairs=$repairs/2$suffix"
}

load_markers

if [ "$MODE" = "--initialize" ]; then
  if [ "$UNIT_COUNT" -eq 1 ]; then
    require_unit
    [ "$UNIT_PROBLEM" = "$PROBLEM_ID" ] &&
      [ "$UNIT_CHANGE" = "$REQUESTED_CHANGE_UNIT" ] &&
      [ "$UNIT_PARENT" = "$REQUESTED_PARENT" ] ||
      die "PR #$PR 已初始化为 problem=$UNIT_PROBLEM change=$UNIT_CHANGE parent=$UNIT_PARENT；不得改名"
    require_parent_chain
    print_status
    exit 0
  fi
  [ "$REPAIR_ONE_COUNT" -eq 0 ] && [ "$REPAIR_TWO_COUNT" -eq 0 ] ||
    die "没有 Review Unit 却已有 repair marker，执行 STOP"
  if [ "$REQUESTED_PARENT" != "none" ]; then
    validate_ancestry "$PROBLEM_ID" "$REQUESTED_PARENT"
    load_markers "$PR"
  fi
  BODY=$(printf '[Review-Unit: pr-%s]\n[Problem-ID: %s]\n[Change-Unit: %s]\n[Parent-PR: %s]' \
    "$PR" "$PROBLEM_ID" "$REQUESTED_CHANGE_UNIT" "$REQUESTED_PARENT")
  gh pr comment "$PR" --body "$BODY" >/dev/null || die "写入 Review Unit marker 失败"
  load_markers
  require_unit
  [ "$UNIT_PROBLEM" = "$PROBLEM_ID" ] &&
    [ "$UNIT_CHANGE" = "$REQUESTED_CHANGE_UNIT" ] &&
    [ "$UNIT_PARENT" = "$REQUESTED_PARENT" ] ||
    die "Review Unit marker 写入后内容不一致"
  require_parent_chain
  print_status
  exit 0
fi

require_unit
require_parent_chain
[ "$MODE" = "--record-repair" ] || {
  print_status
  exit 0
}

HEAD_OID=$(gh pr view "$PR" --json headRefOid --jq .headRefOid) ||
  die "无法读取 PR #$PR head"
case $HEAD_OID in
'' | *[!0-9a-f]*) die "PR head OID 无效：$HEAD_OID" ;;
esac
[ "${#HEAD_OID}" -eq 40 ] || die "PR head OID 长度无效：$HEAD_OID"

REPAIRS=$((REPAIR_ONE_COUNT + REPAIR_TWO_COUNT))
if [ "$REPAIRS" -eq 1 ] && [ "$REPAIR_ONE_HEAD" = "$HEAD_OID" ]; then
  print_status
  exit 0
fi
if [ "$REPAIRS" -eq 2 ] && [ "$REPAIR_TWO_HEAD" = "$HEAD_OID" ]; then
  print_status
  exit 0
fi
[ "$REPAIRS" -lt 2 ] ||
  die "两批 repair 已用完；当前 head 未记录，执行 STOP_FAILED，不得继续修改当前 PR"
[ "$REPAIRS" -eq 0 ] || [ "$REPAIR_ONE_HEAD" != "$HEAD_OID" ] ||
  die "新 repair 没有产生新的 head"

NEXT=$((REPAIRS + 1))
BODY=$(printf '[Review-Repair: %s/2]\n[Review-Unit: %s]\n[Reviewed-Head: %s]' \
  "$NEXT" "$UNIT_NAME" "$HEAD_OID")
gh pr comment "$PR" --body "$BODY" >/dev/null || die "写入 repair $NEXT marker 失败"
load_markers
require_unit
case $NEXT in
1) [ "$REPAIR_ONE_COUNT" -eq 1 ] && [ "$REPAIR_ONE_HEAD" = "$HEAD_OID" ] ;;
2) [ "$REPAIR_TWO_COUNT" -eq 1 ] && [ "$REPAIR_TWO_HEAD" = "$HEAD_OID" ] ;;
esac || die "repair $NEXT marker 写入后未能重读确认"
print_status
