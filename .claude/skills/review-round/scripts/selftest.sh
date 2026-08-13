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

# 先用一个合法查询确认依赖 / 认证 / 网络都可用。否则 gh 缺失或未登录时，
# lib.sh 会在执行非法查询之前就 die，而 `|| ok` 仍把它记成「非法查询以非零退出」——
# 关键防护根本没被测到，selftest 却报全绿。
if (source "$HERE/lib.sh" && gql 'query{ viewer{ login } }' >/dev/null 2>&1); then
  ok "前置条件可用（gh 已登录、网络可达）"
  (source "$HERE/lib.sh" && gql 'query{ bogusField }' >/dev/null 2>&1) &&
    no "非法查询竟然成功了" || ok "非法 GraphQL 查询以非零退出"
else
  no "前置条件不可用（gh 缺失/未登录/网络不可达）——GraphQL 防护未被测试，不能算通过"
fi

echo "== 5. resolve 前必须比对评论数 =="
grep -q 'TOTAL" -ne "\$SEEN' "$HERE/reply-resolve.sh" &&
  ok "reply-resolve.sh 比对扫描后是否有新评论" || no "缺少评论数比对"
grep -q '不执行 resolve' "$HERE/reply-resolve.sh" &&
  ok "回复失败时不 resolve" || no "缺少回复失败保护"
# 非整数的「已见评论数」会让上面那个 test 以 integer expression expected 失败，而失败的
# test 只是让 if 不成立——保护被静默跳过，线程照样被 resolve。实测触发方式：回复正文
# 里含 ASCII 双引号，参数被截断并发生词拆分。
# 断言的是错误信息而不只是退出码：假 thread id 本来就会让查询失败并 exit 1，
# 只看退出码的话，去掉校验后这条用例照样是绿的。
# 断言错误信息而不只是退出码：假 thread id 本来就会让查询失败并 exit 1，只看退出码
# 的话，去掉校验后这两条照样是绿的。输出先落到变量——pipefail 下把被测脚本放在管道
# 左侧，它的非零退出会让整条管道判失败，`grep` 命中与否就无从体现。
BAD_SEEN_OUT=$("$HERE/reply-resolve.sh" PRRT_fake "body" "+" 2>&1 || true)
case $BAD_SEEN_OUT in
  *必须是整数*) ok "非整数的已见评论数被拒（否则新评论保护会被静默跳过）" ;;
  *) no "非整数评论数未被拒" ;;
esac
EXTRA_ARG_OUT=$("$HERE/reply-resolve.sh" PRRT_fake "a" "b" 1 2>&1 || true)
case $EXTRA_ARG_OUT in
  *"参数多于 3 个"*) ok "参数多于 3 个被拒（回复正文未被完整引起来的信号）" ;;
  *) no "多余参数未被拒" ;;
esac

echo "== 6. 分支校验必须比 SHA 而非只比分支名 =="
grep -q 'headRefOid' "$HERE/verify-branch.sh" && ok "verify-branch.sh 读取 headRefOid" || no "未校验 SHA"
grep -q 'isCrossRepository' "$HERE/verify-branch.sh" && ok "检测 fork PR" || no "未检测 fork"

echo "== 7. has-changes 必须按基线判断，而非工作树是否非空 =="
TMP2=$(mktemp -d)
(
  cd "$TMP2" && git init -q
  git config user.email t@t && git config user.name t && git config commit.gpgsign false
  git commit -q --allow-empty -m init || exit 9
  echo pre >preexisting.txt # 技能启动前就存在的无关脏文件
  "$HERE/has-changes.sh" --baseline /tmp/rr-selftest-base >/dev/null
  # 本轮什么都没改
  "$HERE/has-changes.sh" /tmp/rr-selftest-base >/dev/null 2>&1
  [ $? -eq 1 ] || exit 1 # 应判 NO-CHANGES
  echo new >thisround.txt # 本轮新增
  "$HERE/has-changes.sh" /tmp/rr-selftest-base >/dev/null 2>&1
  [ $? -eq 0 ] || exit 2 # 应判 HAS-CHANGES
)
case $? in
0) ok "脏工作树下：无本轮改动判 NO-CHANGES，有则判 HAS-CHANGES" ;;
1) no "既有脏文件被误判成本轮改动（会卡在无内容可提交的 commit）" ;;
2) no "本轮新增未被识别" ;;
*) no "基线测试环境异常" ;;
esac
rm -rf "$TMP2" /tmp/rr-selftest-base

