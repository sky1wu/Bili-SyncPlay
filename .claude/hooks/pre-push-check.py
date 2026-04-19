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
REDIRECTION_RE = re.compile(r"(?:\d+)?(?:>>?|<<?|<>|>&|<&|&>>|&>)$")
REDIRECTION_WITH_TARGET_RE = re.compile(r"(?:\d+)?(?:>>?|<<?|<>|>&|<&|&>>|&>).+")
# `-C`/`--chdir` actually change the working dir of the wrapped command, so
# they are handled explicitly below, not via this "skip the next token" set.
ENV_FLAGS_WITH_ARG = {"-u", "--unset"}
SHELL_CONTROL_TOKENS = {"if", "then", "elif", "else", "fi", "do", "done", "while", "until", "{", "}"}
EXEC_FLAGS_WITH_ARG = {"-a"}
NOOP_CONTROL_TOKENS = {"fi", "done", "}"}


class IfFrame:
    def __init__(
        self,
        success_states: set[Path] | None = None,
        failure_states: set[Path] | None = None,
        after_states: set[Path] | None = None,
        phase: str = "cond",
    ) -> None:
        self.success_states = success_states or set()
        self.failure_states = failure_states or set()
        self.after_states = after_states or set()
        self.phase = phase


class LoopFrame:
    def __init__(self, skip_states: set[Path] | None = None) -> None:
        self.skip_states = skip_states or set()


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
            events.append(("short", ""))
            i += 2
            continue
        if c in "|&":
            flush()
            events.append(("subshell_sep", ""))
            i += 1
            continue
        if c in ";\n":
            flush()
            i += 1
            continue
        buf.append(c)
        i += 1
    flush()
    return events


def _resolve_path(raw: str, cwd: Path) -> Path:
    path = Path(os.path.expandvars(os.path.expanduser(raw)))
    return path if path.is_absolute() else cwd / path


def _parse_redirect(tokens: list[str], start: int) -> int:
    token = tokens[start]
    if REDIRECTION_WITH_TARGET_RE.fullmatch(token):
        return start + 1
    if REDIRECTION_RE.fullmatch(token) and start + 1 < len(tokens):
        return start + 2
    return start


def _leading_git_env(tokens: list[str], cwd: Path) -> Path | None:
    git_dir: Path | None = None
    work_tree: Path | None = None
    i = 0
    while i < len(tokens) and ASSIGNMENT_RE.fullmatch(tokens[i]):
        name, value = tokens[i].split("=", 1)
        if name == "GIT_DIR":
            git_dir = _resolve_path(value, cwd)
        elif name == "GIT_WORK_TREE":
            work_tree = _resolve_path(value, cwd)
        i += 1
    if git_dir is not None:
        return git_dir.parent if git_dir.name == ".git" else git_dir
    return work_tree


def _command_start(tokens: list[str]) -> int | None:
    i = 0
    while i < len(tokens) and ASSIGNMENT_RE.fullmatch(tokens[i]):
        i += 1
    while i < len(tokens) and tokens[i] in SHELL_CONTROL_TOKENS:
        i += 1
        while i < len(tokens) and ASSIGNMENT_RE.fullmatch(tokens[i]):
            i += 1
    while i < len(tokens):
        next_i = _parse_redirect(tokens, i)
        if next_i == i:
            break
        i = next_i
    return i if i < len(tokens) else None


def _leading_control_token(tokens: list[str]) -> str | None:
    i = 0
    while i < len(tokens) and ASSIGNMENT_RE.fullmatch(tokens[i]):
        i += 1
    return tokens[i] if i < len(tokens) and tokens[i] in SHELL_CONTROL_TOKENS else None


