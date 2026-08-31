# AGENTS

## Purpose

- For AI agents, coding assistants, and repository automations working in this
  codebase. [CONTRIBUTING.md](./CONTRIBUTING.md) applies here too — this file
  only adds agent-specific execution constraints and decision rules.
- Keep it short: it loads into every agent's context. Budget **200 lines**, one
  to four lines per rule. Longer reasoning goes to `docs/reference/` behind a
  link; do not restate here what a linked doc already says.
- Runtime invariants live in
  [docs/reference/invariants.md](./docs/reference/invariants.md)
  ([中文](./docs/reference/invariants.zh-CN.md)) — read the relevant section
  before touching playback timing, share ownership, the shared runtime store,
  room-event broadcasts, or a background maintenance timer.

## Language Rules

- Agents must respond in Chinese throughout the entire interaction unless the
  user explicitly requests another language.

## Verification Before Claiming Done

- Re-read the changed region after every Edit/Write (or grep the exact new
  string) before reporting it done — silent no-op replacements keep happening.
- After any fix, run the full test suite AND typecheck, and report the actual
  output. Never judge a check through `| tail`/`| head`: the pipe returns the
  tail's exit code, so a failure reads as green.
- Revert a probe with a `cp` copy taken beforehand or `git stash` — never
  `git checkout <file>` / `git restore <file>`, which destroys uncommitted work
  in that same file.
- Never `git add -A`; stage explicit paths.
- Prefer the smallest relevant verification command while iterating; if
  validation was not run, say so explicitly.

## Commands

Everyday commands are the `package.json` scripts — read them from there.
**Before every commit and every push**, run in order:

```bash
npm run format:check && npm run lint && npm run typecheck && npm run build && npm test && npm run audit
```

`npm run audit` is CI's `verify` dependency gate; `npm test` does not cover it,
and a new advisory can turn it red with no local change — so run it before
pushing, not after CI does. Inapplicable findings go in `audit-allowlist.json`
with a reason and a mandatory expiry date.

## Architecture

Content script detects Bilibili playback changes → `chrome.runtime.sendMessage`
→ background worker validates and updates room state → WebSocket server →
broadcast to room members → their content scripts apply it to the video player.

## Protocol Changes