echo "== 8. verify-branch 必须允许提交后本地领先 =="
grep -q 'allow-ahead' "$HERE/verify-branch.sh" &&
  ok "verify-branch.sh 支持 --allow-ahead（否则有提交的轮次都会在 push 前中止）" ||
  no "缺少 --allow-ahead"
grep -q 'git fetch origin "\$HEAD_REF"' "$HERE/verify-branch.sh" &&
  [ "$(grep -n 'git fetch origin' "$HERE/verify-branch.sh" | cut -d: -f1)" -lt \
    "$(grep -n 'git switch "\$HEAD_REF"' "$HERE/verify-branch.sh" | cut -d: -f1)" ] &&
  ok "fetch 在 switch 之前（新建的 PR 分支本地没有 origin/ref，否则 switch 必失败）" ||
  no "fetch 仍在 switch 之后"

echo "== 9. round-signal 不得把 API 错误降级为未触发 =="
grep -q '这不是「未触发」' "$HERE/round-signal.sh" &&
  ok "Actions API 请求失败时 die 而非报 NOT-TRIGGERED" || no "仍在吞掉 API 错误"
grep -q '2>/dev/null || true' "$HERE/round-signal.sh" &&
  no "仍有 2>/dev/null || true 吞错误" || ok "已移除吞错误的写法"

echo "== 10. reply-resolve 部分失败后可安全重试 =="
grep -q 'MINE" = "true"' "$HERE/reply-resolve.sh" &&
  ok "识别已存在的自身回复，重跑只补 resolve 不重复发" || no "缺少幂等重试路径"

echo "== 11. 基线必须比内容：已脏文件被继续修改要能识别 =="
TMP3=$(mktemp -d)
(
  cd "$TMP3" && git init -q
  git config user.email t@t && git config user.name t && git config commit.gpgsign false
  echo v1 >tracked.txt && git add tracked.txt
  git commit -q -m init || exit 9
  echo v2 >tracked.txt # 技能启动前，该文件已经是 " M"
  "$HERE/has-changes.sh" --baseline /tmp/rr-st2 >/dev/null
  "$HERE/has-changes.sh" /tmp/rr-st2 >/dev/null 2>&1
  [ $? -eq 1 ] || exit 1 # 尚未动手，应判 NO-CHANGES
  echo v3 >tracked.txt   # 本轮继续修改同一个已脏文件——porcelain 状态行不变
  "$HERE/has-changes.sh" /tmp/rr-st2 >/dev/null 2>&1
  [ $? -eq 0 ] || exit 2 # 必须判 HAS-CHANGES
)
case $? in
0) ok "已脏文件的后续内容修改能被识别（只比状态行会漏，导致修复不被提交）" ;;
1) no "基线阶段被误判成有改动" ;;
2) no "已脏文件的后续修改被漏判——修复会只留在工作树" ;;
*) no "内容快照测试环境异常" ;;
esac
rm -rf "$TMP3" /tmp/rr-st2

echo "== 12. 幂等重试不得绕过新评论保护 =="
grep -q 'TOTAL" -ne "\$((SEEN + 1))' "$HERE/reply-resolve.sh" &&
  ok "幂等分支要求增量恰为脚本自己那一条回复" || no "幂等分支仍会绕过新评论检查"

echo "== 13. reaction 按时间取最新，而非存在性 =="
grep -q 'sort_by(.created_at) | last' "$HERE/round-signal.sh" &&
  ok "取时间上最新的 reaction" || no "仍按内容存在性判定"
node -e '
  // 同一 HEAD：先 +1，之后原地触发重审产生更新的 eyes
  const rs = [
    {content:"+1",   created_at:"2026-07-27T10:00:00Z"},
    {content:"eyes", created_at:"2026-07-27T11:00:00Z"},
  ];
  const latest = rs.sort((a,b)=>a.created_at.localeCompare(b.created_at)).at(-1);
  process.exit(latest.content === "eyes" ? 0 : 1);
' && ok "对照组：旧 +1 与新 eyes 并存时取到 eyes（存在性判定会错报 PASSED）" ||
  no "最新信号选择逻辑不正确"

echo "== 14. author 为 null 不得中断解析 =="
grep -c 'author\.login' "$HERE/list-unresolved.sh" "$HERE/reply-resolve.sh" |
  grep -qv ':0' && no "仍有裸 .author.login 解引用" || ok "全部改为可选访问 + ghost 占位"

