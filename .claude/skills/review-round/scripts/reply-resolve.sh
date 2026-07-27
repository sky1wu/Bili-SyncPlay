#!/usr/bin/env bash
# 用法: reply-resolve.sh <线程id> <回复正文> <第1步看到的评论数>
#
# 顺序固定：重读线程 → 比对评论数 → 发回复 → 确认回复成功 → 才 resolve。
# 任何一环失败都不 resolve，线程宁可留着也不能被静默关闭。

source "$(dirname "$0")/lib.sh"

THREAD_ID=${1:?用法: reply-resolve.sh <线程id> <回复正文> <已见评论数>}
BODY=${2:?缺少回复正文}
SEEN=${3:?缺少「第 1 步看到的评论数」——用于检测扫描后是否有新评论}

# 第三轮第 7 条：评审者可能在第 1 步扫描之后、修复期间往同一线程补充条件或指出修复
# 方向有误。若照最初保存的内容直接回复并 resolve，新反馈从未进入根因分析就被关掉了。
RESP=$(gql '
  query($id:ID!){
    node(id:$id){
      ... on PullRequestReviewThread {
        isResolved
        comments(first:100){ totalCount nodes{ author{login} body } }
      }
    }
  }' -F id="$THREAD_ID")

read -r NOW RESOLVED <<<"$(printf '%s' "$RESP" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const n = JSON.parse(s).data.node;
    process.stdout.write(`${n.comments.totalCount} ${n.isResolved}`);
  });
')"

if [ "$RESOLVED" = "true" ]; then
  echo "线程 ${THREAD_ID:0:20} 已是 resolved，跳过"
  exit 0
fi

if [ "$NOW" -ne "$SEEN" ]; then
  echo "拒绝 resolve：该线程评论数由 $SEEN 变为 $NOW，扫描之后有新反馈。" >&2
  printf '%s' "$RESP" | node -e '
    const strip = eval(process.env.BADGE_STRIP_JS);
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const c = JSON.parse(s).data.node.comments.nodes;
      const last = c[c.length - 1];
      console.error(`最新一条 [${last.author.login}]: ${strip(last.body).slice(0, 500)}`);
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

STATE=$(gql '
  mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }
  ' -F id="$THREAD_ID" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(String(JSON.parse(s).data.resolveReviewThread.thread.isResolved))})')

[ "$STATE" = "true" ] || die "resolve 未生效"
echo "OK: ${THREAD_ID:0:20} 已回复并 resolved"