def _unwrap_shell_prefix(
    tokens: list[str], start: int, cwd: Path
) -> tuple[int | None, Path]:
    """Peel shell wrappers (env/command/time/nohup/exec) until reaching the real
    command token. Returns (index of real command, effective cwd). `env -C`/
    `env --chdir` change the wrapped command's working directory, so we apply
    them to `cwd` — otherwise `env -C /repo git push` from outside the repo
    would look like an external push and skip the gate.
    """
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
                if token.startswith("--chdir="):
                    cwd = _resolve_path(token.split("=", 1)[1], cwd)
                    i += 1
                    continue
                if token.startswith("--unset="):
                    i += 1
                    continue
                if token in ("-C", "--chdir"):
                    if i + 1 < len(tokens):
                        cwd = _resolve_path(tokens[i + 1], cwd)
                    i += 2
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
        return (i, cwd) if i < len(tokens) else (None, cwd)
    return (None, cwd)


def _git_push_target(tokens: list[str], running_cwd: Path) -> Path | None:
    start = _command_start(tokens)
    if start is None:
        return None
    start, running_cwd = _unwrap_shell_prefix(tokens, start, running_cwd)
    if start is None:
        return None
    repo_dir = _leading_git_env(tokens, running_cwd) or running_cwd

    executable = tokens[start]
    if executable != "git" and not executable.endswith("/git"):
        return None

    git_cwd = running_cwd
    git_dir_seen = repo_dir != running_cwd
    i = start + 1
    while i < len(tokens):
        token = tokens[i]
        if token == "-C" and i + 1 < len(tokens):
            git_cwd = _resolve_path(tokens[i + 1], git_cwd)
            if not git_dir_seen:
                repo_dir = git_cwd
            i += 2
            continue
        if token.startswith("-C") and token != "-C":
            git_cwd = _resolve_path(token[2:], git_cwd)
            if not git_dir_seen:
                repo_dir = git_cwd
            i += 1
            continue
        if token.startswith("--git-dir="):
            git_dir = _resolve_path(token.split("=", 1)[1], git_cwd)
            repo_dir = git_dir.parent if git_dir.name == ".git" else git_dir
            git_dir_seen = True
            i += 1
            continue
        if token == "--git-dir" and i + 1 < len(tokens):
            git_dir = _resolve_path(tokens[i + 1], git_cwd)
            repo_dir = git_dir.parent if git_dir.name == ".git" else git_dir
            git_dir_seen = True
            i += 2
            continue
        if token.startswith("--work-tree="):
            if not git_dir_seen:
                repo_dir = _resolve_path(token.split("=", 1)[1], git_cwd)
            i += 1
            continue
        if token == "--work-tree" and i + 1 < len(tokens):
            if not git_dir_seen:
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

    if tokens[start] == "cd":
        j = start + 1
        while j < len(tokens) and tokens[j].startswith("-"):
            if tokens[j] == "--":
                j += 1
                break
            if tokens[j] == "-":
                # `cd -` jumps to $OLDPWD; we cannot resolve that statically,
                # so leave running_cwd untouched rather than guessing.
                return [], running_cwd
            j += 1
        if j < len(tokens):
            candidate = _resolve_path(tokens[j], running_cwd)
            if candidate.is_dir():
                running_cwd = candidate
        return [], running_cwd

    target = _git_push_target(tokens, running_cwd)
    return ([target] if target is not None else []), running_cwd


def _segment_outcomes(
    tokens: list[str], running_cwd: Path
) -> tuple[list[Path], Path, bool, bool]:
    """Return targets, next cwd, and whether the segment may succeed/fail."""
    targets, new_cwd = _segment_git_pushes(tokens, running_cwd)

    start = _command_start(tokens)
    if start is None:
        return targets, new_cwd, True, True
    start, effective_cwd = _unwrap_shell_prefix(tokens, start, running_cwd)
    if start is None:
        return targets, new_cwd, True, True

    executable = tokens[start]
    if executable == "cd":
        j = start + 1
        while j < len(tokens) and tokens[j].startswith("-"):
            if tokens[j] == "--":
                j += 1
                break
            if tokens[j] == "-":
                return targets, running_cwd, True, True
            j += 1
        if j < len(tokens):
            return targets, new_cwd, new_cwd != effective_cwd, new_cwd == effective_cwd
        return targets, running_cwd, True, True
    if executable in {"true", ":"}:
        return targets, new_cwd, True, False
    if executable == "false":
        return targets, new_cwd, False, True
    return targets, new_cwd, True, True


