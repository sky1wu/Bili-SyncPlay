#!/usr/bin/env bash
# 用法: reply-resolve.sh <线程id> <带决策元数据的回复正文> <第1步看到的评论数>
#
# 顺序固定：重读线程 → 比对评论数 → 发回复 → 确认成功 → 才 resolve。
# 幂等：若本脚本的同一条回复已经发出过（上次 resolve 失败等），重跑不会重复发，
# 直接补做 resolve。

source "$(dirname "$0")/lib.sh"

THREAD_ID=${1:?用法: reply-resolve.sh <线程id> <回复正文> <已见评论数>}
BODY=${2:?缺少回复正文}
SEEN=${3:?缺少「第 1 步看到的评论数」——用于检测扫描后是否有新评论}

# 非整数会让下面的 `[ "$TOTAL" -ne "$SEEN" ]` 以「integer expression expected」失败，
# 而失败的 test 只是让 if 不成立——新评论保护就此被静默跳过，线程照样被 resolve。
# 实测触发方式：回复正文里含 ASCII 双引号，参数被提前截断、发生词拆分，$3 变成正文
# 里的某个片段。多余的参数同样是这种截断的信号。
[ "$#" -le 3 ] || die "参数多于 3 个（第 4 个是 '$4'）——回复正文很可能没有被完整引起来"
case $SEEN in
  '' | *[!0-9]*) die "「已见评论数」必须是整数，实际收到：'$SEEN'（回复正文里的引号可能截断了参数）" ;;
esac

mapfile -t BODY_LINES <<<"$BODY"
if [[ ${BODY_LINES[0]:-} =~ ^\[Change-Unit:\ ([a-z0-9][a-z0-9-]{0,62}[a-z0-9])\]$ ]]; then
  CHANGE_UNIT=${BASH_REMATCH[1]}
else
  die "回复第 1 行必须是 [Change-Unit: <kebab-case>]"
fi
if [[ ${BODY_LINES[1]:-} =~ ^\[Root-ID:\ ([a-z0-9][a-z0-9-]{0,62}[a-z0-9])\]$ ]]; then
  ROOT_ID=${BASH_REMATCH[1]}
else
  die "回复第 2 行必须是 [Root-ID: <kebab-case>]"
fi
case ${BODY_LINES[2]:-} in
'[Resolution: first-fix]' | '[Resolution: structural-redesign]' | '[Resolution: rejected]') ;;
*) die "回复第 3 行必须记录 first-fix、structural-redesign 或 rejected" ;;
esac
[ -n "${BODY_LINES[3]:-}" ] || die "决策元数据后必须说明处理与验证结果"
case "$CHANGE_UNIT:$ROOT_ID" in
*--*) die "Change Unit 与 Root ID 不得包含连续连字符" ;;
esac

ME=$(gh api user --jq .login) || die "无法确定当前登录用户"

read_thread() {
  gql '
    query($id:ID!){
      node(id:$id){
        ... on PullRequestReviewThread {
          isResolved
          comments(first:100){ totalCount nodes{ author{login} body } }
        }
      }
    }' -F id="$THREAD_ID"
}

RESP=$(read_thread)

# 一次解析出：总数、是否已解决、本脚本此前是否已发过同一条回复
read -r TOTAL RESOLVED MINE <<<"$(printf '%s' "$RESP" | BODY="$BODY" ME="$ME" node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const n = JSON.parse(s).data.node;
    // author 可为 null（账号已注销）——直接解引用会抛异常，整条流程被一条历史评论卡死
    const mine = n.comments.nodes.some(
      (c) => (c.author?.login ?? "ghost") === process.env.ME && c.body.trim() === process.env.BODY.trim(),
    );
    process.stdout.write(`${n.comments.totalCount} ${n.isResolved} ${mine}`);
  });
')"

case $TOTAL in
  '' | *[!0-9]*) die "无法读出线程评论数（收到：'$TOTAL'）" ;;
esac

if [ "$RESOLVED" = "true" ]; then
  echo "线程 ${THREAD_ID:0:20} 已是 resolved，跳过"
  exit 0
fi

resolve_now() {
  local state
  state=$(gql '
    mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }
    ' -F id="$THREAD_ID" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(String(JSON.parse(s).data.resolveReviewThread.thread.isResolved))})')
  [ "$state" = "true" ] || die "resolve 未生效"
}

# 重试路径：回复已发但上次 resolve 失败。若不识别这种情况，按原 SEEN 重跑会因评论数
# 变多而被拒，改用新计数重跑又会再发一条重复回复。
#
# 但幂等分支**不能**绕过新评论保护：上次回复成功、resolve 失败之后，评审者可能又补了
# 内容。此时总数会超过 SEEN+1，直接 resolve 会把没分析过的反馈一起关掉。
# 只有「唯一的增量就是脚本自己那条回复」才允许直接补 resolve。
if [ "$MINE" = "true" ]; then
  if [ "$TOTAL" -ne "$((SEEN + 1))" ]; then
    echo "拒绝 resolve：回复已发，但评论数为 $TOTAL（期望 $((SEEN + 1))），说明之后还有新反馈。" >&2
    printf '%s' "$RESP" | node -e '
      const strip = eval(process.env.BADGE_STRIP_JS);
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const c = JSON.parse(s).data.node.comments.nodes;
        const last = c[c.length - 1];
        console.error(`最新一条 [${last.author?.login ?? "ghost"}]: ${strip(last.body).slice(0, 500)}`);
      });
    '
    die "先把新增内容纳入根因分析，再重跑本脚本"
  fi
  echo "检测到本脚本的同一条回复已存在（上次 resolve 未完成），跳过发送，仅补做 resolve"
  resolve_now
  echo "OK: ${THREAD_ID:0:20} 已 resolved（复用既有回复）"
  exit 0
fi

# 评审者可能在第 1 步扫描之后、修复期间往同一线程补充条件或指出修复方向有误。
# 照最初保存的内容直接回复并 resolve，新反馈从未进入根因分析就被关掉了。
if [ "$TOTAL" -ne "$SEEN" ]; then
  echo "拒绝 resolve：该线程评论数由 $SEEN 变为 $TOTAL，扫描之后有新反馈。" >&2
  printf '%s' "$RESP" | node -e '
    const strip = eval(process.env.BADGE_STRIP_JS);
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const c = JSON.parse(s).data.node.comments.nodes;
      const last = c[c.length - 1];
      console.error(`最新一条 [${last.author?.login ?? "ghost"}]: ${strip(last.body).slice(0, 500)}`);
    });
  '
  die "先把新增内容纳入根因分析，再重跑本脚本"
fi

REPLY=$(gql '
  mutation($id:ID!,$body:String!){
    addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id, body:$body}){
      comment{ id }
    }
  }' -F id="$THREAD_ID" -F body="$BODY" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).data.addPullRequestReviewThreadReply?.comment?.id ?? "")})')

[ -n "$REPLY" ] || die "回复未成功（没拿到 comment id），不执行 resolve"

resolve_now
echo "OK: ${THREAD_ID:0:20} 已回复并 resolved"
