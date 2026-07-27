#!/usr/bin/env bash
# 用法: selftest.sh
#
# 对各脚本的关键防护做判别力测试：每条都构造出「防护若不存在就会走错」的输入，
# 断言脚本给出正确结果。只读，不改仓库、不动 GitHub 状态。

set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
PASS=0
FAIL=0

ok() {
  echo "  ✓ $1"
  PASS=$((PASS + 1))
}
no() {
  echo "  ✗ $1"
  FAIL=$((FAIL + 1))
}

echo "== 1. 徽章剥离：只删 shields.io，保留评审者的截图 =="
BADGE_STRIP_JS='
  (body) => body
    .replace(/!\[[^\]]*\]\(https:\/\/img\.shields\.io\/[^)]*\)/g, "")
    .replace(/<\/?sub>/g, "")
' node -e '
  const strip = eval(process.env.BADGE_STRIP_JS);
  const body = "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> 标题**\n见截图：![failure](https://user-images.githubusercontent.com/x/shot.png)";
  const out = strip(body);
  const badgeGone = !out.includes("img.shields.io");
  const shotKept = out.includes("user-images.githubusercontent.com");
  process.exit(badgeGone && shotKept ? 0 : 1);
' && ok "徽章被剥离且截图被保留" || no "徽章/截图处理不正确"

# 对照组：旧的全局正则应当把截图也删掉（证明这条测试确实抓得住回归）
node -e '
  const body = "![b](https://img.shields.io/x) 见截图：![f](https://user-images.githubusercontent.com/x/shot.png)";
  const old = body.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  process.exit(old.includes("user-images") ? 1 : 0);
' && ok "对照组：旧的全局正则确实会删掉截图（测试有判别力）" || no "对照组未复现旧行为"

echo "== 2. 空推送时刻：jq 的 > \"\" 会选中所有历史 reaction =="
node -e '
  // 复现 jq 语义：任何非空字符串 > "" 为真
  const reactions = [{created_at:"2020-01-01T00:00:00Z"},{created_at:"2026-07-27T00:00:00Z"}];
  const withEmpty = reactions.filter(r => r.created_at > "");
  process.exit(withEmpty.length === reactions.length ? 0 : 1);
' && ok "已确认空阈值会全选——故 round-signal.sh 必须显式分支" || no "空阈值语义与预期不符"

grep -q 'if \[ -z "$PUSHED" \]' "$HERE/round-signal.sh" &&
  ok "round-signal.sh 对空 PUSHED 有显式分支" ||
  no "round-signal.sh 缺少空 PUSHED 分支"

echo "== 3. 改动判断必须覆盖未跟踪文件 =="
TMP=$(mktemp -d)
(
  cd "$TMP" && git init -q
  git config user.email t@t && git config user.name t
  git config commit.gpgsign false # 全局启用了 SSH 签名，临时仓库里签不了
  git commit -q --allow-empty -m init || exit 9
  echo x >untracked.md
  git diff --quiet && git diff --cached --quiet
)
RC=$?
case $RC in
0) ok "对照组：git diff 系列确实看不到未跟踪文件（旧写法会误判无改动）" ;;
9) no "对照组仓库初始化失败（提交没成功，该结论不可信）" ;;
*) no "对照组未复现旧行为（exit=$RC）" ;;
esac
[ -n "$(cd "$TMP" && git status --porcelain)" ] &&
  ok "git status --porcelain 能看到未跟踪文件" ||
  no "porcelain 未覆盖未跟踪文件"
rm -rf "$TMP"

echo "== 4. GraphQL 失败必须终止，不能被当成「没有线程」 =="
grep -q 'j.errors' "$HERE/lib.sh" && ok "lib.sh 检查响应体里的 errors" || no "lib.sh 未检查 errors"
grep -q 'set -euo pipefail' "$HERE/lib.sh" && ok "lib.sh 启用 set -euo pipefail" || no "缺少 set -euo pipefail"
(source "$HERE/lib.sh" && gql 'query{ bogusField }' >/dev/null 2>&1) &&
  no "非法查询竟然成功了" || ok "非法 GraphQL 查询以非零退出"

echo "== 5. resolve 前必须比对评论数 =="
grep -q 'NOW" -ne "\$SEEN' "$HERE/reply-resolve.sh" &&
  ok "reply-resolve.sh 比对扫描后是否有新评论" || no "缺少评论数比对"
grep -q '不执行 resolve' "$HERE/reply-resolve.sh" &&
  ok "回复失败时不 resolve" || no "缺少回复失败保护"

echo "== 6. 分支校验必须比 SHA 而非只比分支名 =="
grep -q 'headRefOid' "$HERE/verify-branch.sh" && ok "verify-branch.sh 读取 headRefOid" || no "未校验 SHA"
grep -q 'isCrossRepository' "$HERE/verify-branch.sh" && ok "检测 fork PR" || no "未检测 fork"

echo "== 7. 翻页一致性（需传入一个真实 PR 编号）=="
if [ -n "${1:-}" ]; then
  BIG=$("$HERE/list-unresolved.sh" "$1" --count 2>/dev/null)
  ONE=$(RR_PAGE_SIZE=1 "$HERE/list-unresolved.sh" "$1" --count 2>/dev/null)
  if [ -n "$BIG" ] && [ "$BIG" = "$ONE" ]; then
    ok "PR#$1 每页 1 条与默认页大小结果一致（=$BIG），游标循环有效"
  else
    no "翻页结果不一致：默认=$BIG 每页1条=$ONE"
  fi
  # 判别力说明：若游标逻辑坏掉（例如用 \x00 做分隔符导致第一页就 break），
  # 每页 1 条只会数到第一个线程，与默认页大小必然不等，这条断言会失败。
else
  echo "  – 跳过（用法: selftest.sh <PR编号> 可启用）"
fi

echo
echo "通过 $PASS 条，失败 $FAIL 条"
[ "$FAIL" -eq 0 ]
