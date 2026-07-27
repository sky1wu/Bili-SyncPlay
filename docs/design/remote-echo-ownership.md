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
  playState: PlaybackState["playState"];
  currentTime: number;
  playbackRate: number;
  actorId: string;
  seq: number;
  appliedAtLocal: number; // local monotonic instant; used for extrapolation and the
  // backstop cap only, never as the primary expiry
  settled: boolean; // has the DOM confirmed it reached this state
}
```

The rule: if a local event reports `(playState, currentTime, playbackRate)` matching the
owned values (within tolerance), it is an echo and is suppressed — **however long ago the
apply happened**.

The marker does not expire on time. It is cleared only by:

| #   | Clearing condition                                                            | Rationale                                                        |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| C1  | A genuine in-player gesture (`lastUserGestureInPlayerAt > appliedAtLocal`)    | The user took over; everything after is local intent             |
| C2  | Local state diverges from the owned values in a way the remote cannot explain | The player moved on its own (start-up, jump) — no longer an echo |
| C3  | A newer remote state arrives                                                  | Straight replacement                                             |
| C4  | Shared video switch / room reset / `<video>` rebind                           | The context is gone                                              |

**C1 must be evaluated first**, otherwise user actions get swallowed. It reads
`lastUserGestureInPlayerAt` (a gesture inside the player) rather than the document-level
`lastUserGestureAt`, so a stray click on blank page area cannot clear ownership.

### The critical split: paused/buffering versus playing

This is what makes or breaks the model; the two cannot be treated alike.

**Ownership of paused / buffering may persist.**
A paused page emits no periodic heartbeat, so a long-lived marker is harmless — and this
is the direction where leaking does the most damage, because a leaked `paused` becomes a
server-side authority that vetoes everyone else's start-up.

**Ownership of playing must be bounded.**
While playing, `onTimeUpdate` broadcasts every 2 seconds
(`playback-binding-controller.ts`: `nowOf() - getLastBroadcastAt() > 2000 && !video.paused`).
If playing ownership never lapsed, the room would lose its playback heartbeat entirely and
peers could no longer correct drift.

So playing ownership only covers events **before the state is reached**: once the DOM
confirms playback started, the marker is cleared and the heartbeat resumes.

### Settled semantics

- **paused ownership**: the DOM reports `paused` with `|currentTime - target| ≤ ε` →
  `settled = true`. It **keeps suppressing** repeat reports of the same state after that —
  exactly the two leaked frames from the incident (`seeked` and `canplay` each reporting
  the same paused@49). Only C1–C4 release it.
- **playing ownership**: cleared as soon as arrival is confirmed.

### Backstop cap

Paused ownership additionally carries a long backstop
(`REMOTE_OWNERSHIP_MAX_AGE_MS = 30_000`). The normal path must not depend on it — C1–C4
are the designed clearing conditions. It exists purely to defend against a contamination
source nobody enumerated, so ownership cannot stay in force forever down some unforeseen
path. Hitting it logs a warning, because it means the design has a hole.

## 4. Contamination sources and who owns them

Changing this state machine requires enumerating every source of "local event that is not
user intent" first, and confirming the new model does not break any of them:

| #   | Source                                                                    | Existing guard                               | Under the new model                                                                  |
| --- | ------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Events emitted synchronously as apply writes the DOM                      | `programmaticApplyUntil` (700ms) + signature | Unchanged. This layer is synchronous; 700ms suffices and it is not the failure point |
| 2   | Transport events arriving late after apply (`seeked`/`canplay`/`waiting`) | `suppressedRemotePlayback` (700ms)           | **Replaced here** → `RemoteAppliedPlayback`                                          |
| 3   | Forced pause (non-shared video autoplay block)                            | `lastForcedPauseAt`                          | Unchanged. Not a remote apply, stays out of the ownership model                      |
| 4   | Soft-apply rate write-back and cancel                                     | `programmaticApplyScope = "ratechange"`      | Unchanged. The scope mechanism already separates it correctly                        |
| 5   | `<video>` element rebuild (stall recovery)                                | `lastVideoElementBoundAt`                    | New C4 clearing path (the old element's ownership is meaningless for a new one)      |
| 6   | Natural end / autoplay-next handoff                                       | `sharerEndedSuppression*` / `holdNonSharer*` | Unchanged                                                                            |
| 7   | Stale page bridge during SPA navigation                                   | `postNavigationAnchor*`                      | Unchanged                                                                            |
| 8   | Non-shared page                                                           | `non-shared-page` branch                     | Unchanged, and it runs before the ownership check                                    |

Only #2 is replaced; #5 gains a clearing path. The other six keep their existing guards.

## 5. Phased rollout

**Phase 1 (implemented) — parallel backstop**
Add `RemoteAppliedPlayback`, consulted **only once the old 700ms window has expired**. The
behavioural delta is exactly "the leak is plugged"; every other path is untouched.
Suppression logs `Suppressed leaked echo by ownership` so its real-world frequency and
scenarios are observable. The #5 clearing path lands in the same phase.

**Phase 2 — ownership becomes the primary check**
`shouldSuppressLocalEcho` consults ownership first; `suppressedRemotePlayback` degrades
into the time bound for playing ownership.

**Phase 3 — cleanup**
Remove `REMOTE_ECHO_SUPPRESSION_MS` and `suppressedRemotePlayback`.

Phase 1 already removes the incident scenario; 2 and 3 pay down technical debt and can
wait.

## 6. Risk

**The dominant risk: ownership that fails to clear silently swallows real user actions.**
That is worse than the original bug — the original is visible ("stuck at paused"), whereas
a swallowed action just feels like "sometimes it doesn't respond".

Mitigations:

1. C1 (gesture clearing) sits first in the decision chain and keys off an in-player
   gesture, so it neither over-clears nor misses a genuine action.
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
