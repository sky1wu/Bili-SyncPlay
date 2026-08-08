# AGENTS

## Purpose

- This file is for AI agents, coding assistants, and repository automations working in this codebase.
- Human contribution rules live in [CONTRIBUTING.md](./CONTRIBUTING.md) and apply here too — workflow, module boundaries, shared sources of truth, commit conventions, testing focus. This file only adds agent-specific execution constraints and decision rules.
- Hard-won runtime invariants live in [docs/reference/invariants.md](./docs/reference/invariants.md) ([中文](./docs/reference/invariants.zh-CN.md)). Read the relevant section before touching playback timing, share ownership, the shared runtime store, room-event broadcasts, or a background maintenance timer.

## Language Rules

- Agents must respond in Chinese throughout the entire interaction unless the user explicitly requests another language.

## Verification Before Claiming Done

- Never report an edit as complete without re-reading the changed region. After
  every Edit/Write, re-read the file (or grep the exact new string) to confirm
  the change actually landed — silent no-op string replacements have happened
  repeatedly.
- After any fix, run the full test suite AND typecheck before saying it works.
  Report the actual command output, not a summary. Never pipe a check into
  `tail`/`head` to judge it: the pipe reports the tail's exit code, so a failure
  reads as green.
- Never use `git checkout <file>` or `git restore <file>` to revert a probe — it
  destroys uncommitted work in that same file. Copy the file aside first (`cp`)
  and restore from the copy, or use `git stash`.
- Never use `git add -A`; stage explicit paths so build artifacts and patch
  files don't get committed.
- While iterating, prefer the smallest relevant verification command first; if
  validation was not run, say so explicitly.

## Commands

Everyday commands are the `package.json` scripts — read them from there.

**Before every commit and every push**, run in order:

```bash
npm run format:check && npm run lint && npm run typecheck && npm run build && npm test && npm run audit
```

`npm run audit` is the same dependency gate CI runs in the `verify` job. It is
not covered by `npm test`, and it can start failing without any local change
when a new advisory is published — so run it before pushing, not only after CI
turns red. Findings that do not apply to this repository go in
`audit-allowlist.json` with a reason and a mandatory expiry date.

## Architecture

Data flow: content script detects Bilibili playback changes →
`chrome.runtime.sendMessage` → background worker validates and updates room state
→ WebSocket server → broadcast to room members → their content scripts apply the
state to the video player.

`packages/protocol/` must always export through the package root to preserve
import stability.

## Protocol Changes

