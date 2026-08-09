# Runtime invariants

Rules that no type, lint, or test enforces on their own, each written down after a
bug or a long review round found it the hard way. [AGENTS.md](../../AGENTS.md)
carries the one-line version of each; this file carries the reasoning, which is
what you need before changing the code they describe.

Read the relevant section before touching: background playback timing, share
ownership, the shared runtime store, room-event broadcasts, or a background
maintenance timer.

中文版见 [invariants.zh-CN.md](./invariants.zh-CN.md)。

## Playback timing invariants

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

- **A marker that stands for "the user did not cause this" must ask about
  gestures over ITS OWN window, and must not carve out exceptions.**
  `lastUserGestureAt` is the only evidence the content script has that a
  navigation/pause was user-driven, and `userGestureGraceMs` (~1.2s) is the wrong
  span to ask over: any marker whose window is wider has a gap where the user's
  gesture is already forgotten while the marker still reads as fresh. The
  question is "could this gesture be what caused what I am seeing now?", so the
  span must be the marker's window — once it is willing to wait 10s for a
  countdown it owes the same patience to a slow-resolving SPA click.
  **Anchor that span on the marker's instant, not on `now`.** Ageing the gesture
  from `now` while the marker ages from its own timestamp leaves a sliver at the
  tail where the marker is still valid and the gesture has just aged out. The
  marker is valid for events in `[mark, mark + window]`, and a gesture that could
  have caused any of them lies in `[mark - window, now]` — so that is the span,
  and `now` drops out of the test entirely. Its lower bound is load-bearing in
  the other direction: without it, pressing play at the start of a 24-minute
  episode would veto that episode's autoplay forever.
  **Within that span every gesture refutes the marker, with no exception**, even
  though some gestures genuinely are compatible with it — a sharer's drag to the
  last seconds really does end in an autoplay. #236 spent five review rounds
  trying to admit exactly that one gesture, and each fix alternated the failure:
  admit a manual episode click (the sharer pushes a private choice to the whole
  room), then reject a real seek-to-end (the room silently stops advancing). The
  signals cannot separate them — both are discrete input, a click can land
  between `seeking` and `seeked`, and a drag's own release `click` postdates the
  `pointerdown` that began it. The rule is therefore the blunt one, and the cost
  is written down as a test
  ("...the accepted cost of having no gesture exception"): a sharer who drags to
  the end shares the next episode manually, once. Re-introducing the exception
  re-opens the alternation.
  The whole scheme is only safe because `lastUserGestureAt` is refreshed by
  DISCRETE input (`gesture-tracker.ts`:
  pointerdown/mousedown/click/touchstart/keydown/popstate) and never by pointer
  movement or scrolling — a tracker that recorded either would turn passive
  viewing into a veto and silently disable the marker.
  **A one-shot marker must be consumed, not merely bounded.** The evidence that
  refutes it is shorter-lived than the marker itself (`resetUserGestureState`
  zeroes `lastUserGestureAt` on every navigation), so a marker that outlives the
  navigation it explains gets a second chance with its objector gone. Read it
  into locals and clear it at the top of the handler.

- **A window constant that two behaviours share is two constants.**
  `INITIAL_ROOM_STATE_PAUSE_HOLD_MS` was both "how long we suppress a page-load
  autoplay" and "how long a natural-end marker stays valid" (#236). Nothing
  connected the two, so the second was silently pinned to a value chosen for the
  first — and 3s is shorter than Bilibili's ~5s next-video countdown, which made
  the marker expire before every autoplay it existed to catch. When a constant is
  read by a second call site asking a different question, split it and state what
  each value is measured against. Values that a regression test must assert
  against live in `extension/src/content/timing-constants.ts`, not in
  `content/index.ts`: a test that re-types the number passes just as happily
  after someone edits the shipped one.

## Share ownership is derived, and deltas do not carry it

`sharedVideo.sharedByMemberId` is written once, at `video:share`, and is a
durable reference to a volatile identity — the sharer's seat. #235 is what
happens when it dangles: nobody computes `isLocalSharedSource()`, so nobody
advances the room. Three rules keep it working, none enforced by a type:

- **Resolve at build, never rewrite the room.** `roomStateFromSessions` is the
  single place `sharedVideo` reaches a client, and the only place the stored id
  is reconciled with the live member list (`resolveSharedVideoOwnerId`). A new
  `room:state` build site must go through it. The persisted room keeps the
  original id on purpose: it is the _preferred_ owner, so a sharer whose socket
  merely blipped reclaims the share on reconnect instead of losing it for good.
