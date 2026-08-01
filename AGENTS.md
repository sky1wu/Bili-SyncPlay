# AGENTS

## Purpose

- This file is for AI agents, coding assistants, and repository automations working in this codebase.
- Human contribution rules live in [CONTRIBUTING.md](./CONTRIBUTING.md). This file only adds agent-specific execution constraints and decision rules.

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

## Language Rules

- Agents must respond in Chinese throughout the entire interaction unless the user explicitly requests another language.

## Commands

Everyday commands are the `package.json` scripts — read them from there.

**Before every commit**, run in order:

```bash
npm run format:check && npm run lint && npm run typecheck && npm run build && npm test && npm run audit
```

`npm run audit` is the same dependency gate CI runs in the `verify` job. It is
not covered by `npm test`, and it can start failing without any local change
when a new advisory is published — so run it before pushing, not only after CI
turns red. Findings that do not apply to this repository go in
`audit-allowlist.json` with a reason and a mandatory expiry date.

## Architecture

### Data Flow

1. Content script detects Bilibili video playback changes
2. Sends to background service worker via `chrome.runtime.sendMessage`
3. Background worker validates, updates room state, forwards to WebSocket server
4. Server broadcasts to all room members
5. Other clients receive the message and apply playback state to their video player

### Protocol Package (`packages/protocol/`)

Always export through the package root to preserve import stability.

## Protocol Changes

Checklist to run before opening any PR that touches the sync protocol:

1. Did the wire format change? If yes, bump the version — and note there are
   **two** constants that must move together, with nothing enforcing that they
   agree: `PROTOCOL_VERSION` in `packages/protocol/src/types/common.ts` (what
   the extension sends) and `CURRENT_PROTOCOL_VERSION` in
   `server/src/messages.ts` (what the server implements and reports back).
2. Grep for ALL call sites of any changed function signature, including
   `server/src/app.ts` and the `index.ts` adapters. Know exactly where the
   compiler stops helping: it _does_ flag a call that passes too few arguments
   (`TS2554`), including inside an adapter that forwards. What it accepts
   silently is a function that _declares_ fewer parameters than the type it is
   assigned to — a callback written against the old signature keeps
   typechecking, never receives the new trailing argument, and drops it without
   a word. That is the case grep has to catch, because `tsc` never will.
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

### Playback timing invariants

These three cost four review rounds on #210 between them. Nothing in the type
system enforces any of them, so they have to be checked by hand whenever a
background path touches room state or playback timing.

- **Never subtract a local timestamp from a server one.** `serverTime` belongs to
  the server's clock; a local timestamp belongs to this machine's. Their
  difference is the clock disagreement, which is not a duration and drifts on its
  own — a receiver aiming at it wobbles the playback rate forever. Extrapolate
  playback from a local monotonic anchor instead (`clock-controller`), and to send
  an age across machines send a _duration_, never a timestamp. Comparing two
  server timestamps to each other is fine (version ordering); comparing two local
  ones is fine (elapsed).
- **A snapshot age is computed at every send and never stored.** `room:state`
  carries `playbackAgeMs` so a client joining mid-playback knows how stale the
  snapshot it was handed already is (`withPlaybackAge` on the server,
  `resolvePlaybackAnchorAtMs` on the receiver). An age is only true at the instant
  it is sent, so storing one turns it back into a timestamp — which is why it
  lives on the `room:state` payload and not on `PlaybackState`, the shape the
  server persists and clients send back. Every `room:state` send site must stamp
  it (there are four: bootstrap, `sync:request`, and two in
  `room-event-consumer`), and the extension strips it before the state reaches
  storage or a member-delta rewrap.
- **Record a playback snapshot's arrival before the snapshot is observable.** Once
  it is in `roomSessionState.roomState`, a rehydrating content script
  (`content:get-room-state`) can read it and a member join/leave can rewrap it,
  and whichever path compensates first would otherwise anchor it at _its_ moment
  and lose everything the room played before that. `markPlaybackArrival` must run
  before the write and before any `await`. Serializing socket messages would not
  cover this: those readers arrive on the `chrome.runtime` channel, not the socket.
