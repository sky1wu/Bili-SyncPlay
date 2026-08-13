#!/usr/bin/env bash
# Create and remove temporary worktrees without modifying the caller's dirty worktree.
#
# Usage:
#   isolated-worktree.sh create-branch <branch>
#   isolated-worktree.sh create-review <PR number> <absolute verify-branch.sh path>
#   isolated-worktree.sh cleanup <isolated worktree path>

set -euo pipefail

die() {
  echo "isolated-worktree: $*" >&2
  exit 1
}

original_worktree() {
  git rev-parse --show-toplevel 2>/dev/null || die "current directory is not a Git worktree"
}

validate_branch() {
  local branch=$1
  git check-ref-format --branch "$branch" >/dev/null 2>&1 || die "invalid branch name: $branch"
  case "$branch" in
  main | master) die "refusing protected branch: $branch" ;;
  esac
}

new_isolation() {
  ISOLATION_ROOT=$(mktemp -d /tmp/bili-syncplay-worktree.XXXXXX)
  ISOLATED_WORKTREE="$ISOLATION_ROOT/worktree"
}

discard_failed_isolation() {
  local repo=$1
  if [ -n "${ISOLATED_WORKTREE:-}" ] && [ -d "$ISOLATED_WORKTREE" ]; then
    git -C "$repo" worktree remove --force "$ISOLATED_WORKTREE" >/dev/null 2>&1 || true
  fi
  if [ -n "${ISOLATION_ROOT:-}" ] && [ -d "$ISOLATION_ROOT" ]; then
    rmdir "$ISOLATION_ROOT" >/dev/null 2>&1 || true
  fi
}

print_isolation() {
  local repo=$1
  printf 'ORIGINAL_WORKTREE=%s\nISOLATION_ROOT=%s\nISOLATED_WORKTREE=%s\n' \
    "$repo" "$ISOLATION_ROOT" "$ISOLATED_WORKTREE"
}

create_branch() {
  [ "$#" -eq 1 ] || die "usage: isolated-worktree.sh create-branch <branch>"
  local branch=$1 repo
  validate_branch "$branch"
  repo=$(original_worktree)
  git -C "$repo" fetch origin main --quiet
  git -C "$repo" cat-file -e 'origin/main^{commit}'
  new_isolation
  if ! git -C "$repo" worktree add -b "$branch" "$ISOLATED_WORKTREE" origin/main; then
    discard_failed_isolation "$repo"
    die "failed to create isolated branch worktree"
  fi
  print_isolation "$repo"
}

create_review() {
  [ "$#" -eq 2 ] ||
    die "usage: isolated-worktree.sh create-review <PR number> <absolute verify-branch.sh path>"
  local pr=$1 verifier=$2 repo meta head_ref head_oid cross fetched_oid
  case $pr in
  '' | *[!0-9]*) die "PR number must be numeric: $pr" ;;
  esac
  case $verifier in
  /*) ;;
  *) die "verify-branch.sh path must be absolute" ;;
  esac
  [ -x "$verifier" ] || die "verify-branch.sh is not executable: $verifier"

  repo=$(original_worktree)
  meta=$(gh pr view "$pr" --json headRefName,headRefOid,isCrossRepository) ||
    die "failed to read PR #$pr metadata"
  read -r head_ref head_oid cross <<<"$(printf '%s' "$meta" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const j = JSON.parse(s);
      process.stdout.write([j.headRefName, j.headRefOid, String(j.isCrossRepository)].join(" "));
    });
  ')"
  [ "$cross" = "false" ] || die "fork PRs are not supported"
  validate_branch "$head_ref"
  case $head_oid in
  *[!0-9a-f]* | '') die "invalid PR head OID: $head_oid" ;;
  esac
  [ "${#head_oid}" -eq 40 ] || die "invalid PR head OID length: $head_oid"

  git -C "$repo" fetch origin "$head_ref" --quiet
  fetched_oid=$(git -C "$repo" rev-parse FETCH_HEAD)
  [ "$fetched_oid" = "$head_oid" ] ||
    die "PR head moved while preparing isolation: expected $head_oid, fetched $fetched_oid"
  git -C "$repo" cat-file -e "$head_oid^{commit}"

  new_isolation
  if ! git -C "$repo" worktree add --detach "$ISOLATED_WORKTREE" "$head_oid"; then
    discard_failed_isolation "$repo"
    die "failed to create detached review worktree"
  fi
  if ! (cd "$ISOLATED_WORKTREE" && "$verifier" "$pr" --detached); then
    discard_failed_isolation "$repo"
    die "detached review worktree failed verification"
  fi
  print_isolation "$repo"
  printf 'PR_HEAD_REF=%s\nPR_HEAD=%s\n' "$head_ref" "$head_oid"
}

cleanup() {
  [ "$#" -eq 1 ] || die "usage: isolated-worktree.sh cleanup <isolated worktree path>"
  local requested=$1 isolated root repo registered
  case $requested in
  /*) ;;
  *) die "cleanup path must be absolute" ;;
  esac
  isolated=$(realpath -m "$requested")
  root=$(dirname "$isolated")
  [ "$(basename "$isolated")" = "worktree" ] || die "refusing unexpected cleanup path: $isolated"
  [ "$(dirname "$root")" = "/tmp" ] || die "refusing worktree outside /tmp: $isolated"
  case $(basename "$root") in
  bili-syncplay-worktree.*) ;;
  *) die "refusing unowned worktree path: $isolated" ;;
  esac

  repo=$(original_worktree)
  registered=$(git -C "$repo" worktree list --porcelain | sed -n 's/^worktree //p')
  printf '%s\n' "$registered" | grep -Fx -- "$isolated" >/dev/null ||
    die "worktree is not registered in this repository: $isolated"
  git -C "$repo" worktree remove "$isolated"
  rmdir "$root"
}

action=${1:-}
[ -n "$action" ] || die "missing action"
shift
case $action in
create-branch) create_branch "$@" ;;
create-review) create_review "$@" ;;
cleanup) cleanup "$@" ;;
*) die "unknown action: $action" ;;
esac