def _run_tokens_for_states(
    tokens: list[str], states: set[Path]
) -> tuple[list[Path], set[Path], set[Path], set[Path]]:
    targets: list[Path] = []
    next_states: set[Path] = set()
    success_states: set[Path] = set()
    failure_states: set[Path] = set()

    for cwd in states:
        seg_targets, new_cwd, may_succeed, may_fail = _segment_outcomes(tokens, cwd)
        targets.extend(seg_targets)
        next_states.add(new_cwd)
        if may_succeed:
            success_states.add(new_cwd)
        if may_fail:
            failure_states.add(new_cwd)

    return targets, next_states, success_states, failure_states


def push_targets(cmd: str, hook_cwd: Path) -> list[Path]:
    """Return directory targets of every `git push` seen in `cmd`.

    Tracks a stack of effective working directories so subshells (`( ... )`)
    restore the outer scope on close. `cd X && ...` inside a subshell only
    affects commands within that subshell.

    Bash short-circuits `A && B` / `A || B`, so B may not run — and any
    `cd` inside the compound may not apply. To block bypasses like
    `cd /tmp && git push; git push` (where the second push really could
    run from the hook cwd if `cd /tmp` had failed), each `&&`/`||` records
    the cwd **before** its left operand ran as a pending alternative.
    Pending alts become active at the next non-short separator (`;`/`|`/
    `&`/newline or a subshell boundary) — i.e. once the short-circuit
    chain has fully merged — and apply to subsequent push evaluations.
    Pushes that sit inside an active chain only see the current cwd; a
    standalone `cd X && git push` therefore still resolves to just X.
    """
    targets: list[Path] = []
    state_stack: list[set[Path]] = [{hook_cwd}]
    prev_state_stack: list[set[Path]] = [{hook_cwd}]
    pending_alts_stack: list[set[Path]] = [set()]
    last_short_stack: list[bool] = [False]
    if_stack: list[list[IfFrame]] = [[]]
    loop_stack: list[list[LoopFrame]] = [[]]

    for kind, payload in _walk_events(cmd):
        if kind == "open":
            state_stack.append(set(state_stack[-1]))
            prev_state_stack.append(set(state_stack[-1]))
            pending_alts_stack.append(set())
            last_short_stack.append(False)
            if_stack.append([])
            loop_stack.append([])
            continue
        if kind == "close":
            if len(state_stack) > 1:
                state_stack.pop()
                prev_state_stack.pop()
                pending_alts_stack.pop()
                last_short_stack.pop()
                if_stack.pop()
                loop_stack.pop()
            prev_state_stack[-1] = set(state_stack[-1])
            last_short_stack[-1] = False
            continue
        if kind == "subshell_sep":
            state_stack[-1].update(pending_alts_stack[-1])
            pending_alts_stack[-1].clear()
            state_stack[-1] = set(prev_state_stack[-1])
            last_short_stack[-1] = False
            continue
        if kind == "short":
            pending_alts_stack[-1].update(prev_state_stack[-1])
            last_short_stack[-1] = True
            continue
        seg = payload.strip()
        if not seg:
            continue
        try:
            tokens = shlex.split(seg)
        except ValueError:
            continue
        if not last_short_stack[-1]:
            state_stack[-1].update(pending_alts_stack[-1])
            pending_alts_stack[-1].clear()

        states = set(state_stack[-1])
        prev_state_stack[-1] = set(states)
        leading = _leading_control_token(tokens)
        frame_stack = if_stack[-1]
        loops = loop_stack[-1]

        if leading == "if":
            command_tokens = tokens[_command_start(tokens) or len(tokens) :]
            seg_targets, next_states, success_states, failure_states = (
                _run_tokens_for_states(command_tokens, states)
                if command_tokens
                else ([], set(states), set(states), set(states))
            )
            targets.extend(seg_targets)
            frame_stack.append(
                IfFrame(
                    success_states=success_states,
                    failure_states=failure_states,
                )
            )
            state_stack[-1] = next_states
            last_short_stack[-1] = False
            continue

        if leading == "then":
            if frame_stack:
                frame = frame_stack[-1]
                frame.phase = "then"
                states = set(frame.success_states)
                command_tokens = tokens[_command_start(tokens) or len(tokens) :]
                if command_tokens:
                    seg_targets, next_states, _, _ = _run_tokens_for_states(
                        command_tokens, states
                    )
                    targets.extend(seg_targets)
                    state_stack[-1] = next_states
                else:
                    state_stack[-1] = states
            last_short_stack[-1] = False
            continue

        if leading == "else":
            if frame_stack:
                frame = frame_stack[-1]
                if frame.phase == "then":
                    frame.after_states.update(states)
                frame.phase = "else"
                states = set(frame.failure_states)
                command_tokens = tokens[_command_start(tokens) or len(tokens) :]
                if command_tokens:
                    seg_targets, next_states, _, _ = _run_tokens_for_states(
                        command_tokens, states
                    )
                    targets.extend(seg_targets)
                    state_stack[-1] = next_states
                else:
                    state_stack[-1] = states
            last_short_stack[-1] = False
            continue

        if leading == "elif":
            if frame_stack:
                frame = frame_stack[-1]
                if frame.phase == "then":
                    frame.after_states.update(states)
                states = set(frame.failure_states)
                command_tokens = tokens[_command_start(tokens) or len(tokens) :]
                seg_targets, next_states, success_states, failure_states = (
                    _run_tokens_for_states(command_tokens, states)
                    if command_tokens
                    else ([], states, states, states)
                )
                targets.extend(seg_targets)
                frame.phase = "cond"
                frame.success_states = success_states
                frame.failure_states = failure_states
                state_stack[-1] = next_states
            last_short_stack[-1] = False
            continue

        if leading == "fi":
            if frame_stack:
                frame = frame_stack.pop()
                if frame.phase == "then":
                    frame.after_states.update(states)
                    states = frame.after_states | frame.failure_states
                elif frame.phase == "else":
                    frame.after_states.update(states)
                    states = frame.after_states
                else:
                    states = frame.after_states | frame.failure_states
                command_tokens = tokens[_command_start(tokens) or len(tokens) :]
                if command_tokens:
                    seg_targets, next_states, _, _ = _run_tokens_for_states(
                        command_tokens, states
                    )
                    targets.extend(seg_targets)
                    state_stack[-1] = next_states
                else:
                    state_stack[-1] = states
            last_short_stack[-1] = False
            continue

        if leading == "do":
            loops.append(LoopFrame(skip_states=set(states)))
            command_tokens = tokens[_command_start(tokens) or len(tokens) :]
            if command_tokens:
                seg_targets, next_states, _, _ = _run_tokens_for_states(
                    command_tokens, states
                )
                targets.extend(seg_targets)
                state_stack[-1] = next_states
            last_short_stack[-1] = False
            continue

        if leading == "done":
            if loops:
                states = set(states) | loops.pop().skip_states
            command_tokens = tokens[_command_start(tokens) or len(tokens) :]
            if command_tokens:
                seg_targets, next_states, _, _ = _run_tokens_for_states(
                    command_tokens, states
                )
                targets.extend(seg_targets)
                state_stack[-1] = next_states
            else:
                state_stack[-1] = states
            last_short_stack[-1] = False
            continue

        if leading in NOOP_CONTROL_TOKENS:
            command_tokens = tokens[_command_start(tokens) or len(tokens) :]
            if command_tokens:
                seg_targets, next_states, _, _ = _run_tokens_for_states(
                    command_tokens, states
                )
                targets.extend(seg_targets)
                state_stack[-1] = next_states
            else:
                state_stack[-1] = states
            last_short_stack[-1] = False
            continue

        seg_targets, next_states, _, _ = _run_tokens_for_states(tokens, states)
        targets.extend(seg_targets)
        state_stack[-1] = next_states
        last_short_stack[-1] = False
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
