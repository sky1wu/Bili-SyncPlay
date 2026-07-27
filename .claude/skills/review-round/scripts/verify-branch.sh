#!/usr/bin/env bash
# 用法: verify-branch.sh <PR编号> [--switch]
#
# 在动任何文件之前，确认本地就是这个 PR 的 head——分支名 *和* SHA 都要对。
# --switch 允许脚本自行切换分支；不传则只校验、不一致就报错退出。

source "$(dirname "$0")/lib.sh"

PR=${1:?用法: verify-branch.sh <PR编号> [--switch]}
MODE=${2:-}

resolve_repo

META=$(gh pr view "$PR" --json headRefName,headRefOid,headRepositoryOwner,isCrossRepository) ||
  die "读取 PR #$PR 元数据失败"

read -r HEAD_REF HEAD_OID CROSS HEAD_OWNER <<<"$(printf '%s' "$META" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const j = JSON.parse(s);
    process.stdout.write([
      j.headRefName,
      j.headRefOid,
      String(j.isCrossRepository),
      j.headRepositoryOwner?.login ?? "?",
    ].join(" "));
  });
')"

echo "PR#$PR head=$HEAD_REF@${HEAD_OID:0:7} owner=$HEAD_OWNER cross_repo=$CROSS"

# 第三轮第 4 条：PR 来自 fork 时 origin 指向基础仓库，headRefName 只有分支名，
# 推送会打到基础仓库的同名分支或直接因权限失败，PR head 不会更新。
# 本仓库不存在 fork PR，与其写一套没法验证的 fork 推送逻辑，不如显式拒绝。
if [ "$CROSS" = "true" ]; then
  die "该 PR 来自 fork（$HEAD_OWNER），本脚本不支持跨仓库推送。请手动配置 fork remote 后再操作。"
fi

case "$HEAD_REF" in
main | master) die "该 PR 的 head 是 $HEAD_REF，拒绝在其上直接操作" ;;
esac

CUR=$(git rev-parse --abbrev-ref HEAD)

if [ "$CUR" != "$HEAD_REF" ]; then
  if [ "$MODE" = "--switch" ]; then
    echo "当前在 $CUR，切换到 $HEAD_REF"
    git switch "$HEAD_REF" >/dev/null 2>&1 ||
      git switch -c "$HEAD_REF" --track "origin/$HEAD_REF" >/dev/null 2>&1 ||
      die "切换到 $HEAD_REF 失败"
  else
    die "当前分支是 $CUR，不是 PR 的 head（$HEAD_REF）。加 --switch 允许自动切换。"
  fi
fi

# 第三轮第 6 条：只比分支名不够——同名本地分支可能落后于远端（协作者或上一轮自动化
# 已推新提交）。此时会基于旧代码处理反馈，甚至把针对当前远端提交的意见判成过时，
# 直到最后 push 被非快进拒绝才暴露。
git fetch origin "$HEAD_REF" --quiet || die "fetch origin/$HEAD_REF 失败"
LOCAL_OID=$(git rev-parse HEAD)

if [ "$LOCAL_OID" != "$HEAD_OID" ]; then
  echo "本地 HEAD=${LOCAL_OID:0:7}  PR head=${HEAD_OID:0:7}" >&2
  if git merge-base --is-ancestor "$LOCAL_OID" "$HEAD_OID" 2>/dev/null; then
    die "本地落后于 PR head，先 git pull --ff-only 再重来（否则会基于旧代码处理反馈）"
  fi
  die "本地 HEAD 与 PR head 不一致且非快进关系，请人工确认后再继续"
fi

echo "OK: 分支 $HEAD_REF 与 SHA ${HEAD_OID:0:7} 均一致"
