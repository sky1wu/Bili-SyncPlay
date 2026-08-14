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
- **Whether the address bar names the video is a per-route property** (#274):
  `/festival/` and `/bangumi/play/ssNNN` name no episode, so the page snapshot
  outranks the address bar there — but `/bangumi/play/epNNN` names the episode
  itself, and an in-page switch moves the address bar _before_ the page globals,
  so there every in-page source is the one that can be stale. Using an identity
  takes confirmation (`lacksAddressBarEpisodeConfirmation`; a `bvid:cid` snapshot
  names no episode, and rejecting it is free because the address bar answers
  completely); an unconfirmed snapshot means "not resolved yet", but explicit
  sharing on a stable `ep` route uses that authoritative address bar immediately.
  `resolveCurrentSharePayload` retries only on `ss` / festival routes, where a
  page snapshot is indispensable. Staleness is a separate
  question answered for **all** page sources at once by `markStalePageRecords` —
  seeded on a contradiction, propagated through records sharing an episode id,
  cid, or title key, with confirmed records immune — and a stale source is
  emptied whole rather than filtered downstream. Answering it per source is what
  brought this defect back six review rounds running: each fix cut the link
  carrying the proof and the next source rebuilt the same wrong answer. **Chase
  the whole equivalence class in one pass.** A regression on one polarity proves
  nothing about the other — every bangumi test used a `ss` page, which is why
  this shipped. A synchronous media event does not make identity synchronous:
  natural-end handling uses a fresh page-bridge read only for unstable `ss` /
  festival identities, shares the adjacent `pause` / `ended` read with
  concurrent playback broadcasts from the same page visit, starts that read
  inside the media event task, and makes an `ended` that already sees the next
  `ep` join it. Only that event read retains its originating unstable visit; an
  arriving navigation joins it before advancing the page baseline or resetting
  playback generations, and a newer destination read cannot cancel its delivery
  or let its old result overwrite the newer cache. Then carry the confirmed
  identity through the terminal flush without reading mutable page state again
  or applying a post-navigation mutable-identity gate to it. Keep the event-time
  anchor and revalidate the structural playback context after awaiting. A later
  gesture is classification evidence, not a new lifecycle; arming suppression at
  the bridge reply would hide that evidence. A stable `ep` identity stays
  address-bar-authoritative (#291).
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
- **A background pass that cannot time out cannot be observed** (#261, #263):
  every tick of `maintenance-pass` records exactly one outcome, a cap that does
  not cancel the call means a pass never runs on top of another, and `stop`
  waits for the real call but only inside its budget — reporting it when the
  budget was not enough, since that overrun used to be visible as a failed
  shutdown step. The cap is derived from what a late pass costs (the heartbeat's
  from `NODE_HEARTBEAT_TTL_MS`), and belongs to the caller — a connection-wide
  `commandTimeout` answers a different question and cannot stand in for it.
- **An unbounded write queue turns a stalled dependency into a growing one**
  (#264): `redis-event-store`'s append chain is fed by every log line, so it
  needs both a per-write cap and a depth limit — neither substitutes for the
  other. Past either, appends are shed and answer successfully, because
  rejecting means one stdout error line per log line. The cap does not release
  the chain; a read past the cap is REFUSED, not delayed, because the fix for an
  unbounded queue is never a bound on how long you wait for it; and `close`
  drains inside a budget and then `disconnect()`s — `QUIT` is a command on the
  same ordered queue, so it inherits the wait it was meant to escape. One
  connection with in-order replies is the limit of all of this, and a fixture
  that does not model it will prove things that are not true.
- **Report a failing dependency as facts, not as an incident** (#266): the drop
  counter answers "still happening?" and "how much?" statelessly; a start/end
  log pair is a span whose invariant nothing in a log stream can enforce, and
  four review rounds went to finding states that broke it. `maintenance-pass`
  may pair because a timer makes each tick discrete — **a pattern's guarantee
  comes from its precondition, not from its shape**. And reporting must not
  route through the thing it reports on.
- **Which record may be shed is a property of the record** (#267): the audit
  store has the same chain as the event store and the opposite answer, so the
  four bounds live in `admin/append-chain.ts` and only the `onRefused` handler
  differs — an audit record is an accountability record, and its refusal is
  affordable only because admin actions feed it at human rate. It needs no new
  counter: `events_total{event="admin_audit_log_append_failed"}` already answers
  both questions. And a shutdown step's budget belongs to the step, not to a
  component in it — `close_admin_services` also closes the admin session store,
  which runs first, so bounding one half fixes nothing.
- **Two layers bound a Redis command, and they do not compose** (#271): a
  **deadline** is per-behaviour, derived from what its caller can promise, and
  decides what happens next; `commandTimeout` is a **liveness backstop** — one
  question, one magnitude, and it decides nothing. Nearly every deadline here is
  built on "the cap does not cancel, so the call stays tracked, and its silence
  is what stops the next attempt" (`ensurePendingCapacity`, `maintenance-pass`'s
  `stalled`, `pending-resync-queue`'s in-flight wait, `writeIsStalled`), and a
  backstop SETTLES those calls — turning each bound into a rate of one more
  command per timeout. So the criterion is not "already bounded" but **no caller
  on this connection derives a bound from a command's silence**: three qualify,
  five do not. `createBoundedRedisClient` requires the declaration and a
  caller-side one must NAME the deadline; `redis-client-bounds.test.ts` keeps
  `new Redis` in one module and makes exempt connections open through
  `connectWithin`, since no per-command deadline reaches the handshake. The
  backstop bounds the caller's wait and not ioredis's queue, so no depth limit
  retires because of it; and bounded still owes a report: 503 with a diagnosis,
  never 401, never a cleanup rejection thrown over a real result, and never a
  precondition nobody enforces.
- **Exempt did not mean fine, and the fix is a cap that keeps the call tracked**
  (#277): both stores' request paths had no bound at all, so a stalled Redis hung
  a WebSocket join in silence. `boundCommand` (`capAttempt` + admission) answers
  the caller while the command stays tracked, so no bound above loses its
  evidence and no declaration moved. **Which bound applies is a property of the
  CALL, not the method** — `loadSession` and `readRoomBody` are each reached from
  a request AND from a maintenance pass, so the bound is passed in and the
  pass-driven callers pass `boundedByOuterCaller`; capping those would make
  `stalled` unreachable. Per command, never per operation (`getRoom` reads one
  session per member). A request that merely joins a background pass bounds its
  own WAIT, absorbing the pass's rejection so it cannot end the process. A
  command whose effect may still land keeps the established `error` status and
  reports the additive typed `confirmation=unconfirmed` marker; callers never
  infer that fact from an open-ended list of error codes, and result-publish
  retries resend the exact executor result rather than rewriting transport
  failure as execution failure. Atomic member eviction owns its terminal
  logging independently of that wait, and its block deadline is a monotonic
  maximum so cross-node retries commute. That effect ownership includes close:
  shut the dispatch gate before unsubscribe can wait, and drain accepted
  handlers plus late evictions inside one shared budget; report what remains
  instead of relying on a later store close to do it implicitly. Runtime room
  teardown follows the same two-lifetime rule one layer up: its generation is
  mandatory (there is no wildcard delete), one real effect per room generation
  remains tracked through every local mirror, and every request waiting on that
  exact effect shares one confirmation cap. Maintenance callers keep awaiting
  the real effect so `stalled` remains observable; the request deadline is its
  own constant rather than the Redis connection's liveness backstop. Retry debt
  is assigned only when the latest exact effect is created (or has no owner
  while awaiting a fresh attempt); a waiter reusing an effect never transfers
  ownership. The generation pinned before the room read is confirmed again
  after that await before any effect can be created or reused. Each pending debt
  is also a unique record: a maintenance candidate snapshots that identity and
  re-checks it after all precondition awaits, so a debt settled meanwhile
  cannot be recreated. Thus a newer generation's success or a live persisted
  room supersedes older effects whose late skip/failure must not retain or
  resurrect the debt.
  Still open on purpose: the five durable writes, where
  #237's trade holds because their effects — unlike a lock's or a dedup slot's
  — do not expire. The former
  standalone `blockMemberToken` had no production caller and was removed rather
  than kept as another unbounded path beside atomic eviction; the room store's
  unused unconditional `saveRoom` write was removed for the same reason.
  Three more the review round added: **a refusal cap must never be reachable by
  ordinary fan-out** (every read that maps over a deployment-sized collection
  goes through a waiting limiter sized under admission, placed at the fan-out
  and not inside the bound, or the limiter grows its own unbounded queue);
  **a bound must not leave its function synchronously** (a sibling in the same
  `Promise.all` literal is then issued with nobody to handle it — a process exit
  on Node 22); and **Node's `requestTimeout` bounds receiving a request, not
  producing its response**, so "at least the HTTP server bounds it" is never an
  argument.
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