echo "== 15. 翻页一致性（需传入一个真实 PR 编号）=="
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

echo "== 16. resolve 回复必须持久化收敛决策 =="
MISSING_META_OUT=$("$HERE/reply-resolve.sh" PRRT_fake "普通回复" 1 2>&1 || true)
case $MISSING_META_OUT in
  *"回复第 1 行必须是 [Change-Unit:"*) ok "缺少 Change Unit 时在访问 GitHub 前拒绝" ;;
  *) no "无决策元数据的回复未被拒绝" ;;
esac
BAD_RESOLUTION_BODY=$(printf '%s\n' \
  '[Change-Unit: review-convergence]' \
  '[Root-ID: history-loss]' \
  '[Resolution: keep-trying]' \
  '说明')
BAD_RESOLUTION_OUT=$("$HERE/reply-resolve.sh" PRRT_fake "$BAD_RESOLUTION_BODY" 1 2>&1 || true)
case $BAD_RESOLUTION_OUT in
  *"必须记录 first-fix、structural-redesign 或 rejected"*) ok "未知 Resolution 被拒绝" ;;
  *) no "未知 Resolution 未被拒绝" ;;
esac
DECISION_BODY=$(printf '%s\n' \
  '[Change-Unit: review-convergence]' \
  '[Decision-ID: review-budget]' \
  '[Resolution: first-fix]' \
  '说明')
DECISION_OUT=$("$HERE/reply-resolve.sh" PRRT_fake "$DECISION_BODY" 1 2>&1 || true)
case $DECISION_OUT in
  *"回复第 2 行必须"*) no "合法 Decision ID 被元数据边界拒绝" ;;
  *ERROR*) ok "合法 Decision ID 通过输入边界并进入只读线程查询" ;;
  *) no "Decision ID 验证路径结果不明确" ;;
esac

echo "== 17. history 模式必须包含 resolved 与 open 线程 =="
BAD_MODE_OUT=$("$HERE/list-unresolved.sh" 1 --unknown 2>&1 || true)
case $BAD_MODE_OUT in
  *"未知模式"*) ok "未知 history 模式在访问 GitHub 前被拒绝" ;;
  *) no "未知模式未被拒绝" ;;
esac
TMP4=$(mktemp -d)
cat >"$TMP4/gh" <<'SH'
#!/usr/bin/env bash
if [ "$1:$2" = "repo:view" ]; then
  echo "fixture/repo"
elif [ "$1:$2" = "api:graphql" ]; then
  cat <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"resolved-1","isResolved":true,"path":"a.ts","line":1,"originalLine":1,"comments":{"totalCount":2,"pageInfo":{"hasNextPage":false},"nodes":[{"author":{"login":"reviewer"},"body":"finding","pullRequestReview":{"commit":{"oid":"1111111"},"submittedAt":"2026-01-01T00:00:00Z"}},{"author":{"login":"agent"},"body":"[Change-Unit: review-convergence]\n[Root-ID: history-loss]\n[Resolution: first-fix]\nfixed","pullRequestReview":null}]}},{"id":"open-1","isResolved":false,"path":"b.ts","line":2,"originalLine":2,"comments":{"totalCount":1,"pageInfo":{"hasNextPage":false},"nodes":[{"author":{"login":"reviewer"},"body":"new finding","pullRequestReview":{"commit":{"oid":"2222222"},"submittedAt":"2026-01-02T00:00:00Z"}}]}}]}}}}}
JSON
else
  exit 2
fi
SH
chmod +x "$TMP4/gh"
HISTORY=$(PATH="$TMP4:$PATH" "$HERE/list-unresolved.sh" 1 --history 2>/dev/null)
HISTORY_RC=$?
OPEN_COUNT=$(PATH="$TMP4:$PATH" "$HERE/list-unresolved.sh" 1 --count 2>/dev/null)
OPEN_RC=$?
HISTORY_COUNT=$(printf '%s\n' "$HISTORY" | grep -c '^═══' || true)
if [ "$HISTORY_RC" -eq 0 ] && [ "$OPEN_RC" -eq 0 ] &&
  [ "$HISTORY_COUNT" -eq 2 ] && [ "$OPEN_COUNT" -eq 1 ] &&
  printf '%s\n' "$HISTORY" | grep -q 'state=resolved' &&
  printf '%s\n' "$HISTORY" | grep -q 'state=open' &&
  printf '%s\n' "$HISTORY" | grep -q '\[Root-ID: history-loss\]'; then
  ok "fixture history 同时恢复 resolved/open 线程及 Root ID（history=2 open=1）"