Checklist to run before opening any PR that touches the sync protocol. See also
the compatibility policy in [CONTRIBUTING.md](./CONTRIBUTING.md#protocol-changes).

1. Did the wire format change? If yes, bump the version — and note there are
   **two** constants that must move together, with nothing enforcing that they
   agree: `PROTOCOL_VERSION` in `packages/protocol/src/types/common.ts` (what
   the extension sends) and `CURRENT_PROTOCOL_VERSION` in
   `server/src/messages.ts` (what the server implements and reports back).
2. Grep for ALL call sites of any changed function signature, including
   `server/src/app.ts` and the `index.ts` adapters. `tsc` flags a call passing
   too few arguments (`TS2554`), but silently accepts a function that _declares_
   fewer parameters than the type it is assigned to — a callback written against
   the old signature keeps typechecking, never receives the new trailing
   argument, and drops it without a word. That is the case grep has to catch.
3. New enum values or new fields: the server accepts clients all the way down to
   `MIN_PROTOCOL_VERSION` (currently `1`), so confirm an older client's guards
   tolerate them, or gate the behaviour behind a version check.
   `MEMBER_DELTA_PROTOCOL_VERSION` in `server/src/room-event-consumer.ts` is the
   pattern to copy.
4. Update `docs/reference/protocol.md` and `docs/reference/protocol.zh-CN.md` in
   the same PR.

## Structural Constraints

- `index.ts` files: bootstrap and wiring only; extract logic to controllers/helpers/stores.
- Do not combine templates, DOM updates, business rules, and message dispatch in one file.
- Separate popup rendering, actions, and state management.
- URL normalization must stay centralized (`normalizeSharedVideoUrl`).
- Protocol types/guards must stay in `@bili-syncplay/protocol`.
- Server env parsing must stay in the server config layer.
- When a mechanism gets a second hand-written copy, extract it instead — four
  hand-rolled retry/timeout copies produced six duplicate review findings in
  #242.

## Runtime Invariants

Nothing in the type system enforces these; each cost multiple review rounds. The
reasoning, and the rest of the rules in each group, is in
[docs/reference/invariants.md](./docs/reference/invariants.md) — read the group
before changing the code it describes.

- **Playback timing** (#210, #236): never subtract a local timestamp from a
  server one; send durations across machines. A snapshot age is stamped at every
  send and never stored. Record a snapshot's arrival before it becomes
  observable, and re-check after every `await` that the state you hold is still
  current. A "the user did not cause this" marker asks about gestures over its
  own window, anchored on its own instant, with no exceptions — and is consumed,
  not merely bounded. A window constant read by two behaviours is two constants.
- **Share ownership** (#235, #242): `sharedVideo.sharedByMemberId` is a durable
  reference to a volatile identity, resolved at build time by
  `roomStateFromSessions` and never rewritten into the room. A full `room:state`
  may only be published where the room index is provably clean — for a leave that
  means waiting for `onRoomLeft` to settle _successfully_, while a room switch may
  publish on either licence (the new join seated, or `onRoomLeft` landed). A
  membership delta that moves ownership owes a full `room:state`.
- **The runtime store is write-behind** (#242): `flush()` says the queue emptied,
  `confirmWrites()` says the writes landed. Retries are paced by `retry-pacer`,
  can outlive their room (hence the room-generation pin), and a timeout answers
  the caller without cancelling the command. A shutdown step that ran out of its
  budget is DEGRADED, not failed. A join whose index write fails is aborted, not
  seated.
- **A background pass that cannot time out cannot be observed** (#261): every
  tick of `maintenance-pass` records exactly one outcome, a cap that does not
  cancel the call means a pass never runs on top of another, and `stop` waits
  for the real call but only inside its budget — reporting it when the budget
  was not enough, since that overrun used to be visible as a failed shutdown
  step. The cap belongs to the caller — the room store client still has no
  `commandTimeout`.
- **One-shot broadcasts need a retry trail** (#242): most `room_state_updated`
  sends are repeated by the next update, but the share-ownership resync and the
  runtime index reaper's announcement are not — losing one loses the room until a
  reload.

## Testing

Regression coverage is required for refactors touching: extension sync flow,
popup state and rendering, server config loading, protocol type guards, and
server room lifecycle / admin routing.

- **Every package's `test/**` must be inside `npm run typecheck`.** How each
  package satisfies that, and the fixture casts that re-open the gap, are in
  [docs/reference/invariants.md](./docs/reference/invariants.md#test-fixtures-must-not-cast-past-the-checker).
  In short: keep fixtures honest instead of casting past the checker, and never
  cast a fixture with `as unknown as <DomainType>` or `as never`.
- Every sync fix needs a regression test that FAILS on the pre-fix code — verify
  this by reverting the fix (stash it, or restore from a copy taken beforehand)
  and running the test. A test that stays green either way guards nothing.

## Debugging Sync Bugs

- Prefer a single root-cause fix over layered patches. If a fix requires adding
  a new suppression flag, cooldown, or special case on top of an existing one,
  stop and re-derive the root cause instead.
- State the hypothesis, name the exact log lines / code path that prove it, and
  confirm before writing code.

## Review Feedback Process

- After addressing review feedback, audit ALL related code paths for the same
  class of bug, not just the specific line flagged — state cleanup, error
  handling, and sibling call sites included.
- For state-cleanup/reset functions, grep for every piece of related state and verify each is handled.
- For async Redis/lock operations, always `await` and wrap in try/catch to avoid orphan locks or race conditions.
- When reviewing code, report findings first, with concrete file references and impact, before giving summary commentary.

## Git Constraints

- ALWAYS create a feature branch before making changes; NEVER push directly to `main`.
- Do not rewrite published history unless explicitly requested by the repository maintainer.
- Keep formatting-only changes separate from behavior changes whenever practical.
- Do not mix unrelated refactors, docs updates, and feature or bug-fix changes in a single commit when they can be reviewed independently.
- Prefer small, reviewable commits that preserve behavior at each step of a refactor.
- Commit message conventions are in [CONTRIBUTING.md](./CONTRIBUTING.md#commit-conventions); notably, do not hide behavior changes inside `chore:` or `docs:`.

## Agent Execution Rules

- Do not perform destructive git operations such as `git reset --hard`, force-pushes, or overwriting unrelated uncommitted user changes unless explicitly requested.
- Do not change secrets, `.env` files, release credentials, or production deployment settings unless explicitly requested.
- Do not update versions, lockfiles, or release artifacts unless the task clearly requires it.
- Keep changes scoped to the task. Avoid opportunistic edits in unrelated files.
- When code changes affect developer workflow, architecture, or shared rules, update the relevant documentation files in the same change.
