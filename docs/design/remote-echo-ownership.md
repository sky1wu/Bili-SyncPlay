# Design: remote playback ownership replaces the fixed echo window

**Describes the code as of `a4c4045` (2026-07-27).** No implementation is bound to this
document and no CI check guards it, so the constants and code paths it names
(`REMOTE_ECHO_SUPPRESSION_MS = 700`, the 2s `onTimeUpdate` heartbeat, the
`rememberExplicitUserAction` gate) can drift out of date without anything failing.
Check them against the source before relying on them.

**Status: problem analysis and constraints. Not an implementable design, not implemented.**

What is solid here: the problem (§1–2), the contamination sources (§4), and the timing traps
and process lessons an implementation attempt paid for (§7). What is not: the direction
sketched in §3, which still carries six unresolved questions (§3.1) — including one where
its own safety net contradicts the document's central claim.

This note records the design trade-offs behind moving the extension's echo suppression
from a _fixed time window_ to an _ownership marker_. It is the follow-up to
[#220](https://github.com/sky1wu/Bili-SyncPlay/pull/220): that PR fixed the server-side
amplifier, this one fixes the root cause.

## 1. Background: an autoplay-next that stuck at paused

After the sharer's autoplay advanced to the next video, the new video sat at its
remembered position (49s) without starting, so the room state was legitimately `paused`.
A peer hard-seeking across to that position took longer to buffer than the extension's
700ms echo-suppression window, and therefore leaked **the remote `paused` it had just
applied** back into the room as its own local state — twice. The server recorded that as
a pause authority, and the sharer's seven subsequent `playing` updates were all dropped
as `authority-window-follow`.

Result: the room stuck at paused with nobody having paused anything.

## 2. Today: three fixed time windows

| Mechanism                                               | Constant                                 | Responsibility                                                                | Expiry      |
| ------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------- | ----------- |
| `programmaticApplyUntil` + `programmaticApplySignature` | `PROGRAMMATIC_APPLY_WINDOW_MS = 700`     | Suppress events emitted **synchronously as apply writes the DOM**             | after 700ms |
| `suppressedRemotePlayback`                              | `REMOTE_ECHO_SUPPRESSION_MS = 700`       | Suppress a broadcast whose local state matches the remote state just received | after 700ms |
| `recentRemotePlayingIntent`                             | `REMOTE_PLAY_TRANSITION_GUARD_MS = 1800` | Suppress the local play transition a remote `playing` causes                  | on expiry   |
| `remoteFollowPlayingUntil`                              | `REMOTE_FOLLOW_PLAYING_WINDOW_MS = 3000` | Mark "currently following remote playback"                                    | on expiry   |
| `pauseHoldUntil`                                        | `PAUSE_HOLD_MS = 1200`                   | Briefly hold back a local play after applying a remote paused                 | on expiry   |

All of them expire on wall-clock time, regardless of whether the DOM event actually
arrived. Anything that delays a transport event past the window leaks an echo: buffering
on a cross-video hard seek, weak networks, background-tab timer throttling, or Bilibili
rebuilding the `<video>` element to recover from a stall.

**Widening the constant is not the fix.** Every extra millisecond of window is an extra
millisecond in which a genuine user action can be swallowed, and a swallowed user action
fails silently — harder to diagnose than a leaked echo. 700ms is a compromise wedged
between two failure modes; moving it either way trades one for the other.

## 3. Explored direction: an ownership marker

> **This section is not an implementable design.** It is the direction that was explored,
> recorded because the reasoning behind it is worth keeping — not because it is ready to
> build. Every decision procedure below has at least one unresolved question, listed in
> §3.1. Three reviews of this document found the section still contradicting itself in
> places; treat it as a starting point for a design, not as one.

When a remote playback state is applied, record that the state **belongs to the remote**:

```ts
interface RemoteAppliedPlayback {
  url: string; // owning video (normalized)
  playState: "paused" | "buffering"; // stop-like only — see the split below
  currentTime: number;
  playbackRate: number;
  actorId: string;
  seq: number;
  appliedAtLocal: number; // wall clock; only ever compared against gesture timestamps
  appliedAtMonotonic: number; // monotonic; the only domain durations are measured in
}
```

The rule: if a local event reports `(playState, currentTime, playbackRate)` matching the
owned values (within tolerance), it is an echo and is suppressed — **however long ago the
apply happened**. `playState` matches on stop-likeness rather than exact equality:
`paused` and `buffering` are the same standstill seen at different moments, the late
`waiting`/`pause` chain a remote paused hard-seek produces is classified as `buffering`,
and the server files both under the same pause authority.

Ownership is taken **twice per applied state**, and both are load-bearing:

- once as soon as the state is known not to be stale, ahead of the noop and cooldown
  branches that return without writing. Those branches skip the write because the local
  player already matches, but a superseded ownership must still be replaced there, or a
  stale `paused` ownership outlives a newer `playing` the local player already agreed with;
- once the adjustment is actually written to the element, which restamps both timestamps.
  A state waiting on `loadedmetadata`/`canplay` can sit pending for a long time on a weak
  network or a throttled tab, and the protection has to run from the write, not the
  receipt — otherwise the backstop can elapse before the write it covers even happens.

The room echoing back **our own state** is never owned. That is an acknowledgement, not an
instruction: a later local report of it is a retry, not an echo, and the duplicate window
decides whether it goes out. Owning it would silence exactly the repeats that exist because
a send may have been dropped by the background, the socket, or the server's rate limiter —
all of which are silent.

The marker does not expire on time. It is cleared only by:

| #   | Clearing condition                                                                               | Rationale                                                        |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| C1  | A playback action whose authenticating gesture was **inside the player** and postdates the apply | The user took over; everything after is local intent             |
| C2  | Local state diverges from the owned values in a way the remote cannot explain                    | The player moved on its own (start-up, jump) — no longer an echo |
| C3  | A newer remote state arrives                                                                     | Straight replacement                                             |
| C4  | Shared video switch / room reset / `<video>` rebind                                              | The context is gone                                              |

**C1 must be evaluated first**, otherwise user actions get swallowed — and it needs _both_
halves of the evidence, because each alone is too weak:

- The playback action alone is not enough. `rememberExplicitUserAction` accepts an action
  whenever any recent **document-level** gesture exists, which is the right call for the
  broadcast paths but far too loose to release a protection: a click on blank page area
  while a remote paused hard-seek is still buffering would let the late `seeked` pose as
  the user taking over.
- An in-player gesture alone is not enough either: volume, settings and danmaku controls
  all live inside the player container and express nothing about playback.

A first attempt at this — recording the most recent in-player gesture on the action
(`inPlayerGestureAt`) and requiring it to postdate the apply — **is not sufficient, and must
not be copied.** Two timestamps both being recent does not make them the same interaction:
an in-player volume click from seconds ago gets copied onto an action that a _newer_
document-level gesture authenticated, manufacturing provenance that never existed (trap 6
in §7). C1 then releases and the late echo leaks — the exact failure this design exists to
prevent.

**C1 requires proof that the gesture and the action belong to one interaction, not merely
that both are recent.** Comparing timestamps cannot establish that. A workable direction:
give each recorded gesture a monotonically increasing id, have `rememberExplicitUserAction`
record the id of the gesture it authenticated on, and let C1 require that this id belongs to
an in-player gesture postdating the apply. Whatever the mechanism, the acceptance criterion
is that the gesture which authenticated _this_ action was itself in-player.

This is specified but unvalidated: no implementation has demonstrated it. One residual case
is accepted by design even so — a genuine in-player volume adjustment that does authenticate
a playback action still releases. That only ends ownership early, degrading to the
pre-existing 700ms window rather than introducing a new failure, and closing it would mean
classifying individual player sub-controls.

### 3.1 Unresolved questions

Each of these has to be answered before any of this can be built. They are listed here
rather than buried because the previous implementation attempt failed by treating open
questions as settled.

1. **The backstop contradicts the premise.** `REMOTE_OWNERSHIP_MAX_AGE_MS` is itself a fixed
   wall-clock window — precisely the construct §2 argues can never be correct. If
   `canplay`/`seeked` arrive later than the cap (a hard seek on a weak network, or a
   throttled background tab), the cap releases ownership and the late echo leaks exactly as
   before. Either the design accepts that a contaminated ownership may persist indefinitely,
   or it needs a release condition that is not a duration. **This is the deepest open
   question: as written, the design's own safety net violates its central claim.**
2. **C1 still has no causal link between gesture and action.** Recording a gesture id does
   not fix it: `onSeeked` calls `rememberExplicitUserAction("seek")` whenever _any_ recent
   document-level gesture exists, so the id it records is "the most recent gesture", not
   "the gesture that caused this action". A volume click followed by a late `seeked` still
   manufactures provenance. Establishing this needs the action's identity to originate from
   the player control interaction itself, which no current code path provides.
3. **The structure has no element identity.** §7 concludes that ownership must at minimum
   hold a reference to the element the state was written to; the shape above does not. Until
   it does, the binding path cannot tell "first bind of this already-applied element" from
   "a different element", and C4 must either clear valid ownership or carry an old element's
   ownership onto a new one. Echo events should additionally be required to originate from
   that element.
4. **No decidable rule for playback-rate divergence.** §3 claims position _and rate_ need
   one; only position got a table. If the room asks for 1.5x while the player transiently
   reports 1.0x mid-write, nothing says whether to keep ownership or apply C2.
5. **`D` is a guess.** The position-delta bound has not been measured against real player
   behaviour. The same applies to the `ε < Δ ≤ D` band now being suppressed rather than
   merely tolerated: that is the right call on the reasoning above, but it widens what
   ownership silences and has never been exercised against a real player.
6. **Nothing invalidates a superseded `pendingPlaybackApplication`.** A state that waits on
   metadata sits in `pendingPlaybackApplication` and is applied later, on `canplay` — by
   which time it may already be obsolete, and the write happens anyway and re-takes
   ownership. Two distinct sources make it obsolete, and the design must address both:
   - **A user takeover.** C1 releases the ownership taken at receipt, but the pending write
     still lands and overwrites the takeover that just occurred.
   - **A newer remote state.** If a later state is accepted through a noop, cooldown, or
     self-confirmation branch, those branches return without touching the pending entry, so
     the older state is still applied afterwards and rolls the room back to a state everyone
     has already moved past.

   Handing ownership over (as §3 requires of those branches) is not enough on its own —
   every accepted state, and every C1 release, has to invalidate or replace a pending apply
   it supersedes.

### The critical split: paused/buffering versus playing

This is what makes or breaks the model; the two cannot be treated alike.

**Ownership of paused / buffering may persist.**
A paused page emits no periodic heartbeat, so a long-lived marker is harmless — and this
is the direction where leaking does the most damage, because a leaked `paused` becomes a
server-side authority that vetoes everyone else's start-up.

**A `playing` state is owned only until playback actually starts.**
While playing, `onTimeUpdate` broadcasts every 2 seconds
(`playback-binding-controller.ts`: `nowOf() - getLastBroadcastAt() > 2000 && !video.paused`).
Any ownership that outlived the arrival of `playing` would mute those heartbeats and the
room would lose its drift correction entirely.

It is tempting to conclude that `playing` should simply never be owned — the withdrawn
implementation did exactly that — but it is too coarse. A remote `playing` can also carry a
hard seek that takes a long time to buffer, and the `seeked`/`waiting`/`canplay` it produces
can land after the existing 1.8s/3s transition guards. The receiver reports `buffering` for
those, and the server files a `playing` → `buffering` transition as a non-steady pause,
arming the very veto window this document exists to prevent.

So ownership of a `playing` apply covers **only the stop-like states it explains before
playback first starts**, and is released the moment the player first reaches `playing`.
That keeps the late-buffering echo suppressed without muting a single heartbeat: the
heartbeats only begin once playback is running, which is exactly when the ownership ends.

The asymmetry that remains: a stop-like target may be owned indefinitely, because a paused
page has no heartbeat to lose, while a `playing` target's ownership is bounded by an event
(first arrival), never by a duration.

### Repeat reports stay suppressed

Ownership deliberately does not stop at the first matching event. The incident leaked
_two_ frames — `seeked` and `canplay` each reporting the same paused@49 — and it was the
second one that extended the server's veto window far enough to swallow the sharer's
start-up. So a match suppresses and leaves the ownership in place; only C1–C4 release it.

A non-matching position or rate needs a decidable rule, because "still settling toward the
target" and "the player jumped somewhere else" both present as a position mismatch, and C2
says the second must release while the leak returns if the first does. Ordering by
magnitude against the apply's target:

| Position delta | Verdict                          | Why                                                                                                                                                                                                                                                                                                                                           |
| -------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `≤ ε` (0.2s)   | match — suppress, keep ownership | The same standstill                                                                                                                                                                                                                                                                                                                           |
| `ε < Δ ≤ D`    | suppress, keep ownership         | Still explainable by the apply — an intermediate sample on the way to the target. It must be suppressed, not merely tolerated: the server files any `paused`/`buffering` update as a pause authority, and a 1.5s position change is not filtered by `isSteadyTick`, so broadcasting it arms a veto window from a frame the room itself caused |
| `> D`          | **C2 — release**                 | Nothing the room asked for puts the playhead here; the player or a script moved it                                                                                                                                                                                                                                                            |

`D` bounds how far a seek in progress may legitimately read from its own target. It has to
be small enough that a real jump falls outside it and large enough to cover intermediate
samples; a starting value around 2s is a guess, not a measured one, and calibrating it
against real player behaviour is part of implementing this.

Without the `> D` arm, ownership survives an unexplained jump all the way to the backstop
and can suppress a genuine state that happens to match the old position again.

### Clocks: durations and ordering

Durations must not be measured on the wall clock: a backwards NTP correction makes the age
negative — a single-domain backstop would then never fire and a matching pause would stay
suppressed indefinitely — while a forwards one makes the apply look arbitrarily old and
drops the protection on the spot. The backstop therefore measures on `performance.now()`.

**Ordering is not exempt from this.** Recording the apply's wall-clock instant just to
compare it against gesture timestamps looks safe because both live in the same domain, but
a correction between the two reorders them: after a backwards jump a genuine later gesture
reads as older than the apply and the user's takeover stays suppressed, and a jump landing
between an old gesture and the apply makes that stale gesture read as newer and releases
ownership wrongly. Ordering needs either the same monotonic clock on both sides or an
explicit sequence number recorded at apply time — the wall-clock instant cannot establish
"happened after" on its own.

### Backstop cap

Paused ownership additionally carries a long backstop
(`REMOTE_OWNERSHIP_MAX_AGE_MS = 30_000`). The normal path must not depend on it — C1–C4
are the designed clearing conditions. It exists purely to defend against a contamination
source nobody enumerated, so ownership cannot stay in force forever down some unforeseen
path. Hitting it logs a warning, because it means the design has a hole.

## 4. Contamination sources and who owns them

Changing this state machine requires enumerating every source of "local event that is not
user intent" first, and confirming the new model does not break any of them:

| #   | Source                                                                    | Existing guard                               | Under the new model                                                                                                                                                  |
| --- | ------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Events emitted synchronously as apply writes the DOM                      | `programmaticApplyUntil` (700ms) + signature | Unchanged. This layer is synchronous; 700ms suffices and it is not the failure point                                                                                 |
| 2   | Transport events arriving late after apply (`seeked`/`canplay`/`waiting`) | `suppressedRemotePlayback` (700ms)           | **Replaced here** → `RemoteAppliedPlayback`                                                                                                                          |
| 3   | Forced pause (non-shared video autoplay block)                            | `lastForcedPauseAt`                          | Unchanged. Not a remote apply, stays out of the ownership model                                                                                                      |
| 4   | Soft-apply rate write-back and cancel                                     | `programmaticApplyScope = "ratechange"`      | Unchanged. The scope mechanism already separates it correctly                                                                                                        |
| 5   | `<video>` element rebuild (stall recovery)                                | `lastVideoElementBoundAt`                    | New C4 clearing path, but **only on a genuine replacement** — clearing on the first bind of an already-applied element would leave nothing to re-establish ownership |
| 6   | Natural end / autoplay-next handoff                                       | `sharerEndedSuppression*` / `holdNonSharer*` | Unchanged                                                                                                                                                            |
| 7   | Stale page bridge during SPA navigation                                   | `postNavigationAnchor*`                      | Unchanged                                                                                                                                                            |
| 8   | Non-shared page                                                           | `non-shared-page` branch                     | Unchanged, and it runs before the ownership check                                                                                                                    |

Only #2 is replaced; #5 gains a clearing path. The other six keep their existing guards.

## 5. Phased rollout

**Phase 1 (attempted, withdrawn) — parallel backstop**
Add `RemoteAppliedPlayback`, consulted **only once the old 700ms window has declined to
suppress**. On every prompt path the behaviour is byte for byte what it was before, so the
behavioural delta is exactly "the leak is plugged". Ownership covers stop-like states only;
`playing` stays entirely with the existing window. Suppression logs
`Suppressed leaked echo by ownership` and every release logs its reason, so both the fix
and any over-suppression are observable in a log the user can send back. The #5 clearing
path lands in the same phase.

**Phase 2 — ownership becomes the primary check**
`shouldSuppressLocalEcho` consults ownership first; `suppressedRemotePlayback` degrades
into the time bound for the `playing` direction, which ownership still does not cover.

**Phase 3 — cleanup**
Remove `REMOTE_ECHO_SUPPRESSION_MS` and `suppressedRemotePlayback`.

Phase 1 already removes the incident scenario; 2 and 3 pay down technical debt and can
wait.

## 6. Risk

**The dominant risk: ownership that fails to clear silently swallows real user actions.**
That is worse than the original bug — the original is visible ("stuck at paused"), whereas
a swallowed action just feels like "sometimes it doesn't respond".

Mitigations:

1. C1 sits first in the decision chain and requires a playback action _plus_ the in-player
   gesture that authenticated it, so it neither over-clears on a stray page click nor
   misses a genuine interaction.
2. Suppression logs the owning source (`actorId` / `seq` / age since `appliedAtMonotonic`), so
   a swallowed action is visible in the log.
3. Phase 1's parallel-backstop mode keeps the new logic purely additive until real-world
   observation supports promoting it.
4. The 30s backstop is the last line of defence and logs a warning when it fires.

## 7. Why the first implementation was withdrawn

An implementation of Phase 1 was written and withdrawn after four rounds of review turned
up eleven findings (seven of them P1).

The _premise_ — that echo suppression must key off state identity rather than a wall-clock
window — still holds. §2 makes that case on evidence and nothing has challenged it.

The direction built on that premise did not survive review. "The design was fine, only the
implementation failed" was the first explanation offered here, and it was wrong: three
reviews of this document alone then found six unresolved questions in §3, including a
backstop that is itself the fixed window the document argues against. An underspecified
design is how an implementation ends up approximating — the two failures were never
independent, and the implementation was withdrawn before the design was ready to be one.

**The mistake:** ownership is fundamentally _"this state, written to this element, at this
instant"_ — an object with an identity. The withdrawn attempt never modelled it that way.
It approximated the identity with indirect signals — timestamps, bind ordering, gesture
inference — and every review round found another interleaving where some approximation
broke. The clearing path in the binding layer was flagged three separate times, each fix
covering only the interleaving that had just been named.

**Any future attempt should start from §3.1, not from §3.** Giving ownership a real
identity — at minimum a reference to the element the state was written to — is a necessary
first step but not a sufficient one; question 1 in particular has to be answered before the
rest is worth building.

### Timing traps a future attempt must handle

Each of these broke a version of the withdrawn implementation. They are the real value of
this document.

1. **The apply's transport events can arrive arbitrarily late.** A cross-video hard seek
   buffers first, so `seeked`/`canplay` land well past any fixed window. This is the bug
   being fixed; it is listed here because every "just widen the window" instinct dies on it.
2. **Ownership must be taken at the DOM write, not on receipt.** A state waiting for
   `loadedmetadata`/`canplay` can sit pending for a long time on a weak network or a
   throttled tab; protection measured from receipt can expire before the write it covers.
3. **A `<video>` element that already has metadata is reachable via `getVideoElement()`
   before the 250ms bind poll reaches it.** So a remote state can be applied — consuming
   the pending state and taking ownership — _before_ that element is ever bound. Any
   "clear ownership on bind" logic must not clear in this case, and neither
   `bindVideoElement`'s return value nor "was something bound before" distinguishes it:
   both the first bind of the page and the bind of an already-applied replacement look
   identical from there.
4. **`rememberExplicitUserAction` authenticates on a _document-level_ gesture.** A click on
   blank page area is enough for it. Anything that _releases_ a protection therefore cannot
   trust the action alone — the loose gate is correct for the broadcast paths and far too
   loose here.
5. **An in-player gesture is not a playback intent either.** Volume, settings and danmaku
   controls all live inside the player container.
6. **Copying the in-player timestamp onto an action does not make them correspond.** An
   in-player gesture from seconds ago (volume) can be copied onto an action that a _newer_
   document-level gesture authenticated, manufacturing false provenance. The two must be
   verified to belong to the same interaction, not merely both exist.
7. **`paused` and `buffering` are one standstill.** The late `waiting`/`pause` chain after a
   remote paused hard-seek is classified as `buffering`; treating it as a different state
   broadcasts a playState _change_, which is not a steady tick and re-arms the server veto
   window ([#220](https://github.com/sky1wu/Bili-SyncPlay/pull/220)).
8. **Every noop/cooldown early-return still has to hand ownership over.** Those branches
   skip the write because the local player already matches, but a superseded ownership must
   still be replaced, or a stale `paused` outlives a newer `playing`.
9. **The room echoing back our own state is an acknowledgement, not an instruction.** Owning
   it mutes the repeats that are the only retry when a send was silently dropped.
10. **The wall clock cannot establish ordering either, not just durations.** Durations need
    `performance.now()` — using the wall clock means an NTP correction either freezes
    ownership forever (backwards ⇒ negative age ⇒ the backstop never fires) or drops it
    instantly (forwards). But "is this gesture newer than the apply" is equally unsafe on
    wall-clock instants: a correction between the two reorders them, so a genuine takeover
    can read as older (and stay suppressed) or a stale gesture as newer (and release
    ownership). Ordering needs one monotonic clock on both sides, or an explicit sequence
    number.

### Process notes

- Controller-level tests set runtime state directly and therefore cannot see binding-layer
  misclassification (traps 4–6). Those need tests at the binding layer.
- "The test passes" and "the test would catch this bug" are different claims. Several tests
  written during the attempt passed against a deliberately reverted implementation — they
  looked like coverage and were not. Verify each by reverting the specific change it
  guards.

## 8. See also

- [PR #220](https://github.com/sky1wu/Bili-SyncPlay/pull/220) — server side: a steady tick
  no longer refreshes the playback veto window
- "Playback timing invariants" in `AGENTS.md`. Note the split this design needs on top of
  that rule: `appliedAtLocal` is a **wall-clock** instant used only for ordering against
  gesture timestamps (which live in the same domain), while every _duration_ — the backstop
  age — is measured on `appliedAtMonotonic` / `performance.now()`. Neither is ever mixed
  with `serverTime`.