- **After any `await`, confirm the room state you hold is still the current one
  before compensating or delivering it.** Handlers are started per socket message
  with `void handleServerMessage(...)` and do not serialize, so a newer state can
  take over while one awaits (`ensureSharedVideoOpen` may open a tab). A
  superseded snapshot must be dropped, not delivered: the content script's
  staleness check is per actor (`lastAppliedVersionByActor`), so an overtaken
  snapshot from a _different_ member is accepted and moves playback backwards.
  `handleRoomStateMessage`, `applyRoomMemberState` and
  `expireBootstrapRoomStateWait` each carry this check; a new delivery path needs
  its own.

### Share ownership is derived, and deltas do not carry it

`sharedVideo.sharedByMemberId` is written once, at `video:share`, and is a
durable reference to a volatile identity — the sharer's seat. #235 is what
happens when it dangles: nobody computes `isLocalSharedSource()`, so nobody
advances the room. Two rules keep it working, neither enforced by a type:

- **Resolve at build, never rewrite the room.** `roomStateFromSessions` is the
  single place `sharedVideo` reaches a client, and the only place the stored id
  is reconciled with the live member list (`resolveSharedVideoOwnerId`). A new
  `room:state` build site must go through it. The persisted room keeps the
  original id on purpose: it is the _preferred_ owner, so a sharer whose socket
  merely blipped reclaims the share on reconnect instead of losing it for good.
- **A membership delta that moves ownership owes a full `room:state`.**
  Protocol >= 2 clients get `room:member-joined` / `room:member-left`, which edit
  the recipient's member list and nothing else — their cached `sharedVideo` still
  names whoever the last full state named. `leaveRoom` publishes an extra
  `room_state_updated` when `needsRoomStateResync`, and the join path does the
  same when the joiner turns out to own the share in the bootstrap state it was
  just sent. Neither check may be replaced by a shortcut that reasons about
  `joinedAt` ordering: that value is stamped by whichever node handled the join,
  so it is a cross-node clock comparison and can reorder members. The tenure
  rule exists to keep ownership from reshuffling on every arrival, nothing more.

## Engineering Constraints

- Repository-wide contribution and refactoring constraints are defined in [CONTRIBUTING.md](./CONTRIBUTING.md).
- When working on structural changes, follow `CONTRIBUTING.md` as the primary source of truth for workflow, module boundary, shared source, and regression test expectations.

## Git Constraints

- ALWAYS create a feature branch before making changes; NEVER push directly to `main`.
- Do not rewrite published history unless explicitly requested by the repository maintainer.
- Before every `git push`, run `npm run format:check` and the full pre-commit check sequence to avoid CI failures.
- Before committing changes, run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, and `npm run audit`.
- Keep formatting-only changes separate from behavior changes whenever practical.
- Do not mix unrelated refactors, docs updates, and feature or bug-fix changes in a single commit when they can be reviewed independently.
- Prefer small, reviewable commits that preserve behavior at each step of a refactor.

## Commit Conventions