else
  no "fixture 未证明 history 覆盖已解决根因（history=$HISTORY_COUNT open=$OPEN_COUNT）"
fi
rm -rf "$TMP4"

echo "== 18. review attempt 预算必须跨会话可恢复且只能追加一次 =="
TMP5=$(mktemp -d)
cat >"$TMP5/gh" <<'SH'
#!/usr/bin/env bash
case "$1:$2" in
repo:view)
  echo "fixture/repo"
  ;;
pr:view)
  printf '%040d\n' 0 | tr 0 b
  ;;
pr:comment)
  : >"$ATTEMPT_STATE_FILE"
  echo "https://example.invalid/comment"
  ;;
api:graphql)
  after_first=false
  case " $* " in
  *" after=cursor-1 "*) after_first=true ;;
  esac
  marker='[Review-Attempt: 2/2]\n[Change-Unit: review-convergence]\n[Reviewed-Head: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb]'
  if [ "${ATTEMPT_FIXTURE:-}" = "page2" ] && [ "$after_first" = false ]; then
    printf '%s\n' '{"data":{"repository":{"pullRequest":{"comments":{"pageInfo":{"hasNextPage":true,"endCursor":"cursor-1"},"nodes":[]}}}}}'
  elif [ "${ATTEMPT_FIXTURE:-}" = "duplicate" ]; then
    printf '{"data":{"repository":{"pullRequest":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"body":"%s"},{"body":"%s"}]}}}}}\n' "$marker" "$marker"
  elif [ "${ATTEMPT_FIXTURE:-}" = "second" ] ||
    [ "${ATTEMPT_FIXTURE:-}" = "page2" ] ||
    [ -e "${ATTEMPT_STATE_FILE:-/nonexistent}" ]; then
    printf '{"data":{"repository":{"pullRequest":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"body":"%s"}]}}}}}\n' "$marker"
  else
    printf '%s\n' '{"data":{"repository":{"pullRequest":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}'
  fi
  ;;
*) exit 2 ;;
esac
SH
chmod +x "$TMP5/gh"
ATTEMPT_STATE_FILE="$TMP5/state"
FIRST=$(ATTEMPT_FIXTURE=none ATTEMPT_STATE_FILE="$ATTEMPT_STATE_FILE" PATH="$TMP5:$PATH" \
  "$HERE/review-attempt.sh" 1 review-convergence 2>/dev/null)
PAGE2=$(ATTEMPT_FIXTURE=page2 ATTEMPT_STATE_FILE="$ATTEMPT_STATE_FILE" PATH="$TMP5:$PATH" \
  "$HERE/review-attempt.sh" 1 review-convergence 2>/dev/null)
DUPLICATE=$(ATTEMPT_FIXTURE=duplicate ATTEMPT_STATE_FILE="$ATTEMPT_STATE_FILE" PATH="$TMP5:$PATH" \
  "$HERE/review-attempt.sh" 1 review-convergence 2>&1 || true)
if printf '%s\n' "$FIRST" | grep -q 'attempts=1/2' &&
  printf '%s\n' "$PAGE2" | grep -q 'attempts=2/2' &&
  printf '%s\n' "$DUPLICATE" | grep -q '历史不唯一，执行 STOP'; then
  ok "首轮隐式恢复、分页 second marker 与重复 marker STOP 均成立"
else
  no "review attempt 状态恢复不完整"
fi
RECORDED=$(ATTEMPT_FIXTURE=record ATTEMPT_STATE_FILE="$ATTEMPT_STATE_FILE" PATH="$TMP5:$PATH" \
  "$HERE/review-attempt.sh" 1 review-convergence --record-second 2>/dev/null)
REPLAY=$(ATTEMPT_FIXTURE=record ATTEMPT_STATE_FILE="$ATTEMPT_STATE_FILE" PATH="$TMP5:$PATH" \
  "$HERE/review-attempt.sh" 1 review-convergence --record-second 2>/dev/null)
if printf '%s\n' "$RECORDED" | grep -q '（已记录）' &&
  printf '%s\n' "$REPLAY" | grep -q '（marker 已存在）'; then
  ok "second marker 写后重读确认，重跑保持幂等"
else
  no "second marker 写入或幂等重试失败"
fi
rm -rf "$TMP5"

echo
echo "通过 $PASS 条，失败 $FAIL 条"
[ "$FAIL" -eq 0 ]