- **A full `room:state` may only be published where the index is provably
  clean.** A room switch leaves the old room inside `createRoomForSession` /
  `joinRoomForSession`, and `releasePreviousRoom` reports whether `onRoomLeft`
  actually cleared the index. The `room_member_left` delta goes out regardless —
  it reads no state — but the full state is published only where the switcher
  cannot come back — `publishPreviousRoomResync` holds both licences: the join
  was seated (its write re-stamps the whole session record under the NEW room
  code) OR `onRoomLeft` itself landed. A refused join still owes the old room
  its state on the second licence, since the rollback only unwinds the new room.
  "The session hash already names the new room" is not something to assume: that
  hash is written by `onRoomLeft` itself (#242).
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
- **No `room:state` may be published for a leave until `onRoomLeft` has settled
  _successfully_.** That hook clears the session out of the room index, and
  `getRoomStateByCode` reads the index, not the member map — so a state built
  while the write is still queued, or after it failed, contains the member who
  just left and hands them the share straight back. `runRoomLeftHook` is awaited
  and reports whether it succeeded; the app's implementation awaits
  `runtimeStore.flush`. `room:member-left` is exempt and still goes out on
  failure: it reads no state, so a dirty index cannot corrupt it.
  Two paths beyond an explicit leave need the same treatment, and both are easy
  to miss because the leave is not visible in them:
  - A member switching rooms leaves the old one inside `createRoomForSession` /
    `joinRoomForSession`, which publish nothing of their own — so both handler
    branches release the old room themselves.
  - Those same calls leave the old room _before_ they can fail (room full, bad
    join token, admission lock timeout, code collision). `enterRoom` releases the
    old room on that path too, guarded on `session.roomCode` having actually
    changed, or a failure that never got as far as leaving would broadcast a
    room the member never left.

## The runtime store is write-behind, so "drained" never means "written"

`registerSession`, `markSessionJoinedRoom`, `markSessionLeftRoom` and
`unregisterSession` update this node's own maps synchronously and queue the
shared write behind them. Everything downstream that writes, reads back, and
decides something has to know which of the two questions it is asking (#242):

- **`flush()` says the queue emptied. `confirmWrites()` says the writes landed.**
  `flush` waits on error-swallowed copies, so a failed write drains exactly like
  a successful one. Use `flush` when the point is ordering ("my own writes are
  visible to the read I am about to do") and `confirmWrites` when the point is
  durability. `confirmWrites` is store-wide and clears what it reports, so the
  answer is "since you last asked"; a caller that only needs its OWN write
  confirmed should await that write, since all four report their real outcome.
- **Queued writes are retried with backoff, and a retry can outlive its room.**
  `durable-write-queue` gives every queued write a bounded, backed-off retry
  budget. That reopens the room-code recycling hazard #237 closed: a retry that
  lands after the code changed hands would write into the new room. Only the
  join write ADDS a session to a room, so only it needs the guard — and the pin
  is read when `markSessionJoinedRoom` is CALLED, never inside the retryable
  body: the body does not run until the session's chain drains, which is
  unbounded, so a pin taken there can already name the code's NEXT occupant and
  the check waves the write straight through. A mismatch is a
  `NonRetryableWriteError` (a generation only moves forward, so no later attempt
  can find its way back). An unreadable generation refuses the join rather than
  re-reading later, since a second read is a second chance to pin the wrong
  instance. An ABSENT generation still pins as `""`, which is why the teardown
  leaves a TOMBSTONE in that key rather than deleting it: deleting made "torn
  down" indistinguishable from "never stamped", so a pin of `""` matched the
  room it was about to resurrect. The tombstone does NOT expire — a TTL would
  have to outlive every write that could still be holding the old pin, and
  nothing bounds those, so a lapsed tombstone lets a `""` pin match an absent
  key all over again. What reclaims it is the next occupant's
  `markRoomGeneration`. Pinning the tombstone ITSELF is refused, or a pin taken
  after the teardown would match it. `hasRoomResidue` ignores the key, so a
  tombstone never keeps a code reserved. A new write that seats or moves
  anything by room code needs the same pin; one that only touches keys named
  after the session does not, because session ids are never reused.
- **Every retry budget is sized against the shutdown step that drains it.**
  `close_shared_runtime_store` and `flush_pending_room_event_publishes` carry
  explicit timeouts, and an overrun is logged at error level and reported as a
  degraded step — so a shutdown that merely waited out a retry abandons writes it
  could have landed (it does not exit non-zero; see the DEGRADED rule two bullets
  down). `close()` calls
  `stopRetrying()` first, which cuts the backoffs in flight short AND drops
  writes that have not started, leaving at most ONE in-flight attempt; the step
  budget must exceed that attempt's own timeout. Raising `maxAttempts` or a
  delay means redoing that arithmetic.
- **The retry timing lives in `retry-pacer`, not in each facility.** The
  backoff schedule, the shutdown-cancellable wait, the per-attempt cap that
  does not cancel the call, and the record of calls that outlived one are ONE
  implementation shared by `durable-write-queue`, `pending-resync-queue`,
  `runtime-index-reaper` and the store's command wrapper. They used to be four
  hand-rolled copies, and six of #242's review findings were the same defect in
  whichever copy the previous round had not touched. A new retrying facility
  uses the pacer; it does not grow a fifth copy. What stays local is what
  genuinely differs: ordering/supersession/confirmation, dedupe, and who decides
  to retry.
- **A shutdown step that ran out of its budget is DEGRADED, not failed.** Only
  a step that threw exits the process non-zero (`graceful-shutdown.ts`). The
  budgets exist because these steps wait on I/O this process cannot cancel, so
  giving up on it is the designed outcome. Treating an overrun as a failure
  turned every "what if this particular call hangs?" into a correctness claim —
  a question with no last answer, because each bounded wait added to satisfy it
  becomes a new call site to ask it about. Ten of #242's review findings were
  that one question re-asked. Both outcomes are still logged at error level; a
  drain that gives up must stay visible.
- **A timeout answers the caller; it does not cancel the command.** This one
  bites in three places, and fixing one of them is not fixing it:
  - The session's key is released only once every command the write started has
    really finished (`DurableWriteRequest.settle`). Releasing it when the caller
    is answered lets the compensating write — queued on that same key — run
    first, and the abandoned command then lands on top of its own rollback,
    leaving a member the client was told does not exist and who can win the
    share back. `drain` waits for those releases; `confirm` deliberately does
    not, since a command still in flight has already reported its verdict.
  - Nothing starts a second call while the first has not answered — not the
    write queue, not `pending-resync-queue`, not the reaper's per-room publish.
    Otherwise a hung dependency accumulates one live command per retry.
  - Nothing that closes a connection or a bus does so under a live call:
    `close()` drains the chain (bounded) before `quit`, and the resync drain
    waits out its abandoned calls (bounded) before shutdown closes the bus.
- **A retry is abandoned when a newer write for the same session is queued.**
  Retrying past that point fights the newer write. This is only sound because
  the join write re-writes the WHOLE session record rather than patching
  `roomCode` — so a lost `registerSession` is repaired by the next join instead
  of leaving a hash with no `id`, which `loadSession` reads as no session at
  all. A new session write that carries a strict subset of the record must not
  rely on an earlier one having landed.
- **A join whose index write fails is aborted, not seated.** `runRoomJoinedHook`
  reports failure and the handler rolls the join back through
  `leaveRoom(session, "disconnect")` — `"disconnect"` so a reconnecting member
  keeps the identity the ownership rule depends on. Everything a join sends next
  is read back off the index this write maintains, so a member the room cannot
  see is worse than a refused join the client retries. And if the ROLLBACK
  fails, the socket is dropped: `leaveCurrentRoom` restores the member when its
  own persistence fails and the socket is open, so reporting the join refused
  while the server still holds the seat leaves the two disagreeing.

## One-shot broadcasts need a retry trail; repeated ones do not

Nearly every `room_state_updated` is re-sent by the next `video:share` /
`playback:update` / `profile:update`, so dropping one costs a moment. Two are
one-shot, and both lose the room permanently when the bus rejects them (#242):

- The **share-ownership resync** (`publishSharedOwnerResync`) fires precisely
  because the room stopped advancing, so nothing follows it, and an idle room
  never sends `sync:request` either — only a page reload recovers. It goes
  through `pending-resync-queue`, which retries with backoff behind a `request`
  that returns immediately; `firePublishRoomEvent` deliberately does not await
  its wrapper, and making the leave/join handlers block on the bus would be the
  worse trade. A record retries until the bus takes it — a per-record attempt
  budget is just a slower way to discard a notification nothing else will
  re-send — so `drain` is unbounded by design and the shutdown call passes
  `{ final: true }`, which calls `stopRetrying` first and leaves at most one
  in-flight attempt to wait for. A record never starts a second publish while
  its first has not answered: the attempt cap races the bus call, it does not
  abort it, so an unbounded retry loop over a hung bus would otherwise pile up
  one live Redis command per retry — the same "a timeout is not a cancel"
  reasoning as the write queue's `settle`.
- The **runtime index reaper's** announcement is the only thing that tells a
  room a dead node's members are gone. Once the sweep has cleaned the indexes,
  `listClusterSessions` no longer returns those sessions, so a later sweep has
  nothing to rediscover the room from. The reaper keeps its own record set and
  retries it at the START of every sweep — before the "no offline nodes" early
  return — dropping a record only once the publish succeeds. Neither this queue
  nor `pending-resync-queue` caps its backlog: evicting or refusing an
  unpublished record loses exactly what they exist to keep, so a backlog is
  logged, never shed. Because it is uncapped, every SHUTDOWN path over it has to
  be bounded, and there are two: `stop()` drains with bounded concurrency
  against its own deadline, and it sets `stopping` BEFORE awaiting the sweep in
  flight so that sweep's serial drain gives way instead of running the whole
  backlog first. Bounding only the second one leaves the budget just as blown.
  An overrun step is logged loudly AND lets the bus close under
  in-flight publishes, which then delete their records as if they had landed.
  Each publish is capped on its own too: a deadline that only decides whether to
  START the next record bounds nothing when the bus hangs instead of rejecting.
  Sweeps also no longer overlap: they share that set, and `stop()` awaits only
  the sweep it knows about.
  What creates a record is the other half of this: a room is announced only
  once THAT session's cleanup writes are confirmed, and the session record is
  what makes a retry possible at all. The sweep's steps are ordered by what
  they destroy — the member removal needs `roomCode` and `memberId`,
  `markSessionLeftRoom` blanks `roomCode`, `unregisterSession` deletes the
  record — so each runs only after the previous one is confirmed, and a step
  that did not land (failed, capped, or cut short by `stop`) leaves the record
  untouched for the next sweep to redo from the top. Every step is idempotent,
  which is what makes redoing it free. #235 answered this the other way — it
  announced regardless, since `unregisterSession` cleaned the same key anyway
  and gating "left the next pass nothing to retry" — and that reasoning only
  held while the sweep unregistered unconditionally. `unregisterSession` is the
  one write nothing gates on, because it returns `void` (so `confirmWrites` is
  the only place its outcome is visible) and because failing it leaves the room
  index already clean and merely re-runs a no-op next sweep.

## A background pass that cannot time out cannot be observed

`room-reaper`, `room-index-reconciler` and `node-heartbeat` each run one async
pass against Redis per tick. None had a timeout anywhere on that path, and
neither Redis client has one either — `lazyConnect` and `maxRetriesPerRequest:
1` bound retries, not how long a command that Redis already accepted may take to
answer. A half-open connection therefore left a pass pending forever, and the
reaper stopped collecting expired rooms with **no** signal at all: both series
of `bili_syncplay_room_reaper_sweeps_total` went flat, so an alert on the
failure rate never fired, and only a manual restart recovered (#261). The
heartbeat failed the same way and worse: `node_heartbeat_failed` was only ever
reachable through the beat's `.catch`, so a beat that never settled logged
nothing at all, while other nodes aged this one out of the cluster index and
reaped its sessions — from a node still serving clients (#263). All the rules
below live in `maintenance-pass.ts` — one driver, because the same defect turned
up in every hand-written copy:

- **Every tick records exactly one outcome.** That is what makes "the rate went
  flat" mean "the timer is gone" and nothing else. A pass that outlives its cap
  is an `error`, not silence. A cap that only reported the FIRST stalled tick
  would let the series go quiet again while the stall continued, which is the
  original bug with extra steps. But "recorded" is not the same as "failed": a
  tick that finds the previous pass still running INSIDE its cap gets its own
  `skipped` label, because the interval is a configurable positive integer and
  can be set below the cap — filing that under `error` puts the failure rate at
  1 on a dependency that is answering (#262 review). `stalled` therefore always
  follows a `timed_out` on the same call, which is what the runbook tells
  operators to read it as.
- **The cap does not cancel the call, so a pass never runs on top of another.**
  Nothing can abort an in-flight Redis command; the cap only stops the caller
  waiting. Ticking again while the previous command is unanswered piles up one
  command per interval for as long as the stall lasts, and — because the
  shutdown step waits on the promise the LAST tick stored — leaves shutdown
  waiting on the newest pass while older ones are still writing. Same
  reasoning as `pending-resync-queue` and the runtime index reaper's
  per-publish cap. The overlap slot is released by the call's own answer, not
  by the cap: a slot freed one hop late skips the next pass as `still_running`
  and halves the sweep rate.
- **`stop` waits for the real call, bounded — and says when the budget was not
  enough.** The next shutdown step closes the Redis connection, so returning
  while a command is in the air races `redis.quit()`; but an unbounded wait only
  moves the overrun into the shutdown step, which is then recorded as failed.
  `retry-pacer`'s `settleTracked` is that bounded wait, and its budget must stay
  inside the step's own timeout. Giving up quietly is the same trade in reverse:
  that race used to be visible precisely BECAUSE the step timed out, so a `stop`
  that returns cleanly owes an `onSettleTimeout` line naming the calls still
  outstanding. Bounding a wait and dropping its signal in the same change is how
  a fix for silence reintroduces it one step down.

- **The cap is derived from what a late pass costs, not picked for comfort.**
  The reaper's is a flat 30s under a 60s default interval. The heartbeat's is
  computed (`heartbeatTimeoutMs`): half an interval, and never more than a third
  of `NODE_HEARTBEAT_TTL_MS` — because the consequence of a late beat is other
  nodes calling this one stale at `staleAt` and reaping its sessions at
  `expiresAt`. A cap that fired at the same time as the expiry would answer a
  question nobody could still act on. Below the interval is the other half of
  the rule: it is what makes the tick after a timeout a `stalled` rather than an
  `overlapped`.

The cap belongs to the caller, not to the connection: neither the room store's
nor the runtime store's client has a `commandTimeout`, so the command itself
stays out on the socket. `heartbeatNode` in particular is a direct `MULTI` —
it does not go through the write queue, so the queue's own
`pendingOperationTimeoutMs` never applied to it.
Adding one there would bound the request path (`get_room` / `update_room`) too,
which is a separate decision with its own retry semantics to weigh — deliberately
not taken in #261.

## An unbounded write queue turns a stalled dependency into a growing one

`redis-event-store` serialises appends on a promise chain so the stream's order
matches the events' order. Nothing capped any link of it, and the queue is fed by
**every** structured log line — so the first XADD that never answered turned each
subsequent log line into another closure holding its own event payload, with no
bound and no dedupe. Memory grew with the log rate for as long as Redis stayed
hung, `queryEvents` waited on the same chain and so did every count on the admin
overview, and `close` was `await pendingAppend` and therefore guaranteed to
overrun `close_event_store`'s budget (#264). The rules:

- **A queue that cannot refuse work is not bounded by anything.** The per-write
  cap and the depth limit answer two different failures and neither substitutes
  for the other: the cap fires when Redis stops answering, and the depth limit
  when Redis answers more slowly than events arrive — a state in which no cap
  ever fires and the queue grows forever. Both are needed.
- **Shedding is the right trade here, and is not elsewhere.** The event stream is
  observability data with a `MAXLEN` of its own; losing entries costs an
  incomplete list, which the drop counter then says out loud. That is the
  opposite of `pending-resync-queue`, where a dropped record is gone for good —
  see [one-shot broadcasts](#one-shot-broadcasts-need-a-retry-trail-repeated-ones-do-not).
- **Report the failure as facts, not as an incident.** The first version of this
  logged a start and a matching end, with a magnitude, a stage that could
  escalate, and two possible terminators. #266 then spent four review rounds
  finding states where the pair broke: a node whose traffic went quiet, a
  shutdown that arrived first, a write that answered with an error, a stage
  change that emitted a second start, an end that a raised `LOG_LEVEL` filtered
  away. That was not bad luck. A start/end pair is a span, a span has an
  invariant, and nothing in a log stream can enforce one — least of all in the
  component whose dependency is the thing breaking, so every failure mode of
  that dependency is another way to break it. `maintenance-pass` gets away with
  the same shape only because a timer guarantees each tick is discrete and
  completes; **a pattern's guarantee comes from its precondition, not from its
  shape**, and the append path is a caller-driven stream that inherits neither.
  What replaced it: one throttled line per reason saying what is happening, and
  a counter — which answered "still happening?" and "how much?" from the first
  version onward, statelessly, and was never once flagged.
- **The reporting must not depend on the thing it reports on.** These lines go
  through `logEvent`, which goes through `eventStore.append` — so the report
  competed for the capacity it was reporting about, and produced a reflexive
  loop, a level-routing problem, and per-completed-write churn at the capacity
  edge. Four findings from one bad dependency direction. `logger.ts` excludes
  them from the store and pins them to `error`, together, because both rules
  have that one reason.
- **A dropped append answers its caller successfully.** The caller is the
  structured logger, which turns a rejection into a `runtime_event_append_failed`
  line on stdout — so rejecting would answer a Redis stall with one error line
  per log line, on the path already established to be overloaded. Drops are
  reported in aggregate instead: every drop on the counter, and a shedding line
  throttled to one per reason per minute.
- **The cap does not release the chain.** It flips the store into shedding; the
  link itself still waits for the real answer. Letting the chain advance would
  put a second write on a connection that has answered neither, and would land
  them out of order if Redis recovered — the ordering the chain exists for.
- **A read must not join the write queue it is trying to read about, and past a
  point must not be issued at all.** The chain is serial, so `await
pendingAppend` made a read wait for every queued write to be ISSUED and
  answered one after another — round trips that had not started yet. Bounding
  that wait leaves the read queued behind only the write in flight. But once
  that write is past its own cap, the read will not come back either, and a
  longer wait is the wrong lever entirely: the admin console polls events and
  the overview every 15s, so each poll leaves another read and its closure in
  ioredis's queue for as long as the stall lasts — timer-driven growth of
  exactly the kind this section exists to stop (#266 review). So the read is
  refused (`503 event_store_unavailable`), not delayed. The fix for an unbounded
  queue is never a bound on how long you wait for it.
- **`close` drains, bounded, then drops the socket — `QUIT` is not an escape
  hatch.** Dropping the queue outright would lose the shutdown's own events on
  every clean restart, and waiting unbounded makes the step fail on every hung
  one. So: wait for the chain inside a budget, and past it stop the links that
  have not started, because a command issued on a connection that is going away
  is rejected and the logger turns that back into one
  `runtime_event_append_failed` per queued event, after shutdown reported it was
  done. Then `disconnect()`, NOT `quit()`: ioredis puts `QUIT` on the same
  `commandQueue` as everything else and pairs replies front-first, so a graceful
  close inherits the exact wait that was just bounded (#264 review). The graceful
  path is still taken when the chain drained — and is bounded too, because a
  half-open socket swallows `QUIT`'s reply with no write left to blame, and
  that bound owes the same line as every other one here (#266 review): it just
  spent the whole budget, and a `close` that returns cleanly is the only thing
  standing between that and a shutdown recorded as successful. `settleWithin`
  answers "did it settle", which is the right question for the drain (a rejected
  write is still an answer) and the wrong one for `QUIT` (a rejection settles
  just fine while leaving the socket in a state nobody checked) — hence three
  outcomes there, not two. Bounding without reporting is the same trade in
  reverse as in
  [background passes](#a-background-pass-that-cannot-time-out-cannot-be-observed),
  hence `runtime_event_appends_abandoned_at_shutdown`.

One connection, replies in order. That is what makes `disconnect` the only
bounded close, and it is what the read refusal is derived from. It is also the
limit of that refusal: the store can only refuse once one of ITS OWN commands
has outlived a cap, so a read issued before that, or while Redis is hung with no
write of ours in flight, is still exposed. Closing that needs either a separate
read connection or a `commandTimeout` — the same deferred decision as in #261
and #263, and all three should be weighed together. A test fixture for this
store is only worth trusting if it models the ordering; one that lets each call
settle on its own will happily prove that reads and shutdown sail past a hung
write.

## Test fixtures must not cast past the checker

Every package's `test/**` is inside `npm run typecheck` — otherwise a signature
change that misses a test call site passes the gate silently, and can hide the
behaviour regression the missed argument causes (`#210` / `#211`). How a package
satisfies it depends on whether src and tests can share one compiler
configuration:

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