- Prefer Conventional Commit style prefixes such as `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, and `ci:`.
- Keep the subject line concise and focused on the primary change in that commit.
- A single commit should represent one reviewable unit of change.
- Do not hide behavior changes inside `chore:` or `docs:` commits.
- Use `refactor:` only when behavior is intended to stay unchanged; if behavior changes, use a more accurate prefix.

## Review Feedback Process

- After addressing review feedback, re-verify related code paths for similar issues (e.g., state cleanup, error handling) before declaring the fix complete.
- When addressing Codex/reviewer feedback, audit ALL related code paths for the same class of bug, not just the specific line flagged.
- For state-cleanup/reset functions, grep for every piece of related state and verify each is handled.
- For async Redis/lock operations, always `await` and wrap in try/catch to avoid orphan locks or race conditions.

## Testing Focus

Refactors touching these areas require regression coverage:

- Extension sync flow
- Popup state and rendering flow
- Server config loading
- Protocol validation (type guards)
- Server room lifecycle and admin routing

### Test directories are inside typecheck

The rule is: **every package's `test/**` must be inside `npm run typecheck`.**
Otherwise a signature change that misses a test call site passes the gate
silently — and can hide the behaviour regression the missed argument causes
(`#210` / `#211`). How a package satisfies it depends on whether src and tests
can share one compiler configuration:

- `protocol`, `server`, `extension` need a second project, because their tests
  need `node` types (and `server`'s reach into `bench/`) that the src build must
  not carry. Their `typecheck` runs `tsconfig.json` then `tsconfig.test.json`.
- `admin-ui` needs no second project: its `tsconfig.json` already includes
  `test` (its src is browser code compiled by Vite, so no split is required).

A new package picks whichever applies — do not add an unnecessary
`tsconfig.test.json` just to match the majority.

Keep fixtures honest rather than casting past the checker: a fixture that no
longer matches its type usually means the type moved (a field was renamed,
removed, or became required), and the fix belongs in the fixture. Three casts to
avoid specifically, because each re-opens the gap this gate exists to close:

- `as unknown as <DomainType>` / `as never` on a fixture (`RoomState`,
  `PlaybackState`, `Session`, `RoomStore`) — it silences exactly the
  missing-required-field error you want to see.
- A stub satisfying an unconstrained `<T>(…) => Promise<T>` via `as T`. No value
  inhabits every `T`, so the cast is unconditional.
- A stub satisfying a contract that lumps several request/response pairs into
  one all-optional response type. `{}` then satisfies everything and nothing is
  checked — `#211` shipped this mistake once before catching it.

When a callback serves one request/response pair, declare that pair. When it
serves several, split it into one callback per pair (`sendPlaybackUpdate` /
`requestRoomStateHydration`) rather than widening the response. When the payload
genuinely cannot be modelled and must be runtime-guarded anyway, declare
`Promise<unknown>` and let the guard narrow it. If a consumer only touches part
of a large interface, its parameter should say so (`Pick<RoomStore,
"countRooms">`) — that removes the fake's need to cast at all.

`as unknown as T` is fine for genuinely unfakeable platform/library objects
(`ws.WebSocket`, `chrome.tabs.Tab`, `HTMLVideoElement`, `IncomingMessage`);
prefer one shared constructor over per-call-site casts.

## Debugging Sync Bugs

- Prefer a single root-cause fix over layered patches. If a fix requires adding
  a new suppression flag, cooldown, or special case on top of an existing one,
  stop and re-derive the root cause instead.
- State the hypothesis, name the exact log lines / code path that prove it, and
  confirm before writing code.
- Every sync fix needs a regression test that FAILS on the pre-fix code — verify
  this by reverting the fix (stash it, or restore from a copy taken beforehand)
  and running the test. A test that stays green either way guards nothing.

## Agent Execution Rules

- Do not perform destructive git operations such as `git reset --hard`, force-pushes, or overwriting unrelated uncommitted user changes unless explicitly requested.
- Do not change secrets, `.env` files, release credentials, or production deployment settings unless explicitly requested.
- Do not update versions, lockfiles, or release artifacts unless the task clearly requires it.
- While iterating, prefer the smallest relevant verification command first; if validation was not run, say so explicitly. Claiming a change works is a different bar — see [Verification Before Claiming Done](#verification-before-claiming-done).
- Keep changes scoped to the task. Avoid opportunistic edits in unrelated files.
- When code changes affect developer workflow, architecture, or shared rules, update the relevant documentation files in the same change.
- When reviewing code, report findings first, with concrete file references and impact, before giving summary commentary.
