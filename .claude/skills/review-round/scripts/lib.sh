#!/usr/bin/env bash
# review-round 各脚本的公共库。用 `source` 引入，不要直接执行。
#
# 本机没有可用于管道的 jq，所有 JSON 解析走 node。
# gh api 不支持 --arg（那是 jq 自己的 flag，--jq 不透传）。

set -euo pipefail

die() {
  echo "ERROR: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "缺少依赖：$1"
}

need gh
need git
need node

# 解析仓库坐标，导出 REPO / OWNER / NAME
resolve_repo() {
  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner) ||
    die "无法解析仓库（gh 未登录？不在 git 仓库内？）"
  [ -n "$REPO" ] || die "仓库名为空"
  OWNER=${REPO%%/*}
  NAME=${REPO##*/}
  export REPO OWNER NAME
}

# gh api graphql 包装：任何一层失败都必须终止，绝不把「没读到」当成「没有」。
#
# 这是第三轮评审的第 1 条：原先赋值失败后循环仍继续，node 解析报错但 NEXT 为空，
# 随后 break 让整个代码块以 0 退出，执行者会把「根本没读到线程」误判成「没有未解决
# 线程」并继续回复或判定本轮状态。
gql() {
  local query=$1
  shift
  local resp status
  set +e
  resp=$(gh api graphql -f query="$query" "$@" 2>&1)
  status=$?
  set -e
  [ $status -eq 0 ] || die "GraphQL 请求失败（exit=$status）：$resp"

  # HTTP 200 但 body 里带 errors 的情况，gh 不一定以非零退出
  printf '%s' "$resp" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let j;
      try { j = JSON.parse(s); }
      catch { console.error("响应不是合法 JSON：" + s.slice(0, 300)); process.exit(1); }
      if (j.errors) { console.error("GraphQL 返回 errors：" + JSON.stringify(j.errors)); process.exit(1); }
      if (!j.data) { console.error("响应缺少 data 字段：" + s.slice(0, 300)); process.exit(1); }
      process.stdout.write(s);
    });
  ' || die "GraphQL 响应校验失败"
}

# 只剥 shields.io 徽章，保留评审者贴的截图等真实图片。
#
# 第三轮第 5 条：原先的全局 /!\[[^\]]*\]\([^)]*\)/g 会删掉正文里的每一张图片，
# 包括失败截图和示意图，而注释却说「只剥徽章」。
export BADGE_STRIP_JS='
  (body) => body
    .replace(/!\[[^\]]*\]\(https:\/\/img\.shields\.io\/[^)]*\)/g, "")
    .replace(/<\/?sub>/g, "")
'
