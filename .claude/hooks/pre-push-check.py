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

ASSIGNMENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=.*")
ENV_FLAGS_WITH_ARG = {"-u", "--unset", "--chdir", "-C"}
SHELL_CONTROL_TOKENS = {"if", "then", "elif", "else", "fi", "do", "done", "while", "until", "{", "}"}
EXEC_FLAGS_WITH_ARG = {"-a"}


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


def _resolve_path(raw: str, cwd: Path) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else cwd / path


def _command_start(tokens: list[str]) -> int | None:
    i = 0
    while i < len(tokens) and ASSIGNMENT_RE.fullmatch(tokens[i]):
        i += 1
    while i < len(tokens) and tokens[i] in SHELL_CONTROL_TOKENS:
        i += 1
        while i < len(tokens) and ASSIGNMENT_RE.fullmatch(tokens[i]):
            i += 1
    return i if i < len(tokens) else None


def _unwrap_shell_prefix(tokens: list[str], start: int) -> int | None:
    i = start
    while i < len(tokens):
        executable = tokens[i]
        if executable == "env":
            i += 1
            while i < len(tokens):
                token = tokens[i]
                if ASSIGNMENT_RE.fullmatch(token):
                    i += 1
                    continue
                if token == "--":
                    i += 1
                    break
                if token.startswith("--unset=") or token.startswith("--chdir="):
                    i += 1
                    continue
                if token in ENV_FLAGS_WITH_ARG:
                    i += 2
                    continue
                if token.startswith("-"):
                    i += 1
                    continue
                break
            continue
        if executable == "command":
            i += 1
            while i < len(tokens) and tokens[i].startswith("-"):
                if tokens[i] == "--":
                    i += 1
                    break
                i += 1
            continue
        if executable in {"time", "nohup"}:
            i += 1
            while i < len(tokens) and tokens[i].startswith("-"):
                if tokens[i] == "--":
                    i += 1
                    break
                i += 1
            continue
        if executable == "exec":
            i += 1
            while i < len(tokens):
                token = tokens[i]
                if token == "--":
                    i += 1
                    break
                if token in EXEC_FLAGS_WITH_ARG:
                    i += 2
                    continue
                if token.startswith("-"):
                    i += 1
                    continue
                break
            continue
        return i if i < len(tokens) else None
    return None


def _git_push_target(tokens: list[str], running_cwd: Path) -> Path | None:
    start = _command_start(tokens)
    if start is None:
        return None
    start = _unwrap_shell_prefix(tokens, start)
    if start is None:
        return None

    executable = tokens[start]
    if executable != "git" and not executable.endswith("/git"):
        return None

    git_cwd = running_cwd
    repo_dir = running_cwd
    i = start + 1
    while i < len(tokens):
        token = tokens[i]
        if token == "-C" and i + 1 < len(tokens):
            git_cwd = _resolve_path(tokens[i + 1], git_cwd)
            repo_dir = git_cwd
            i += 2
            continue
        if token.startswith("-C") and token != "-C":
            git_cwd = _resolve_path(token[2:], git_cwd)
            repo_dir = git_cwd
            i += 1
            continue
        if token.startswith("--git-dir="):
            git_dir = _resolve_path(token.split("=", 1)[1], git_cwd)
            repo_dir = git_dir.parent if git_dir.name == ".git" else git_dir
            i += 1
            continue
        if token == "--git-dir" and i + 1 < len(tokens):
            git_dir = _resolve_path(tokens[i + 1], git_cwd)
            repo_dir = git_dir.parent if git_dir.name == ".git" else git_dir
            i += 2
            continue
        if token.startswith("--work-tree="):
            repo_dir = _resolve_path(token.split("=", 1)[1], git_cwd)
            i += 1
            continue
        if token == "--work-tree" and i + 1 < len(tokens):
            repo_dir = _resolve_path(tokens[i + 1], git_cwd)
            i += 2
            continue
        if token.startswith("-"):
            if token in GIT_FLAGS_WITH_ARG:
                i += 2
            else:
                i += 1
            continue
        return repo_dir if token == "push" else None
    return None


def _segment_git_pushes(
    tokens: list[str], running_cwd: Path
) -> tuple[list[Path], Path]:
    """Scan one shell segment and return targeted `git push` repos."""
    if not tokens:
        return [], running_cwd

    start = _command_start(tokens)
    if start is None:
        return [], running_cwd

    if tokens[start] == "cd" and start + 1 < len(tokens):
        candidate = _resolve_path(tokens[start + 1], running_cwd)
        if candidate.is_dir():
            running_cwd = candidate
        return [], running_cwd

    target = _git_push_target(tokens, running_cwd)
    return ([target] if target is not None else []), running_cwd


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
