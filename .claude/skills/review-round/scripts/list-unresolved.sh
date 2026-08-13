#!/usr/bin/env bash
# 用法: list-unresolved.sh <PR编号> [--count|--history]
#
# 列出全部未解决评审线程。翻页取全、正文不截断、每条评论标注所属评审 commit。
# --count 只输出未解决线程数（供脚本判断用）。
# --history 输出全部线程及 open/resolved 状态，供恢复历史 Root ID。
#
# 任何一层失败都以非零退出（见 lib.sh 的 gql）——「没读到」绝不能被当成「没有」。

source "$(dirname "$0")/lib.sh"

PR=${1:?用法: list-unresolved.sh <PR编号> [--count|--history]}
MODE=${2:-}
case $MODE in
'' | --count | --history) ;;
*) die "未知模式：$MODE" ;;
esac

resolve_repo

QUERY='
query($owner:String!,$repo:String!,$pr:Int!,$after:String,$size:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      reviewThreads(first:$size, after:$after){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id isResolved path line originalLine
          comments(first:100){
            totalCount
            pageInfo{ hasNextPage }
            nodes{ author{login} body pullRequestReview{ commit{oid} submittedAt } }
          }
        }
      }
    }
  }
}'

# 页大小可覆盖，仅供 selftest 强制触发翻页用
PAGE_SIZE=${RR_PAGE_SIZE:-100}

CURSOR=null
COUNT=0
PAGES=0
OUT=""
META="/tmp/rr-meta.$$"
trap 'rm -f "$META"' EXIT

while :; do
  RESP=$(gql "$QUERY" -F owner="$OWNER" -F repo="$NAME" -F pr="$PR" \
    -F after="$CURSOR" -F size="$PAGE_SIZE")

  # 正文走 stdout，「计数 + 游标」走 stderr 写进文件。
  # 不要用 \x00 之类做行内分隔符：bash 的 $'\x00' 求值为空串，命令替换也会丢掉
  # NUL，模式退化成 `*` 后游标恒为空——翻页会在第一页就静默停下。
  PAGE=$(printf '%s' "$RESP" | MODE="$MODE" node -e '
    const strip = eval(process.env.BADGE_STRIP_JS);
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const t = JSON.parse(s).data.repository.pullRequest.reviewThreads;
      const selected = process.env.MODE === "--history"
        ? t.nodes
        : t.nodes.filter((n) => !n.isResolved);
      const lines = [];
      for (const n of selected) {
        const state = n.isResolved ? "resolved" : "open";
        lines.push(`\n═══ ${n.path}:${n.line ?? n.originalLine}  id=${n.id}  state=${state}  评论数=${n.comments.totalCount}`);
        for (const c of n.comments.nodes) {
          const sha = c.pullRequestReview?.commit?.oid?.slice(0, 7) ?? "?";
          lines.push(`[${c.author?.login ?? "ghost"} @${sha}] ${strip(c.body)}`);
        }
        if (n.comments.pageInfo.hasNextPage)
          lines.push("  ⚠ 该线程评论超过 100 条，仍有未取出的内容");
      }
      process.stdout.write(lines.join("\n"));
      process.stderr.write(selected.length + " " + (t.pageInfo.hasNextPage ? t.pageInfo.endCursor : "-") + "\n");
    });
  ' 2>"$META") || die "解析线程失败"

  read -r N NEXT <"$META" || die "读取分页元信息失败"
  [ -n "${N:-}" ] || die "分页元信息为空——不能把「没读到」当成「没有」"

  COUNT=$((COUNT + N))
  PAGES=$((PAGES + 1))
  OUT="$OUT$PAGE"

  [ "$NEXT" = "-" ] && break
  CURSOR="$NEXT"
done

if [ "$MODE" = "--count" ]; then
  echo "$COUNT"
elif [ "$MODE" = "--history" ]; then
  [ "$COUNT" -eq 0 ] && echo "（无评审线程）" || printf '%s\n' "$OUT"
  echo
  echo "历史线程数: $COUNT"
else
  [ "$COUNT" -eq 0 ] && echo "（无未解决线程）" || printf '%s\n' "$OUT"
  echo
  echo "未解决线程数: $COUNT"
fi
