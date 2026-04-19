#!/usr/bin/env python3
"""Pre-push format/lint gate for Bili-SyncPlay.

Invoked by a PreToolUse Bash hook (see .claude/settings.json). Reads the
tool_input JSON from stdin and:
  * exits 0 (allow) when the command is not a git push, or is a push
    that does not target THIS project;
  * runs `npm run format:check` and `npm run lint` when the push targets
    this project;
  * exits 2 (block) when our own checks fail, or when the push clearly
    targets this project but its package.json is missing.

The hook intentionally only guards pushes of THIS project, anchored via
`__file__`. Pushes of unrelated repos are allowed through — it is not our
job to police them.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

OUR_REPO = Path(__file__).resolve().parent.parent.parent

# Git global flags whose argument is a separate shell token.
GIT_FLAGS_WITH_ARG = {
    "-c",
    "--namespace",
    "--super-prefix",
    "--exec-path",
    "--config-env",
}

# Split a command line into shell segments on control operators so each
# segment can be tokenized independently.
SEGMENT_SPLIT = re.compile(r"\|\|?|&&|[;&\n()]")


def _process_segment(
    tokens: list[str], running_cwd: Path
) -> tuple[list[Path], Path]:
    """Process ONE shell segment. Return (push_target_dirs, updated_running_cwd).

    A leading `cd <dir>` token updates `running_cwd` for subsequent segments in
    the same command (approximating shell semantics for `cd X && cmd`). Subshell
    scoping is not tracked; the result is conservative — if a push falls outside
    OUR_REPO it is merely skipped rather than wrongly blocked.
    """
    targets: list[Path] = []

    if tokens and tokens[0] == "cd" and len(tokens) >= 2:
        raw = Path(tokens[1])
        running_cwd = raw if raw.is_absolute() else running_cwd / raw
        tokens = tokens[2:]

    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok == "git" or tok.endswith("/git"):
            repo_dir = running_cwd
            j = i + 1
            while j < len(tokens):
                t = tokens[j]
                if t == "-C" and j + 1 < len(tokens):
                    raw = Path(tokens[j + 1])
                    repo_dir = raw if raw.is_absolute() else repo_dir / raw
                    j += 2
                    continue
                if t.startswith("--git-dir="):
                    gd = Path(t.split("=", 1)[1])
                    repo_dir = gd.parent if gd.name == ".git" else gd
                    j += 1
                    continue
                if t == "--git-dir" and j + 1 < len(tokens):
                    gd = Path(tokens[j + 1])
                    repo_dir = gd.parent if gd.name == ".git" else gd
                    j += 2
                    continue
                if t.startswith("--work-tree="):
                    repo_dir = Path(t.split("=", 1)[1])
                    j += 1
                    continue
                if t == "--work-tree" and j + 1 < len(tokens):
                    repo_dir = Path(tokens[j + 1])
                    j += 2
                    continue
                if t.startswith("-"):
                    if t in GIT_FLAGS_WITH_ARG:
                        j += 2
                    else:
                        j += 1
                    continue
                if t == "push":
                    targets.append(repo_dir)
                break
            i = j + 1
            continue
        i += 1
    return targets, running_cwd


def push_targets(cmd: str, hook_cwd: Path) -> list[Path]:
    targets: list[Path] = []
    running_cwd = hook_cwd
    for segment in SEGMENT_SPLIT.split(cmd):
        seg = segment.strip()
        if not seg:
            continue
        try:
            tokens = shlex.split(seg)
        except ValueError:
            continue
        seg_targets, running_cwd = _process_segment(tokens, running_cwd)
        targets.extend(seg_targets)
    return targets


def _within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root)
        return True
    except (ValueError, OSError):
        return False


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    cmd = (payload.get("tool_input") or {}).get("command") or ""
    hook_cwd = Path(os.getcwd())

    targets = push_targets(cmd, hook_cwd)
    if not targets:
        return 0

    our_push = any(_within(t, OUR_REPO) for t in targets)
    if not our_push:
        return 0

    if not (OUR_REPO / "package.json").is_file():
        print(
            f"pre-push check: expected package.json at {OUR_REPO} not found — "
            "refusing to allow push without verification",
            file=sys.stderr,
        )
        return 2

    for step in (["npm", "run", "format:check"], ["npm", "run", "lint"]):
        result = subprocess.run(step, cwd=str(OUR_REPO))
        if result.returncode != 0:
            print(
                "pre-push checks failed — fix format/lint locally, then retry push",
                file=sys.stderr,
            )
            return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