Checklist for any PR touching the sync protocol; compatibility policy is in
[CONTRIBUTING.md](./CONTRIBUTING.md#protocol-changes).

1. Wire format changed? Bump **both** constants — nothing enforces that they
   agree: `PROTOCOL_VERSION` (`packages/protocol/src/types/common.ts`, what the
   extension sends) and `CURRENT_PROTOCOL_VERSION` (`server/src/messages.ts`,
   what the server implements and reports).
2. Grep ALL call sites of a changed signature, including `server/src/app.ts` and
   the `index.ts` adapters. `tsc` catches a call with too few arguments
   (`TS2554`) but silently accepts a function that _declares_ fewer parameters
   than the type it is assigned to — that callback keeps typechecking, never
   receives the new trailing argument, and drops it without a word. Only grep
   catches this one.
3. New enum values or fields: the server accepts clients down to
   `MIN_PROTOCOL_VERSION` (currently `1`), so confirm an old client's guards
   tolerate them or gate on a version check — copy
   `MEMBER_DELTA_PROTOCOL_VERSION` (`server/src/room-event-consumer.ts`).
4. Update `docs/reference/protocol.md` and `protocol.zh-CN.md` in the same PR.

## Structural Constraints

- Keep entry files thin: `index.ts` is bootstrap and wiring, logic goes to
  controllers/helpers/stores. No file mixing templates, DOM updates, business
  rules and message dispatch; popup rendering, actions and state stay separate.
- Stays centralized: URL normalization (`normalizeSharedVideoUrl`), protocol
  types/guards in `@bili-syncplay/protocol` (exported through the package root),
  server env parsing in the server config layer.
- Extract a mechanism at its SECOND hand-written copy — four hand-rolled
  retry/timeout copies produced six duplicate review findings in #242.

## Runtime Invariants

Nothing in the type system enforces these; each cost multiple review rounds.
These are the one-line versions — reasoning and code references are in the
linked section, and that is where new detail goes, not here.

- **[Playback timing](./docs/reference/invariants.md#playback-timing-invariants)**
  (#210, #236) — never subtract a local timestamp from a server one; send
  durations across machines. Stamp a snapshot's age at every send, record its
  arrival before it becomes observable, re-check after every `await`. A "the
  user did not cause this" marker is consumed, not merely bounded, and a window
  constant read by two behaviours is two constants.
- **[Whether the address bar names the video is a per-route property](./docs/reference/invariants.md#whether-the-address-bar-names-the-video-is-a-per-route-property)**
  (#274, #291) — `ss` / festival routes name no episode, so the page snapshot
  outranks the address bar; an `ep` route is authoritative and every in-page
  source is the one that can be stale. Staleness is answered for **all** page
  sources at once: chase the whole equivalence class in one pass, and prove the
  regression on both polarities.
- **[Share ownership is derived](./docs/reference/invariants.md#share-ownership-is-derived-and-deltas-do-not-carry-it)**
  (#235, #242) — `sharedVideo.sharedByMemberId` is resolved at build time and
  never rewritten into the room; a full `room:state` may only be published where
  the room index is provably clean, and a delta that moves ownership owes one.
- **[The runtime store is write-behind](./docs/reference/invariants.md#the-runtime-store-is-write-behind-so-drained-never-means-written)**
  (#242) — `flush()` says the queue emptied, `confirmWrites()` says the writes
  landed. A timeout answers the caller without cancelling the command; retries
  can outlive their room (hence the room-generation pin); a shutdown step out of
  budget is DEGRADED, not failed.
- **[A background pass that cannot time out cannot be observed](./docs/reference/invariants.md#a-background-pass-that-cannot-time-out-cannot-be-observed)**
  (#261, #263) — exactly one outcome per tick, a cap that does not cancel the
  call so no pass runs on top of another, and a `stop` that waits for the real
  call inside its budget and reports when that budget was not enough.
- **[An unbounded write queue turns a stalled dependency into a growing one](./docs/reference/invariants.md#an-unbounded-write-queue-turns-a-stalled-dependency-into-a-growing-one)**
  (#264, #266) — a per-write cap and a depth limit, neither substituting for the
  other; past either, appends are shed and answer successfully. Report the
  failure as facts (a counter), never as a start/end span, and never route the
  report through the thing it reports on: **a pattern's guarantee comes from its
  precondition, not from its shape.**
- **[Which record may be shed is a property of the record](./docs/reference/invariants.md#which-record-may-be-shed-is-a-property-of-the-record-not-of-the-queue)**
  (#267) — event store and audit store share the four bounds in
  `admin/append-chain.ts` and differ only in `onRefused`; a shutdown step's
  budget belongs to the step, not to one component inside it.
- **[Two layers bound a Redis command, and they do not compose](./docs/reference/invariants.md#two-layers-bound-a-redis-command)**
  (#271, #277) — a **deadline** is per-behaviour, derived from what its caller
  can promise, and decides what happens next; `commandTimeout` is a **liveness
  backstop** that decides nothing and settles the very calls whose silence other
  bounds are built on. Which bound applies is a property of the CALL, not the
  method. Cap the caller's WAIT and keep the effect — an effect that must keep
  going may not be built out of capped calls, and conditionality makes a late
  landing safe to HAVE happened without discharging what the write's SUCCESS
  owes. Nothing is unbounded on either connection; keep it that way.
- **[One-shot broadcasts need a retry trail](./docs/reference/invariants.md#one-shot-broadcasts-need-a-retry-trail-repeated-ones-do-not)**
  (#242) — the share-ownership resync and the runtime index reaper's
  announcement are not repeated by the next update; losing one loses the room
  until a reload.

## Testing

- Regression coverage required for: extension sync flow, popup state and
  rendering, server config loading, protocol type guards, server room lifecycle
  and admin routing.
- **Every package's `test/**` must be inside `npm run typecheck`**; keep
  fixtures honest instead of casting past the checker — never
  `as unknown as <DomainType>` or `as never`
  ([details](./docs/reference/invariants.md#test-fixtures-must-not-cast-past-the-checker)).
- Every sync fix needs a regression test that FAILS on the pre-fix code — prove
  it by reverting the fix and running the test. A test that stays green either
  way guards nothing.

## Debugging Sync Bugs

- State the hypothesis and name the exact log lines / code path that prove it,
  and confirm, before writing code.
- One root-cause fix beats layered patches: if a fix needs a new suppression
  flag, cooldown or special case stacked on an existing one, stop and re-derive
  the root cause.

## Review Feedback Process

- Report findings first, with concrete file references and impact, before any
  summary commentary.
- After addressing feedback, audit ALL paths with the same class of bug, not the
  flagged line only — sibling call sites, error handling, and state cleanup
  (grep every piece of related state and verify each reset handles it).
- Always `await` async Redis/lock work inside try/catch, or an orphan lock is
  the failure mode.

## Git And Execution Constraints

- ALWAYS branch before making changes; NEVER push to `main`, and never rewrite
  published history unless the maintainer asks.
- No destructive git operations (`git reset --hard`, force-push, overwriting
  unrelated uncommitted changes) unless explicitly requested.
- Do not touch secrets, `.env`, release credentials or deployment settings, and
  do not bump versions, lockfiles or release artifacts, unless the task requires
  it.
- Keep changes scoped to the task; no opportunistic edits in unrelated files.
- Small commits that preserve behavior at each step: formatting-only changes stay
  out of behavior commits, unrelated refactors/docs/fixes are not mixed when they
  can be reviewed apart, and prefixes follow
  [CONTRIBUTING.md](./CONTRIBUTING.md#commit-conventions) — never hide a behavior
  change in `chore:` or `docs:`.
- When a change affects developer workflow, architecture or shared rules, update
  the relevant docs in the same change.
