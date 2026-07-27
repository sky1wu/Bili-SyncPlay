#!/usr/bin/env bash
# 用法: verify-branch.sh <PR编号> [--switch] [--allow-ahead]
#
#   --switch       允许自行切换到 PR 的 head 分支（编辑前用）
#   --allow-ahead  允许本地领先远端（提交之后、推送之前用）
#
# 在动任何文件之前，确认本地就是这个 PR 的 head——分支名 *和* SHA 都要对。

source "$(dirname "$0")/lib.sh"

PR=${1:?用法: verify-branch.sh <PR编号> [--switch] [--allow-ahead]}
shift || true

DO_SWITCH=0
ALLOW_AHEAD=0
for arg in "$@"; do
  case "$arg" in
  --switch) DO_SWITCH=1 ;;
  --allow-ahead) ALLOW_AHEAD=1 ;;
  *) die "未知参数：$arg" ;;
  esac
done

resolve_repo

META=$(gh pr view "$PR" --json headRefName,headRefOid,headRepositoryOwner,isCrossRepository) ||
  die "读取 PR #$PR 元数据失败"

read -r HEAD_REF HEAD_OID CROSS HEAD_OWNER <<<"$(printf '%s' "$META" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const j = JSON.parse(s);
    process.stdout.write([
      j.headRefName, j.headRefOid, String(j.isCrossRepository),
      j.headRepositoryOwner?.login ?? "?",
    ].join(" "));
  });
')"

echo "PR#$PR head=$HEAD_REF@${HEAD_OID:0:7} owner=$HEAD_OWNER cross_repo=$CROSS"

# fork PR：origin 指向基础仓库，headRefName 只有分支名，推送会打到基础仓库的同名
# 分支或因权限失败，PR head 不会更新。本仓库不存在 fork PR，显式拒绝而不是写一套
# 无法在此验证的跨仓库推送逻辑。
[ "$CROSS" = "true" ] &&
  die "该 PR 来自 fork（$HEAD_OWNER），本脚本不支持跨仓库推送。请手动配置 fork remote。"

case "$HEAD_REF" in
main | master) die "该 PR 的 head 是 $HEAD_REF，拒绝在其上直接操作" ;;
esac

# fetch 必须在切换之前：PR 分支若是上次 fetch 之后才创建的，本地既没有同名分支也没有
# origin/$HEAD_REF，两个 git switch 都会以 "invalid reference: origin/xxx" 失败。
# --track 只设置跟踪配置，不会自行下载缺失的引用。
git fetch origin "$HEAD_REF" --quiet || die "fetch origin/$HEAD_REF 失败"

CUR=$(git rev-parse --abbrev-ref HEAD)
if [ "$CUR" != "$HEAD_REF" ]; then
  if [ "$DO_SWITCH" -eq 1 ]; then
    echo "当前在 $CUR，切换到 $HEAD_REF"
    git switch "$HEAD_REF" >/dev/null 2>&1 ||
      git switch -c "$HEAD_REF" --track "origin/$HEAD_REF" >/dev/null 2>&1 ||
      die "切换到 $HEAD_REF 失败"
  else
    die "当前分支是 $CUR，不是 PR 的 head（$HEAD_REF）。加 --switch 允许自动切换。"
  fi
fi

LOCAL_OID=$(git rev-parse HEAD)

if [ "$LOCAL_OID" = "$HEAD_OID" ]; then
  echo "OK: 分支 $HEAD_REF 与 SHA ${HEAD_OID:0:7} 均一致"
  exit 0
fi

echo "本地 HEAD=${LOCAL_OID:0:7}  PR head=${HEAD_OID:0:7}" >&2

# 本地落后：会基于旧代码处理反馈，甚至把针对当前远端提交的意见误判成过时。
if git merge-base --is-ancestor "$LOCAL_OID" "$HEAD_OID" 2>/dev/null; then
  die "本地落后于 PR head，先 git pull --ff-only 再重来"
fi

# 本地领先：提交之后、推送之前的正常状态。严格相等会让每个有提交的轮次都在 push
# 前中止，所以推送前的复验要用 --allow-ahead。
if git merge-base --is-ancestor "$HEAD_OID" "$LOCAL_OID" 2>/dev/null; then
  AHEAD=$(git rev-list --count "$HEAD_OID..$LOCAL_OID")
  if [ "$ALLOW_AHEAD" -eq 1 ]; then
    echo "OK: 本地领先远端 $AHEAD 个提交（待推送），分支 $HEAD_REF 正确"
    exit 0
  fi
  die "本地领先远端 $AHEAD 个提交。编辑前应与远端一致；若这是提交后的推送前复验，请加 --allow-ahead。"
fi

die "本地 HEAD 与 PR head 已分叉（互非祖先），请人工确认后再继续"
