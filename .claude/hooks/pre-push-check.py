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
import shlex
import subprocess
import sys
from pathlib import Path

OUR_REPO = Path(__file__).resolve().parent.parent.parent

# Git global flags whose argument is a separate shell token. `-C`,
# `--git-dir`, and `--work-tree` are handled explicitly (they affect the
# effective repo directory) and so are NOT listed here.
GIT_FLAGS_WITH_ARG = {
    "-c",
    "--namespace",
    "--super-prefix",
    "--exec-path",
    "--config-env",
}


def _walk_events(cmd: str) -> list[tuple[str, str]]:
    """Tokenize the command line into a stream of shell-level events.

    Each event is one of:
      ("seg", <text>)     — a runnable command segment, fed to shlex.split
      ("open", "")         — entering a subshell `(`
      ("close", "")        — leaving a subshell `)`
    Separators like `;`, `&`, `&&`, `||`, `|`, newline close the current
    segment without changing scope; quotes and backslash escapes are
    preserved inside segments and do NOT trigger paren/separator handling.
    """
    events: list[tuple[str, str]] = []
    buf: list[str] = []

    def flush():
        if buf:
            events.append(("seg", "".join(buf)))
            buf.clear()

    i, n = 0, len(cmd)
    quote: str | None = None
    while i < n:
        c = cmd[i]
        if quote is not None:
            buf.append(c)
            if c == "\\" and i + 1 < n:
                buf.append(cmd[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in ('"', "'"):
            buf.append(c)
            quote = c
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            buf.append(c)
            buf.append(cmd[i + 1])
            i += 2
            continue
        if c == "(":
            flush()
            events.append(("open", ""))
            i += 1
            continue
        if c == ")":
            flush()
            events.append(("close", ""))
            i += 1
            continue
        if cmd.startswith("&&", i) or cmd.startswith("||", i):
            flush()
            i += 2
            continue
        if c in ";&\n|":
            flush()
            i += 1
            continue
        buf.append(c)
        i += 1
    flush()
    return events


def _segment_git_pushes(
    tokens: list[str], running_cwd: Path
) -> tuple[list[Path], Path]:
    """Scan tokens of one segment for `git ... push` invocations.

    A leading `cd <dir>` is applied to `running_cwd` (the updated value is
    returned so the caller can carry it into later segments within the same
    shell scope). Subsequent `git` occurrences in the same segment also use
    the updated `running_cwd`. Handles `-C`, `--git-dir`, `--work-tree` for
    re-targeting the repo of a specific `git` call.
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
    """Return directory targets of every `git push` seen in `cmd`.

    Tracks a stack of effective working directories so subshells (`( ... )`)
    restore the outer scope on close. `cd X && ...` inside a subshell only
    affects commands within that subshell.
    """
    targets: list[Path] = []
    cwd_stack: list[Path] = [hook_cwd]
    for kind, payload in _walk_events(cmd):
        if kind == "open":
            cwd_stack.append(cwd_stack[-1])
            continue
        if kind == "close":
            if len(cwd_stack) > 1:
                cwd_stack.pop()
            continue
        seg = payload.strip()
        if not seg:
            continue
        try:
            tokens = shlex.split(seg)
        except ValueError:
            continue
        seg_targets, new_cwd = _segment_git_pushes(tokens, cwd_stack[-1])
        cwd_stack[-1] = new_cwd
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
