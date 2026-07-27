# Design: remote playback ownership replaces the fixed echo window

Status: Phase 1 implemented, Phase 2/3 pending.

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

## 3. Design: an ownership marker

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
- once the adjustment is actually written to the element, which restamps `appliedAtLocal`.
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

So the action records the in-player gesture that authenticated it
(`ExplicitUserAction.inPlayerGestureAt`), and C1 requires _that_ to postdate the apply. One
residual case remains by choice: adjusting volume inside the player at the exact moment a
late transport event lands still releases. The consequence is only that ownership ends
early — degrading to the pre-existing 700ms window — rather than any new failure, and
closing it would mean classifying individual player sub-controls.

### The critical split: paused/buffering versus playing

This is what makes or breaks the model; the two cannot be treated alike.

**Ownership of paused / buffering may persist.**
A paused page emits no periodic heartbeat, so a long-lived marker is harmless — and this
is the direction where leaking does the most damage, because a leaked `paused` becomes a
server-side authority that vetoes everyone else's start-up.

**A `playing` state is never owned at all.**
While playing, `onTimeUpdate` broadcasts every 2 seconds
(`playback-binding-controller.ts`: `nowOf() - getLastBroadcastAt() > 2000 && !video.paused`).
Any ownership that outlived the arrival of `playing` would mute those heartbeats and the
room would lose its drift correction entirely. Rather than bound it with yet another
window — the very construct this design is replacing — `rememberRemoteAppliedPlayback`
simply declines to own anything that is not stop-like, and the local player reaching
`playing` releases an existing ownership (C2, `left-state`).

That asymmetry is the whole trick: the direction that can be owned indefinitely is
exactly the direction with no heartbeat to lose, and it is also the direction where
leaking does damage.

### Repeat reports stay suppressed

Ownership deliberately does not stop at the first matching event. The incident leaked
_two_ frames — `seeked` and `canplay` each reporting the same paused@49 — and it was the
second one that extended the server's veto window far enough to swallow the sharer's
start-up. So a match suppresses and leaves the ownership in place; only C1–C4 release it.

A non-matching position or rate suppresses nothing but does **not** release either: the
player may still be settling toward the target, and releasing on the first intermediate
sample would put the leak back.

### Two clock domains

Gesture timestamps live on the wall clock (`Date.now()`), so ownership records that instant
to compare against them. Durations must not use it: a backwards NTP correction makes the
wall-clock age negative — a single-domain backstop would then never fire and a matching
pause would stay suppressed indefinitely — while a forwards one makes the apply look
arbitrarily old and drops the protection on the spot. The backstop measures on
`performance.now()`, recorded alongside as `appliedAtMonotonic`.

### Backstop cap

Paused ownership additionally carries a long backstop
(`REMOTE_OWNERSHIP_MAX_AGE_MS = 30_000`). The normal path must not depend on it — C1–C4
are the designed clearing conditions. It exists purely to defend against a contamination
source nobody enumerated, so ownership cannot stay in force forever down some unforeseen
path. Hitting it logs a warning, because it means the design has a hole.

## 4. Contamination sources and who owns them

Changing this state machine requires enumerating every source of "local event that is not
user intent" first, and confirming the new model does not break any of them:

| #   | Source                                                                    | Existing guard                               | Under the new model                                                                                                |
| --- | ------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Events emitted synchronously as apply writes the DOM                      | `programmaticApplyUntil` (700ms) + signature | Unchanged. This layer is synchronous; 700ms suffices and it is not the failure point                               |
| 2   | Transport events arriving late after apply (`seeked`/`canplay`/`waiting`) | `suppressedRemotePlayback` (700ms)           | **Replaced here** → `RemoteAppliedPlayback`                                                                        |
| 3   | Forced pause (non-shared video autoplay block)                            | `lastForcedPauseAt`                          | Unchanged. Not a remote apply, stays out of the ownership model                                                    |
| 4   | Soft-apply rate write-back and cancel                                     | `programmaticApplyScope = "ratechange"`      | Unchanged. The scope mechanism already separates it correctly                                                      |
| 5   | `<video>` element rebuild (stall recovery)                                | `lastVideoElementBoundAt`                    | New C4 clearing path; safe only because the pending state's own write re-establishes ownership for the new element |
| 6   | Natural end / autoplay-next handoff                                       | `sharerEndedSuppression*` / `holdNonSharer*` | Unchanged                                                                                                          |
| 7   | Stale page bridge during SPA navigation                                   | `postNavigationAnchor*`                      | Unchanged                                                                                                          |
| 8   | Non-shared page                                                           | `non-shared-page` branch                     | Unchanged, and it runs before the ownership check                                                                  |

Only #2 is replaced; #5 gains a clearing path. The other six keep their existing guards.

## 5. Phased rollout

**Phase 1 (implemented) — parallel backstop**
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
2. Suppression logs the owning source (`actorId` / `seq` / age since `appliedAtLocal`), so
   a swallowed action is visible in the log.
3. Phase 1's parallel-backstop mode keeps the new logic purely additive until real-world
   observation supports promoting it.
4. The 30s backstop is the last line of defence and logs a warning when it fires.

## 7. See also

- [PR #220](https://github.com/sky1wu/Bili-SyncPlay/pull/220) — server side: a steady tick
  no longer refreshes the playback veto window
- "Playback timing invariants" in `AGENTS.md` — `appliedAtLocal` here is a local monotonic
  instant, only ever subtracted from other local instants, never mixed with `serverTime`
